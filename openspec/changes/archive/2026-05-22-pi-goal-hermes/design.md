## Context

Pi is a modular coding agent with a public extension API. The agent runs in a loop: user message -> tool calls -> assistant response -> stop. Currently, multi-step objectives require the user to manually re-prompt after each stopping point.

The Hermes project (Claude Code fork) implemented a goal continuation system where an external judge LLM evaluates whether the objective is complete after each agent turn, and injects synthetic continuation messages to keep the agent working autonomously. This pattern has been validated in production.

The existing `pi-goal` extension (github.com/Michaelliv/pi-goal) proved that Pi's extension API supports this pattern, but takes a simplified approach (no external judge -- uses in-band self-audit). This design adds the external judge while maintaining the same extension API surface.

**Constraints:**
- Pi core (`agent-loop.ts`, `types.ts`) MUST NOT be modified
- `Agent.createLoopConfig()` is private -- no hook-patching possible
- `shouldStopAfterTurn` is not exposed in `AgentOptions`
- Extension API is the only viable integration surface
- The extension will live at `.pi/extensions/pi-goal-hermes/`

## Goals / Non-Goals

**Goals:**
- Faithfully reproduce the Hermes goal continuation loop using only Pi's public extension API
- External judge LLM evaluation (temperature=0, independent model) with Hermes-aligned prompts
- Robust fail-safe mechanisms (parse failure counting, maxTurns budget, error guards)
- User control via slash commands (pause, resume, clear, subgoals)
- Correct timing: judge at `agent_end` (not mid-tool-chain), continuation via idle macrotask

**Non-Goals:**
- New_symphony Goal Master Loop integration (multi-stage, review gates, kanban)
- Cross-session goal persistence (goals are single-session only)
- Token-budget-based stopping (uses turn count, matching Hermes)
- Modifying Pi core or coding-agent packages
- Multi-worker concurrent goals
- Structured handoff schema to external systems

## Unknowns & Investigation

### 1. Can `agent_end` handler reliably trigger the next turn?

**Unknown**: Pi's `agent_end` fires after the run-loop completes. Can a handler at this point inject a followUp message that starts a new run?

**Investigation**: Reviewed `agent-loop.ts` and `agent-session.ts`. The low-level run polls `getFollowUpMessages` before `agent_end` fires. During streaming, `sendCustomMessage(..., { triggerTurn: true })` is swallowed by the streaming branch. After `agent_end` returns, the system enters idle state.

**Conclusion**: Direct injection inside `agent_end` handler does NOT work. Must use an idle macrotask: `setTimeout(() => { if (ctx.isIdle()) pi.sendMessage(..., { triggerTurn: true }) }, 0)`. This schedules the continuation after the current event loop tick, when the agent is truly idle and `triggerTurn` can start a new run.

### 2. What is the correct `pi.sendMessage` payload shape?

**Unknown**: The extension API payload format for custom messages.

**Investigation**: Reviewed extension API types and pi-goal reference implementation.

**Conclusion**: Must use `{ customType, content, display, details }` -- NOT the old-style `{ type, data }` wrapper. The `type/role/timestamp` fields are set internally by Pi.

### 3. How do custom followUp messages appear in the LLM context?

**Unknown**: What role does a `custom` followUp message take when converted for the LLM?

**Investigation**: Traced `convertToLlm()` in the codebase.

**Conclusion**: Custom messages are converted to user-role LLM messages. This satisfies the Hermes "synthetic user message" requirement without modifying system prompts or toolsets.

### 4. Can the judge silently fall back to the main agent model?

**Unknown**: What happens if no lightweight judge model is configured?

**Investigation**: Hermes uses a dedicated `auxiliary.goal_judge` client separate from the main model.

**Conclusion**: Silent fallback to `ctx.model` violates the Hermes invariant of independent evaluation. If no dedicated judge model is available, the extension MUST fail-open (continue without judging) rather than use the main model. A future enhancement may allow explicit "degraded judge mode" with UI indication.

### 5. How to handle fork/branch scenarios in state recovery?

**Unknown**: When a session forks, which branch's goal state should be active?

