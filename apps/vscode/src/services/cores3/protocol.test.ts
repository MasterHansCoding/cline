import { describe, expect, it } from "bun:test"
import {
	ChunkAssembler,
	chunkText,
	encodeChunked,
	encodeLine,
	isChunked,
	NdjsonLineDecoder,
	PROTOCOL_VERSION,
	parseClientMessage,
	parseServerMessage,
} from "./protocol"

describe("chunkText", () => {
	it("returns the text unchanged when it fits", () => {
		expect(chunkText("hello", 64)).toEqual(["hello"])
	})

	it("never exceeds the byte budget", () => {
		for (const chunk of chunkText("a".repeat(100), 10)) {
			expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(10)
		}
	})

	it("loses nothing and keeps order", () => {
		const text = "Le chat dort sur le clavier. ".repeat(20)
		expect(chunkText(text, 32).join("")).toBe(text)
	})

	it("never cuts a surrogate pair or an accent in half", () => {
		const text = "🎧 é".repeat(20)
		const chunks = chunkText(text, 3)
		expect(chunks.join("")).toBe(text)
		for (const chunk of chunks) {
			expect(/[\uD800-\uDBFF]$/.test(chunk)).toBe(false)
			expect(/^[\uDC00-\uDFFF]/.test(chunk)).toBe(false)
		}
	})

	it("prefers cutting on whitespace", () => {
		expect(chunkText("aaaa bbbb", 6)[0].endsWith(" ")).toBe(true)
	})

	it("handles the empty text and rejects a nonsense budget", () => {
		expect(chunkText("", 8)).toEqual([""])
		expect(() => chunkText("x", 0)).toThrow()
	})
})

describe("encodeChunked", () => {
	it("keeps a short message on a single line", () => {
		const reply = { type: "reply", id: "1", text: "hi" } as const
		expect(encodeChunked(reply)).toEqual([encodeLine(reply)])
	})

	it("splits a long text into ordered parts sharing the same id", () => {
		const text = "x".repeat(30)
		const lines = encodeChunked({ type: "reply", id: "42", text }, 10)
		expect(lines.length).toBe(3)
		const parts = lines.map((line) => JSON.parse(line))
		expect(parts.map((part) => part.part)).toEqual([0, 1, 2])
		expect(parts.every((part) => part.parts === 3 && part.id === "42" && part.type === "reply")).toBe(true)
		expect(parts.map((part) => part.text).join("")).toBe(text)
	})

	it("leaves messages that carry no text alone", () => {
		const status = { type: "status", state: "thinking" } as const
		expect(encodeChunked(status)).toEqual([encodeLine(status)])
		expect(encodeChunked({ type: "ack", id: "1" })).toEqual([encodeLine({ type: "ack", id: "1" })])
	})
})

