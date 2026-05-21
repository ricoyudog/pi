import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateWithJudge } from "./goal-manager.ts";
import { GOAL_CUSTOM_TYPE, createPiLocalGoalState, latestStateFromSession, type PiLocalGoalState } from "./goal-state.ts";
import { JudgeService } from "./judge-service.ts";

function createSessionContext(entries: SessionEntry[], branchThrows = false): ExtensionContext {
	return {
		sessionManager: {
			getBranch: () => {
				if (branchThrows) {
					throw new Error("branch unavailable");
				}
				return entries;
			},
			getEntries: () => entries,
		},
	} as unknown as ExtensionContext;
}

function createExtensionContext(): ExtensionContext {
	return {
		signal: undefined,
	} as unknown as ExtensionContext;
}

function createPi(): { pi: ExtensionAPI; appendEntry: ReturnType<typeof vi.fn> } {
	const appendEntry = vi.fn();

	return {
		pi: {
			appendEntry,
		} as unknown as ExtensionAPI,
		appendEntry,
	};
}

function createGoalState(overrides: Partial<PiLocalGoalState> = {}): PiLocalGoalState {
	return {
		...createPiLocalGoalState("ship the feature"),
		...overrides,
	};
}

describe("pi-goal-hermes state scaffold", () => {
	it("creates an active goal state with default counters", () => {
		const state = createPiLocalGoalState("ship the feature");

		expect(state).toMatchObject({
			goal: "ship the feature",
			status: "active",
			turnsUsed: 0,
			maxTurns: 20,
			lastVerdict: null,
			lastReason: null,
			pausedReason: null,
			consecutiveParseFailures: 0,
			subgoals: [],
		});
		expect(state.id).toEqual(expect.any(String));
		expect(state.createdAt).toEqual(state.updatedAt);
	});

	it("recovers the latest branch goal state", () => {
		const older = createPiLocalGoalState("older");
		const latest = createPiLocalGoalState("latest");
		const ctx = createSessionContext([
			{
				type: "custom",
				customType: GOAL_CUSTOM_TYPE,
				data: { goal: older },
				id: "older",
				parentId: null,
				timestamp: new Date(0).toISOString(),
			},
			{
				type: "custom",
				customType: GOAL_CUSTOM_TYPE,
				data: { goal: latest },
				id: "latest",
				parentId: "older",
				timestamp: new Date(1).toISOString(),
			},
		]);

		expect(latestStateFromSession(ctx)).toBe(latest);
	});

	it("falls back to all entries and ignores cleared terminal state", () => {
		const cleared = { ...createPiLocalGoalState("cleared"), status: "cleared" as const };
		const ctx = createSessionContext(
			[
				{
					type: "custom",
					customType: GOAL_CUSTOM_TYPE,
					data: { goal: cleared },
					id: "cleared",
					parentId: null,
					timestamp: new Date(0).toISOString(),
				},
			],
			true,
		);

		expect(latestStateFromSession(ctx)).toBeNull();
	});
});

