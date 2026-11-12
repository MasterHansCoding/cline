/**
 * Wire protocol between the Cline extension and the M5Stack Core S3.
 *
 * The device joins the same WiFi network as the PC and opens one socket to the
 * extension. Messages are newline-delimited JSON (NDJSON): one object per line,
 * UTF-8, `\n` terminated. Text fields that may exceed the link's comfortable
 * write size are split into parts the receiver reassembles by `id`.
 *
 * Nothing here touches a socket, so the whole protocol (framing, chunking,
 * validation, reassembly) is unit-testable against a fake link.
 *
 * Line grammar:
 *   { type, ... }                    a complete message
 *   { type, id, part, parts, ... }   one fragment of a chunked message
 * `parts` is the fragment count and `part` the zero-based index.
 */

export const PROTOCOL_VERSION = "cline-cores3/1"

/** Largest text fragment written in one line by default. */
export const DEFAULT_MAX_CHUNK_BYTES = 512

/** Anything larger than this is a bug or an attack; reject it. */
export const MAX_TEXT_BYTES = 64 * 1024

/** A partial chunked message is dropped after this long. */
export const CHUNK_TIMEOUT_MS = 30_000

/** Agent lifecycle as shown on the device. */
export type Cores3StatusState = "idle" | "thinking" | "tool" | "waiting" | "offline"

/** Device -> extension. */
export type Cores3ClientMessage =
	| { type: "hello"; protocol: string; token: string; device?: string }
	| { type: "prompt"; id: string; text: string }
	| { type: "answer"; id: string; text: string }
	| { type: "ack"; id: string }
	| { type: "ping"; id: string }

/** Extension -> device. */
export type Cores3ServerMessage =
	| { type: "hello_ack"; protocol: string; device: string; agent: string }
	| { type: "status"; state: Cores3StatusState }
	| { type: "reply"; id: string; text: string; truncated?: boolean; last?: boolean }
	| { type: "question"; id: string; text: string; options: string[]; timeoutMs: number }
	| { type: "error"; id?: string; text: string; retryable?: boolean }
	| { type: "ack"; id: string }
	| { type: "pong"; id: string }

/** A validated client message, plus chunk metadata when it was fragmented. */
export type ParsedClientMessage = Cores3ClientMessage & { part?: number; parts?: number }

export interface ChunkedMessage {
	id: string
	part: number
	parts: number
	text: string
}

export type ParseResult<TMessage> = { ok: true; message: TMessage } | { ok: false; reason: string }

/** One NDJSON line: the message plus its terminator. */
export function encodeLine(message: unknown): string {
	return `${JSON.stringify(message)}\n`
}

/**
 * Split `text` into fragments of at most `maxBytes` UTF-8 bytes, cutting only on
 * code point boundaries (a surrogate pair is never cut in half) and preferring
 * the last space or newline of the fragment when that keeps at least half of it.
 *
 * `chunkText(text, n).join("")` always equals `text`.
 */
export function chunkText(text: string, maxBytes: number = DEFAULT_MAX_CHUNK_BYTES): string[] {
	if (text.length === 0) {
		return [""]
	}
	if (!Number.isFinite(maxBytes) || maxBytes < 1) {
		throw new RangeError(`chunkText: maxBytes must be >= 1 (got ${maxBytes})`)
	}

	const chunks: string[] = []
	let current = ""
	let currentBytes = 0
	// Index just after the last whitespace of `current`, or -1.
	let softBreak = -1

	const flush = () => {
		if (current.length > 0) {
			chunks.push(current)
		}
		current = ""
		currentBytes = 0
		softBreak = -1
	}

	for (const character of text) {
		const characterBytes = Buffer.byteLength(character, "utf8")
		if (currentBytes + characterBytes > maxBytes) {
			if (softBreak > 0 && softBreak >= Math.floor(current.length / 2)) {
				const head = current.slice(0, softBreak)
				const tail = current.slice(softBreak)
				chunks.push(head)
				current = tail
				currentBytes = Buffer.byteLength(tail, "utf8")
				softBreak = -1
			} else {
				flush()
			}
		}
		current += character
		currentBytes += characterBytes
		if (character === " " || character === "\n") {
			softBreak = current.length
		}
	}
	if (current.length > 0) {
		chunks.push(current)
	}
	return chunks
}

