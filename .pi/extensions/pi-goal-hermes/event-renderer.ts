import type { ExtensionAPI, MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { PiLocalGoalState } from "./goal-state.ts";

export type GoalEventType =
	| "goal-set"
	| "goal-continuing"
	| "goal-achieved"
	| "goal-paused"
	| "goal-resumed"
	| "goal-cleared";

export interface GoalEventDetails {
	eventType: GoalEventType;
	goal: string;
	status: string;
	turnsUsed: number;
	maxTurns: number;
	lastVerdict: string | null;
	lastReason: string | null;
	pausedReason: string | null;
}

export function emitGoalEvent(pi: ExtensionAPI, eventType: GoalEventType, state: PiLocalGoalState): void {
	const summary = buildEventSummary(eventType, state);
	pi.sendMessage<GoalEventDetails>(
		{
			customType: "pi-goal-hermes:event",
			content: summary,
			display: true,
			details: {
				eventType,
				goal: state.goal,
				status: state.status,
				turnsUsed: state.turnsUsed,
				maxTurns: state.maxTurns,
				lastVerdict: state.lastVerdict,
				lastReason: state.lastReason,
				pausedReason: state.pausedReason,
			},
		},
	);
}

function buildEventSummary(eventType: GoalEventType, state: PiLocalGoalState): string {
	switch (eventType) {
		case "goal-set":
			return `Goal set: ${state.goal}`;
		case "goal-continuing":
			return `Goal continuing (${state.turnsUsed}/${state.maxTurns} turns)`;
		case "goal-achieved":
			return `Goal achieved: ${state.goal}`;
		case "goal-paused":
			return `Goal paused: ${state.pausedReason ?? "unknown reason"}`;
		case "goal-resumed":
			return `Goal resumed: ${state.goal}`;
		case "goal-cleared":
			return "Goal cleared";
	}
}

export const goalEventRenderer: MessageRenderer<GoalEventDetails> = (message, { expanded }, theme) => {
	const details = message.details;
	if (!details) return undefined;

	if (!expanded) {
		return renderCollapsedEvent(details, theme);
	}

	return renderExpandedEvent(details, theme);
};

function renderCollapsedEvent(details: GoalEventDetails, theme: Theme): Box {
	const icon = getEventIcon(details.eventType, theme);
	const label = getCollapsedLabel(details);
	const hint = theme.fg("dim", " (ctrl+o to expand)");
	const box = new Box(1, 0, (t) => theme.bg("customMessageBg", t));
	box.addChild(new Text(`${icon} ${label}${hint}`, 0, 0));
	return box;
}

function renderExpandedEvent(details: GoalEventDetails, theme: Theme): Box {
	const icon = getEventIcon(details.eventType, theme);
	const label = getCollapsedLabel(details);
	const lines: string[] = [`${icon} ${label}`];

	lines.push(theme.fg("dim", `  Objective: ${details.goal}`));
	lines.push(theme.fg("dim", `  Progress: ${details.turnsUsed}/${details.maxTurns} turns`));

	if (details.lastVerdict) {
		lines.push(theme.fg("dim", `  Verdict: ${details.lastVerdict}`));
	}
	if (details.lastReason) {
		lines.push(theme.fg("dim", `  Reason: ${details.lastReason}`));
	}
	if (details.pausedReason) {
		lines.push(theme.fg("dim", `  Paused: ${details.pausedReason}`));
	}

	const box = new Box(1, 0, (t) => theme.bg("customMessageBg", t));
	box.addChild(new Text(lines.join("\n"), 0, 0));
	return box;
}

function getEventIcon(eventType: GoalEventType, theme: Theme): string {
	switch (eventType) {
		case "goal-set":
			return theme.fg("accent", "◉");
		case "goal-continuing":
			return theme.fg("accent", "→");
		case "goal-achieved":
			return theme.fg("success", "✓");
		case "goal-paused":
			return theme.fg("warning", "⏸");
		case "goal-resumed":
			return theme.fg("accent", "▶");
		case "goal-cleared":
			return theme.fg("dim", "○");
	}
}

function getCollapsedLabel(details: GoalEventDetails): string {
	switch (details.eventType) {
		case "goal-set":
			return "Goal set";
		case "goal-continuing":
			return `Goal continuing (${details.turnsUsed}/${details.maxTurns})`;
		case "goal-achieved":
			return "Goal achieved";
		case "goal-paused":
			return `Goal paused (${details.pausedReason ?? "unknown"})`;
		case "goal-resumed":
			return "Goal resumed";
		case "goal-cleared":
			return "Goal cleared";
	}
}

export interface ContinuationDetails {
	goalId: string;
}

export const continuationRenderer: MessageRenderer<ContinuationDetails> = (message, { expanded }, theme) => {
	if (!expanded) {
		const hint = theme.fg("dim", " (ctrl+o to expand)");
		const box = new Box(1, 0, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${theme.fg("accent", "→")} Continuation sent${hint}`, 0, 0));
		return box;
	}

	const text = typeof message.content === "string"
		? message.content
		: message.content.filter((c) => c.type === "text").map((c) => (c as { type: "text"; text: string }).text).join("\n");

	const box = new Box(1, 0, (t) => theme.bg("customMessageBg", t));
	box.addChild(new Text(`${theme.fg("accent", "→")} Continuation:\n${theme.fg("dim", text)}`, 0, 0));
	return box;
};