describe("NdjsonLineDecoder", () => {
	it("reassembles a line split across fragments", () => {
		const decoder = new NdjsonLineDecoder()
		expect(decoder.push('{"type":"pi')).toEqual([])
		expect(decoder.push('ng","id":"1"}\n')).toEqual(['{"type":"ping","id":"1"}'])
	})

	it("returns every complete line of a batched fragment", () => {
		const decoder = new NdjsonLineDecoder()
		expect(decoder.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
	})

	it("skips blank lines and the trailing terminator", () => {
		const decoder = new NdjsonLineDecoder()
		expect(decoder.push('\n\n {"a":1}\n')).toEqual(['{"a":1}'])
	})

	it("drops an overlong line instead of buffering it", () => {
		const decoder = new NdjsonLineDecoder(8)
		expect(() => decoder.push("x".repeat(9))).toThrow()
	})
})

describe("ChunkAssembler", () => {
	const fragment = (part: number, parts: number, text: string, id = "1") => ({ id, part, parts, text })

	it("returns the text once the last part arrives", () => {
		const assembler = new ChunkAssembler()
		expect(assembler.add(fragment(0, 2, "abc"))).toBeUndefined()
		expect(assembler.add(fragment(1, 2, "def"))).toBe("abcdef")
		expect(assembler.pendingCount).toBe(0)
	})

	it("accepts parts in any order", () => {
		const assembler = new ChunkAssembler()
		expect(assembler.add(fragment(1, 3, "C"))).toBeUndefined()
		expect(assembler.add(fragment(2, 3, "D"))).toBeUndefined()
		expect(assembler.add(fragment(0, 3, "B"))).toBe("BCD")
	})

	it("keeps messages with different ids apart", () => {
		const assembler = new ChunkAssembler()
		expect(assembler.add(fragment(0, 2, "a", "one"))).toBeUndefined()
		expect(assembler.add(fragment(0, 2, "x", "two"))).toBeUndefined()
		expect(assembler.add(fragment(1, 2, "b", "one"))).toBe("ab")
		expect(assembler.add(fragment(1, 2, "y", "two"))).toBe("xy")
	})

	it("lets a retransmitted part overwrite without duplicating", () => {
		const assembler = new ChunkAssembler()
		assembler.add(fragment(0, 2, "abc"))
		assembler.add(fragment(0, 2, "abc"))
		expect(assembler.add(fragment(1, 2, "def"))).toBe("abcdef")
	})

	it("evicts a message that never completes", () => {
		const assembler = new ChunkAssembler(1000)
		assembler.add(fragment(0, 2, "abc"))
		expect(assembler.prune(Date.now() + 2000)).toBe(1)
		expect(assembler.pendingCount).toBe(0)
	})
})

// ---- message validation ----

describe("parseClientMessage", () => {
	it("accepts a well-formed prompt", () => {
		expect(parseClientMessage('{"type":"prompt","id":"1","text":"salut"}')).toEqual({
			ok: true,
			message: { type: "prompt", id: "1", text: "salut" },
		})
	})

	it("accepts a chunked prompt and keeps its metadata", () => {
		const result = parseClientMessage('{"type":"prompt","id":"1","text":"a","part":0,"parts":2}')
		expect(result.ok && isChunked(result.message)).toBe(true)
	})

	it("requires a token on the handshake", () => {
		expect(parseClientMessage(`{"type":"hello","protocol":"${PROTOCOL_VERSION}"}`)).toEqual({
			ok: false,
			reason: "missing_handshake_fields",
		})
	})

	it("rejects malformed lines with a reason instead of throwing", () => {
		expect(parseClientMessage("{")).toEqual({ ok: false, reason: "invalid_json" })
		expect(parseClientMessage("[]")).toEqual({ ok: false, reason: "not_an_object" })
		expect(parseClientMessage('{"type":"nope"}')).toEqual({ ok: false, reason: "unknown_type:nope" })
		expect(parseClientMessage('{"type":"prompt","id":"1","text":"a","part":2,"parts":2}')).toEqual({
			ok: false,
			reason: "invalid_chunk_fields",
		})
	})

	it("rejects a message missing its payload", () => {
		expect(parseClientMessage('{"type":"prompt","id":"1"}')).toEqual({ ok: false, reason: "missing_id_or_text" })
		expect(parseClientMessage('{"type":"answer","text":"x"}')).toEqual({ ok: false, reason: "missing_id_or_text" })
		expect(parseClientMessage('{"type":"ack"}')).toEqual({ ok: false, reason: "missing_id" })
	})
})

describe("parseServerMessage", () => {
	it("accepts the types the device expects", () => {
		expect(parseServerMessage('{"type":"status","state":"thinking"}').ok).toBe(true)
		expect(parseServerMessage('{"type":"question","id":"1","text":"q","options":["a"],"timeoutMs":5000}').ok).toBe(true)
	})

	it("rejects anything else", () => {
		expect(parseServerMessage('{"type":"hello"}')).toEqual({ ok: false, reason: "unknown_type:hello" })
		expect(parseServerMessage("nope")).toEqual({ ok: false, reason: "invalid_json" })
	})
})
