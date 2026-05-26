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

	pi.on("before_agent_start", (event: any, _ctx: any) => {
		lastSystemPrompt = event.systemPrompt ?? null
		if (server) {
			server.setSystemPrompt(lastSystemPrompt)
			server.broadcast({
				type: "system_prompt",
				prompt: event.systemPrompt,
				userPrompt: event.prompt
			})
		}
	})

	pi.on("session_start", (_event: any, ctx: any) => {
		if (server && ctx.sessionManager?.getSessionFile) {
			const sessionFile = ctx.sessionManager.getSessionFile()
			if (sessionFile) {
				server.watchSession(sessionFile)
			}
		}
	})
}
