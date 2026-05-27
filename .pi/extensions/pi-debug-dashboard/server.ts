import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export interface DashboardServerOptions {
	port: number
	htmlPath: string
}

export interface DashboardServer {
	start(): void
	stop(): void
	readonly port: number
	readonly url: string
	broadcast(data: object): void
	watchSession(filePath: string): void
	setSystemPrompt(prompt: string | null): void
	resetRuntimeBuffer(): void
}

interface SessionMeta {
	cwd: string;
	sessionId: string;
	sessionVersion: number;
	sessionTimestamp: string;
	sessionName?: string;
	firstMessage?: string;
	goalText?: string;
}

const metadataCache = new Map<string, { mtime: number; metadata: SessionMeta | null }>();

function peekSessionMeta(filePath: string): SessionMeta | null {
	try {
		const stat = statSync(filePath)
		const cached = metadataCache.get(filePath)
		if (cached && cached.mtime === stat.mtimeMs) return cached.metadata

		const fd = readFileSync(filePath, { encoding: "utf-8", flag: "r" })
		const chunk = fd.slice(0, 4096)
		const lines = chunk.split("\n").slice(0, 20)

		let meta: Partial<SessionMeta> = {}
		for (const line of lines) {
			if (!line.startsWith("{")) continue
			try {
				const obj = JSON.parse(line) as Record<string, unknown>
				if (obj.type === "session") {
					meta.cwd = obj.cwd as string
					meta.sessionId = obj.id as string
					meta.sessionVersion = obj.version as number
					meta.sessionTimestamp = obj.timestamp as string
				} else if (obj.type === "message" && !meta.firstMessage) {
					const msg = obj.message as Record<string, unknown> | undefined
					if (msg?.role === "user") {
						const content = msg.content as Array<Record<string, unknown>> | string | undefined
						if (Array.isArray(content)) {
							const textBlock = content.find((b) => b.type === "text")
							meta.firstMessage = textBlock ? String(textBlock.text).slice(0, 80) : undefined
						} else if (typeof content === "string") {
							meta.firstMessage = content.slice(0, 80)
						}
					}
				} else if (obj.customType === "pi-goal-hermes:event") {
					const details = obj.details as Record<string, unknown> | undefined
					if (details?.eventType === "goal-set" && details?.goal) {
						meta.goalText = String(details.goal)
					}
				} else if (obj.type === "session_info" && obj.name) {
					meta.sessionName = obj.name as string
				}
			} catch {}
		}

		const result = meta.sessionId ? (meta as SessionMeta) : null
		metadataCache.set(filePath, { mtime: stat.mtimeMs, metadata: result })
		return result
	} catch {
		return null
	}
}

