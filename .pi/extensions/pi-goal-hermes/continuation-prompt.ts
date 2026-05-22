import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiLocalGoalState } from "./goal-state.ts";

export interface ContinuationState {
	queued: boolean;
}

const MAX_IDLE_RETRIES = 10;

export function makeContinuationPrompt(state: PiLocalGoalState): string {
	if (state.subgoals.length === 0) {
		return `Continue working toward the goal:\n${state.goal}`;
	}

	return `Continue working toward the goal AND all additional criteria:\n${state.goal}\n\nAdditional criteria:\n${state.subgoals.map((subgoal, index) => `${index + 1}. ${subgoal}`).join("\n")}`;
}

export function queueContinuation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: PiLocalGoalState,
	getGoal: () => PiLocalGoalState | null,
	continuationState: ContinuationState,
): void {
	if (continuationState.queued) return;
	continuationState.queued = true;

	const goalId = state.id;
	const prompt = makeContinuationPrompt(state);

	const attemptSend = (retries: number) => {
		const currentGoal = getGoal();
		if (
			!currentGoal ||
			currentGoal.id !== goalId ||
			currentGoal.status !== "active" ||
			ctx.hasPendingMessages()
		) {
			continuationState.queued = false;
			return;
		}

		if (!ctx.isIdle()) {
			if (retries >= MAX_IDLE_RETRIES) {
				continuationState.queued = false;
				return;
			}
			setTimeout(() => attemptSend(retries + 1), 0);
			return;
		}

		pi.sendMessage<{ goalId: string }>(
			{
				customType: "pi-goal-hermes:continuation",
				content: [{ type: "text", text: prompt }],
				display: true,
				details: { goalId },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);

		continuationState.queued = false;
	};

	setTimeout(() => attemptSend(0), 0);
}
