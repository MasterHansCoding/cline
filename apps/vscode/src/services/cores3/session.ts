/**
 * The behavioural core of the Core S3 link: handshake, prompt routing, question
 * lifecycle and outbound replies.
 *
 * It sits between the pure protocol (./protocol), the socket (./transport) and
 * the agent wiring, and owns every rule that must not depend on either:
 *
 * - Nothing is served before a valid handshake. A hello must carry the shared
 *   token and the exact protocol version; a rejected peer is answered with an
 *   `error` and keeps the socket, which "last connection wins" in the transport
 *   hands to the real device as soon as it reconnects.
 * - The IDE always stays in charge. A question nobody answers on the device
 *   (timeout, or device offline when it is asked) resolves to `undefined`, i.e.
 *   "leave the ask pending in the IDE" - never block the agent waiting for
 *   hardware that may be switched off.
 * - While a question is pending, ANY text from the device counts as its answer,
 *   even one shaped like a new prompt: that is what a user means when they type
 *   instead of tapping an option.
 * - A loose answer is mapped onto the closest option (./option-matcher); text
 *   that matches nothing goes to `onFreeTextAnswer` as ordinary feedback, since
 *   dropping it would look like a lost message on the device.
 * - Retransmitted ids are acknowledged but never processed twice, so a flaky
 *   link cannot run the same prompt twice.
 */

import { Logger } from "@/shared/services/Logger"
import { matchOption, type OptionMatchOptions } from "./option-matcher"
import {
	ChunkAssembler,
	type Cores3ServerMessage,
	type Cores3StatusState,
	DEFAULT_MAX_CHUNK_BYTES,
	encodeChunked,
	isChunked,
	PROTOCOL_VERSION,
	parseClientMessage,
} from "./protocol"
import type { Cores3Transport } from "./transport"

/** How long the device is given to answer before the IDE takes over again. */
export const DEFAULT_QUESTION_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Default resemblance floor.
 *
 * 0.5 is the empirical floor: Jaro-Winkler is length-sensitive, so two words
 * that merely share letters ("banana" vs "Refactor the parser") already reach
 * ~0.48, while any genuine resemblance scores far higher - containment 0.85,
 * yes/no 0.9, ordinal 0.98. Keeping the floor above that noise band is what
 * stops a nonsense answer from silently selecting a wrong option; the answer is
 * then handed to `onFreeTextAnswer` instead of being mapped.
 *
 * Lower `minScore` (e.g. 0.1) to force "always pick the closest option", or
 * raise `distinctMargin` to fall back to the IDE when two labels look alike.
 */
export const DEFAULT_MATCH_SETTINGS: OptionMatchOptions = { minScore: 0.5, distinctMargin: 0.05 }

/** Prompt/answer ids remembered for retransmission protection. */
const MAX_REMEMBERED_IDS = 64

export interface Cores3SessionOptions {
	transport: Cores3Transport
	/** Shared secret the device must present in its hello. */
	token: string
	/** Label shown on the device, typically the workspace folder name. */
	agentName: string
	/**
	 * A prompt typed on the device. Fire-and-forget: the agent must never be
	 * awaited from the socket handler, or a slow turn would freeze the link.
	 */
	onPrompt: (prompt: string, id: string) => void
	/** Loose text that matched no option, routed as ordinary user feedback. */
	onFreeTextAnswer?: (text: string, id: string) => void
	questionTimeoutMs?: number
	maxChunkBytes?: number
	matchSettings?: OptionMatchOptions
}

export interface Cores3PendingQuestion {
	id: string
	question: string
	options: string[]
}

interface PendingQuestionInternal extends Cores3PendingQuestion {
	resolve: (answer: string | undefined) => void
	timer: ReturnType<typeof setTimeout>
}

export class Cores3Session {
	private handshaken = false
	private chunks = new ChunkAssembler()
	private status: Cores3StatusState = "idle"
	private sequence = 0
	private pending: PendingQuestionInternal | undefined
	private readonly processedIds = new Set<string>()
	private readonly processedOrder: string[] = []
	private readonly readyListeners = new Set<(ready: boolean) => void>()
	private readonly unsubscribes: (() => void)[] = []

	constructor(private readonly options: Cores3SessionOptions) {}

	/** True only while a handshaken device is connected. */
	get isReady(): boolean {
		return this.handshaken && this.options.transport.isConnected
	}

	get pendingQuestion(): Cores3PendingQuestion | undefined {
		const pending = this.pending
		return pending ? { id: pending.id, question: pending.question, options: [...pending.options] } : undefined
	}

	/** Subscribe to the transport. Call once per session, before using it. */
	async start(): Promise<void> {
		this.unsubscribes.push(this.options.transport.onLine((line) => this.handleLine(line)))
		this.unsubscribes.push(this.options.transport.onStateChange((connected) => this.handleTransportState(connected)))
	}

