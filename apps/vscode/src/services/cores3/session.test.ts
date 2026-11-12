import { describe, expect, it } from "bun:test"
import { encodeChunked, PROTOCOL_VERSION } from "./protocol"
import { Cores3Session, type Cores3SessionOptions } from "./session"
import type { Cores3Transport } from "./transport"

interface WireMessage {
	type: string
	id?: string
	text?: string
	part?: number
	parts?: number
	options?: string[]
	state?: string
	protocol?: string
	device?: string
	agent?: string
	retryable?: boolean
	timeoutMs?: number
}

/** In-memory link: no sockets, no timers beyond the ones the session sets. */
class FakeTransport implements Cores3Transport {
	isConnected = false
	readonly sent: string[] = []
	/** Set by makeSession, so helpers can ask questions on the owning session. */
	session?: Cores3Session
	private readonly lineListeners = new Set<(line: string) => void>()
	private readonly stateListeners = new Set<(connected: boolean) => void>()

	onLine(listener: (line: string) => void): () => void {
		this.lineListeners.add(listener)
		return () => {
			this.lineListeners.delete(listener)
		}
	}

	onStateChange(listener: (connected: boolean) => void): () => void {
		this.stateListeners.add(listener)
		return () => {
			this.stateListeners.delete(listener)
		}
	}

	send(lines: readonly string[]): boolean {
		if (!this.isConnected) {
			return false
		}
		this.sent.push(...lines)
		return true
	}

	async dispose(): Promise<void> {}

	// ---- test helpers ----

	connect(): void {
		this.isConnected = true
		for (const listener of this.stateListeners) {
			listener(true)
		}
	}

	disconnect(): void {
		this.isConnected = false
		for (const listener of this.stateListeners) {
			listener(false)
		}
	}

	/** Feed one device frame (the transport hands listeners bare lines). */
	receiveLine(line: string): void {
		const trimmed = line.replace(/\r?\n$/, "")
		for (const listener of this.lineListeners) {
			listener(trimmed)
		}
	}

	receive(message: unknown): void {
		this.receiveLine(JSON.stringify(message))
	}

	messages(): WireMessage[] {
		return this.sent.map((line) => JSON.parse(line) as WireMessage)
	}

	types(): string[] {
		return this.messages().map((message) => message.type)
	}
}

function makeSession(overrides: Partial<Cores3SessionOptions> = {}) {
	const transport = new FakeTransport()
	const prompts: { text: string; id: string }[] = []
	const freeText: { text: string; id: string }[] = []
	const ready: boolean[] = []
	const session = new Cores3Session({
		transport,
		token: "secret",
		agentName: "my-project",
		onPrompt: (text, id) => prompts.push({ text, id }),
		onFreeTextAnswer: (text, id) => freeText.push({ text, id }),
		questionTimeoutMs: 500,
		...overrides,
	})
	transport.session = session
	void session.start()
	session.onReadyChange((value) => ready.push(value))
	return { session, transport, prompts, freeText, ready }
}

function handshake(transport: FakeTransport, token = "secret", protocol = PROTOCOL_VERSION): void {
	transport.connect()
	transport.receive({ type: "hello", protocol, token, device: "m5stack" })
}

/** Ask a question on the session owning this transport (test sugar). */
function makeQuestion(transport: FakeTransport, options: string[]): Promise<string | undefined> {
	const session = transport.session
	if (!session) {
		throw new Error("makeQuestion: the transport has no session")
	}
	return session.askQuestion("Which one?", options, { timeoutMs: 500 })
}

describe("Cores3Session handshake", () => {
	it("stays unready until a valid hello arrives", () => {
		const { session, transport } = makeSession()
		transport.connect()
		expect(session.isReady).toBe(false)

		transport.receive({ type: "hello", protocol: PROTOCOL_VERSION, token: "secret", device: "m5stack" })
		expect(session.isReady).toBe(true)
		expect(transport.types()).toEqual(["hello_ack", "status"])
		expect(transport.messages()[0]).toMatchObject({ agent: "my-project", device: "m5stack" })
	})

	it("refuses a wrong token and serves nothing afterwards", () => {
		const { session, transport, prompts } = makeSession()
		transport.connect()
		transport.receive({ type: "hello", protocol: PROTOCOL_VERSION, token: "guessed" })

		expect(session.isReady).toBe(false)
		expect(transport.types()).toEqual(["error"])
		expect(transport.messages()[0].text).toBe("invalid token")

		transport.receive({ type: "prompt", id: "p-1", text: "hello" })
		expect(prompts).toEqual([])
		expect(transport.types()).toEqual(["error"])
	})

	it("refuses a device speaking another protocol version", () => {
		const { session, transport } = makeSession()
		transport.connect()
		transport.receive({ type: "hello", protocol: "cline-cores3/99", token: "secret" })
		expect(session.isReady).toBe(false)
		expect(transport.messages()[0].text).toContain("unsupported protocol")
	})

	it("reports readiness changes to listeners", () => {
		const { transport, ready } = makeSession()
		handshake(transport)
		transport.disconnect()
		expect(ready).toEqual([false, true, false])
	})

	it("requires a fresh handshake after a reconnect", () => {
		const { session, transport } = makeSession()
		handshake(transport)
		transport.disconnect()
		transport.connect()
		expect(session.isReady).toBe(false)
	})

	it("shows the remembered status at handshake time", () => {
		const { session, transport } = makeSession()
		session.setStatus("thinking")
		expect(transport.types()).toEqual([])
		handshake(transport)
		expect(transport.messages()[1]).toEqual({ type: "status", state: "thinking" })
	})
})

