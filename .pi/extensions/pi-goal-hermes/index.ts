import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ContinuationState, queueContinuation } from "./continuation-prompt.ts";
import { continuationRenderer, emitGoalEvent, goalEventRenderer } from "./event-renderer.ts";
import { evaluateWithJudge } from "./goal-manager.ts";
import { createPiLocalGoalState, latestStateFromSession, persist, type PiLocalGoalState } from "./goal-state.ts";

const GOAL_SUBCOMMANDS = ["status", "pause", "stop", "resume", "done", "clear"];
const SUBGOAL_SUBCOMMANDS = ["list", "remove", "clear"];

export default function piGoalHermes(pi: ExtensionAPI) {
	let goal: PiLocalGoalState | null = null;
	let lastAssistantContent = "";
	let lastAssistantStopReason: string | null = null;
	let lastAssistantErrorMessage: string | null = null;
	const continuationState: ContinuationState = { queued: false };

	pi.registerMessageRenderer("pi-goal-hermes:event", goalEventRenderer);
	pi.registerMessageRenderer("pi-goal-hermes:continuation", continuationRenderer);

	function updateFooterStatus(ctx: ExtensionContext): void {
		if (!goal || goal.status === "cleared") {
			ctx.ui.setStatus("pi-goal-hermes", undefined);
			return;
		}
		const theme = ctx.ui.theme;
		switch (goal.status) {
			case "active":
				ctx.ui.setStatus("pi-goal-hermes", theme.fg("accent", "●") + theme.fg("dim", " Pursuing goal"));
				break;
			case "paused":
				ctx.ui.setStatus("pi-goal-hermes", theme.fg("warning", "⏸") + theme.fg("dim", " Goal paused"));
				break;
			case "done":
				ctx.ui.setStatus("pi-goal-hermes", theme.fg("success", "✓") + theme.fg("dim", " Goal achieved"));
				break;
		}
	}

	pi.on("session_start", (event, ctx) => {
		goal = latestStateFromSession(ctx);
		if (!goal) return;

		if (event.reason === "reload" && goal.status === "active") {
			goal.status = "paused";
			goal.pausedReason = "reload";
			goal.updatedAt = Date.now();
			persist(pi, ctx, goal);
			ctx.ui.notify("Goal paused (session reload). Use /goal resume to continue.", "warning");
			updateFooterStatus(ctx);
			return;
		}

		if (goal.status === "active") {
			ctx.ui.notify(`Goal restored: ${goal.goal}`, "info");
		} else if (goal.status === "paused") {
			ctx.ui.notify(`Goal paused: ${goal.pausedReason ?? "unknown reason"}. Use /goal resume.`, "info");
		}
		updateFooterStatus(ctx);
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
			emitGoalEvent(pi, "goal-paused", goal);
			ctx.ui.notify("Goal paused (interrupted).", "warning");
			updateFooterStatus(ctx);
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
			emitGoalEvent(pi, "goal-paused", goal);
			ctx.ui.notify(`Goal paused (${goal.pausedReason}).`, "warning");
			updateFooterStatus(ctx);
			return;
		}

		if (!lastAssistantContent.trim()) return;

		const result = await evaluateWithJudge(pi, ctx, goal, lastAssistantContent);

		if (result.statusMessage) {
			ctx.ui.notify(result.statusMessage, "info");
		}

		if (goal.status === "done") {
			emitGoalEvent(pi, "goal-achieved", goal);
			updateFooterStatus(ctx);
		} else if (goal.status === "paused") {
			emitGoalEvent(pi, "goal-paused", goal);
			updateFooterStatus(ctx);
		} else if (result.shouldContinue) {
			emitGoalEvent(pi, "goal-continuing", goal);
			queueContinuation(pi, ctx, goal, () => goal, continuationState);
		}
	});

	pi.registerCommand("goal", {
		description: "Manage Pi goal continuation loop (/goal <text> | status | pause | stop | resume | done | clear)",
		getArgumentCompletions(argumentPrefix: string) {
			return GOAL_SUBCOMMANDS.filter((cmd) => cmd.startsWith(argumentPrefix)).map((cmd) => ({
				value: cmd,
				label: cmd,
			}));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			if (!trimmed || trimmed === "status") {
				handleGoalStatus(ctx);
				return;
			}

			if (trimmed === "pause" || trimmed === "stop") {
				handleGoalPause(ctx, trimmed);
				return;
			}

			if (trimmed === "resume") {
				handleGoalResume(pi, ctx);
				return;
			}

			if (trimmed === "done") {
				handleGoalDone(pi, ctx);
				return;
			}

			if (trimmed === "clear") {
				handleGoalClear(pi, ctx);
				return;
			}

			handleGoalSet(pi, ctx, trimmed);
		},
	});

	pi.registerCommand("subgoal", {
		description: "Manage goal acceptance criteria (/subgoal <text> | list | remove <n> | clear)",
		getArgumentCompletions(argumentPrefix: string) {
			return SUBGOAL_SUBCOMMANDS.filter((cmd) => cmd.startsWith(argumentPrefix)).map((cmd) => ({
				value: cmd,
				label: cmd,
			}));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			if (!trimmed || trimmed === "list") {
				handleSubgoalList(ctx);
				return;
			}

			if (trimmed === "clear") {
				handleSubgoalClear(pi, ctx);
				return;
			}

			if (trimmed.startsWith("remove")) {
				const indexStr = trimmed.slice("remove".length).trim();
				handleSubgoalRemove(pi, ctx, indexStr);
				return;
			}

			handleSubgoalAdd(pi, ctx, trimmed);
		},
	});

	function handleGoalStatus(ctx: ExtensionCommandContext) {
		if (!goal) {
			ctx.ui.notify("No goal is set. Use /goal <text> to set one.", "info");
			return;
		}
		const lines = [
			`Goal: ${goal.goal}`,
			`Status: ${goal.status}`,
			`Progress: ${goal.turnsUsed}/${goal.maxTurns} turns`,
		];
		if (goal.lastVerdict) {
			lines.push(`Last verdict: ${goal.lastVerdict}`);
		}
		if (goal.lastReason) {
			lines.push(`Reason: ${goal.lastReason}`);
		}
		if (goal.pausedReason) {
			lines.push(`Paused reason: ${goal.pausedReason}`);
		}
		ctx.ui.notify(lines.join("\n"), "info");
	}

	function handleGoalPause(ctx: ExtensionCommandContext, variant: string) {
		if (!goal || goal.status !== "active") {
			ctx.ui.notify("No active goal to pause.", "warning");
			return;
		}
		goal.status = "paused";
		goal.pausedReason = variant === "stop" ? "user stop" : "user pause";
		goal.updatedAt = Date.now();
		persist(pi, ctx, goal);
		emitGoalEvent(pi, "goal-paused", goal);
		ctx.ui.notify(`Goal paused (${goal.pausedReason}).`, "info");
		updateFooterStatus(ctx);
	}

	function handleGoalResume(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
		if (!goal || goal.status !== "paused") {
			ctx.ui.notify("No paused goal to resume.", "warning");
			return;
		}
		goal.turnsUsed = 0;
		goal.consecutiveParseFailures = 0;
		goal.status = "active";
		goal.pausedReason = null;
		goal.lastVerdict = null;
		goal.lastReason = null;
		goal.updatedAt = Date.now();
		persist(pi, ctx, goal);
		emitGoalEvent(pi, "goal-resumed", goal);
		ctx.ui.notify(`Goal resumed: ${goal.goal}`, "info");
		updateFooterStatus(ctx);
		if (ctx.isIdle()) {
			queueContinuation(pi, ctx, goal, () => goal, continuationState);
		}
	}

	function handleGoalDone(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
		if (!goal || (goal.status !== "active" && goal.status !== "paused")) {
			ctx.ui.notify("No goal to mark done.", "warning");
			return;
		}
		goal.status = "done";
		goal.lastVerdict = "done";
		goal.lastReason = "marked done by user";
		goal.pausedReason = null;
		goal.updatedAt = Date.now();
		persist(pi, ctx, goal);
		emitGoalEvent(pi, "goal-achieved", goal);
		ctx.ui.notify("Goal marked done.", "info");
		updateFooterStatus(ctx);
	}

	function handleGoalClear(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
		if (!goal) {
			ctx.ui.notify("No goal to clear.", "warning");
			return;
		}
		goal.status = "cleared";
		goal.updatedAt = Date.now();
		persist(pi, ctx, goal);
		emitGoalEvent(pi, "goal-cleared", goal);
		goal = null;
		ctx.ui.notify("Goal cleared.", "info");
		updateFooterStatus(ctx);
	}

	function handleGoalSet(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string) {
		if (goal && goal.status === "active") {
			ctx.ui.notify(`Replacing active goal: "${goal.goal}"`, "info");
		}
		goal = createPiLocalGoalState(text);
		persist(pi, ctx, goal);
		emitGoalEvent(pi, "goal-set", goal);
		ctx.ui.notify(`Goal set: ${text}`, "info");
		updateFooterStatus(ctx);
		if (ctx.isIdle()) {
			queueContinuation(pi, ctx, goal, () => goal, continuationState);
		}
	}

	function handleSubgoalList(ctx: ExtensionCommandContext) {
		if (!goal) {
			ctx.ui.notify("No goal is set.", "warning");
			return;
		}
		if (goal.subgoals.length === 0) {
			ctx.ui.notify("No subgoals.", "info");
			return;
		}
		const numbered = goal.subgoals.map((sg, i) => `${i + 1}. ${sg}`).join("\n");
		ctx.ui.notify(numbered, "info");
	}

	function handleSubgoalAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string) {
		if (!goal) {
			ctx.ui.notify("No goal is set.", "warning");
			return;
		}
		goal.subgoals.push(text);
		goal.updatedAt = Date.now();
		persist(pi, ctx, goal);
		ctx.ui.notify(`Subgoal added: ${text}`, "info");
	}

	function handleSubgoalRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext, indexStr: string) {
		if (!goal) {
			ctx.ui.notify("No goal is set.", "warning");
			return;
		}
		const index = parseInt(indexStr, 10);
		if (isNaN(index) || index < 1 || index > goal.subgoals.length) {
			ctx.ui.notify("Subgoal index out of range.", "warning");
			return;
		}
		const removed = goal.subgoals.splice(index - 1, 1)[0];
		goal.updatedAt = Date.now();
		persist(pi, ctx, goal);
		ctx.ui.notify(`Subgoal removed: ${removed}`, "info");
	}

	function handleSubgoalClear(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
		if (!goal) {
			ctx.ui.notify("No goal is set.", "warning");
			return;
		}
		goal.subgoals = [];
		goal.updatedAt = Date.now();
		persist(pi, ctx, goal);
		ctx.ui.notify("Subgoals cleared.", "info");
	}
}
