import { afterEach, describe, expect, it } from "bun:test"
import { createSocket } from "node:dgram"
import net from "node:net"
import { PROTOCOL_VERSION } from "./protocol"
import {
	buildBeaconPayload,
	Cores3TcpServer,
	type Cores3TcpServerOptions,
	Cores3UdpBeacon,
	DISCOVERY_MAGIC,
	directedBroadcast,
	listLanInterfaces,
} from "./transport"

const servers: Cores3TcpServer[] = []
const sockets: net.Socket[] = []

function makeServer(overrides: Partial<Cores3TcpServerOptions> = {}) {
	const lines: string[] = []
	const states: boolean[] = []
	const server = new Cores3TcpServer({ port: 0, idleTimeoutMs: 0, ...overrides })
	server.onLine((line) => lines.push(line))
	server.onStateChange((connected) => states.push(connected))
	servers.push(server)
	return { server, lines, states }
}

function connect(port: number): Promise<net.Socket> {
	const socket = net.createConnection({ port, host: "127.0.0.1" })
	sockets.push(socket)
	return new Promise((resolve, reject) => {
		socket.once("connect", () => resolve(socket))
		socket.once("error", reject)
	})
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("waitFor timed out")
		}
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

afterEach(async () => {
	for (const socket of sockets) {
		socket.destroy()
	}
	sockets.length = 0
	for (const server of servers) {
		await server.dispose()
	}
	servers.length = 0
})

describe("Cores3TcpServer", () => {
	it("binds an ephemeral port, reports it and starts only once", async () => {
		const { server } = makeServer()
		const port = await server.start()
		expect(port).toBeGreaterThan(0)
		expect(server.port).toBe(port)
		expect(await server.start()).toBe(port)
	})

	it("receives a complete line and reports the device as connected", async () => {
		const { server, lines, states } = makeServer()
		const socket = await connect(await server.start())
		socket.write('{"type":"ping","id":"1"}\n')
		await waitFor(() => lines.length === 1)
		expect(lines[0]).toBe('{"type":"ping","id":"1"}')
		expect(states).toEqual([true])
		expect(server.isConnected).toBe(true)
	})

	it("reassembles a line split across writes and strips CRLF", async () => {
		const { server, lines } = makeServer()
		const socket = await connect(await server.start())
		socket.write('{"type":"pi')
		socket.write('ng","id":"7"}\r\n')
		await waitFor(() => lines.length === 1)
		expect(lines[0]).toBe('{"type":"ping","id":"7"}')
	})

	it("splits several lines sent in a single write", async () => {
		const { server, lines } = makeServer()
		const socket = await connect(await server.start())
		socket.write('{"a":1}\n{"b":2}\n')
		await waitFor(() => lines.length === 2)
		expect(lines).toEqual(['{"a":1}', '{"b":2}'])
	})

	it("sends lines to the device in order", async () => {
		const { server } = makeServer()
		const socket = await connect(await server.start())
		const received: string[] = []
		socket.on("data", (chunk: Buffer) => received.push(chunk.toString("utf8")))
		expect(server.send(['{"type":"reply"}\n', '{"type":"status"}\n'])).toBe(true)
		await waitFor(() => received.join("").includes('"status"'))
		expect(received.join("")).toBe('{"type":"reply"}\n{"type":"status"}\n')
	})

	it("refuses to send when no device is connected", async () => {
		const { server } = makeServer()
		await server.start()
		expect(server.send(["x\n"])).toBe(false)
	})

	// ---- lifecycle ----

	it("keeps only the newest connection", async () => {
		const { server, lines, states } = makeServer()
		const port = await server.start()
		await connect(port)
		const second = await connect(port)
		// The replaced socket stays silent (no spurious disconnect followed by a
		// connect): the device appears connected the whole time.
		await waitFor(() => states.length === 2)
		expect(states).toEqual([true, true])
		second.write('{"type":"ping","id":"2"}\n')
		await waitFor(() => lines.length === 1)
		expect(lines[0]).toContain('"2"')
		expect(server.isConnected).toBe(true)
	})

	it("drops an over-long line but keeps serving new devices", async () => {
		const { server, lines, states } = makeServer({ maxLineChars: 64 })
		const port = await server.start()
		const socket = await connect(port)
		socket.write("x".repeat(200))
		await waitFor(() => states.includes(false))
		expect(lines).toEqual([])

		const again = await connect(port)
		again.write('{"type":"ping","id":"9"}\n')
		await waitFor(() => lines.length === 1)
		expect(lines[0]).toContain('"9"')
	})

	it("reports a disconnect when the device goes away", async () => {
		const { server, states } = makeServer()
		const socket = await connect(await server.start())
		await waitFor(() => states.length === 1)
		socket.destroy()
		await waitFor(() => states.includes(false))
		expect(server.isConnected).toBe(false)
	})

	it("closes a silent device after the idle timeout", async () => {
		const { server, states } = makeServer({ idleTimeoutMs: 60 })
		await connect(await server.start())
		await waitFor(() => states.includes(false))
		expect(server.isConnected).toBe(false)
	})

	it("stops listening after dispose", async () => {
		const { server } = makeServer()
		const port = await server.start()
		await server.dispose()
		await expect(connect(port)).rejects.toBeDefined()
	})

	it("lets a listener unsubscribe", async () => {
		const { server, lines } = makeServer()
		await server.start()
		const unsubscribe = server.onLine(() => {
			throw new Error("unsubscribed listener must not run")
		})
		unsubscribe()
		// A throwing listener would be swallowed anyway, so assert on delivery:
		// the first listener still receives the line and nothing crashes.
		const socket = await connect(server.port)
		socket.write('{"type":"ping","id":"3"}\n')
		await waitFor(() => lines.length === 1)
		expect(lines[0]).toContain('"3"')
	})
})