	async dispose(): Promise<void> {
		for (const unsubscribe of this.unsubscribes) {
			unsubscribe()
		}
		this.unsubscribes.length = 0
		this.resolvePending(undefined, "session disposed")
		this.handshaken = false
		this.readyListeners.clear()
		this.processedIds.clear()
		this.processedOrder.length = 0
	}

	/**
	 * Notified when the device becomes ready or goes away, so the wiring can log
	 * it and re-push whatever the device should display.
	 */
	onReadyChange(listener: (ready: boolean) => void): () => void {
		this.readyListeners.add(listener)
		return () => {
			this.readyListeners.delete(listener)
		}
	}

	// ---- outbound ----

	/** Status shown on the device. Sent only when it changes. */
	setStatus(state: Cores3StatusState): void {
		if (this.status === state) {
			return
		}
		this.status = state
		this.sendStatus()
	}

	/** Final text of a turn, chunked. `false` when there is nothing to send. */
	sendReply(text: string, settings: { truncated?: boolean; last?: boolean } = {}): boolean {
		const trimmed = text.trim()
		if (trimmed.length === 0) {
			return false
		}
		return this.send({
			type: "reply",
			id: this.nextId("r"),
			text: trimmed,
			truncated: settings.truncated ?? false,
			last: settings.last ?? true,
		})
	}

	/** Blocking error to surface on the device (provider down, bad protocol…). */
	notifyError(text: string, retryable = false): boolean {
		return this.send({ type: "error", text, retryable })
	}

	/** The IDE answered (or cancelled) the pending question before the device. */
	cancelPendingQuestion(reason: string): void {
		this.resolvePending(undefined, reason)
	}

	// ---- internals ----

	private sendRaw(message: Cores3ServerMessage): boolean {
		return this.options.transport.send(encodeChunked(message, this.options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES))
	}

	/** Every message except a handshake error requires a handshaken device. */
	private send(message: Cores3ServerMessage): boolean {
		if (!this.isReady) {
			return false
		}
		return this.sendRaw(message)
	}

	private sendStatus(): void {
		this.send({ type: "status", state: this.status })
	}

	private nextId(prefix: string): string {
		this.sequence++
		return `${prefix}-${this.sequence}`
	}

	private handleTransportState(connected: boolean): void {
		if (!connected) {
			// The device is gone: nobody can answer a pending question any more.
			this.resolvePending(undefined, "device disconnected")
		}
		// A new connection always starts unauthenticated, and a half-received
		// message from the previous one must never be completed by the new one.
		this.handshaken = false
		this.chunks = new ChunkAssembler()
		if (connected) {
			Logger.log("[Cores3] device socket open, waiting for the handshake")
		}
		this.notifyReady()
	}

	private notifyReady(): void {
		for (const listener of this.readyListeners) {
			try {
				listener(this.isReady)
			} catch (error) {
				Logger.error("[Cores3] ready listener failed:", error)
			}
		}
	}

	// ---- inbound ----

	private handleLine(line: string): void {
		const parsed = parseClientMessage(line)
		if (!parsed.ok) {
			Logger.warn(`[Cores3] ignoring inbound line: ${parsed.reason}`)
			this.notifyError(`unreadable message: ${parsed.reason}`)
			return
		}
		const message = parsed.message

		// A chunked payload is only usable once every fragment has arrived, so
		// the switch below always sees whole text.
		let text: string | undefined
		if (isChunked(message)) {
			if (!("text" in message)) {
				Logger.warn("[Cores3] ignoring chunk metadata on a message without text")
				return
			}
			text = this.chunks.add({
				id: message.id,
				part: message.part ?? 0,
				parts: message.parts ?? 1,
				text: message.text,
			})
			if (text === undefined) {
				return
			}
		} else if ("text" in message) {
			text = message.text
		}

		try {
			switch (message.type) {
				case "hello":
					this.handleHello(message.protocol, message.token, message.device)
					return
				case "prompt":
					this.handleDeviceText(message.id, text ?? "", "prompt")
					return
				case "answer":
					this.handleDeviceText(message.id, text ?? "", "answer")
					return
				case "ping":
					this.send({ type: "pong", id: message.id })
					return
				case "ack":
					Logger.debug(`[Cores3] device acknowledged ${message.id}`)
			}
		} catch (error) {
			// A malformed or hostile message must never take the link down.
			Logger.error("[Cores3] failed to handle inbound message:", error)
		}
	}

	// ---- handshake and device text ----