export function createDashboardServer(options: DashboardServerOptions): DashboardServer {
	const { port, htmlPath } = options
	let storedSystemPrompt: string | null = null
	const clients = new Set<ServerResponse>()
	const MAX_RUNTIME_EVENTS = 500
	const runtimeBuffer: object[] = []
	const sessionsDir = join(homedir(), ".pi/agent/sessions")

	function pushRuntimeEvent(event: object): void {
		runtimeBuffer.push(event)
		while (runtimeBuffer.length > MAX_RUNTIME_EVENTS) runtimeBuffer.shift()
		const msg = `data: ${JSON.stringify(event)}\n\n`
		for (const client of clients) client.write(msg)
	}

	function getSessionDirs(): string[] {
		if (!existsSync(sessionsDir)) return []
		return readdirSync(sessionsDir).filter((d) => {
			const full = join(sessionsDir, d)
			try { return statSync(full).isDirectory() } catch { return false }
		})
	}

	function getSessionFiles(cwdDir: string) {
		const dir = join(sessionsDir, cwdDir)
		if (!existsSync(dir)) return []
		return readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => {
				const full = join(dir, f)
				const stat = statSync(full)
				const parts = f.replace(".jsonl", "").split("_")
				const meta = peekSessionMeta(full)
				return {
					file: full,
					timestamp: parts[0] || f,
					id: parts.slice(1).join("_") || f,
					size: stat.size,
					mtime: stat.mtimeMs,
					...(meta ?? {}),
				}
			})
			.sort((a, b) => b.mtime - a.mtime)
	}

	function parseSessionEntries(filePath: string): object[] {
		if (!existsSync(filePath)) return []
		const content = readFileSync(filePath, "utf-8")
		const entries: object[] = []
		for (const line of content.split("\n")) {
			if (!line.startsWith("{")) continue
			try {
				const obj = JSON.parse(line) as Record<string, unknown>
				if (obj.type === "message" && obj.message) {
					const msg = obj.message as Record<string, unknown>
					entries.push({ ...msg, timestamp: msg.timestamp ?? obj.timestamp })
				} else if (obj.type === "custom_message") {
					entries.push({
						role: "custom",
						customType: obj.customType,
						content: obj.content,
						details: obj.details,
						timestamp: obj.timestamp,
					})
				} else if (obj.type === "custom" && obj.customType) {
					entries.push({
						role: "custom",
						customType: obj.customType,
						details: obj.data,
						timestamp: obj.timestamp,
					})
				}
			} catch {}
		}
		return entries
	}

	function getLatestSessionFile(): string | null {
		const dirs = getSessionDirs()
		let latest: { file: string; mtime: number } | null = null
		for (const d of dirs) {
			const files = getSessionFiles(d)
			if (files.length > 0 && (!latest || files[0].mtime > latest.mtime)) {
				latest = { file: files[0].file, mtime: files[0].mtime }
			}
		}
		return latest?.file ?? null
	}

	function broadcast(data: object) {
		const dataAny = data as any
		if (dataAny.type && typeof dataAny.type === "string" && dataAny.type.startsWith("runtime:")) {
			pushRuntimeEvent(data)
			return
		}
		const msg = `data: ${JSON.stringify(data)}\n\n`
		for (const client of clients) client.write(msg)
	}

	let watchTimer: ReturnType<typeof setTimeout> | null = null
	let watchedFile: string | null = null
	let cachedEntries: object[] = []
	let lastSize = 0
	let autoFollow = true
	let autoFollowTimer: ReturnType<typeof setInterval> | null = null

	function watchSession(filePath: string) {
		watchedFile = filePath
		lastSize = 0
		cachedEntries = parseSessionEntries(filePath)
		if (existsSync(filePath)) {
			lastSize = statSync(filePath).size
		}
		broadcast({ type: "reset", entries: cachedEntries, total: cachedEntries.length })

		if (watchTimer) clearInterval(watchTimer)
		watchTimer = setInterval(() => {
			if (!watchedFile || !existsSync(watchedFile)) return
			const stat = statSync(watchedFile)
			if (stat.size === lastSize) return
			lastSize = stat.size
			const newEntries = parseSessionEntries(watchedFile)
			if (newEntries.length > cachedEntries.length) {
				const delta = newEntries.slice(cachedEntries.length)
				cachedEntries = newEntries
				broadcast({ type: "delta", entries: delta, total: cachedEntries.length })
			} else if (newEntries.length < cachedEntries.length) {
				cachedEntries = newEntries
				broadcast({ type: "reset", entries: cachedEntries, total: cachedEntries.length })
			}
		}, 500)
	}

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const cors = { "Access-Control-Allow-Origin": "*" }
		const url = new URL(req.url ?? "/", `http://localhost:${port}`)

		if (url.pathname === "/events") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				...cors,
			})
			res.write(`data: ${JSON.stringify({ type: "reset", entries: cachedEntries, total: cachedEntries.length, systemPrompt: storedSystemPrompt, runtimeEvents: runtimeBuffer })}\n\n`)
			clients.add(res)
			req.on("close", () => clients.delete(res))
			return
		}

		if (url.pathname === "/sessions") {
			const dirs = getSessionDirs()
			const result = dirs.map((d) => {
				const files = getSessionFiles(d)
				const latestMeta = files[0] ? peekSessionMeta(files[0].file) : null
				return {
					dir: d,
					cwd: d,
					displayName: d,
					sessionCount: files.length,
					latestFile: files[0]?.file ?? null,
					latestTimestamp: files[0]?.timestamp ?? null,
					latestMtime: files[0]?.mtime ?? null,
					...(latestMeta ?? {}),
				}
			}).sort((a, b) => (b.latestMtime ?? 0) - (a.latestMtime ?? 0))
			res.writeHead(200, { "Content-Type": "application/json", ...cors })
			res.end(JSON.stringify(result))
			return
		}

		if (url.pathname === "/session-files") {
			const cwdDir = url.searchParams.get("cwd") ?? ""
			if (!cwdDir) {
				res.writeHead(400, cors)
				res.end("Missing cwd parameter")
				return
			}
			const files = getSessionFiles(cwdDir)
			res.writeHead(200, { "Content-Type": "application/json", ...cors })
			res.end(JSON.stringify(files))
			return
		}

		if (url.pathname === "/load-session") {
			const filePath = url.searchParams.get("file") ?? ""
			if (!filePath || !filePath.endsWith(".jsonl")) {
				res.writeHead(400, cors)
				res.end("Invalid session file")
				return
			}
			// Security: only allow reading from sessions dir
			if (!filePath.startsWith(sessionsDir)) {
				res.writeHead(403, cors)
				res.end("Access denied")
				return
			}
			autoFollow = false
			watchSession(filePath)
			res.writeHead(200, { "Content-Type": "application/json", ...cors })
			res.end(JSON.stringify({ ok: true, entries: cachedEntries.length }))
			return
		}

		if (url.pathname === "/entries") {
			res.writeHead(200, { "Content-Type": "application/json", ...cors })
			res.end(JSON.stringify(cachedEntries))
			return
		}

		if (url.pathname === "/runtime-events") {
			res.writeHead(200, { "Content-Type": "application/json", ...cors })
			res.end(JSON.stringify(runtimeBuffer))
			return
		}

		if (url.pathname === "/" || url.pathname === "/index.html") {
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

		if (req.method === "POST" && url.pathname === "/auto-follow") {
			let body = ""
			req.on("data", (chunk) => { body += chunk })
			req.on("end", () => {
				try {
					const parsed = JSON.parse(body) as { enabled: boolean }
					autoFollow = Boolean(parsed.enabled)
				} catch {}
				res.writeHead(200, { "Content-Type": "application/json", ...cors })
				res.end(JSON.stringify({ autoFollow }))
			})
			return
		}

		res.writeHead(404, cors)
		res.end("Not found")
	})


	const latest = getLatestSessionFile()
	if (latest) {
		cachedEntries = parseSessionEntries(latest)
		lastSize = existsSync(latest) ? statSync(latest).size : 0
		watchedFile = latest
	}

	return {
		port,
		get url() {
			return `http://localhost:${port}`
		},
		broadcast,
		watchSession,
		setSystemPrompt(prompt: string | null) {
			storedSystemPrompt = prompt
		},
		resetRuntimeBuffer() {
			runtimeBuffer.length = 0
		},
		start() {
			if (watchedFile) {
				watchTimer = setInterval(() => {
					if (!watchedFile || !existsSync(watchedFile)) return
					const stat = statSync(watchedFile)
					if (stat.size === lastSize) return
					lastSize = stat.size
					const newEntries = parseSessionEntries(watchedFile)
					if (newEntries.length > cachedEntries.length) {
						const delta = newEntries.slice(cachedEntries.length)
						cachedEntries = newEntries
						broadcast({ type: "delta", entries: delta, total: cachedEntries.length })
					} else if (newEntries.length < cachedEntries.length) {
						cachedEntries = newEntries
						broadcast({ type: "reset", entries: cachedEntries, total: cachedEntries.length })
					}
				}, 500)
			}
			server.listen(port)
			autoFollowTimer = setInterval(() => {
				if (!autoFollow) return
				const latestFile = getLatestSessionFile()
				if (latestFile && latestFile !== watchedFile) {
					watchSession(latestFile)
					broadcast({ type: "session_switch", file: latestFile, metadata: peekSessionMeta(latestFile) })
				}
			}, 2000)
		},
		stop() {
			if (watchTimer) clearInterval(watchTimer)
			if (autoFollowTimer) clearInterval(autoFollowTimer)
			for (const client of clients) client.end()
			clients.clear()
			server.close()
		},
	}
}