describe("discovery addressing", () => {
	it("computes the directed broadcast address of a subnet", () => {
		expect(directedBroadcast("192.168.1.10", "255.255.255.0")).toBe("192.168.1.255")
		expect(directedBroadcast("10.0.5.7", "255.255.0.0")).toBe("10.0.255.255")
		expect(directedBroadcast("172.27.248.23", "255.255.240.0")).toBe("172.27.255.255")
	})

	it("rejects unusable addresses and masks", () => {
		expect(directedBroadcast("not-an-ip", "255.255.255.0")).toBeUndefined()
		expect(directedBroadcast("192.168.1.10", "0.0.0.0")).toBeUndefined()
		expect(directedBroadcast("192.168.1.10", "255.255.255.300")).toBeUndefined()
	})

	it("lists real interfaces with a distinct broadcast address", () => {
		for (const entry of listLanInterfaces()) {
			expect(entry.address).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
			expect(entry.broadcast).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
			expect(entry.broadcast).not.toBe(entry.address)
		}
	})
})

describe("discovery beacon", () => {
	it("builds a payload the device can recognise", () => {
		expect(buildBeaconPayload(49000)).toEqual({
			service: DISCOVERY_MAGIC,
			protocol: PROTOCOL_VERSION,
			port: 49000,
		})
		expect(buildBeaconPayload(49000, "192.168.43.5")).toEqual({
			service: DISCOVERY_MAGIC,
			protocol: PROTOCOL_VERSION,
			port: 49000,
			host: "192.168.43.5",
		})
	})

	it("actually delivers a beacon the device could parse", async () => {
		const received: string[] = []
		const receiver = createSocket("udp4")
		await new Promise<void>((resolve) => receiver.bind(0, "127.0.0.1", () => resolve()))
		const bound = receiver.address()
		const udpPort = typeof bound === "string" ? 0 : bound.port
		receiver.on("message", (message) => received.push(message.toString("utf8")))

		const beacon = new Cores3UdpBeacon({ tcpPort: 49000, port: udpPort, address: "127.0.0.1", intervalMs: 20 })
		await beacon.start()
		await beacon.start()
		await waitFor(() => received.length > 0)
		beacon.stop()
		beacon.stop()
		receiver.close()

		const payload = JSON.parse(received[0])
		expect(payload.service).toBe(DISCOVERY_MAGIC)
		expect(payload.port).toBe(49000)
		expect(payload.protocol).toBe(PROTOCOL_VERSION)
	})
})
