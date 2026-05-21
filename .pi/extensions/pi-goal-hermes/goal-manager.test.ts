import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { GOAL_CUSTOM_TYPE, createPiLocalGoalState, latestStateFromSession } from "./goal-state.ts";

function createContext(entries: SessionEntry[], branchThrows = false): ExtensionContext {
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
		const ctx = createContext([
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
		const ctx = createContext(
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
