/**
 * TCP transport between the Cline extension and the M5Stack Core S3.
 *
 * Decisions, driven by the device and the network it lives on:
 *
 * - The device is the CLIENT and the extension is the SERVER. The Core S3 only
 *   needs WiFiClient (zero extra Arduino library) and never has to listen.
 * - NDJSON over a raw socket, not WebSocket: the framing already lives in
 *   ./protocol, there is no proxy or browser in the path, and `node:net` is
 *   built into Node while `ws` would be a new runtime dependency.
 * - The socket binds 0.0.0.0 (not loopback) because the device is on the LAN.
 *   Windows Firewall therefore prompts once: allow the port on the PRIVATE
 *   profile. The handshake token is what keeps that port from being a remote
 *   control for anyone else on the same hotspot.
 * - UDP discovery is outbound-only from the PC (broadcast to 255.255.255.255),
 *   so no inbound UDP rule is needed and the device never hard-codes the PC's
 *   address, which changes between sessions on a phone hotspot.
 * - "Last connection wins": a device reconnecting after a WiFi blip must not be
 *   blocked by a socket the OS has not torn down yet.
 */

import { createSocket, type Socket as DgramSocket } from "node:dgram"
import { createServer, type Server, type Socket } from "node:net"
import { networkInterfaces } from "node:os"
import { Logger } from "@/shared/services/Logger"
import { NdjsonLineDecoder, PROTOCOL_VERSION } from "./protocol"

/** A silent device is assumed gone after this long (keeps one live socket). */
export const DEFAULT_IDLE_TIMEOUT_MS = 90_000

/** Fixed UDP port the discovery beacon is broadcast to. */
export const DEFAULT_DISCOVERY_PORT = 48910

/** Marker in the beacon payload so the device can ignore foreign broadcasts. */
export const DISCOVERY_MAGIC = "cline-cores3"

/**
 * The socket-facing half of the link. Keeping it behind an interface lets the
 * session layer be tested against an in-memory fake, and lets a different radio
 * be swapped in later without touching the agent wiring.
 */
export interface Cores3Transport {
	readonly isConnected: boolean
	/** Called for every complete inbound line. Returns an unsubscribe function. */
	onLine(listener: (line: string) => void): () => void
	/** Called when a device connects or disconnects. Returns an unsubscribe. */
	onStateChange(listener: (connected: boolean) => void): () => void
	/** Write complete lines (terminators included). False when nothing is connected. */
	send(lines: readonly string[]): boolean
	dispose(): Promise<void>
}

export interface Cores3TcpServerOptions {
	/** TCP port to bind. 0 binds an ephemeral port (tests). */
	port: number
	/** Interface to bind. Default 0.0.0.0 so the LAN can reach the extension. */
	host?: string
	/** 0 disables the idle reaper. */
	idleTimeoutMs?: number
	/** Cap on a single inbound line, to bound memory on a bad peer. */
	maxLineChars?: number
}

export class Cores3TcpServer implements Cores3Transport {
	private server: Server | undefined
	private client: Socket | undefined
	private decoder = new NdjsonLineDecoder()
	private idleTimer: ReturnType<typeof setTimeout> | undefined
	private readonly lineListeners = new Set<(line: string) => void>()
	private readonly stateListeners = new Set<(connected: boolean) => void>()
	private boundPort = 0

	constructor(private readonly options: Cores3TcpServerOptions) {}

	get isConnected(): boolean {
		return this.client !== undefined && !this.client.destroyed
	}

	/** The port actually bound, known after start() (relevant when port was 0). */
	get port(): number {
		return this.boundPort
	}

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