describe("pi-goal-hermes core evaluation logic", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("marks the goal done when the judge returns done", async () => {
		const state = createGoalState();
		const { pi, appendEntry } = createPi();

		vi.spyOn(JudgeService.prototype, "evaluate").mockResolvedValue({
			verdict: "done",
			done: true,
			reason: "blocked waiting on user input",
			parseFailed: false,
		});

		const result = await evaluateWithJudge(pi, createExtensionContext(), state, "I need the user to continue.");

		expect(result).toEqual({ shouldContinue: false, statusMessage: "Goal achieved" });
		expect(state).toMatchObject({
			status: "done",
			turnsUsed: 1,
			lastVerdict: "done",
			lastReason: "blocked waiting on user input",
			pausedReason: null,
		});
		expect(appendEntry).toHaveBeenCalledWith(GOAL_CUSTOM_TYPE, { goal: state });
	});

	it("continues after a successful judge verdict and increments turns before calling the judge", async () => {
		const state = createGoalState();
		const { pi, appendEntry } = createPi();

		vi.spyOn(JudgeService.prototype, "evaluate").mockImplementation(async (input) => {
			expect(state.turnsUsed).toBe(1);
			expect(input).toEqual({
				goal: "ship the feature",
				response: "Still working on it.",
				subgoals: [],
			});

			return {
				verdict: "continue",
				done: false,
				reason: "keep going",
				parseFailed: false,
			};
		});

		const result = await evaluateWithJudge(pi, createExtensionContext(), state, "Still working on it.");

		expect(result.shouldContinue).toBe(true);
		expect(result.continuationPrompt).toEqual(expect.stringContaining("ship the feature"));
		expect(state).toMatchObject({
			status: "active",
			turnsUsed: 1,
			lastVerdict: "continue",
			lastReason: "keep going",
			consecutiveParseFailures: 0,
			pausedReason: null,
		});
		expect(appendEntry).toHaveBeenCalledWith(GOAL_CUSTOM_TYPE, { goal: state });
	});

	it("fails open on a parse failure before the pause threshold", async () => {
		const state = createGoalState();
		const { pi, appendEntry } = createPi();

		vi.spyOn(JudgeService.prototype, "evaluate").mockResolvedValue({
			verdict: "continue",
			done: false,
			reason: "judge reply was not JSON: nope",
			parseFailed: true,
		});

		const result = await evaluateWithJudge(pi, createExtensionContext(), state, "No structured response.");

		expect(result.shouldContinue).toBe(true);
		expect(state).toMatchObject({
			status: "active",
			turnsUsed: 1,
			lastVerdict: "continue",
			consecutiveParseFailures: 1,
			lastReason: "judge reply was not JSON: nope",
		});
		expect(appendEntry).toHaveBeenCalledWith(GOAL_CUSTOM_TYPE, { goal: state });
	});

	it("pauses after the third consecutive parse failure", async () => {
		const state = createGoalState({ consecutiveParseFailures: 2 });
		const { pi, appendEntry } = createPi();

		vi.spyOn(JudgeService.prototype, "evaluate").mockResolvedValue({
			verdict: "continue",
			done: false,
			reason: "judge reply was not JSON: nope",
			parseFailed: true,
		});

		const result = await evaluateWithJudge(pi, createExtensionContext(), state, "No structured response.");

		expect(result).toEqual({ shouldContinue: false });
		expect(state).toMatchObject({
			status: "paused",
			turnsUsed: 1,
			lastVerdict: "continue",
			consecutiveParseFailures: 3,
			pausedReason: "judge output was unparseable 3 times in a row",
		});
		expect(appendEntry).toHaveBeenCalledWith(GOAL_CUSTOM_TYPE, { goal: state });
	});

	it("pauses when the maxTurns budget is exhausted after the judge returns continue", async () => {
		const state = createGoalState({ turnsUsed: 1, maxTurns: 2 });
		const { pi, appendEntry } = createPi();
		const evaluate = vi.spyOn(JudgeService.prototype, "evaluate").mockResolvedValue({
			verdict: "continue",
			done: false,
			reason: "still more work to do",
			parseFailed: false,
		});

		const result = await evaluateWithJudge(pi, createExtensionContext(), state, "Still more work to do.");

		expect(result).toEqual({ shouldContinue: false });
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(state).toMatchObject({
			status: "paused",
			turnsUsed: 2,
			lastVerdict: "continue",
			lastReason: "still more work to do",
			consecutiveParseFailures: 0,
			pausedReason: "maxTurns budget exhausted",
		});
		expect(appendEntry).toHaveBeenCalledWith(GOAL_CUSTOM_TYPE, { goal: state });
	});

	it("resets the parse failure counter after a successful parsed continue verdict", async () => {
		const state = createGoalState({ consecutiveParseFailures: 2 });
		const { pi, appendEntry } = createPi();

		vi.spyOn(JudgeService.prototype, "evaluate").mockResolvedValue({
			verdict: "continue",
			done: false,
			reason: "keep going",
			parseFailed: false,
		});

		const result = await evaluateWithJudge(pi, createExtensionContext(), state, "Still working.");

		expect(result.shouldContinue).toBe(true);
		expect(state).toMatchObject({
			status: "active",
			turnsUsed: 1,
			consecutiveParseFailures: 0,
			lastVerdict: "continue",
			lastReason: "keep going",
		});
		expect(appendEntry).toHaveBeenCalledWith(GOAL_CUSTOM_TYPE, { goal: state });
	});

	it("preserves the parse failure counter when the judge fails open with continue", async () => {
		const state = createGoalState({ consecutiveParseFailures: 2 });
		const { pi, appendEntry } = createPi();

		vi.spyOn(JudgeService.prototype, "evaluate").mockResolvedValue({
			verdict: "continue",
			done: false,
			reason: "no judge model available",
			parseFailed: false,
			preserveParseFailureCounter: true,
		});

		const result = await evaluateWithJudge(pi, createExtensionContext(), state, "Still working.");

		expect(result.shouldContinue).toBe(true);
		expect(state).toMatchObject({
			status: "active",
			turnsUsed: 1,
			consecutiveParseFailures: 2,
			lastVerdict: "continue",
			lastReason: "no judge model available",
		});
		expect(appendEntry).toHaveBeenCalledWith(GOAL_CUSTOM_TYPE, { goal: state });
	});
});