**Investigation**: `pi.appendEntry` writes to the current branch. Recovery needs to scan only the current leaf branch.

**Conclusion**: Use `ctx.sessionManager.getBranch()` (scoped to current branch) when available; fall back to `getEntries()` only for backward compatibility with older Pi versions.

## Decisions

### 1. Extension API Event-Driven Architecture (vs Hook-Patching)

**Decision:** Use Pi extension API events (`turn_end`, `agent_end`, `session_start`) and commands (`pi.registerCommand`) exclusively. No core modifications.

**Rationale:** `Agent.createLoopConfig()` is private, `shouldStopAfterTurn` is not exposed. pi-goal has validated this approach in production. Event-driven architecture is maintainable and survives Pi core upgrades.

**Alternatives considered:**
- Fork pi core to expose hooks -- breaks on upgrades, maintenance burden
- Monkey-patch private methods -- fragile, version-dependent, unsafe

### 2. Judge at `agent_end` (vs `turn_end`)

**Decision:** Call the judge LLM in the `agent_end` handler, not `turn_end`.

**Rationale:** Pi's inner loop fires `turn_end` for EVERY assistant response in a tool-call chain. Judging mid-chain would incorrectly evaluate intermediate tool results. `agent_end` fires once when the entire tool chain completes -- semantically equivalent to Hermes's post-turn evaluation.

**Alternatives considered:**
- Judge at `turn_end` with tool-call filtering -- complex, error-prone heuristics
- Judge only on "final" turn_end -- no reliable signal for "final" before agent_end

### 3. Idle Macrotask Continuation (vs Direct Injection)

**Decision:** Use `setTimeout(() => {...}, 0)` with `ctx.isIdle()` polling (max 10 retries) to inject continuation after `agent_end`.

**Rationale:** Direct `sendMessage` inside `agent_end` handler fails because:
1. The current run-loop has already polled followUp messages
2. During streaming, `triggerTurn` is swallowed by the streaming branch
3. The agent must be truly idle for `triggerTurn` to start a new run

The idle macrotask defers injection to after the current event loop tick when the agent enters idle state.

**Alternatives considered:**
- Microtask (`Promise.resolve().then(...)`) -- still too early, agent may not be idle
- Fixed delay (`setTimeout(..., 100)`) -- brittle, timing-dependent
- `process.nextTick` -- same timing issues as microtask

### 4. Session Custom Entries for Persistence (vs JSON Files)

**Decision:** Use `pi.appendEntry(GOAL_CUSTOM_TYPE, { goal: state })` for all state persistence.

**Rationale:**
1. Automatic branch-following -- fork/branch semantics are correct
2. Atomic with conversation history -- no external file sync issues
3. Implicit version history -- every state change is a traceable entry
4. pi-goal validated this approach in production

**Alternatives considered:**
- JSON file in extension directory -- manual branch handling, race conditions
- SQLite -- overkill for single-session state, external dependency

### 5. Fail-Open Judge Semantics

**Decision:** Judge failures (API errors, timeouts, auth failures, no dedicated judge model) result in `continue` verdict without incrementing or resetting the parse failure counter. Only actual parse failures (valid response but unparseable output) increment the counter, and only successfully parsed judge replies reset it.