	/** Bind and listen, resolving with the bound port. Idempotent. */
	async start(): Promise<number> {
		if (this.server) {
			return this.boundPort
		}

		const host = this.options.host ?? "0.0.0.0"
		const server = createServer((socket) => this.handleConnection(socket))
		this.server = server

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen({ port: this.options.port, host }, () => {
				server.off("error", reject)
				resolve()
			})
		})

		// A post-listen error (accept failure, EMFILE) must not kill the host
		// process: the agent simply keeps working without a device.
		server.on("error", (error) => Logger.error("[Cores3] TCP server error:", error))

		const address = server.address()
		this.boundPort = typeof address === "object" && address ? address.port : this.options.port
		Logger.log(`[Cores3] listening for the device on ${host}:${this.boundPort}`)
		return this.boundPort
	}

	// ---- connection handling ----

	send(lines: readonly string[]): boolean {
		const socket = this.client
		if (!socket || socket.destroyed || !socket.writable) {
			return false
		}
		for (const line of lines) {
			socket.write(line)
		}
		return true
	}

	async dispose(): Promise<void> {
		this.closeClient("transport disposed", true)
		const server = this.server
		this.server = undefined
		this.lineListeners.clear()
		this.stateListeners.clear()
		if (!server) {
			return
		}
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}

	private handleConnection(socket: Socket): void {
		// Replace, never refuse: see "last connection wins" in the module header.
		this.closeClient("replaced by a new connection", true)

		this.client = socket
		this.decoder = new NdjsonLineDecoder(this.options.maxLineChars)
		socket.setNoDelay(true)
		socket.setKeepAlive(true, 5000)
		Logger.log(`[Cores3] device connected from ${socket.remoteAddress ?? "unknown"}`)
		this.emitState(true)
		this.armIdleTimer()

		socket.on("data", (chunk: Buffer) => this.handleData(socket, chunk))
		socket.on("close", () => {
			// The guard matters: a REPLACED socket closing later must not report
			// the current device as gone.
			if (this.client !== socket) {
				return
			}
			this.client = undefined
			this.clearIdleTimer()
			Logger.log("[Cores3] device disconnected")
			this.emitState(false)
		})
		socket.on("error", (error) => {
			Logger.warn(`[Cores3] socket error: ${error.message}`)
			socket.destroy()
		})
	}

	private handleData(socket: Socket, chunk: Buffer): void {
		if (this.client !== socket) {
			return
		}
		this.armIdleTimer()

		let lines: string[]
		try {
			// Arduino's println() sends CRLF; the decoder trims each line, so the
			// "\r" never reaches the JSON parser.
			lines = this.decoder.push(chunk.toString("utf8"))
		} catch (error) {
			// Over the line cap: not our device, or a bug. Drop this connection
			// but keep listening for a reconnect instead of taking down the host.
			Logger.warn(`[Cores3] dropping connection: ${error instanceof Error ? error.message : String(error)}`)
			this.closeClient("malformed frame")
			return
		}

		for (const line of lines) {
			for (const listener of this.lineListeners) {
				try {
					listener(line)
				} catch (error) {
					Logger.error("[Cores3] line listener failed:", error)
				}
			}
		}
	}

	/**
	 * Tear down the current connection. `silent` skips the disconnect event for
	 * the replacement case, where the very next statement reports the new device.
	 */
	private closeClient(reason: string, silent = false): void {
		const socket = this.client
		this.client = undefined
		this.clearIdleTimer()
		if (socket && !socket.destroyed) {
			Logger.log(`[Cores3] closing device connection: ${reason}`)
			socket.destroy()
		}
		if (socket && !silent) {
			this.emitState(false)
		}
	}

	private armIdleTimer(): void {
		this.clearIdleTimer()
		const timeout = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
		if (timeout <= 0) {
			return
		}
		this.idleTimer = setTimeout(() => this.closeClient("idle timeout"), timeout)
	}

	private clearIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer)
			this.idleTimer = undefined
		}
	}

	private emitState(connected: boolean): void {
		for (const listener of this.stateListeners) {
			try {
				listener(connected)
			} catch (error) {
				Logger.error("[Cores3] state listener failed:", error)
			}
		}
	}
}

// ---- discovery ----

export interface Cores3BeaconPayload {
	/** Fixed marker so a foreign broadcast can be ignored. */
	service: string
	protocol: string
	/** TCP port the extension is listening on. */
	port: number
	/** Best-effort LAN address, for display/logging on the device. */
	host?: string
}

/** Beacon body; the device learns the PC's address from the datagram sender. */
export function buildBeaconPayload(tcpPort: number, host?: string): Cores3BeaconPayload {
	return {
		service: DISCOVERY_MAGIC,
		protocol: PROTOCOL_VERSION,
		port: tcpPort,
		...(host ? { host } : {}),
	}
}

/** First non-internal IPv4 address, or undefined when the PC is offline. */
export function findLanAddress(): string | undefined {
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal) {
				return address.address
			}
		}
	}
	return undefined
}

function toIPv4Number(value: string): number | undefined {
	const parts = value.split(".")
	if (parts.length !== 4) {
		return undefined
	}
	let result = 0
	for (const part of parts) {
		const byte = Number.parseInt(part, 10)
		if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
			return undefined
		}
		result = (result << 8) | byte
	}
	return result >>> 0
}

function fromIPv4Number(value: number): string {
	return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".")
}

/**
 * Directed broadcast address of an IPv4 interface ("192.168.1.255" for
 * 192.168.1.10/255.255.255.0), or undefined for an unusable pair.
 */