// ---- device to agent ----

describe("Cores3Session device text", () => {
	it("trims a prompt, forwards it and acknowledges it", () => {
		const { transport, prompts } = makeSession()
		handshake(transport)
		transport.receive({ type: "prompt", id: "p-1", text: "  fix the tests  " })
		expect(prompts).toEqual([{ text: "fix the tests", id: "p-1" }])
		expect(transport.types()).toEqual(["hello_ack", "status", "ack"])
	})

	it("acknowledges a retransmitted id without running it twice", () => {
		const { transport, prompts } = makeSession()
		handshake(transport)
		transport.receive({ type: "prompt", id: "p-1", text: "run once" })
		transport.receive({ type: "prompt", id: "p-1", text: "run once" })
		expect(prompts).toHaveLength(1)
		expect(transport.types().filter((type) => type === "ack")).toHaveLength(2)
	})

	it("waits for every fragment of a chunked prompt", () => {
		const { transport, prompts } = makeSession()
		handshake(transport)
		const long = "explique-moi ce que fait ce fichier ".repeat(4)
		const lines = encodeChunked({ type: "prompt", id: "p-9", text: long }, 24)
		expect(lines.length).toBeGreaterThan(1)

		for (const line of lines.slice(0, -1)) {
			transport.receiveLine(line)
		}
		expect(prompts).toEqual([])

		transport.receiveLine(lines[lines.length - 1])
		// Prompts are trimmed, and `long` ends with a space on purpose.
		expect(prompts).toEqual([{ text: long.trim(), id: "p-9" }])
	})

	it("ignores everything received before the handshake", () => {
		const { transport, prompts } = makeSession()
		transport.connect()
		transport.receive({ type: "prompt", id: "p-1", text: "hello" })
		expect(prompts).toEqual([])
		expect(transport.types()).toEqual([])
	})

	it("survives an unreadable line", () => {
		const { session, transport } = makeSession()
		handshake(transport)
		transport.receiveLine('{"type":"nope"}')
		transport.receiveLine("{not json")
		expect(session.isReady).toBe(true)
		expect(transport.types().slice(2)).toEqual(["error", "error"])
	})

	it("answers a ping", () => {
		const { transport } = makeSession()
		handshake(transport)
		transport.receive({ type: "ping", id: "1" })
		expect(transport.types().at(-1)).toBe("pong")
	})
})

// ---- questions ----