// ---- framing and reassembly ----

/**
 * Encode one message, splitting its `text` field when needed. The returned
 * strings are complete NDJSON lines (terminators included) to write in order;
 * the receiver reassembles them with `ChunkAssembler`.
 *
 * Messages without a `text` field are always a single line.
 */
export function encodeChunked(
	message: Cores3ServerMessage | Cores3ClientMessage,
	maxBytes: number = DEFAULT_MAX_CHUNK_BYTES,
): string[] {
	const withText = message as { id?: string; text?: string }
	if (typeof withText.text !== "string" || withText.id === undefined) {
		return [encodeLine(message)]
	}

	const parts = chunkText(withText.text, maxBytes)
	if (parts.length === 1) {
		return [encodeLine(message)]
	}
	return parts.map((part, index) =>
		encodeLine({ ...(message as Record<string, unknown>), part: index, parts: parts.length, text: part }),
	)
}

/**
 * Turns an arbitrarily split byte stream into complete lines: a socket delivers
 * fragments, not lines, so the tail is kept until its `\n` arrives. An overlong
 * line is dropped (with a throw the caller logs) rather than buffered forever.
 */
export class NdjsonLineDecoder {
	private buffer = ""
	private readonly maxChars: number

	constructor(maxChars: number = MAX_TEXT_BYTES * 2) {
		this.maxChars = maxChars
	}

	/** Feed a fragment, get back the lines it completed. */
	push(fragment: string): string[] {
		this.buffer += fragment
		const lines: string[] = []
		let newlineIndex = this.buffer.indexOf("\n")
		while (newlineIndex !== -1) {
			const line = this.buffer.slice(0, newlineIndex).trim()
			this.buffer = this.buffer.slice(newlineIndex + 1)
			if (line.length > 0) {
				lines.push(line)
			}
			newlineIndex = this.buffer.indexOf("\n")
		}
		if (this.buffer.length > this.maxChars) {
			this.buffer = ""
			throw new Error(`NDJSON decoder: line exceeds ${this.maxChars} characters and was dropped`)
		}
		return lines
	}

	/** Drop a truncated tail left by a link reset in the middle of a line. */
	reset(): void {
		this.buffer = ""
	}
}

// ---- chunk reassembly ----

/**
 * Reassembles messages split by `encodeChunked`. Completions are keyed by `id`,
 * so several chunked messages can be in flight at once, and a partial message
 * that never completes is evicted by `prune` instead of leaking memory.
 */
export class ChunkAssembler {
	private readonly pending = new Map<string, { parts: number; received: Map<number, string>; updatedAt: number }>()

	constructor(private readonly timeoutMs: number = CHUNK_TIMEOUT_MS) {}

	/**
	 * Register one fragment, returning the reassembled text once every part has
	 * arrived and undefined while some are still missing. A retransmitted part
	 * (same id, same part) overwrites in place, so a retry is harmless.
	 */
	add(fragment: ChunkedMessage): string | undefined {
		const entry = this.pending.get(fragment.id) ?? {
			parts: fragment.parts,
			received: new Map<number, string>(),
			updatedAt: 0,
		}
		entry.parts = fragment.parts
		entry.received.set(fragment.part, fragment.text)
		entry.updatedAt = Date.now()
		this.pending.set(fragment.id, entry)

		if (entry.received.size < entry.parts) {
			return undefined
		}
		let text = ""
		for (let index = 0; index < entry.parts; index++) {
			const part = entry.received.get(index)
			if (part === undefined) {
				return undefined
			}
			text += part
		}
		this.pending.delete(fragment.id)
		if (text.length > MAX_TEXT_BYTES) {
			throw new Error(`ChunkAssembler: reassembled text exceeds ${MAX_TEXT_BYTES} bytes`)
		}
		return text
	}

