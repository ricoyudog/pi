import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { latestStateFromSession, type PiLocalGoalState } from "./goal-state.ts";

export default function piGoalHermes(pi: ExtensionAPI) {
	let goal: PiLocalGoalState | null = null;

	pi.on("session_start", (_event, ctx) => {
		goal = latestStateFromSession(ctx);
	});

	pi.on("turn_end", () => {
		// Placeholder: assistant response capture is implemented in the event-handler task group.
	});

	pi.on("agent_end", () => {
		// Placeholder: judge evaluation and continuation queuing are implemented in later task groups.
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
