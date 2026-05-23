---
type: wiki
updated: 2026-05-23
---

# Pi Goal Hermes - Evaluate Method

> Documents the `evaluateWithJudge` function — the core decision point in the goal continuation loop.

## Location

`.pi/extensions/pi-goal-hermes/goal-manager.ts`

## Signature

```typescript
evaluateWithJudge(pi: ExtensionAPI, ctx: ExtensionContext, state: PiLocalGoalState, lastResponse: string): Promise<EvaluateWithJudgeResult>
```

## Flow

Called at `agent_end` after each turn where the goal is `active` and the assistant produced text.

1. Increments `state.turnsUsed`
2. Calls `JudgeService.evaluate()` with `{ goal, response, subgoals }` — secondary LLM (haiku) judges whether the goal is met
3. Stores `verdict` and `reason` on state
4. Decision tree:
   - **verdict.done** → status=`done`, persist, return `shouldContinue: false`
   - **verdict.parseFailed** 3x consecutive → status=`paused`, reason="unparseable", return `shouldContinue: false`
   - **turnsUsed >= maxTurns** → status=`paused`, reason="budget exhausted", return `shouldContinue: false`
   - **otherwise** → status=`active`, return `shouldContinue: true` + continuation prompt

## Return Type

```typescript
interface EvaluateWithJudgeResult {
  shouldContinue: boolean;
  statusMessage?: string;
  continuationPrompt?: string;
}
```

## Pause Conditions

| Condition | pausedReason |
|-----------|-------------|
| 3 consecutive parse failures | `"judge output was unparseable 3 times in a row"` |
| Turn budget exhausted | `"maxTurns budget exhausted"` |
| Error/abort stop reason | `"error: <message>"` or `"assistant response aborted"` (handled in index.ts) |
| Session reload | `"reload"` (handled in index.ts) |
| Ctrl+C interrupt | `"interrupted (Ctrl+C)"` (handled in index.ts) |

## Tracing

- State persisted via `pi.appendEntry("pi-goal-hermes:state", { goal: state })` — visible in session JSONL
- Events emitted via `pi.sendMessage("pi-goal-hermes:event", ...)` — visible in event stream
- Full prompt composition captured by `pi-goal-trace` extension → `.pi/traces/`
- Live monitoring: `npx tsx .pi/scripts/goal-monitor.ts`

## Judge Trace Emission

`JudgeService.evaluate()` now emits a `pi-goal-hermes:judge` custom entry to the debug log via `pi.sendMessage()`. This is the primary mechanism for observing judge behavior.

### Signature Change

```typescript
// Before
evaluate(input: JudgeServiceInput, ctx: ExtensionContext): Promise<JudgeVerdict>

// After
evaluate(input: JudgeServiceInput, ctx: ExtensionContext, pi?: ExtensionAPI): Promise<JudgeVerdict>
```

The `pi` parameter is optional for backward compatibility (tests can omit it). When provided, judge results are emitted to the debug log.

### Emitted Entry Shape

```typescript
interface JudgeEntryDetails {
  model: string;           // e.g. "claude-haiku-4-5"
  prompt: string;          // full user prompt sent to judge
  rawResponse: string | null; // judge LLM's raw text output
  verdict: "done" | "continue";
  reason: string;
  done: boolean;
  parseFailed: boolean;
  durationMs: number;      // wall-clock time for judge call
  usage: unknown;          // token usage from LLM response
}
```

### Emission Points

| Path | Emitted When |
|------|-------------|
| Success path | Judge call completes, verdict parsed → emits full details |
| Error path | Judge call throws → emits with `verdict: "continue"`, `rawResponse: null`, error as `reason` |

### Call Chain

```
index.ts agent_end hook
  → evaluateWithJudge(pi, ctx, state, lastResponse)
    → JudgeService.evaluate(input, ctx, pi)  // pi passed as 3rd arg
      → pi.sendMessage<JudgeEntryDetails>({ customType: "pi-goal-hermes:judge", ... })
```

### Other Changes in This Diff

- `findJudgeModel()` now uses `ctx.model` (the session's configured model) instead of hardcoded haiku/gpt-4o-mini
- `extractEmbeddedJson()` regex tightened to avoid false positives on non-JSON text
- `/resume` command now resets `lastVerdict` and `lastReason` on state

### Viewing Judge Entries

Use the debug dashboard: `npx tsx .pi/scripts/debug-dashboard-server.ts --port 9848`

See [[wiki/architecture/debug-dashboard|Debug Dashboard]] for full usage.
