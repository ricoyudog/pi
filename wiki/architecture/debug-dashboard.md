---
type: wiki
updated: 2026-05-26
---

# Debug Dashboard

> Real-time visualization of pi agent sessions, showing turns, judge verdicts, goal events, and continuation prompts. Runs as a pi extension with auto-follow and system prompt visibility.

## Starting the Dashboard

The debug dashboard is a pi extension at `.pi/extensions/pi-debug-dashboard/`. Start it with:

```
/dashboard start
```

Then open `http://localhost:9848` in a browser.

## Architecture

```
~/.pi/agent/sessions/**/*.jsonl → extension (HTTP + SSE) → dashboard.html (browser)
```

- **Extension entry**: `.pi/extensions/pi-debug-dashboard/index.ts` — registers `/dashboard` command, hooks `before_agent_start` (captures system prompt) and `session_start` (auto-watch new sessions)
- **Server**: `.pi/extensions/pi-debug-dashboard/server.ts` — HTTP+SSE server, auto-discovers sessions from `~/.pi/agent/sessions/`, metadata peeking with mtime cache, auto-follow timer (2s), exposes `broadcast()`, `watchSession()`, `setSystemPrompt()` on `DashboardServer` interface
- **UI**: `.pi/extensions/pi-debug-dashboard/dashboard.html` — SPA with session selector (enriched labels: goal/message/cwd), system prompt collapsible panel, auto-follow toggle

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Serves `dashboard.html` |
| `/events` | GET (SSE) | Real-time stream of new log entries + system prompt |
| `/entries` | GET | Full JSON array of all parsed entries |
| `/sessions` | GET | List discovered sessions with metadata |
| `/session-files?dir=` | GET | List session files in a directory |
| `/load-session` | POST | Load a specific session by path |
| `/auto-follow` | POST | Enable/disable auto-follow mode |

## Key Features

### Auto-Follow

ON by default. Polls every 2s for new session files in `~/.pi/agent/sessions/`. When a new session appears (via `session_start` hook or filesystem discovery), the dashboard automatically switches to it. Disabled when the user manually selects a session; re-enabled via the UI toggle.

### System Prompt Visibility

The `before_agent_start` hook captures the full system prompt and stores it on the server. Late-connecting clients receive it immediately; live clients get it as an SSE event. Displayed in a collapsible panel in the UI.

### Session Metadata Peeking

For the session selector, the server reads the first 4KB / 20 lines of each session file to extract:
- `cwd` (working directory)
- `sessionId`
- `firstMessage` (user's initial prompt)
- `goalText` (if goal-hermes is active)

Results are cached by filename + mtime — no re-read unless the file changes.

### Judge Verdicts

Judge verdicts are visible because sessions are properly tracked via auto-follow and the `session_start` hook. When a judge verdict appears, the detail view shows:

- **Verdict badge**: DONE (green) or CONTINUE (orange)
- **Model + Duration**: e.g. `claude-haiku-4-5 | 1234ms`
- **Reason**: judge's reasoning text
- **Prompt** (collapsible): full prompt sent to judge LLM
- **Raw Response** (collapsible): judge LLM's raw output
- **Usage**: token counts if available

## Log Entry Types

The dashboard groups raw log lines into these display types:

| Type | Source | Sidebar Style |
|------|--------|---------------|
| Turn (assistant) | `role: "assistant"` | Blue left border |
| Turn (user) | `role: "user"` | Default |
| Tool Result | `role: "toolResult"` | Default |
| Goal Event | `customType: "pi-goal-hermes:event"` | Orange left border |
| Judge Verdict | `customType: "pi-goal-hermes:judge"` | Green (done) / Red (continue) border |
| Continuation | `customType: "pi-goal-hermes:continuation"` | Purple left border |

## Comparison with Goal Trace Dashboard

| | Debug Dashboard (port 9848) | Goal Trace Dashboard (port 9847) |
|---|---|---|
| Data source | `~/.pi/agent/sessions/` (all messages) | `.pi/traces/*.jsonl` (trace events) |
| Shows judge details | Yes (prompt, response, verdict) | No |
| Shows continuation prompts | Yes | No |
| Shows tool calls | Yes (full content) | Partial (names only) |
| Real-time | Yes (SSE) | Yes (SSE) |
| Auto-follow | Yes (2s poll) | No |
| System prompt | Yes (collapsible panel) | No |
