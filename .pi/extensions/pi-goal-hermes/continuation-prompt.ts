import type { PiLocalGoalState } from "./goal-state.ts";

export function makeContinuationPrompt(state: PiLocalGoalState): string {
	if (state.subgoals.length === 0) {
		return `Continue working toward the goal:\n${state.goal}`;
	}

	return `Continue working toward the goal AND all additional criteria:\n${state.goal}\n\nAdditional criteria:\n${state.subgoals.map((subgoal, index) => `${index + 1}. ${subgoal}`).join("\n")}`;
}
