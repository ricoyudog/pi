import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ContinuationState, queueContinuation } from "./continuation-prompt.ts";
import { evaluateWithJudge } from "./goal-manager.ts";
import { latestStateFromSession, persist, type PiLocalGoalState } from "./goal-state.ts";

export default function piGoalHermes(pi: ExtensionAPI) {
	let goal: PiLocalGoalState | null = null;
	let lastAssistantContent = "";
	let lastAssistantStopReason: string | null = null;
	let lastAssistantErrorMessage: string | null = null;
	const continuationState: ContinuationState = { queued: false };

	pi.on("session_start", (event, ctx) => {
		goal = latestStateFromSession(ctx);
		if (!goal) return;

		if (event.reason === "reload" && goal.status === "active") {
			goal.status = "paused";
			goal.pausedReason = "reload";
			goal.updatedAt = Date.now();
			persist(pi, ctx, goal);
			ctx.ui.notify("Goal paused (session reload). Use /goal resume to continue.", "warning");
			return;
		}

		if (goal.status === "active") {
			ctx.ui.notify(`Goal restored: ${goal.goal}`, "info");
		} else if (goal.status === "paused") {
			ctx.ui.notify(`Goal paused: ${goal.pausedReason ?? "unknown reason"}. Use /goal resume.`, "info");
		}
	});

	pi.on("turn_end", (event, _ctx) => {
		if (!goal || goal.status !== "active") return;

		const msg = event.message;
		if (!msg || !("role" in msg) || msg.role !== "assistant") return;

		const textParts: string[] = [];
		for (const block of msg.content) {
			if (block.type === "text") {
				textParts.push(block.text);
			}
		}
		lastAssistantContent = textParts.join("\n");
		lastAssistantStopReason = msg.stopReason;
		lastAssistantErrorMessage = msg.errorMessage ?? null;
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!goal || goal.status !== "active") return;

		if (ctx.signal?.aborted) {
			goal.status = "paused";
			goal.pausedReason = "interrupted (Ctrl+C)";
			goal.updatedAt = Date.now();
			persist(pi, ctx, goal);
			ctx.ui.notify("Goal paused (interrupted).", "warning");
			return;
		}

		if (ctx.hasPendingMessages()) return;

		if (lastAssistantStopReason === "error" || lastAssistantStopReason === "aborted") {
			goal.status = "paused";
			goal.pausedReason = lastAssistantErrorMessage
				? `error: ${lastAssistantErrorMessage}`
				: `assistant response ${lastAssistantStopReason}`;
			goal.updatedAt = Date.now();
			persist(pi, ctx, goal);
			ctx.ui.notify(`Goal paused (${goal.pausedReason}).`, "warning");
			return;
		}

		if (!lastAssistantContent.trim()) return;

		const result = await evaluateWithJudge(pi, ctx, goal, lastAssistantContent);

		if (result.statusMessage) {
			ctx.ui.notify(result.statusMessage, "info");
		}

		if (result.shouldContinue) {
			queueContinuation(pi, ctx, goal, () => goal, continuationState);
		}
	});

	pi.registerCommand("goal", {
		description: "Manage Pi goal continuation state",
		handler: async (_args, ctx) => {
			const status = goal ? `Current goal status: ${goal.status}` : "Goal command is scaffolded.";
			ctx.ui.notify(status, "info");
		},
	});

	pi.registerCommand("subgoal", {
		description: "Manage Pi goal acceptance criteria",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Subgoal command is scaffolded.", "info");
		},
	});
}
