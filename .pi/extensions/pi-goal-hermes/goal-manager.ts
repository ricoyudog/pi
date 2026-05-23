import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeContinuationPrompt } from "./continuation-prompt.ts";
import { persist, type PiLocalGoalState } from "./goal-state.ts";
import { JudgeService } from "./judge-service.ts";

export interface EvaluateWithJudgeResult {
	shouldContinue: boolean;
	statusMessage?: string;
	continuationPrompt?: string;
}

export async function evaluateWithJudge(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: PiLocalGoalState,
	lastResponse: string,
): Promise<EvaluateWithJudgeResult> {
	state.turnsUsed += 1;

	const verdict = await new JudgeService().evaluate(
		{
			goal: state.goal,
			response: lastResponse,
			subgoals: state.subgoals,
		},
		ctx,
		pi,
	);

	state.lastVerdict = verdict.verdict;
	state.lastReason = verdict.reason;

	if (verdict.done) {
		state.status = "done";
		state.pausedReason = null;
		state.updatedAt = Date.now();
		persist(pi, ctx, state);
		return { shouldContinue: false, statusMessage: "Goal achieved" };
	}

	if (verdict.parseFailed) {
		state.consecutiveParseFailures += 1;
	} else if (!verdict.preserveParseFailureCounter) {
		state.consecutiveParseFailures = 0;
	}

	if (state.consecutiveParseFailures >= 3) {
		state.status = "paused";
		state.pausedReason = "judge output was unparseable 3 times in a row";
		state.updatedAt = Date.now();
		persist(pi, ctx, state);
		return { shouldContinue: false };
	}

	if (state.turnsUsed >= state.maxTurns) {
		state.status = "paused";
		state.pausedReason = "maxTurns budget exhausted";
		state.updatedAt = Date.now();
		persist(pi, ctx, state);
		return { shouldContinue: false };
	}

	state.status = "active";
	state.pausedReason = null;
	state.updatedAt = Date.now();
	persist(pi, ctx, state);

	return {
		shouldContinue: true,
		continuationPrompt: makeContinuationPrompt(state),
	};
}