	private handleHello(protocol: string, token: string, device?: string): void {
		if (protocol !== PROTOCOL_VERSION) {
			Logger.warn(`[Cores3] refusing a device speaking ${protocol}`)
			this.handshaken = false
			this.sendRaw({ type: "error", text: `unsupported protocol (expected ${PROTOCOL_VERSION})`, retryable: false })
			return
		}
		if (token !== this.options.token) {
			// The socket is left open on purpose: "last connection wins" in the
			// transport hands it to the real device as soon as it reconnects.
			Logger.warn("[Cores3] refusing a device with an invalid token")
			this.handshaken = false
			this.sendRaw({ type: "error", text: "invalid token", retryable: false })
			return
		}

		this.handshaken = true
		Logger.log(`[Cores3] device ready${device ? ` (${device})` : ""}`)
		this.sendRaw({
			type: "hello_ack",
			protocol: PROTOCOL_VERSION,
			device: device ?? "cores3",
			agent: this.options.agentName,
		})
		this.sendStatus()
		this.notifyReady()
	}

	private handleDeviceText(id: string, text: string, kind: "prompt" | "answer"): void {
		if (!this.isReady) {
			Logger.warn(`[Cores3] ignoring ${kind} received before the handshake`)
			return
		}
		this.send({ type: "ack", id })
		if (this.hasProcessed(id)) {
			Logger.debug(`[Cores3] ignoring retransmitted ${kind} ${id}`)
			return
		}
		this.rememberProcessed(id)

		// While a question is pending, whatever the device sends is its answer.
		if (this.pending) {
			this.answerPendingFromDevice(text)
			return
		}

		// An `answer` with no pending question belongs to the past: the IDE
		// answered first, or the question timed out. Running it as a prompt would
		// start a turn the user never asked for.
		if (kind === "answer") {
			Logger.debug(`[Cores3] ignoring late answer ${id}: no question is pending`)
			return
		}

		const trimmed = text.trim()
		if (trimmed.length === 0) {
			return
		}
		try {
			this.options.onPrompt(trimmed, id)
		} catch (error) {
			Logger.error("[Cores3] prompt handler failed:", error)
		}
	}

	private answerPendingFromDevice(text: string): void {
		const pending = this.pending
		if (!pending) {
			return
		}

		const match = matchOption(text, pending.options, this.options.matchSettings ?? DEFAULT_MATCH_SETTINGS)
		if (match.option !== undefined) {
			Logger.log(`[Cores3] device answer "${text}" -> "${match.option}" (score ${match.score.toFixed(2)})`)
			this.resolvePending(match.option, "device answer")
			return
		}

		Logger.log(`[Cores3] device answer matched no option (${match.reason}); forwarding as feedback`)
		this.resolvePending(undefined, `unmatched answer (${match.reason})`)
		const trimmed = text.trim()
		if (trimmed.length === 0) {
			return
		}
		try {
			this.options.onFreeTextAnswer?.(trimmed, pending.id)
		} catch (error) {
			Logger.error("[Cores3] free-text handler failed:", error)
		}
	}

	// ---- questions ----

	/**
	 * Ask the device a question and wait for its answer.
	 *
	 * Resolves with the option the device picked, or `undefined` when the device
	 * cannot answer (offline, timeout, or text matching no option). `undefined`
	 * always means the same thing to the caller: keep the ask pending in the IDE,
	 * which remains the source of truth.
	 */
	askQuestion(
		question: string,
		options: readonly string[],
		settings: { timeoutMs?: number } = {},
	): Promise<string | undefined> {
		if (!this.isReady) {
			return Promise.resolve(undefined)
		}
		if (this.pending) {
			Logger.warn("[Cores3] a question is already pending; this one stays IDE-only")
			return Promise.resolve(undefined)
		}

		const labels = [...new Set(options.map((option) => option.trim()).filter((option) => option.length > 0))]
		if (labels.length === 0) {
			return Promise.resolve(undefined)
		}

		const id = this.nextId("q")
		const timeoutMs = settings.timeoutMs ?? this.options.questionTimeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS

		return new Promise<string | undefined>((resolve) => {
			const timeout = setTimeout(() => {
				if (this.pending?.id === id) {
					Logger.log(`[Cores3] question ${id} timed out; the IDE stays in charge`)
					this.resolvePending(undefined, "timeout")
				}
			}, timeoutMs)
			this.pending = { id, question, options: labels, resolve, timer: timeout }

			if (!this.send({ type: "question", id, text: question, options: labels, timeoutMs })) {
				this.resolvePending(undefined, "question could not be sent")
			}
		})
	}

	/** Settle the pending question exactly once, whoever answered it. */
	private resolvePending(answer: string | undefined, reason: string): void {
		const pending = this.pending
		if (!pending) {
			return
		}
		this.pending = undefined
		clearTimeout(pending.timer)
		Logger.debug(`[Cores3] question ${pending.id} settled: ${reason}`)
		pending.resolve(answer)
	}

	// ---- retransmission protection ----

	private hasProcessed(id: string): boolean {
		return this.processedIds.has(id)
	}

	private rememberProcessed(id: string): void {
		this.processedIds.add(id)
		this.processedOrder.push(id)
		while (this.processedOrder.length > MAX_REMEMBERED_IDS) {
			const oldest = this.processedOrder.shift()
			if (oldest !== undefined) {
				this.processedIds.delete(oldest)
			}
		}
	}
}
