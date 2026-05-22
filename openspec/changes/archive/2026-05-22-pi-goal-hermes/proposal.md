## Why

Pi lacks a goal-oriented continuation mechanism. Users must manually prompt the agent after each stopping point, even when the overall objective is not yet complete. The Hermes project solved this with an external judge LLM that evaluates completion after each agent turn and automatically injects continuation prompts until the goal is achieved. This extension brings that proven pattern to Pi using only the public extension API -- no core modifications required.

## What Changes

- Add a new Pi extension (`pi-goal-hermes`) that implements a single-session goal continuation loop with external judge LLM evaluation.
- Register `/goal` and `/subgoal` slash commands for goal lifecycle management (set, pause, resume, done, clear, status) and mid-loop acceptance criteria.
- Hook into `turn_end` and `agent_end` events to capture assistant responses and trigger judge evaluation at the correct timing boundary.
- Implement an idle-macrotask-based continuation injection (`sendMessage` with `triggerTurn: true`) that respects Pi's internal run-loop timing constraints.
- Introduce `PiLocalGoalState` persisted via `pi.appendEntry` in session custom entries (no external files, no core state mutation).
- Integrate a `JudgeService` that calls a lightweight model (claude-haiku-4-5 or gpt-4o-mini) with Hermes-aligned prompts (temperature=0, forced JSON output, 3-tier parse fallback).
- Implement fail-safe mechanisms: consecutive parse failure auto-pause, maxTurns budget, error/aborted response guards, user-message priority.

## Capabilities

### New Capabilities

- `goal-lifecycle`: Goal state machine (active/paused/done/cleared) with slash command interface, session persistence via appendEntry, and reload safety (auto-pause on reload).
- `judge-evaluation`: External LLM judge service with Hermes-aligned prompts, temperature=0, forced single-line JSON output, 3-tier parse fallback, and fail-open semantics.
- `continuation-loop`: Event-driven auto-continuation via idle macrotask + sendMessage(followUp, triggerTurn) that correctly handles Pi's agent_end timing, stale goal guards, and user-message priority.
- `subgoal-management`: Mid-loop acceptance criteria via /subgoal commands that modify judge evaluation prompts to require specific evidence per criterion.

### Modified Capabilities

(none -- this is a new extension with no modifications to existing Pi capabilities)

## Impact

- **Code**: New extension at `.pi/extensions/pi-goal-hermes/` (6 files). Zero modifications to pi core or coding-agent.
- **APIs**: Uses public extension API only: `pi.registerCommand`, `pi.on`, `pi.sendMessage`, `pi.appendEntry`, `pi.registerMessageRenderer`.
- **Dependencies**: Peer dependency on `@earendil-works/pi-coding-agent` (extension types) and `@earendil-works/pi-ai` (streamSimple for judge LLM calls).
- **LLM Cost**: Adds one lightweight judge call (~500 tokens) per continuation turn. Uses haiku/gpt-4o-mini, not the main agent model.
- **Session State**: Adds custom entries with type `pi-goal-hermes:state` to session storage. Does not modify existing session entries or core state.
- **Naming**: `/goal` and `/subgoal` commands. If deployed alongside New_symphony Goal Runtime, must rename to `/pi-goal` / `/pi-subgoal` to avoid namespace collision.

## GitHub Issue

- Parent issue: https://github.com/ricoyudog/pi/issues/1
