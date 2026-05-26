import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { watchFile, unwatchFile, readFileSync, existsSync, statSync } from "node:fs"
import { resolve } from "node:path"

export interface DashboardServerOptions {
	logPath: string
	port: number
	htmlPath: string
}

export interface DashboardServer {
	start(): void
	stop(): void
	readonly port: number
	readonly url: string
}

export function createDashboardServer(options: DashboardServerOptions): DashboardServer {
	const { logPath, port, htmlPath } = options
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

		if (req.url === "/entries") {
			res.writeHead(200, { "Content-Type": "application/json", ...cors })
			res.end(JSON.stringify(cachedEntries))
			return
		}

		if (req.url === "/" || req.url === "/index.html") {
			try {
				const html = readFileSync(htmlPath, "utf-8")
				res.writeHead(200, { "Content-Type": "text/html", ...cors })
				res.end(html)
			} catch {
				res.writeHead(500, cors)
				res.end("Dashboard HTML not found")
			}
			return
		}

		res.writeHead(404, cors)
		res.end("Not found")
	})

	cachedEntries = parseLogFile()
	lastSize = existsSync(logPath) ? statSync(logPath).size : 0

	return {
		port,
		get url() {
			return `http://localhost:${port}`
		},
		start() {
			watchFile(logPath, { interval: 500 }, checkUpdates)
			server.listen(port)
		},
		stop() {
			unwatchFile(logPath)
			for (const client of clients) client.end()
			clients.clear()
			server.close()
		},
	}
}