export function directedBroadcast(address: string, netmask: string): string | undefined {
	const ip = toIPv4Number(address)
	const mask = toIPv4Number(netmask)
	if (ip === undefined || mask === undefined || mask === 0) {
		return undefined
	}
	return fromIPv4Number((ip | (~mask >>> 0)) >>> 0)
}

/**
 * Every usable LAN interface with its directed broadcast address.
 *
 * A limited broadcast (255.255.255.255) leaves by the default route, which on a
 * machine with Hyper-V/WSL/Docker/VMware adapters is often NOT the interface the
 * device is on. Sending a directed broadcast from a socket bound to each address
 * puts the beacon on every real network.
 */
export function listLanInterfaces(): { address: string; broadcast: string }[] {
	const found: { address: string; broadcast: string }[] = []
	for (const addresses of Object.values(networkInterfaces())) {
		for (const entry of addresses ?? []) {
			if (entry.family !== "IPv4" || entry.internal) {
				continue
			}
			const broadcast = directedBroadcast(entry.address, entry.netmask)
			if (broadcast) {
				found.push({ address: entry.address, broadcast })
			}
		}
	}
	return found
}

export interface Cores3UdpBeaconOptions {
	/** TCP port advertised in the beacon. */
	tcpPort: number
	/** UDP port to broadcast to. Defaults to DEFAULT_DISCOVERY_PORT. */
	port?: number
	/** Broadcast period in ms. Defaults to 1000. */
	intervalMs?: number
	/** Destination address. Defaults to the limited broadcast address. */
	address?: string
}

/**
 * Periodic UDP broadcast telling the device where the extension listens, so the
 * device never hard-codes an address (a phone hotspot hands out a new one every
 * session). Outbound only, so no inbound firewall rule is involved.
 */
export class Cores3UdpBeacon {
	private readonly sockets: { socket: DgramSocket; destination: string }[] = []
	private timer: ReturnType<typeof setInterval> | undefined

	constructor(private readonly options: Cores3UdpBeaconOptions) {}

	async start(): Promise<void> {
		if (this.sockets.length > 0) {
			return
		}

		// One socket per interface, bound to its address, so the beacon leaves by
		// the interface the device is actually on.
		const targets = this.options.address
			? [{ bindTo: "0.0.0.0", destination: this.options.address }]
			: listLanInterfaces().map((entry) => ({ bindTo: entry.address, destination: entry.broadcast }))
		if (targets.length === 0) {
			Logger.warn("[Cores3] no usable LAN interface: discovery is disabled")
			return
		}

		for (const target of targets) {
			try {
				const socket = await this.openSocket(target.bindTo)
				this.sockets.push({ socket, destination: target.destination })
				Logger.log(`[Cores3] beacon on ${target.bindTo} -> ${target.destination}`)
			} catch (error) {
				Logger.warn(`[Cores3] discovery unavailable on ${target.bindTo}: ${String(error)}`)
			}
		}
		if (this.sockets.length === 0) {
			return
		}

		this.broadcast()
		this.timer = setInterval(() => this.broadcast(), this.options.intervalMs ?? 1000)
	}

	private openSocket(bindTo: string): Promise<DgramSocket> {
		const socket = createSocket("udp4")
		socket.on("error", (error) => Logger.warn(`[Cores3] discovery beacon error: ${error.message}`))
		return new Promise<DgramSocket>((resolve, reject) => {
			socket.once("error", reject)
			socket.bind({ port: 0, address: bindTo, exclusive: false }, () => {
				socket.off("error", reject)
				socket.setBroadcast(true)
				resolve(socket)
			})
		})
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = undefined
		}
		for (const entry of this.sockets) {
			try {
				entry.socket.close()
			} catch (error) {
				Logger.debug(`[Cores3] discovery beacon close failed: ${String(error)}`)
			}
		}
		this.sockets.length = 0
	}

	/** Send one beacon now (also used by tests and a manual "find device"). */
	broadcast(): void {
		if (this.sockets.length === 0) {
			return
		}
		const payload = Buffer.from(JSON.stringify(buildBeaconPayload(this.options.tcpPort, findLanAddress())), "utf8")
		const port = this.options.port ?? DEFAULT_DISCOVERY_PORT
		for (const entry of this.sockets) {
			entry.socket.send(payload, port, entry.destination, (error) => {
				if (error) {
					Logger.debug(`[Cores3] discovery to ${entry.destination} failed: ${error.message}`)
				}
			})
		}
	}
}
