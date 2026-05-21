import { randomUUID } from "node:crypto";
import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const GOAL_CUSTOM_TYPE = "pi-goal-hermes:state";
export const DEFAULT_MAX_TURNS = 20;

export type PiLocalGoalStatus = "active" | "paused" | "done" | "cleared";
export type PiLocalGoalVerdict = "done" | "continue";

export interface PiLocalGoalState {
	id: string;
	goal: string;
	status: PiLocalGoalStatus;
	turnsUsed: number;
	maxTurns: number;
	lastVerdict: PiLocalGoalVerdict | null;
	lastReason: string | null;
	pausedReason: string | null;
	consecutiveParseFailures: number;
	subgoals: string[];
	createdAt: number;
	updatedAt: number;
}

export interface PiLocalGoalEntryData {
	goal: PiLocalGoalState;
}

export function createPiLocalGoalState(goal: string, maxTurns: number = DEFAULT_MAX_TURNS): PiLocalGoalState {
	const now = Date.now();

	return {
		id: randomUUID(),
		goal,
		status: "active",
		turnsUsed: 0,
		maxTurns,
		lastVerdict: null,
		lastReason: null,
		pausedReason: null,
		consecutiveParseFailures: 0,
		subgoals: [],
		createdAt: now,
		updatedAt: now,
	};
}

export function persist(pi: ExtensionAPI, ctx: ExtensionContext, state: PiLocalGoalState): void {
	void ctx;
	pi.appendEntry<PiLocalGoalEntryData>(GOAL_CUSTOM_TYPE, { goal: state });
}

export function latestStateFromSession(ctx: ExtensionContext): PiLocalGoalState | null {
	let entries: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>;

	try {
		entries = ctx.sessionManager.getBranch();
	} catch {
		entries = ctx.sessionManager.getEntries();
	}

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== GOAL_CUSTOM_TYPE) continue;

		const data = entry.data;
		if (!isRecord(data) || !isPiLocalGoalState(data.goal)) continue;
		if (data.goal.status === "cleared") return null;
		return data.goal;
	}

	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isPiLocalGoalState(value: unknown): value is PiLocalGoalState {
	if (!isRecord(value)) return false;

	const status = value.status;
	const lastVerdict = value.lastVerdict;

	const hasValidStatus = status === "active" || status === "paused" || status === "done" || status === "cleared";
	const hasValidVerdict =
		lastVerdict === null || lastVerdict === "done" || lastVerdict === "continue";

	return (
		typeof value.id === "string" &&
		typeof value.goal === "string" &&
		hasValidStatus &&
		typeof value.turnsUsed === "number" &&
		typeof value.maxTurns === "number" &&
		hasValidVerdict &&
		(value.lastReason === null || typeof value.lastReason === "string") &&
		(value.pausedReason === null || typeof value.pausedReason === "string") &&
		typeof value.consecutiveParseFailures === "number" &&
		Array.isArray(value.subgoals) &&
		value.subgoals.every((subgoal) => typeof subgoal === "string") &&
		typeof value.createdAt === "number" &&
		typeof value.updatedAt === "number"
	);
}

export type PiLocalGoalCustomEntry = CustomEntry<PiLocalGoalEntryData>;
