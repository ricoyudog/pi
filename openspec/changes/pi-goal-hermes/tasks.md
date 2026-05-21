<!-- Task Groups (## headings) are checkpoint units. Each group becomes a child GitHub issue. Apply executes one group at a time. -->

## 1. Extension Scaffold & State Types

- [x] 1.1 Create `.pi/extensions/pi-goal-hermes/` directory structure with `index.ts`, `goal-state.ts`, `judge-service.ts`, `continuation-prompt.ts`, `goal-manager.ts`, and `goal-manager.test.ts`
- [x] 1.2 Define `PiLocalGoalState` interface and `PiLocalGoalStatus` type union (`active | paused | done | cleared`) in `goal-state.ts`
- [x] 1.3 Implement `createPiLocalGoalState(goal, maxTurns?)` factory function with UUID generation, default maxTurns=20, and correct initial field values
- [x] 1.4 Implement `persist(pi, ctx, state)` function using `pi.appendEntry("pi-goal-hermes:state", { goal: state })`
- [x] 1.5 Implement `latestStateFromSession(ctx)` function: scan from leaf backward using `ctx.sessionManager.getBranch()` (fallback to `getEntries()`), return null for status="cleared"
- [x] 1.6 Define `GOAL_CUSTOM_TYPE = "pi-goal-hermes:state"` constant and export all types
- [x] 1.7 Create empty extension entry point (`index.ts`) with `export default function piGoalHermes(pi: ExtensionAPI)` skeleton that registers placeholder event handlers and commands
- [x] 1.8 Add `package.json` with correct peerDependencies on `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`

## 2. Judge Service

- [x] 2.1 Implement `JUDGE_SYSTEM_PROMPT` constant matching Hermes source verbatim (three OR paths for DONE, single-line JSON output requirement)
- [x] 2.2 Implement `buildJudgeUserPrompt(goal, response)` function matching Hermes template
- [x] 2.3 Implement `buildJudgeUserPromptWithSubgoals(goal, response, subgoals)` function matching Hermes template with numbered criteria and specific-evidence instruction
- [x] 2.4 Implement `truncate(text, maxLen)` utility (goal<=2000, response<=4000, subgoals<=2000)
- [x] 2.5 Implement `parseJudgeResponse(raw)` with 3-tier fallback: (1) clean JSON, (2) markdown fence extraction, (3) regex embedded JSON search. Return `{ done, reason, parseFailed }`
- [x] 2.6 Implement `JudgeService.evaluate(input, ctx)`: model lookup via `ctx.modelRegistry.find` (claude-haiku-4-5 then gpt-4o-mini), auth via `getApiKeyAndHeaders`, `streamSimple` with temperature=0, timeoutMs=30000, signal=ctx.signal
- [x] 2.7 Implement fail-open error handling in `JudgeService.evaluate`: no model -> continue/no-counter, auth failure -> continue/no-counter, API/transport error -> continue/no-counter
- [x] 2.8 Write unit tests for `parseJudgeResponse`: clean JSON, markdown fence, prose embedded, completely unparseable
- [x] 2.9 Write unit tests for `JudgeService.evaluate` with mocked streamSimple: done verdict, continue verdict, API error, auth failure, no model available, timeout

## 3. Core Evaluation Logic

- [ ] 3.1 Implement `evaluateWithJudge(pi, ctx, state, lastResponse)` in `goal-manager.ts` following exact Hermes sequence: (1) turnsUsed++ (2) call judge (3) check done (4) update parse counter (5) check >=3 failures (6) check budget (7) return continue
- [ ] 3.2 On verdict="done": set status="done", persist, return `{ shouldContinue: false, statusMessage: "Goal achieved" }`
- [ ] 3.3 On parseFailed: increment consecutiveParseFailures; on success: reset to 0
- [ ] 3.4 On consecutiveParseFailures >= 3: set status="paused" with reason, persist, return shouldContinue=false
- [ ] 3.5 On turnsUsed >= maxTurns: set status="paused" with budget reason, persist, return shouldContinue=false
- [ ] 3.6 On continue (normal): persist updated state, return `{ shouldContinue: true, continuationPrompt: makeContinuationPrompt(state) }`
- [ ] 3.7 Write unit tests covering all branches: done, continue, parse-fail-open, parse-fail-pause, budget-exhausted, counter-reset-on-success

## 4. Continuation Prompt & Queue Mechanism

- [ ] 4.1 Implement `makeContinuationPrompt(state)` in `continuation-prompt.ts`: basic template (no subgoals) matching Hermes verbatim
- [ ] 4.2 Implement subgoals variant of `makeContinuationPrompt`: numbered criteria + "Continue working toward the goal AND all additional criteria" instruction
- [ ] 4.3 Implement `queueContinuation(pi, ctx, state)` with: `continuationQueued` dedup flag, idle macrotask via `setTimeout(..., 0)`, stale guards (goal null / id mismatch / status != active / hasPendingMessages), `ctx.isIdle()` polling with max 10 retries
- [ ] 4.4 Implement the `pi.sendMessage` call inside queueContinuation with correct payload: `{ customType: "pi-goal-hermes:continuation", content: [{type:"text", text: prompt}], display: true, details: { goalId } }` and options `{ deliverAs: "followUp", triggerTurn: true }`
- [ ] 4.5 Implement `continuationQueued` flag reset on both successful send and all abandon paths (stale, exhausted retries)
- [ ] 4.6 Write unit tests for queueContinuation: dedup prevention, stale-goal abandon, stale-id abandon, pending-messages abandon, retry exhaustion, successful send

## 5. Event Handlers Integration

- [ ] 5.1 Implement `session_start` handler: call `latestStateFromSession(ctx)`, restore goal state, handle reload auto-pause (reason="reload"), notify user of restored/paused state
- [ ] 5.2 Implement `turn_end` handler: guard on `goal?.status === "active"`, extract text content from event.message, store lastAssistantContent/lastAssistantStopReason/lastAssistantErrorMessage
- [ ] 5.3 Implement `agent_end` handler entry guards: check goal active, check ctx.signal?.aborted (-> pause), check ctx.hasPendingMessages() (-> skip), check error/aborted stopReason (-> pause), check empty response (-> skip)
- [ ] 5.4 Implement `agent_end` core flow: call `evaluateWithJudge`, display statusMessage, if shouldContinue call `queueContinuation`
- [ ] 5.5 Wire all handlers in `index.ts` entry point: `pi.on("session_start", ...)`, `pi.on("turn_end", ...)`, `pi.on("agent_end", ...)`
- [ ] 5.6 Write integration tests: full goal loop with mock judge (agent_end -> idle macrotask -> next turn trigger), user interruption flow, maxTurns exhaustion, consecutive parse failures -> pause

## 6. Slash Commands

- [ ] 6.1 Implement `/goal <text>` handler: create new PiLocalGoalState, persist, emit goal event, queue continuation if idle; handle replacement confirmation when active goal exists
- [ ] 6.2 Implement `/goal status` handler: display goal text, status, progress (turnsUsed/maxTurns), last verdict/reason
- [ ] 6.3 Implement `/goal pause` and `/goal stop` handlers: transition to paused with appropriate reason, persist
- [ ] 6.4 Implement `/goal resume` handler: reset turnsUsed=0 and consecutiveParseFailures=0, transition to active, persist, queue continuation if idle
- [ ] 6.5 Implement `/goal done` handler: transition to done with lastVerdict="done" and lastReason="marked done by user", persist
- [ ] 6.6 Implement `/goal clear` handler: persist cleared terminal state via appendEntry THEN set runtime goal=null
- [ ] 6.7 Implement `/subgoal <text>` handler: append to subgoals array, persist, show confirmation
- [ ] 6.8 Implement `/subgoal list` handler: display numbered subgoals or "No subgoals."
- [ ] 6.9 Implement `/subgoal remove <n>` handler: validate 1-based index, remove, persist
- [ ] 6.10 Implement `/subgoal clear` handler: empty subgoals array, persist
- [ ] 6.11 Register both commands with `pi.registerCommand("goal", {...})` and `pi.registerCommand("subgoal", {...})` including `getArgumentCompletions`
- [ ] 6.12 Write tests for all command handlers: set/status/pause/stop/resume/done/clear, subgoal add/list/remove/clear, replacement confirmation flow

## 7. Message Rendering & Polish

- [ ] 7.1 Implement `emitGoalEvent(pi, eventType, state, options?)` helper for dispatching UI event messages with customType "pi-goal-hermes:event"
- [ ] 7.2 Register `pi.registerMessageRenderer("pi-goal-hermes:event", ...)` with collapsed mode ("Goal continuing (ctrl+o to expand)") and expanded mode (full status + objective + usage)
- [ ] 7.3 Register `pi.registerMessageRenderer("pi-goal-hermes:continuation", ...)` with collapsed continuation display
- [ ] 7.4 Implement footer status line integration (if available): "Pursuing goal" / "Goal paused" / "Goal achieved"
- [ ] 7.5 Verify all user-facing notifications use `ctx.ui.notify` with correct severity levels (info/warning)

## 8. Regression Tests & Edge Cases

- [ ] 8.1 Write regression test T01: agent_end judge=continue uses idle macrotask + ctx.isIdle() + triggerTurn:true
- [ ] 8.2 Write regression test T02: tool-call chain multiple turn_end, judge only at agent_end
- [ ] 8.3 Write regression test T03: custom continuation message is user-role in LLM context
- [ ] 8.4 Write regression test T06: empty response skips judge, no turnsUsed increment
- [ ] 8.5 Write regression test T07: stale continuation abandoned (pause/clear/new-goal/pending-user)
- [ ] 8.6 Write regression test T08: /goal clear persists cleared then nullifies, reload does not restore
- [ ] 8.7 Write regression test T12: Ctrl+C / aborted signal -> auto-pause
- [ ] 8.8 Write regression test T13: sendMessage payload uses only { customType, content, display, details }
- [ ] 8.9 Write regression test T14: error/aborted assistant response -> pause, no judge
- [ ] 8.10 Write regression test T15: judge timeout/abort treated as transport error (fail-open)
- [ ] 8.11 Run all tests and ensure zero failures before declaring implementation complete