describe("Cores3Session questions", () => {
	it("does not ask when no device is ready", async () => {
		const { session, transport } = makeSession()
		await expect(session.askQuestion("Which one?", ["A", "B"])).resolves.toBeUndefined()
		expect(transport.types()).toEqual([])
	})

	it("sends the question with its options and resolves a tapped ordinal", async () => {
		const { session, transport } = makeSession()
		handshake(transport)

		const answer = session.askQuestion("Which approach?", ["Alpha", "Beta"], { timeoutMs: 200 })
		expect(transport.messages().at(-1)).toMatchObject({
			type: "question",
			options: ["Alpha", "Beta"],
			timeoutMs: 200,
		})
		expect(session.pendingQuestion?.options).toEqual(["Alpha", "Beta"])

		transport.receive({ type: "answer", id: "a-1", text: "2" })
		await expect(answer).resolves.toBe("Beta")
		expect(session.pendingQuestion).toBeUndefined()
	})

	it("maps a loose answer onto the closest option", async () => {
		const { transport } = makeSession()
		handshake(transport)
		const answer = transport.messages().length
		const question = makeQuestion(transport, ["Refactor the parser", "Rewrite the tests"])

		transport.receive({ type: "answer", id: "a-2", text: "Parser" })
		await expect(question).resolves.toBe("Refactor the parser")
		expect(transport.messages().length).toBeGreaterThan(answer)
	})

	it("treats a prompt as the answer while a question is pending", async () => {
		const { transport, prompts } = makeSession()
		handshake(transport)
		const question = makeQuestion(transport, ["Approve", "Reject"])

		transport.receive({ type: "prompt", id: "p-7", text: "ok" })
		await expect(question).resolves.toBe("Approve")
		expect(prompts).toEqual([])
	})

	it("forwards an answer that matches no option as feedback", async () => {
		const { transport, freeText } = makeSession()
		handshake(transport)
		const question = makeQuestion(transport, ["Refactor the parser", "Rewrite the tests"])

		// "banana" shares letters with both labels but resembles neither. With the
		// default floor it is rejected instead of being silently mapped to a wrong
		// option, and travels to the agent as ordinary feedback.
		transport.receive({ type: "answer", id: "a-3", text: "banana" })
		await expect(question).resolves.toBeUndefined()
		expect(freeText).toEqual([{ text: "banana", id: "q-1" }])
	})

	it("can be told to always pick the closest option", async () => {
		const { transport, freeText } = makeSession({ matchSettings: { minScore: 0.1, distinctMargin: 0 } })
		handshake(transport)
		const question = makeQuestion(transport, ["Refactor the parser", "Rewrite the tests"])

		transport.receive({ type: "answer", id: "a-4", text: "banana" })
		await expect(question).resolves.toBe("Refactor the parser")
		expect(freeText).toEqual([])
	})

	it("gives up at the timeout and leaves the IDE in charge", async () => {
		const { session, transport } = makeSession()
		handshake(transport)
		await expect(session.askQuestion("Which one?", ["A", "B"], { timeoutMs: 30 })).resolves.toBeUndefined()
		expect(session.pendingQuestion).toBeUndefined()
	})

	it("lets the IDE answer first and ignores the late device answer", async () => {
		const { session, transport, prompts } = makeSession()
		handshake(transport)

		const answer = session.askQuestion("Which one?", ["A", "B"], { timeoutMs: 200 })
		session.cancelPendingQuestion("answered in the IDE")
		await expect(answer).resolves.toBeUndefined()

		const before = transport.sent.length
		transport.receive({ type: "answer", id: "a-9", text: "A" })
		expect(transport.types().at(-1)).toBe("ack")
		expect(transport.sent.length).toBe(before + 1)
		expect(session.pendingQuestion).toBeUndefined()
		expect(prompts).toEqual([])
	})

	it("resolves undefined when the device disappears mid-question", async () => {
		const { session, transport } = makeSession()
		handshake(transport)
		const answer = session.askQuestion("Which one?", ["A", "B"], { timeoutMs: 400 })
		transport.disconnect()
		await expect(answer).resolves.toBeUndefined()
		expect(session.isReady).toBe(false)
	})
})

// ---- outbound ----

describe("Cores3Session outbound", () => {
	it("sends a status only when it changes", () => {
		const { session, transport } = makeSession()
		handshake(transport)
		const before = transport.sent.length
		session.setStatus("thinking")
		session.setStatus("thinking")
		expect(transport.sent.length).toBe(before + 1)
		expect(transport.messages().at(-1)).toEqual({ type: "status", state: "thinking" })
	})

	it("chunks a long reply under the byte budget", () => {
		const { session, transport } = makeSession({ maxChunkBytes: 64 })
		handshake(transport)
		const text = "réponse ".repeat(60)
		expect(session.sendReply(text)).toBe(true)

		const parts = transport.messages().filter((message) => message.type === "reply")
		expect(parts.length).toBeGreaterThan(1)
		expect(parts.map((part) => part.parts)).toEqual(parts.map(() => parts.length))
		expect(parts.map((part) => part.text).join("")).toBe(text.trim())
		expect(parts.map((part) => part.id).every((id) => id === parts[0].id)).toBe(true)
	})

	it("refuses an empty reply and serves nothing while offline", () => {
		const { session, transport } = makeSession()
		expect(session.sendReply("   ")).toBe(false)
		expect(session.sendReply("hi")).toBe(false)

		handshake(transport)
		expect(session.sendReply("hi")).toBe(true)
		expect(transport.messages().at(-1)).toMatchObject({ type: "reply", text: "hi", last: true })
	})

	it("surfaces an error to the device", () => {
		const { session, transport } = makeSession()
		handshake(transport)
		expect(session.notifyError("provider down", true)).toBe(true)
		expect(transport.messages().at(-1)).toEqual({ type: "error", text: "provider down", retryable: true })
	})
})
