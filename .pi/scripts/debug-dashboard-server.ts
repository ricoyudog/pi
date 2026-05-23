#!/usr/bin/env npx tsx
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { watchFile, unwatchFile, readFileSync, existsSync, statSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const args = process.argv.slice(2)
let logPath = resolve(process.env.HOME ?? "~", ".pi/agent/pi-debug.log")
let port = 9848

for (let i = 0; i < args.length; i++) {
	if (args[i] === "--log" && args[i + 1]) logPath = resolve(args[++i])
	else if (args[i] === "--port" && args[i + 1]) port = parseInt(args[++i], 10)
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const dashboardPath = resolve(scriptDir, "debug-dashboard.html")

const clients = new Set<ServerResponse>()
let lastSize = 0
let cachedEntries: object[] = []

function parseLogFile(): object[] {
	if (!existsSync(logPath)) return []
	const content = readFileSync(logPath, "utf-8")
	const entries: object[] = []
	for (const line of content.split("\n")) {
		if (!line.startsWith("{")) continue
		try {
			entries.push(JSON.parse(line))
		} catch {}
	}
	return entries
}

function broadcast(data: object) {
	const msg = `data: ${JSON.stringify(data)}\n\n`
	for (const client of clients) client.write(msg)
}

function checkUpdates() {
	if (!existsSync(logPath)) return
	const stat = statSync(logPath)
	if (stat.size === lastSize) return
	lastSize = stat.size

	const newEntries = parseLogFile()
	if (newEntries.length > cachedEntries.length) {
		const delta = newEntries.slice(cachedEntries.length)
		cachedEntries = newEntries
		broadcast({ type: "delta", entries: delta, total: cachedEntries.length })
	} else if (newEntries.length < cachedEntries.length) {
		cachedEntries = newEntries
		broadcast({ type: "reset", entries: cachedEntries, total: cachedEntries.length })
	}
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
	const cors = { "Access-Control-Allow-Origin": "*" }

	if (req.url === "/events") {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			...cors,
		})
		res.write(`data: ${JSON.stringify({ type: "reset", entries: cachedEntries, total: cachedEntries.length })}\n\n`)
		clients.add(res)
		req.on("close", () => clients.delete(res))
		return
	}

	if (req.url === "/" || req.url === "/index.html") {
		try {
			const html = readFileSync(dashboardPath, "utf-8")
			res.writeHead(200, { "Content-Type": "text/html", ...cors })
			res.end(html)
		} catch (e) {
			res.writeHead(500, cors)
			res.end("debug-dashboard.html not found")
		}
		return
	}

	res.writeHead(404, cors)
	res.end("Not found")
})

cachedEntries = parseLogFile()
lastSize = existsSync(logPath) ? statSync(logPath).size : 0

watchFile(logPath, { interval: 500 }, checkUpdates)

const shutdown = () => {
	unwatchFile(logPath)
	for (const client of clients) client.end()
	clients.clear()
	server.close()
	process.exit(0)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

server.listen(port, () => {
	console.log(`Debug dashboard: http://localhost:${port}`)
	console.log(`Watching: ${logPath}`)
	console.log(`Entries loaded: ${cachedEntries.length}`)
})