	/** Forget partial messages older than the timeout; returns how many went. */
	prune(now: number = Date.now()): number {
		let dropped = 0
		for (const [id, entry] of this.pending) {
			if (now - entry.updatedAt > this.timeoutMs) {
				this.pending.delete(id)
				dropped++
			}
		}
		return dropped
	}

	get pendingCount(): number {
		return this.pending.size
	}
}

export function isChunked(message: { part?: unknown; parts?: unknown }): message is ChunkedMessage {
	const candidate = message as ChunkedMessage
	return typeof candidate.part === "number" && typeof candidate.parts === "number" && candidate.parts > 1
}

// ---- validation ----

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function optionalChunkFields(record: Record<string, unknown>): { part?: number; parts?: number } | undefined {
	const { part, parts } = record
	if (part === undefined && parts === undefined) {
		return {}
	}
	if (typeof part !== "number" || typeof parts !== "number" || part < 0 || parts < 1 || part >= parts) {
		return undefined
	}
	return { part, parts }
}

/**
 * Validate one line received from the device. Unknown types, missing fields and
 * malformed chunk metadata come back as a reason the caller logs and answers
 * with an `error` message: a bad line must never throw inside a socket handler.
 */
export function parseClientMessage(line: string): ParseResult<ParsedClientMessage> {
	let decoded: unknown
	try {
		decoded = JSON.parse(line)
	} catch {
		return { ok: false, reason: "invalid_json" }
	}
	const record = asRecord(decoded)
	if (!record) {
		return { ok: false, reason: "not_an_object" }
	}
	const { type } = record
	if (typeof type !== "string" || type.length === 0) {
		return { ok: false, reason: "missing_type" }
	}
	const chunk = optionalChunkFields(record)
	if (!chunk) {
		return { ok: false, reason: "invalid_chunk_fields" }
	}

	switch (type) {
		case "hello": {
			if (typeof record.protocol !== "string" || typeof record.token !== "string") {
				return { ok: false, reason: "missing_handshake_fields" }
			}
			const device = typeof record.device === "string" ? { device: record.device } : {}
			return {
				ok: true,
				message: { type, protocol: record.protocol, token: record.token, ...device, ...chunk } as ParsedClientMessage,
			}
		}
		case "prompt":
		case "answer": {
			if (typeof record.id !== "string" || typeof record.text !== "string") {
				return { ok: false, reason: "missing_id_or_text" }
			}
			return { ok: true, message: { type, id: record.id, text: record.text, ...chunk } as ParsedClientMessage }
		}
		case "ack":
		case "ping": {
			if (typeof record.id !== "string") {
				return { ok: false, reason: "missing_id" }
			}
			return { ok: true, message: { type, id: record.id, ...chunk } as ParsedClientMessage }
		}
		default:
			return { ok: false, reason: `unknown_type:${type}` }
	}
}

const SERVER_TYPES = new Set(["hello_ack", "status", "reply", "question", "error", "ack", "pong"])

/** Validate a line the extension is about to send (guards against our bugs). */
export function parseServerMessage(line: string): ParseResult<Cores3ServerMessage> {
	let decoded: unknown
	try {
		decoded = JSON.parse(line)
	} catch {
		return { ok: false, reason: "invalid_json" }
	}
	const record = asRecord(decoded)
	if (!record) {
		return { ok: false, reason: "not_an_object" }
	}
	if (typeof record.type !== "string" || !SERVER_TYPES.has(record.type)) {
		return { ok: false, reason: `unknown_type:${String(record.type)}` }
	}
	return { ok: true, message: decoded as Cores3ServerMessage }
}
