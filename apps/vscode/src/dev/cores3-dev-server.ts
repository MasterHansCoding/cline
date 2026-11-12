#!/usr/bin/env bun
/**
 * Standalone harness for the Core S3 link.
 *
 * It runs the real TCP server, session and discovery beacon with a scripted
 * stand-in for the agent, so the DEVICE and the WIRE PROTOCOL can be validated
 * without building the extension, reloading VS Code or having a working model
 * provider. Precedent for such dev entry points: src/dev/local-cloud-server.ts
 * and src/dev/mcp-oauth-test-server/.
 *
 *   bun run src/dev/cores3-dev-server.ts [--port 48901] [--token cline-m5]
 *
 * Behaviour of the stand-in agent:
 *   - a prompt starting with "?" triggers a multiple-choice question, so the
 *     answer matching path can be exercised from the device keyboard;
 *   - any other prompt is "executed" (2 s) and answered with a reply, including
 *     a long one when the prompt contains "long" (chunking path);
 *   - "error" prompts return a retryable error.
 */

import { appendFileSync } from "node:fs"
import { Logger } from "@/shared/services/Logger"
import { Cores3Session } from "../services/cores3/session"
import { Cores3TcpServer, Cores3UdpBeacon, DEFAULT_DISCOVERY_PORT, findLanAddress } from "../services/cores3/transport"

function argValue(flag: string, fallback: string): string {
	const index = process.argv.indexOf(flag)
	const value = index === -1 ? undefined : process.argv[index + 1]
	return value ?? fallback
}

const port = Number.parseInt(argValue("--port", "48901"), 10)
const token = argValue("--token", "cline-m5")
const agentName = argValue("--agent", "cores3-dev")

Logger.subscribe((line) => console.log(line))

// Mirror everything to a file: bun buffers stdout when it is redirected, so a
// background run shows nothing until it exits, while the file is written
// synchronously and stays readable while the device connects.
const logFile = argValue("--log", "")
if (logFile) {
	const toConsole = console.log.bind(console)
	console.log = (...args: unknown[]) => {
		const line = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")
		toConsole(line)
		appendFileSync(logFile, `${line}\n`)
	}
}

const LONG_ANSWER = Array.from(
	{ length: 12 },
	(_, index) =>
		`Ligne ${index + 1} de la réponse longue : le protocole découpe le texte en fragments numérotés, ` +
		`le Core S3 les réassemble et les affiche à la suite.`,
).join("\n")

async function run(): Promise<void> {
	const transport = new Cores3TcpServer({ port })
	const created = new Cores3Session({
		transport,
		token,
		agentName,
		onPrompt: (prompt) => {
			void handlePrompt(created, prompt)
		},
		onFreeTextAnswer: (text) => {
			console.log(`\n[agent] réponse libre du Core S3 : ${JSON.stringify(text)}`)
		},
	})
	await created.start()

	created.onReadyChange((ready) => console.log(`\n[agent] ${ready ? "Core S3 PRÊT" : "Core S3 absent"}`))

	const boundPort = await transport.start()
	const beacon = new Cores3UdpBeacon({ tcpPort: boundPort })
	await beacon.start()

	console.log("-".repeat(72))
	console.log(`Serveur TCP   : 0.0.0.0:${boundPort}`)
	console.log(`IP du PC      : ${findLanAddress() ?? "hors ligne"}`)
	console.log(`Token attendu : ${token}`)
	console.log(`Découverte    : UDP broadcast sur le port ${DEFAULT_DISCOVERY_PORT} toutes les secondes`)
	console.log("Pense à autoriser cet exécutable sur le réseau PRIVÉ (pare-feu Windows).")
	console.log("-".repeat(72))

	const shutdown = async (): Promise<void> => {
		console.log("\n[dev] arrêt…")
		beacon.stop()
		await created.dispose()
		await transport.dispose()
		process.exit(0)
	}
	process.on("SIGINT", () => void shutdown())
	process.on("SIGTERM", () => void shutdown())
}

async function handlePrompt(session: Cores3Session, prompt: string): Promise<void> {
	console.log(`\n[agent] prompt reçu : ${JSON.stringify(prompt)}`)

	if (prompt.includes("error")) {
		session.setStatus("waiting")
		session.notifyError("Erreur simulée : le fournisseur ne répond pas.", true)
		return
	}

	session.setStatus("thinking")
	await new Promise((resolve) => setTimeout(resolve, 2000))

	if (prompt.startsWith("?")) {
		session.setStatus("waiting")
		const answer = await session.askQuestion(
			"Quelle approche veux-tu que je suive ?",
			["Refactor the parser", "Rewrite the tests"],
			{ timeoutMs: 120_000 },
		)
		session.setStatus("thinking")
		await new Promise((resolve) => setTimeout(resolve, 500))
		session.setStatus("idle")
		session.sendReply(
			answer === undefined
				? "Pas de réponse exploitable du Core S3 : la question reste ouverte dans l'IDE."
				: `Choix retenu : ${answer}`,
		)
		return
	}

	session.setStatus("idle")
	session.sendReply(prompt.includes("long") ? LONG_ANSWER : `Terminé. J'ai traité : « ${prompt} »`)
}

void run()
