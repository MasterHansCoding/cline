/**
 * Wires the M5Stack Core S3 link into the extension.
 *
 * This is the only file that knows about both sides: it owns the socket, the
 * discovery beacon and the session, reads the settings, and maps the device onto
 * the agent:
 *
 *   device prompt  ->  controller.askResponse() (open task) or initTask()
 *   turn phase     ->  status on the device, plus the final text as a reply
 *   Cline question ->  session.askQuestion() (the IDE stays the source of truth)
 *
 * The controller registers itself when it is constructed, so the link can start
 * before the Cline panel has ever been opened; a prompt that arrives in that
 * window is refused with a message the device shows, instead of being lost.
 */

import type { ClineMessage, TurnState } from "@shared/ExtensionMessage"
import { StateManager } from "@/core/storage/StateManager"
import type { Controller } from "@/sdk/SdkController"
import { Logger } from "@/shared/services/Logger"
import { Cores3Session } from "./session"
import { Cores3TcpServer, Cores3UdpBeacon } from "./transport"

/** Longest text mirrored to the device; the rest stays in the IDE. */
const MAX_DEVICE_TEXT = 1500

/** Margin kept between the best and second-best option before the device wins. */
const MATCH_DISTINCT_MARGIN = 0.05

/** A window reload restarts the host before the previous socket is released. */
const START_RETRY_DELAY_MS = 3000
const MAX_START_RETRIES = 20

function isAddressInUse(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EADDRINUSE"
}

interface Cores3Settings {
	enabled: boolean
	port: number
	token: string
	questionTimeoutMs: number
	matchThreshold: number
}

const DEFAULT_SETTINGS: Cores3Settings = {
	enabled: true,
	port: 48901,
	token: "cline-m5",
	questionTimeoutMs: 300_000,
	matchThreshold: 0.5,
}

export class Cores3LinkService {
	private transport: Cores3TcpServer | undefined
	private beacon: Cores3UdpBeacon | undefined
	private session: Cores3Session | undefined
	private controller: Controller | undefined
	/** ts of the agent message already mirrored, so a turn is never sent twice. */
	private lastMirroredTs: number | undefined
	private starting = false
	/** Consecutive EADDRINUSE failures; reset once the port is ours. */
	private startRetries = 0

	/** Called by SdkController as soon as it exists. */
	attachController(controller: Controller): void {
		this.controller = controller
	}

	/** Start listening. Safe to call twice; does nothing when disabled. */
	async start(): Promise<void> {
		if (this.starting || this.transport) {
			return
		}
		this.starting = true
		let transport: Cores3TcpServer | undefined
		let session: Cores3Session | undefined
		try {
			const settings = this.readSettings()
			if (!settings.enabled) {
				Logger.log("[Cores3] link disabled (cores3LinkEnabled is false)")
				return
			}

			transport = new Cores3TcpServer({ port: settings.port })
			session = new Cores3Session({
				transport,
				token: settings.token,
				agentName: "Cline Extension",
				onPrompt: (prompt) => this.handlePrompt(prompt),
				onFreeTextAnswer: (text) => this.handleFreeTextAnswer(text),
				questionTimeoutMs: settings.questionTimeoutMs,
				matchSettings: { minScore: settings.matchThreshold, distinctMargin: MATCH_DISTINCT_MARGIN },
			})
			await session.start()
			session.onReadyChange((ready) => Logger.log(`[Cores3] device ${ready ? "ready" : "gone"}`))

			const port = await transport.start()
			const beacon = new Cores3UdpBeacon({ tcpPort: port })
			await beacon.start()

			this.transport = transport
			this.session = session
			this.beacon = beacon
			this.startRetries = 0
			Logger.log(`[Cores3] listening on port ${port}; the device needs the shared token`)
		} catch (error) {
			await session?.dispose()
			await transport?.dispose()

			// After a window reload the new extension host starts before the old one
			// has released the port. Retrying is what turns "the device only ever
			// connects on the first launch" into a self-healing link.
			if (isAddressInUse(error) && this.startRetries < MAX_START_RETRIES) {
				this.startRetries++
				Logger.warn(
					`[Cores3] port still held by a previous instance; retrying (${this.startRetries}/${MAX_START_RETRIES}) in ${
						START_RETRY_DELAY_MS / 1000
					} s`,
				)
				setTimeout(() => void this.start(), START_RETRY_DELAY_MS)
				return
			}
			Logger.error("[Cores3] failed to start the link:", error)
		} finally {
			this.starting = false
		}
	}

	async stop(): Promise<void> {
		this.beacon?.stop()
		this.beacon = undefined
		await this.session?.dispose()
		this.session = undefined
		await this.transport?.dispose()
		this.transport = undefined
	}

	/** True while a handshaken device is connected. */
	get isDeviceReady(): boolean {
		return this.session?.isReady ?? false
	}

