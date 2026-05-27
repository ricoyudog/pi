import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createDashboardServer, type DashboardServer } from "./server.ts"

const DEFAULT_PORT = 9848

export default function piDebugDashboard(pi: ExtensionAPI) {
	let server: DashboardServer | null = null

	const scriptDir = dirname(fileURLToPath(import.meta.url))
	const htmlPath = resolve(scriptDir, "dashboard.html")

	pi.registerCommand("dashboard", {
		description: "Start/stop the debug dashboard server (/dashboard [start|stop|status])",
		getArgumentCompletions(argumentPrefix: string) {
			return ["start", "stop", "status"]
				.filter((cmd) => cmd.startsWith(argumentPrefix))
				.map((cmd) => ({ value: cmd, label: cmd }))
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim()

			if (!trimmed || trimmed === "start") {
				if (server) {
					ctx.ui.notify(`Dashboard already running at ${server.url}`, "info")
					return
				}
				server = createDashboardServer({ port: DEFAULT_PORT, htmlPath })
				server.start()
				ctx.ui.notify(`Debug dashboard started: ${server.url}`, "info")
				ctx.ui.setStatus("pi-debug-dashboard", `Dashboard: ${server.url}`)
				return
			}

			if (trimmed === "stop") {
				if (!server) {
					ctx.ui.notify("Dashboard is not running.", "warning")
					return
				}
				server.stop()
				server = null
				ctx.ui.setStatus("pi-debug-dashboard", undefined)
				ctx.ui.notify("Debug dashboard stopped.", "info")
				return
			}

			if (trimmed === "status") {
				if (server) {
					ctx.ui.notify(`Dashboard running at ${server.url}`, "info")
				} else {
					ctx.ui.notify("Dashboard is not running. Use /dashboard start.", "info")
				}
				return
			}

			ctx.ui.notify("Usage: /dashboard [start|stop|status]", "warning")
		},
	})

	let lastSystemPrompt: string | null = null
	const toolTiming = new Map<string, { toolName: string; startedAt: number; turnIndex: number }>()
	let currentTurnIndex = 0

	pi.on("before_agent_start", (event: any, _ctx: any) => {
		lastSystemPrompt = event.systemPrompt ?? null
		if (server) {
			server.setSystemPrompt(lastSystemPrompt)
			server.broadcast({
				type: "system_prompt",
				prompt: event.systemPrompt,
				userPrompt: event.prompt
			})
			const opts = event.systemPromptOptions
			server.broadcast({
				type: "runtime:init",
				model: event.prompt ? String(event.prompt).slice(0, 50) : undefined,
				timestamp: Date.now(),
				selectedTools: opts?.selectedTools || [],
				skills: opts?.skills?.map((s: any) => s.name) || [],
				contextFiles: opts?.contextFiles?.map((f: any) => f.path) || [],
				systemPromptLength: (event.systemPrompt || "").length,
			})
		}
	})

	pi.on("session_start", (_event: any, ctx: any) => {
		if (server) {
			server.resetRuntimeBuffer()
			if (ctx.sessionManager?.getSessionFile) {
				const sessionFile = ctx.sessionManager.getSessionFile()
				if (sessionFile) {
					server.watchSession(sessionFile)
				}
			}
		}
	})

	pi.on("turn_start", (event: any, _ctx: any) => {
		currentTurnIndex = event.turnIndex
		if (server) {
			server.broadcast({
				type: "runtime:turn_start",
				turnIndex: event.turnIndex,
				timestamp: event.timestamp,
			})
		}
	})

	pi.on("turn_end", (event: any, ctx: any) => {
		const usage = ctx.getContextUsage ? ctx.getContextUsage() : undefined
		if (server) {
			server.broadcast({
				type: "runtime:turn_end",
				turnIndex: event.turnIndex,
				timestamp: Date.now(),
				tokens: usage?.tokens ?? null,
				contextWindow: usage?.contextWindow ?? 0,
				percent: usage?.percent ?? null,
				stopReason: event.message?.stopReason ?? null,
			})
			// Flush orphaned in-flight tools
			for (const [toolCallId, info] of toolTiming) {
				if (info.turnIndex === event.turnIndex) {
					server.broadcast({
						type: "runtime:tool_end",
						toolCallId,
						toolName: info.toolName,
						durationMs: null,
						isError: true,
						error: "timed_out",
						turnIndex: event.turnIndex,
						timestamp: Date.now(),
					})
					toolTiming.delete(toolCallId)
				}
			}
		}
	})

	pi.on("tool_execution_start", (event: any, _ctx: any) => {
		toolTiming.set(event.toolCallId, {
			toolName: event.toolName,
			startedAt: Date.now(),
			turnIndex: currentTurnIndex,
		})
		if (server) {
			server.broadcast({
				type: "runtime:tool_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				turnIndex: currentTurnIndex,
				timestamp: Date.now(),
			})
		}
	})

	pi.on("tool_execution_end", (event: any, _ctx: any) => {
		const info = toolTiming.get(event.toolCallId)
		const durationMs = info ? Date.now() - info.startedAt : null
		toolTiming.delete(event.toolCallId)
		if (server) {
			server.broadcast({
				type: "runtime:tool_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				durationMs,
				isError: event.isError,
				turnIndex: currentTurnIndex,
				timestamp: Date.now(),
			})
		}
	})

	pi.on("session_compact", (event: any, _ctx: any) => {
		if (server) {
			server.broadcast({
				type: "runtime:compaction",
				timestamp: Date.now(),
				tokensBefore: event.compactionEntry?.tokensBefore ?? 0,
				summaryLength: event.compactionEntry?.summary?.length ?? 0,
			})
		}
	})
}
