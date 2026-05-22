import type { AgentEndEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionHandler, SessionEntry, SessionStartEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ContinuationState, queueContinuation } from "./continuation-prompt.ts";
import { evaluateWithJudge } from "./goal-manager.ts";
import { GOAL_CUSTOM_TYPE, createPiLocalGoalState, latestStateFromSession, type PiLocalGoalState } from "./goal-state.ts";
import piGoalHermes from "./index.ts";
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

describe("queueContinuation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function createQueueContext(overrides: {
		isIdle?: boolean;
		hasPendingMessages?: boolean;
	} = {}): ExtensionContext {
		return {
			isIdle: () => overrides.isIdle ?? true,
			hasPendingMessages: () => overrides.hasPendingMessages ?? false,
			signal: undefined,
		} as unknown as ExtensionContext;
	}

	function createQueuePi(): { pi: ExtensionAPI; sendMessage: ReturnType<typeof vi.fn> } {
		const sendMessage = vi.fn();
		return {
			pi: { sendMessage } as unknown as ExtensionAPI,
			sendMessage,
		};
	}

	it("sends continuation message when agent is idle", () => {
		const state = createPiLocalGoalState("build the feature");
		const { pi, sendMessage } = createQueuePi();
		const ctx = createQueueContext({ isIdle: true });
		const continuationState: ContinuationState = { queued: false };
		const getGoal = () => state;

		queueContinuation(pi, ctx, state, getGoal, continuationState);
		vi.runAllTimers();

		expect(sendMessage).toHaveBeenCalledWith(
			{
				customType: "pi-goal-hermes:continuation",
				content: [{ type: "text", text: `Continue working toward the goal:\n${state.goal}` }],
				display: true,
				details: { goalId: state.id },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		expect(continuationState.queued).toBe(false);
	});

	it("prevents duplicate continuation when already queued", () => {
		const state = createPiLocalGoalState("build the feature");
		const { pi, sendMessage } = createQueuePi();
		const ctx = createQueueContext({ isIdle: true });
		const continuationState: ContinuationState = { queued: false };
		const getGoal = () => state;

		queueContinuation(pi, ctx, state, getGoal, continuationState);
		queueContinuation(pi, ctx, state, getGoal, continuationState);
		vi.runAllTimers();

		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	it("abandons when goal is null (cleared)", () => {
		const state = createPiLocalGoalState("build the feature");
		const { pi, sendMessage } = createQueuePi();
		const ctx = createQueueContext({ isIdle: true });
		const continuationState: ContinuationState = { queued: false };
		const getGoal = () => null;

		queueContinuation(pi, ctx, state, getGoal, continuationState);
		vi.runAllTimers();

		expect(sendMessage).not.toHaveBeenCalled();
		expect(continuationState.queued).toBe(false);
	});

	it("abandons when goal id has changed (new goal set)", () => {
		const state = createPiLocalGoalState("build the feature");
		const newGoal = createPiLocalGoalState("different goal");
		const { pi, sendMessage } = createQueuePi();
		const ctx = createQueueContext({ isIdle: true });
		const continuationState: ContinuationState = { queued: false };
		const getGoal = () => newGoal;

		queueContinuation(pi, ctx, state, getGoal, continuationState);
		vi.runAllTimers();

		expect(sendMessage).not.toHaveBeenCalled();
		expect(continuationState.queued).toBe(false);
	});

	it("abandons when there are pending user messages", () => {
		const state = createPiLocalGoalState("build the feature");
		const { pi, sendMessage } = createQueuePi();
		const ctx = createQueueContext({ isIdle: true, hasPendingMessages: true });
		const continuationState: ContinuationState = { queued: false };
		const getGoal = () => state;

		queueContinuation(pi, ctx, state, getGoal, continuationState);
		vi.runAllTimers();

		expect(sendMessage).not.toHaveBeenCalled();
		expect(continuationState.queued).toBe(false);
	});

	it("abandons when goal status is no longer active", () => {
		const state = createPiLocalGoalState("build the feature");
		const pausedGoal = { ...state, status: "paused" as const };
		const { pi, sendMessage } = createQueuePi();
		const ctx = createQueueContext({ isIdle: true });
		const continuationState: ContinuationState = { queued: false };
		const getGoal = () => pausedGoal;

		queueContinuation(pi, ctx, state, getGoal, continuationState);
		vi.runAllTimers();

		expect(sendMessage).not.toHaveBeenCalled();
		expect(continuationState.queued).toBe(false);
	});

	it("retries when not idle and eventually sends on idle", () => {
		const state = createPiLocalGoalState("build the feature");
		const { pi, sendMessage } = createQueuePi();
		let idleCallCount = 0;
		const ctx = {
			isIdle: () => {
				idleCallCount++;
				return idleCallCount >= 3;
			},
			hasPendingMessages: () => false,
			signal: undefined,
		} as unknown as ExtensionContext;
		const continuationState: ContinuationState = { queued: false };
		const getGoal = () => state;

		queueContinuation(pi, ctx, state, getGoal, continuationState);
		vi.runAllTimers();

		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(idleCallCount).toBe(3);
		expect(continuationState.queued).toBe(false);
	});

	it("abandons after max retries exhausted without reaching idle", () => {
		const state = createPiLocalGoalState("build the feature");
		const { pi, sendMessage } = createQueuePi();
		const ctx = createQueueContext({ isIdle: false });
		const continuationState: ContinuationState = { queued: false };
		const getGoal = () => state;

		queueContinuation(pi, ctx, state, getGoal, continuationState);
		vi.runAllTimers();

		expect(sendMessage).not.toHaveBeenCalled();
		expect(continuationState.queued).toBe(false);
	});

	it("resets queued flag after successful send allowing future continuations", () => {
		const state = createPiLocalGoalState("build the feature");
		const { pi, sendMessage } = createQueuePi();
		const ctx = createQueueContext({ isIdle: true });
		const continuationState: ContinuationState = { queued: false };
		const getGoal = () => state;

		queueContinuation(pi, ctx, state, getGoal, continuationState);
		vi.runAllTimers();

		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(continuationState.queued).toBe(false);

		queueContinuation(pi, ctx, state, getGoal, continuationState);
		vi.runAllTimers();

		expect(sendMessage).toHaveBeenCalledTimes(2);
	});
});

describe("piGoalHermes event handler integration", () => {
	type HandlerMap = {
		session_start: ExtensionHandler<SessionStartEvent>;
		turn_end: ExtensionHandler<TurnEndEvent>;
		agent_end: ExtensionHandler<AgentEndEvent>;
	};

	function setupExtension(sessionEntries: SessionEntry[] = []) {
		const handlers: Partial<HandlerMap> = {};
		const appendEntry = vi.fn();
		const sendMessage = vi.fn();
		const notify = vi.fn();

		const pi = {
			on: (event: string, handler: unknown) => {
				(handlers as Record<string, unknown>)[event] = handler;
			},
			registerCommand: vi.fn(),
			registerMessageRenderer: vi.fn(),
			appendEntry,
			sendMessage,
		} as unknown as ExtensionAPI;

		piGoalHermes(pi);

		function createCtx(overrides: {
			signal?: { aborted: boolean };
			hasPendingMessages?: boolean;
			isIdle?: boolean;
			entries?: SessionEntry[];
		} = {}): ExtensionContext {
			const entries = overrides.entries ?? sessionEntries;
			return {
				sessionManager: {
					getBranch: () => entries,
					getEntries: () => entries,
				},
				ui: {
					notify,
					setStatus: vi.fn(),
					theme: { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text },
				},
				signal: overrides.signal,
				hasPendingMessages: () => overrides.hasPendingMessages ?? false,
				isIdle: () => overrides.isIdle ?? true,
			} as unknown as ExtensionContext;
		}

		return { handlers: handlers as HandlerMap, appendEntry, sendMessage, notify, createCtx };
	}

	function makeGoalEntry(goal: PiLocalGoalState): SessionEntry {
		return {
			type: "custom",
			customType: GOAL_CUSTOM_TYPE,
			data: { goal },
			id: goal.id,
			parentId: null,
			timestamp: new Date().toISOString(),
		};
	}

	function makeAssistantMessage(text: string, stopReason = "stop", errorMessage?: string) {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason,
			errorMessage,
		};
	}

	describe("session_start handler", () => {
		it("restores active goal and notifies user", () => {
			const goal = createPiLocalGoalState("finish the task");
			const entries = [makeGoalEntry(goal)];
			const { handlers, notify, createCtx } = setupExtension(entries);

			handlers.session_start({ type: "session_start", reason: "startup" }, createCtx());

			expect(notify).toHaveBeenCalledWith(
				expect.stringContaining("Goal restored: finish the task"),
				"info",
			);
		});

		it("pauses active goal on reload and persists", () => {
			const goal = createPiLocalGoalState("finish the task");
			const entries = [makeGoalEntry(goal)];
			const { handlers, notify, appendEntry, createCtx } = setupExtension(entries);

			handlers.session_start({ type: "session_start", reason: "reload" }, createCtx());

			expect(notify).toHaveBeenCalledWith(
				expect.stringContaining("Goal paused (session reload)"),
				"warning",
			);
			expect(appendEntry).toHaveBeenCalledWith(
				GOAL_CUSTOM_TYPE,
				expect.objectContaining({ goal: expect.objectContaining({ status: "paused", pausedReason: "reload" }) }),
			);
		});

		it("notifies about paused goal with reason", () => {
			const goal = { ...createPiLocalGoalState("finish the task"), status: "paused" as const, pausedReason: "interrupted (Ctrl+C)" };
			const entries = [makeGoalEntry(goal)];
			const { handlers, notify, createCtx } = setupExtension(entries);

			handlers.session_start({ type: "session_start", reason: "resume" }, createCtx());

			expect(notify).toHaveBeenCalledWith(
				expect.stringContaining("interrupted (Ctrl+C)"),
				"info",
			);
		});

		it("does nothing when no goal exists in session", () => {
			const { handlers, notify, createCtx } = setupExtension([]);

			handlers.session_start({ type: "session_start", reason: "startup" }, createCtx());

			expect(notify).not.toHaveBeenCalled();
		});
	});

	describe("turn_end handler", () => {
		it("captures assistant text content for later use by agent_end", async () => {
			const goal = createPiLocalGoalState("ship it");
			const entries = [makeGoalEntry(goal)];
			const { handlers, createCtx, sendMessage } = setupExtension(entries);

			handlers.session_start({ type: "session_start", reason: "startup" }, createCtx());

			const msg = makeAssistantMessage("I deployed the code.");
			handlers.turn_end(
				{ type: "turn_end", turnIndex: 0, message: msg, toolResults: [] } as unknown as TurnEndEvent,
				createCtx(),
			);

			vi.spyOn(JudgeService.prototype, "evaluate").mockResolvedValue({
				verdict: "done",
				done: true,
				reason: "deployed",
				parseFailed: false,
			});

			await handlers.agent_end(
				{ type: "agent_end", messages: [] } as unknown as AgentEndEvent,
				createCtx(),
			);

			expect(JudgeService.prototype.evaluate).toHaveBeenCalledWith(
				expect.objectContaining({ response: "I deployed the code." }),
				expect.anything(),
			);
		});

		it("ignores non-assistant messages", () => {
			const goal = createPiLocalGoalState("ship it");
			const entries = [makeGoalEntry(goal)];
			const { handlers, createCtx } = setupExtension(entries);

			handlers.session_start({ type: "session_start", reason: "startup" }, createCtx());

			const userMsg = { type: "user", content: [{ type: "text", text: "hello" }] };
			handlers.turn_end(
				{ type: "turn_end", turnIndex: 0, message: userMsg, toolResults: [] } as unknown as TurnEndEvent,
				createCtx(),
			);
		});

		it("skips when no active goal", () => {
			const { handlers, createCtx } = setupExtension([]);

			const msg = makeAssistantMessage("hello");
			handlers.turn_end(
				{ type: "turn_end", turnIndex: 0, message: msg, toolResults: [] } as unknown as TurnEndEvent,
				createCtx(),
			);
		});
	});

	describe("agent_end handler", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
			vi.restoreAllMocks();
		});

		it("evaluates with judge and queues continuation on shouldContinue", async () => {
			const goal = createPiLocalGoalState("build feature");
			const entries = [makeGoalEntry(goal)];
			const { handlers, createCtx, sendMessage, notify } = setupExtension(entries);

			handlers.session_start({ type: "session_start", reason: "startup" }, createCtx());

			const msg = makeAssistantMessage("Working on it.");
			handlers.turn_end(
				{ type: "turn_end", turnIndex: 0, message: msg, toolResults: [] } as unknown as TurnEndEvent,
				createCtx(),
			);

			vi.spyOn(JudgeService.prototype, "evaluate").mockResolvedValue({
				verdict: "continue",
				done: false,
				reason: "more work needed",
				parseFailed: false,
			});

			await handlers.agent_end(
				{ type: "agent_end", messages: [] } as unknown as AgentEndEvent,
				createCtx({ isIdle: true }),
			);

			expect(notify).toHaveBeenCalledWith(expect.any(String), "info");

			vi.runAllTimers();
			expect(sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "pi-goal-hermes:continuation" }),
				expect.objectContaining({ deliverAs: "followUp", triggerTurn: true }),
			);
		});

		it("evaluates with judge and does not queue on goal done", async () => {
			const goal = createPiLocalGoalState("build feature");
			const entries = [makeGoalEntry(goal)];
			const { handlers, createCtx, sendMessage, notify } = setupExtension(entries);

			handlers.session_start({ type: "session_start", reason: "startup" }, createCtx());

			const msg = makeAssistantMessage("Done, everything is deployed.");
			handlers.turn_end(
				{ type: "turn_end", turnIndex: 0, message: msg, toolResults: [] } as unknown as TurnEndEvent,
				createCtx(),
			);

			vi.spyOn(JudgeService.prototype, "evaluate").mockResolvedValue({
				verdict: "done",
				done: true,
				reason: "goal achieved",
				parseFailed: false,
			});

			await handlers.agent_end(
				{ type: "agent_end", messages: [] } as unknown as AgentEndEvent,
				createCtx({ isIdle: true }),
			);

			expect(notify).toHaveBeenCalledWith("Goal achieved", "info");
			vi.runAllTimers();
			expect(sendMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ customType: "pi-goal-hermes:continuation" }),
			);
		});

		it("pauses on signal.aborted (user interrupt)", async () => {
			const goal = createPiLocalGoalState("build feature");
			const entries = [makeGoalEntry(goal)];
			const { handlers, createCtx, appendEntry, notify, sendMessage } = setupExtension(entries);

			handlers.session_start({ type: "session_start", reason: "startup" }, createCtx());

			const msg = makeAssistantMessage("Working...");
			handlers.turn_end(
				{ type: "turn_end", turnIndex: 0, message: msg, toolResults: [] } as unknown as TurnEndEvent,
				createCtx(),
			);

			await handlers.agent_end(
				{ type: "agent_end", messages: [] } as unknown as AgentEndEvent,
				createCtx({ signal: { aborted: true } }),
			);

			expect(notify).toHaveBeenCalledWith(
				expect.stringContaining("Goal paused (interrupted)"),
				"warning",
			);
			expect(appendEntry).toHaveBeenCalledWith(
				GOAL_CUSTOM_TYPE,
				expect.objectContaining({
					goal: expect.objectContaining({ status: "paused", pausedReason: "interrupted (Ctrl+C)" }),
				}),
			);
			expect(sendMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ customType: "pi-goal-hermes:continuation" }),
			);
		});

		it("skips evaluation when pending messages exist", async () => {
			const goal = createPiLocalGoalState("build feature");
			const entries = [makeGoalEntry(goal)];
			const { handlers, createCtx, sendMessage } = setupExtension(entries);

			handlers.session_start({ type: "session_start", reason: "startup" }, createCtx());

			const msg = makeAssistantMessage("Working...");
			handlers.turn_end(
				{ type: "turn_end", turnIndex: 0, message: msg, toolResults: [] } as unknown as TurnEndEvent,
				createCtx(),
			);

			const evaluateSpy = vi.spyOn(JudgeService.prototype, "evaluate");

			await handlers.agent_end(
				{ type: "agent_end", messages: [] } as unknown as AgentEndEvent,
				createCtx({ hasPendingMessages: true }),
			);

			expect(evaluateSpy).not.toHaveBeenCalled();
			expect(sendMessage).not.toHaveBeenCalled();
		});

		it("pauses on error stopReason with errorMessage", async () => {
			const goal = createPiLocalGoalState("build feature");
			const entries = [makeGoalEntry(goal)];
			const { handlers, createCtx, appendEntry, notify } = setupExtension(entries);

			handlers.session_start({ type: "session_start", reason: "startup" }, createCtx());

			const msg = makeAssistantMessage("Oops", "error", "rate limit exceeded");
			handlers.turn_end(
				{ type: "turn_end", turnIndex: 0, message: msg, toolResults: [] } as unknown as TurnEndEvent,
				createCtx(),
			);

			await handlers.agent_end(
				{ type: "agent_end", messages: [] } as unknown as AgentEndEvent,
				createCtx(),
			);

			expect(notify).toHaveBeenCalledWith(
				expect.stringContaining("error: rate limit exceeded"),
				"warning",
			);
			expect(appendEntry).toHaveBeenCalledWith(
				GOAL_CUSTOM_TYPE,
				expect.objectContaining({
					goal: expect.objectContaining({ status: "paused", pausedReason: "error: rate limit exceeded" }),
				}),
			);
		});

		it("pauses on aborted stopReason without errorMessage", async () => {
			const goal = createPiLocalGoalState("build feature");
			const entries = [makeGoalEntry(goal)];
			const { handlers, createCtx, appendEntry, notify } = setupExtension(entries);

			handlers.session_start({ type: "session_start", reason: "startup" }, createCtx());

			const msg = makeAssistantMessage("...", "aborted");
			handlers.turn_end(
				{ type: "turn_end", turnIndex: 0, message: msg, toolResults: [] } as unknown as TurnEndEvent,
				createCtx(),
			);

			await handlers.agent_end(
				{ type: "agent_end", messages: [] } as unknown as AgentEndEvent,
				createCtx(),
			);

			expect(notify).toHaveBeenCalledWith(
				expect.stringContaining("assistant response aborted"),
				"warning",
			);
			expect(appendEntry).toHaveBeenCalledWith(
				GOAL_CUSTOM_TYPE,
				expect.objectContaining({
					goal: expect.objectContaining({ status: "paused", pausedReason: "assistant response aborted" }),
				}),
			);
		});

		it("skips evaluation when assistant content is empty", async () => {
			const goal = createPiLocalGoalState("build feature");
			const entries = [makeGoalEntry(goal)];
			const { handlers, createCtx, sendMessage } = setupExtension(entries);

			handlers.session_start({ type: "session_start", reason: "startup" }, createCtx());

			const msg = makeAssistantMessage("");
			handlers.turn_end(
				{ type: "turn_end", turnIndex: 0, message: msg, toolResults: [] } as unknown as TurnEndEvent,
				createCtx(),
			);

			const evaluateSpy = vi.spyOn(JudgeService.prototype, "evaluate");

			await handlers.agent_end(
				{ type: "agent_end", messages: [] } as unknown as AgentEndEvent,
				createCtx(),
			);

			expect(evaluateSpy).not.toHaveBeenCalled();
			expect(sendMessage).not.toHaveBeenCalled();
		});

		it("pauses after maxTurns exhaustion via evaluateWithJudge", async () => {
			const goal = { ...createPiLocalGoalState("build feature"), turnsUsed: 19, maxTurns: 20 };
			const entries = [makeGoalEntry(goal)];
			const { handlers, createCtx, sendMessage, appendEntry } = setupExtension(entries);

			handlers.session_start({ type: "session_start", reason: "startup" }, createCtx());

			const msg = makeAssistantMessage("Still going...");
			handlers.turn_end(
				{ type: "turn_end", turnIndex: 0, message: msg, toolResults: [] } as unknown as TurnEndEvent,
				createCtx(),
			);

			vi.spyOn(JudgeService.prototype, "evaluate").mockResolvedValue({
				verdict: "continue",
				done: false,
				reason: "not done yet",
				parseFailed: false,
			});

			await handlers.agent_end(
				{ type: "agent_end", messages: [] } as unknown as AgentEndEvent,
				createCtx({ isIdle: true }),
			);

			vi.runAllTimers();
			expect(sendMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ customType: "pi-goal-hermes:continuation" }),
			);
			expect(appendEntry).toHaveBeenCalledWith(
				GOAL_CUSTOM_TYPE,
				expect.objectContaining({
					goal: expect.objectContaining({ status: "paused", pausedReason: "maxTurns budget exhausted" }),
				}),
			);
		});

		it("pauses after consecutive parse failures reach threshold", async () => {
			const goal = { ...createPiLocalGoalState("build feature"), consecutiveParseFailures: 2 };
			const entries = [makeGoalEntry(goal)];
			const { handlers, createCtx, sendMessage, appendEntry } = setupExtension(entries);

			handlers.session_start({ type: "session_start", reason: "startup" }, createCtx());

			const msg = makeAssistantMessage("Working...");
			handlers.turn_end(
				{ type: "turn_end", turnIndex: 0, message: msg, toolResults: [] } as unknown as TurnEndEvent,
				createCtx(),
			);

			vi.spyOn(JudgeService.prototype, "evaluate").mockResolvedValue({
				verdict: "continue",
				done: false,
				reason: "judge reply was not JSON: garbage",
				parseFailed: true,
			});

			await handlers.agent_end(
				{ type: "agent_end", messages: [] } as unknown as AgentEndEvent,
				createCtx({ isIdle: true }),
			);

			vi.runAllTimers();
			expect(sendMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ customType: "pi-goal-hermes:continuation" }),
			);
			expect(appendEntry).toHaveBeenCalledWith(
				GOAL_CUSTOM_TYPE,
				expect.objectContaining({
					goal: expect.objectContaining({ status: "paused", pausedReason: "judge output was unparseable 3 times in a row" }),
				}),
			);
		});

		it("does nothing when no goal is active", async () => {
			const { handlers, createCtx, sendMessage } = setupExtension([]);

			const evaluateSpy = vi.spyOn(JudgeService.prototype, "evaluate");

			await handlers.agent_end(
				{ type: "agent_end", messages: [] } as unknown as AgentEndEvent,
				createCtx(),
			);

			expect(evaluateSpy).not.toHaveBeenCalled();
			expect(sendMessage).not.toHaveBeenCalled();
		});
	});

	describe("slash command handlers", () => {
		interface CommandDef {
			description: string;
			handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
		}

		function setupCommands(sessionEntries: SessionEntry[] = []) {
			const handlerMap: Partial<HandlerMap> = {};
			const mockAppendEntry = vi.fn();
			const mockSendMessage = vi.fn();
			const mockNotify = vi.fn();
			const mockRegisterCommand = vi.fn();

			const mockPi = {
				on: (event: string, handler: unknown) => {
					(handlerMap as Record<string, unknown>)[event] = handler;
				},
				registerCommand: mockRegisterCommand,
				registerMessageRenderer: vi.fn(),
				appendEntry: mockAppendEntry,
				sendMessage: mockSendMessage,
			} as unknown as ExtensionAPI;

			piGoalHermes(mockPi);

			const commands: Record<string, CommandDef> = {};
			for (const call of mockRegisterCommand.mock.calls) {
				commands[call[0] as string] = call[1] as CommandDef;
			}

			function createCommandCtx(overrides: {
				signal?: { aborted: boolean };
				hasPendingMessages?: boolean;
				isIdle?: boolean;
				entries?: SessionEntry[];
			} = {}): ExtensionCommandContext {
				const entries = overrides.entries ?? sessionEntries;
				return {
					sessionManager: {
						getBranch: () => entries,
						getEntries: () => entries,
					},
					ui: {
						notify: mockNotify,
						setStatus: vi.fn(),
						theme: { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text },
					},
					signal: overrides.signal,
					hasPendingMessages: () => overrides.hasPendingMessages ?? false,
					isIdle: () => overrides.isIdle ?? true,
				} as unknown as ExtensionCommandContext;
			}

			return {
				commands,
				handlers: handlerMap as HandlerMap,
				appendEntry: mockAppendEntry,
				sendMessage: mockSendMessage,
				notify: mockNotify,
				createCtx: createCommandCtx,
			};
		}

		describe("/goal command", () => {
			it("shows 'no goal' status when none is set", async () => {
				const { commands, createCtx, notify } = setupCommands([]);
				await commands.goal.handler("", createCtx());
				expect(notify).toHaveBeenCalledWith(
					expect.stringContaining("No goal is set"),
					"info",
				);
			});

			it("shows 'no goal' status with explicit 'status' arg when none set", async () => {
				const { commands, createCtx, notify } = setupCommands([]);
				await commands.goal.handler("status", createCtx());
				expect(notify).toHaveBeenCalledWith(
					expect.stringContaining("No goal is set"),
					"info",
				);
			});

			it("shows goal status when one is active", async () => {
				const goal = createPiLocalGoalState("ship feature");
				const entries = [makeGoalEntry(goal)];
				const { commands, handlers, createCtx, notify } = setupCommands(entries);
				handlers.session_start({ type: "session_start", reason: "startup" }, createCtx() as unknown as ExtensionContext);
				await commands.goal.handler("status", createCtx());
				expect(notify).toHaveBeenCalledWith(
					expect.stringContaining("ship feature"),
					"info",
				);
				expect(notify).toHaveBeenCalledWith(
					expect.stringContaining("active"),
					"info",
				);
			});

			it("sets a new goal", async () => {
				const { commands, createCtx, notify, appendEntry } = setupCommands([]);
				await commands.goal.handler("build the widget", createCtx());
				expect(notify).toHaveBeenCalledWith("Goal set: build the widget", "info");
				expect(appendEntry).toHaveBeenCalledWith(
					GOAL_CUSTOM_TYPE,
					expect.objectContaining({
						goal: expect.objectContaining({ goal: "build the widget", status: "active" }),
					}),
				);
			});

			it("replaces active goal and notifies", async () => {
				const goal = createPiLocalGoalState("old goal");
				const entries = [makeGoalEntry(goal)];
				const { commands, handlers, createCtx, notify } = setupCommands(entries);
				handlers.session_start({ type: "session_start", reason: "startup" }, createCtx() as unknown as ExtensionContext);

				await commands.goal.handler("new goal", createCtx());
				expect(notify).toHaveBeenCalledWith(
					expect.stringContaining('Replacing active goal: "old goal"'),
					"info",
				);
				expect(notify).toHaveBeenCalledWith("Goal set: new goal", "info");
			});

			it("pauses an active goal with /goal pause", async () => {
				const goal = createPiLocalGoalState("active goal");
				const entries = [makeGoalEntry(goal)];
				const { commands, handlers, createCtx, notify, appendEntry } = setupCommands(entries);
				handlers.session_start({ type: "session_start", reason: "startup" }, createCtx() as unknown as ExtensionContext);

				await commands.goal.handler("pause", createCtx());
				expect(notify).toHaveBeenCalledWith("Goal paused (user pause).", "info");
				expect(appendEntry).toHaveBeenCalledWith(
					GOAL_CUSTOM_TYPE,
					expect.objectContaining({
						goal: expect.objectContaining({ status: "paused", pausedReason: "user pause" }),
					}),
				);
			});

			it("stops an active goal with /goal stop", async () => {
				const goal = createPiLocalGoalState("active goal");
				const entries = [makeGoalEntry(goal)];
				const { commands, handlers, createCtx, notify, appendEntry } = setupCommands(entries);
				handlers.session_start({ type: "session_start", reason: "startup" }, createCtx() as unknown as ExtensionContext);

				await commands.goal.handler("stop", createCtx());
				expect(notify).toHaveBeenCalledWith("Goal paused (user stop).", "info");
				expect(appendEntry).toHaveBeenCalledWith(
					GOAL_CUSTOM_TYPE,
					expect.objectContaining({
						goal: expect.objectContaining({ status: "paused", pausedReason: "user stop" }),
					}),
				);
			});

			it("warns when pausing with no active goal", async () => {
				const { commands, createCtx, notify } = setupCommands([]);
				await commands.goal.handler("pause", createCtx());
				expect(notify).toHaveBeenCalledWith("No active goal to pause.", "warning");
			});

			it("resumes a paused goal", async () => {
				const goal = { ...createPiLocalGoalState("paused goal"), status: "paused" as const, pausedReason: "user pause" };
				const entries = [makeGoalEntry(goal)];
				const { commands, handlers, createCtx, notify, appendEntry } = setupCommands(entries);
				handlers.session_start({ type: "session_start", reason: "startup" }, createCtx() as unknown as ExtensionContext);

				await commands.goal.handler("resume", createCtx());
				expect(notify).toHaveBeenCalledWith("Goal resumed: paused goal", "info");
				expect(appendEntry).toHaveBeenCalledWith(
					GOAL_CUSTOM_TYPE,
					expect.objectContaining({
						goal: expect.objectContaining({ status: "active", turnsUsed: 0, consecutiveParseFailures: 0, pausedReason: null }),
					}),
				);
			});

			it("warns when resuming with no paused goal", async () => {
				const { commands, createCtx, notify } = setupCommands([]);
				await commands.goal.handler("resume", createCtx());
				expect(notify).toHaveBeenCalledWith("No paused goal to resume.", "warning");
			});

			it("marks an active goal as done", async () => {
				const goal = createPiLocalGoalState("done goal");
				const entries = [makeGoalEntry(goal)];
				const { commands, handlers, createCtx, notify, appendEntry } = setupCommands(entries);
				handlers.session_start({ type: "session_start", reason: "startup" }, createCtx() as unknown as ExtensionContext);

				await commands.goal.handler("done", createCtx());
				expect(notify).toHaveBeenCalledWith("Goal marked done.", "info");
				expect(appendEntry).toHaveBeenCalledWith(
					GOAL_CUSTOM_TYPE,
					expect.objectContaining({
						goal: expect.objectContaining({ status: "done", lastVerdict: "done", lastReason: "marked done by user" }),
					}),
				);
			});

			it("warns when marking done with no goal", async () => {
				const { commands, createCtx, notify } = setupCommands([]);
				await commands.goal.handler("done", createCtx());
				expect(notify).toHaveBeenCalledWith("No goal to mark done.", "warning");
			});

			it("clears a goal", async () => {
				const goal = createPiLocalGoalState("to clear");
				const entries = [makeGoalEntry(goal)];
				const { commands, handlers, createCtx, notify, appendEntry } = setupCommands(entries);
				handlers.session_start({ type: "session_start", reason: "startup" }, createCtx() as unknown as ExtensionContext);

				await commands.goal.handler("clear", createCtx());
				expect(notify).toHaveBeenCalledWith("Goal cleared.", "info");
				expect(appendEntry).toHaveBeenCalledWith(
					GOAL_CUSTOM_TYPE,
					expect.objectContaining({
						goal: expect.objectContaining({ status: "cleared" }),
					}),
				);
			});

			it("warns when clearing with no goal", async () => {
				const { commands, createCtx, notify } = setupCommands([]);
				await commands.goal.handler("clear", createCtx());
				expect(notify).toHaveBeenCalledWith("No goal to clear.", "warning");
			});

			it("provides argument completions", () => {
				const { commands } = setupCommands([]);
				const completions = commands.goal.getArgumentCompletions!("");
				expect(completions).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ value: "status" }),
						expect.objectContaining({ value: "pause" }),
						expect.objectContaining({ value: "stop" }),
						expect.objectContaining({ value: "resume" }),
						expect.objectContaining({ value: "done" }),
						expect.objectContaining({ value: "clear" }),
					]),
				);
			});

			it("filters argument completions by prefix", () => {
				const { commands } = setupCommands([]);
				const completions = commands.goal.getArgumentCompletions!("s");
				expect(completions).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ value: "status" }),
						expect.objectContaining({ value: "stop" }),
					]),
				);
				expect(completions!.length).toBe(2);
			});
		});

		describe("/subgoal command", () => {
			it("warns when no goal set on /subgoal list", async () => {
				const { commands, createCtx, notify } = setupCommands([]);
				await commands.subgoal.handler("", createCtx());
				expect(notify).toHaveBeenCalledWith("No goal is set.", "warning");
			});

			it("shows empty subgoals message", async () => {
				const goal = createPiLocalGoalState("main goal");
				const entries = [makeGoalEntry(goal)];
				const { commands, handlers, createCtx, notify } = setupCommands(entries);
				handlers.session_start({ type: "session_start", reason: "startup" }, createCtx() as unknown as ExtensionContext);

				await commands.subgoal.handler("list", createCtx());
				expect(notify).toHaveBeenCalledWith("No subgoals.", "info");
			});

			it("adds a subgoal", async () => {
				const goal = createPiLocalGoalState("main goal");
				const entries = [makeGoalEntry(goal)];
				const { commands, handlers, createCtx, notify, appendEntry } = setupCommands(entries);
				handlers.session_start({ type: "session_start", reason: "startup" }, createCtx() as unknown as ExtensionContext);

				await commands.subgoal.handler("write tests", createCtx());
				expect(notify).toHaveBeenCalledWith("Subgoal added: write tests", "info");
				expect(appendEntry).toHaveBeenCalledWith(
					GOAL_CUSTOM_TYPE,
					expect.objectContaining({
						goal: expect.objectContaining({ subgoals: ["write tests"] }),
					}),
				);
			});

			it("lists numbered subgoals", async () => {
				const goal = { ...createPiLocalGoalState("main goal"), subgoals: ["task A", "task B"] };
				const entries = [makeGoalEntry(goal)];
				const { commands, handlers, createCtx, notify } = setupCommands(entries);
				handlers.session_start({ type: "session_start", reason: "startup" }, createCtx() as unknown as ExtensionContext);

				await commands.subgoal.handler("list", createCtx());
				expect(notify).toHaveBeenCalledWith("1. task A\n2. task B", "info");
			});

			it("removes a subgoal by index", async () => {
				const goal = { ...createPiLocalGoalState("main goal"), subgoals: ["task A", "task B", "task C"] };
				const entries = [makeGoalEntry(goal)];
				const { commands, handlers, createCtx, notify, appendEntry } = setupCommands(entries);
				handlers.session_start({ type: "session_start", reason: "startup" }, createCtx() as unknown as ExtensionContext);

				await commands.subgoal.handler("remove 2", createCtx());
				expect(notify).toHaveBeenCalledWith("Subgoal removed: task B", "info");
				expect(appendEntry).toHaveBeenCalledWith(
					GOAL_CUSTOM_TYPE,
					expect.objectContaining({
						goal: expect.objectContaining({ subgoals: ["task A", "task C"] }),
					}),
				);
			});

			it("warns on out-of-range subgoal removal", async () => {
				const goal = { ...createPiLocalGoalState("main goal"), subgoals: ["task A"] };
				const entries = [makeGoalEntry(goal)];
				const { commands, handlers, createCtx, notify } = setupCommands(entries);
				handlers.session_start({ type: "session_start", reason: "startup" }, createCtx() as unknown as ExtensionContext);

				await commands.subgoal.handler("remove 5", createCtx());
				expect(notify).toHaveBeenCalledWith("Subgoal index out of range.", "warning");
			});

			it("warns on non-numeric subgoal removal", async () => {
				const goal = { ...createPiLocalGoalState("main goal"), subgoals: ["task A"] };
				const entries = [makeGoalEntry(goal)];
				const { commands, handlers, createCtx, notify } = setupCommands(entries);
				handlers.session_start({ type: "session_start", reason: "startup" }, createCtx() as unknown as ExtensionContext);

				await commands.subgoal.handler("remove abc", createCtx());
				expect(notify).toHaveBeenCalledWith("Subgoal index out of range.", "warning");
			});

			it("clears all subgoals", async () => {
				const goal = { ...createPiLocalGoalState("main goal"), subgoals: ["task A", "task B"] };
				const entries = [makeGoalEntry(goal)];
				const { commands, handlers, createCtx, notify, appendEntry } = setupCommands(entries);
				handlers.session_start({ type: "session_start", reason: "startup" }, createCtx() as unknown as ExtensionContext);

				await commands.subgoal.handler("clear", createCtx());
				expect(notify).toHaveBeenCalledWith("Subgoals cleared.", "info");
				expect(appendEntry).toHaveBeenCalledWith(
					GOAL_CUSTOM_TYPE,
					expect.objectContaining({
						goal: expect.objectContaining({ subgoals: [] }),
					}),
				);
			});

			it("warns when clearing subgoals with no goal", async () => {
				const { commands, createCtx, notify } = setupCommands([]);
				await commands.subgoal.handler("clear", createCtx());
				expect(notify).toHaveBeenCalledWith("No goal is set.", "warning");
			});

			it("provides argument completions", () => {
				const { commands } = setupCommands([]);
				const completions = commands.subgoal.getArgumentCompletions!("");
				expect(completions).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ value: "list" }),
						expect.objectContaining({ value: "remove" }),
						expect.objectContaining({ value: "clear" }),
					]),
				);
			});

			it("filters subgoal argument completions by prefix", () => {
				const { commands } = setupCommands([]);
				const completions = commands.subgoal.getArgumentCompletions!("r");
				expect(completions).toEqual([expect.objectContaining({ value: "remove" })]);
			});
		});
	});
});