	/**
	 * Mirror an agent turn phase: the status shown on the device, and the final
	 * text of the turn. Called from the turn-state tracker, so it covers every
	 * transition regardless of which coordinator caused it.
	 */
	onTurnPhase(state: TurnState): void {
		const session = this.session
		if (!session) {
			return
		}

		// Leaving the follow-up phase means the IDE answered (or the turn moved
		// on): the device must stop waiting for an answer nobody needs any more.
		if (state.phase !== "awaiting_followup") {
			session.cancelPendingQuestion("the IDE moved on")
		}

		switch (state.phase) {
			case "streaming":
				session.setStatus("thinking")
				break
			case "awaiting_approval":
				session.setStatus("tool")
				break
			case "awaiting_followup":
				session.setStatus("waiting")
				this.mirrorFinalText()
				break
			case "completed":
				session.setStatus("idle")
				this.mirrorFinalText()
				break
			case "resumable":
				session.setStatus("waiting")
				break
			case "error":
				session.setStatus("idle")
				this.mirrorError()
				break
			case "idle":
				session.setStatus("idle")
				break
			default:
				break
		}
	}

	/**
	 * Ask the device a question and wait for its answer. Resolving undefined
	 * means "the IDE stays in charge", which is the behaviour the interaction
	 * coordinator needs when no device can answer.
	 */
	askDevice(question: string, options: readonly string[]): Promise<string | undefined> {
		const session = this.session
		if (!session?.isReady) {
			return Promise.resolve(undefined)
		}
		return session.askQuestion(question, options)
	}

	// ==== internals ====

	private readSettings(): Cores3Settings {
		try {
			const stateManager = StateManager.get()
			return {
				enabled: stateManager.getGlobalSettingsKey("cores3LinkEnabled") ?? DEFAULT_SETTINGS.enabled,
				port: stateManager.getGlobalSettingsKey("cores3LinkPort") ?? DEFAULT_SETTINGS.port,
				token: stateManager.getGlobalSettingsKey("cores3LinkToken") ?? DEFAULT_SETTINGS.token,
				questionTimeoutMs:
					stateManager.getGlobalSettingsKey("cores3LinkQuestionTimeoutMs") ?? DEFAULT_SETTINGS.questionTimeoutMs,
				matchThreshold: stateManager.getGlobalSettingsKey("cores3LinkMatchThreshold") ?? DEFAULT_SETTINGS.matchThreshold,
			}
		} catch (error) {
			Logger.warn(`[Cores3] settings unavailable, using defaults: ${String(error)}`)
			return DEFAULT_SETTINGS
		}
	}

	/**
	 * A prompt typed or spoken on the device, routed exactly like the composer:
	 * continue the open task, or start a new one.
	 */
	private handlePrompt(prompt: string): void {
		const controller = this.controller
		if (!controller) {
			this.session?.notifyError("Open the Cline panel in VS Code first.", false)
			return
		}
		const run = controller.task ? controller.askResponse(prompt) : controller.initTask(prompt)
		run.catch((error) => {
			Logger.error("[Cores3] prompt failed:", error)
			const message = error instanceof Error ? error.message : String(error)
			this.session?.notifyError(`Cline refused the prompt: ${message}`, false)
		})
	}

	/** A loose answer that matched no option: ordinary feedback for the agent. */
	private handleFreeTextAnswer(text: string): void {
		const controller = this.controller
		if (!controller?.task) {
			return
		}
		controller.askResponse(text).catch((error) => {
			Logger.error("[Cores3] free-text answer failed:", error)
		})
	}

	/** Mirror the final text of a turn (at most once per agent message). */
	private mirrorFinalText(): void {
		const text = this.takeAgentText()
		if (!text) {
			return
		}
		const truncated = text.length > MAX_DEVICE_TEXT
		const payload = truncated ? `${text.slice(0, MAX_DEVICE_TEXT)}…` : text
		this.session?.sendReply(payload, { truncated })
	}

	private mirrorError(): void {
		const text = this.lastMessageText((message) => message.type === "say" && message.say === "error")
		if (text) {
			this.session?.notifyError(text.slice(0, 400), true)
		}
	}

	/**
	 * Last completed agent text of the turn. Reported once: the phase settles
	 * through several transitions (completed then idle, for instance) and the
	 * device must not receive the same answer twice.
	 */
	private takeAgentText(): string | undefined {
		const messages = this.controller?.task?.messageStateHandler?.getClineMessages?.()
		if (!messages) {
			return undefined
		}
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]
			if (message.partial || !message.text) {
				continue
			}
			const isAgentText = message.type === "say" && (message.say === "completion_result" || message.say === "text")
			if (!isAgentText) {
				continue
			}
			if (this.lastMirroredTs === message.ts) {
				return undefined
			}
			this.lastMirroredTs = message.ts
			return message.text
		}
		return undefined
	}

	private lastMessageText(predicate: (message: ClineMessage) => boolean): string | undefined {
		const messages = this.controller?.task?.messageStateHandler?.getClineMessages?.()
		if (!messages) {
			return undefined
		}
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]
			if (message.partial || !message.text) {
				continue
			}
			if (predicate(message)) {
				return message.text
			}
		}
		return undefined
	}
}

/**
 * Single instance: the listening socket and the beacon must never be duplicated,
 * and the controller must find the same object when it registers itself.
 */
export const cores3Link = new Cores3LinkService()