**Rationale:** Hermes explicitly distinguishes transport failures (fail-open, don't count) from output quality failures (fail-open but count). Three consecutive parse failures trigger auto-pause as a circuit breaker.

### 6. Dedicated Judge Model (No Silent Fallback)

**Decision:** If no lightweight judge model is found via `ctx.modelRegistry`, fail-open with `continue` verdict. Never silently use `ctx.model` (the main agent model).

**Rationale:** The Hermes invariant requires independent evaluation. Using the same model that produced the work to judge that work violates this principle. Fail-open is safer than degraded evaluation.

## Risks / Trade-offs

| Risk | Severity | Mitigation |
|------|----------|------------|
| `agent_end` timing changes in future Pi versions | Medium | Comprehensive regression tests lock the timing contract; idle-macrotask with retry is resilient |
| Judge false-positive (marks done prematurely) | Medium | User can `/goal resume`; prompt explicitly requires concrete evidence for subgoals |
| Judge false-negative (infinite continuation) | Low | `maxTurns` hard budget (default 20); user can `/goal pause` or `/goal stop` at any time |
| Lightweight model unavailable (no haiku/gpt-4o-mini) | Medium | Fail-open: continues without judging, user retains manual control |
| Context window bloat from continuation messages | Low | Pi's built-in compaction handles long sessions; continuation messages are short |
| Race condition: user message arrives during judge call | Low | `ctx.hasPendingMessages()` checked before AND after judge; stale goal-id guard in macrotask |
| Namespace collision with New_symphony `/goal` | Medium | Document requirement to rename commands in adapter mode; test T11 enforces |

## Data Model

### PiLocalGoalState (Session Custom Entry)

Persisted as `pi.appendEntry("pi-goal-hermes:state", { goal: <state> })`. Recovery scans from leaf entry backward.

```typescript
interface PiLocalGoalState {
  id: string;                          // UUID, used for stale-continuation guards
  goal: string;                        // User-provided objective text
  status: "active" | "paused" | "done" | "cleared";
  turnsUsed: number;                   // Incremented BEFORE judge call
  maxTurns: number;                    // Default 20, configurable at set time
  lastVerdict: "done" | "continue" | null;
  lastReason: string | null;           // Judge's rationale
  pausedReason: string | null;         // Why paused (budget, parse failures, user, error)
  consecutiveParseFailures: number;    // Reset on successful parse; >=3 triggers auto-pause
  subgoals: string[];                  // Extra acceptance criteria added via /subgoal
  createdAt: number;                   // Epoch ms
  updatedAt: number;                   // Epoch ms, updated on every state change
}
```

**State transitions:**
- `active` -> `paused` (user stop, maxTurns, parse failures >=3, error/aborted response, Ctrl+C)
- `active` -> `done` (judge verdict done, user `/goal done`)
- `active` -> `cleared` (user `/goal clear`)
- `paused` -> `active` (user `/goal resume` -- resets turnsUsed and parseFailures)
- `paused` -> `cleared` (user `/goal clear`)
- `done` -> `cleared` (user `/goal clear`)
- Any terminal -> new goal replaces (new id invalidates stale continuations)

## API Contracts

### Slash Commands (Extension Command API)

| Command | Arguments | Effect |
|---------|-----------|--------|
| `/goal <text>` | Objective text | Creates new goal, starts continuation loop |
| `/goal status` | (none) | Displays current goal state |
| `/goal pause` | (none) | Sets status=paused, stops continuation |
| `/goal stop` | (none) | Alias for pause with reason="user stop" |
| `/goal resume` | (none) | Resets turnsUsed/parseFailures, restarts loop |
| `/goal done` | (none) | Marks Pi-local done (not New_symphony completed) |
| `/goal clear` | (none) | Persists cleared state, nulls runtime pointer |
| `/subgoal <text>` | Criteria text | Appends to subgoals array |
| `/subgoal list` | (none) | Shows numbered subgoals |
| `/subgoal remove <n>` | 1-based index | Removes nth subgoal |
| `/subgoal clear` | (none) | Empties subgoals array |

### Extension Events Consumed

| Event | Handler Purpose |
|-------|----------------|
| `session_start` | Restore state from entries; auto-pause on reload |
| `turn_end` | Capture `lastAssistantContent` and `stopReason`/`errorMessage` |
| `agent_end` | Run judge evaluation; queue continuation if not done |

### Judge LLM Contract

- **Model**: `claude-haiku-4-5` or `gpt-4o-mini` (via `ctx.modelRegistry.find`)
- **Temperature**: 0
- **Max tokens**: 4096
- **Timeout**: 30,000ms
- **Input**: System prompt (fixed) + user prompt (goal + response + optional subgoals)
- **Output**: Single-line JSON `{"done": boolean, "reason": string}`

### Custom Message Types

| customType | Purpose |
|------------|---------|
| `pi-goal-hermes:state` | Persisted goal state entry |
| `pi-goal-hermes:continuation` | Continuation prompt injected as followUp |
| `pi-goal-hermes:event` | UI event messages (status changes, judge results) |
