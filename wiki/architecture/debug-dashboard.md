---
type: wiki
updated: 2026-05-23
---

# Debug Dashboard

> Real-time visualization of pi's debug log (`pi-debug.log`), showing turns, judge verdicts, goal events, and continuation prompts.

## Quick Start

```bash
cd /mnt/e/code/Pi
npx tsx .pi/scripts/debug-dashboard-server.ts --port 9848
```

Open `http://localhost:9848` in a browser.

## Architecture

```
pi-debug.log (JSON lines) → debug-dashboard-server.ts (HTTP + SSE) → debug-dashboard.html (browser)
```

- **Server**: `.pi/scripts/debug-dashboard-server.ts` — watches `~/.pi/agent/pi-debug.log` via `fs.watchFile`, parses JSON lines, serves SSE stream and static HTML
- **UI**: `.pi/scripts/debug-dashboard.html` — single-file SPA, connects to SSE, renders sidebar + detail view

## Server Options

| Flag | Default | Description |
|------|---------|-------------|
| `--log <path>` | `~/.pi/agent/pi-debug.log` | Path to debug log file |
| `--port <n>` | `9848` | HTTP port |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Serves `debug-dashboard.html` |
| `/events` | GET (SSE) | Real-time stream of new log entries |
| `/entries` | GET | Full JSON array of all parsed entries |

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

## Judge Entry Details

When a judge verdict appears, the detail view shows:

- **Verdict badge**: DONE (green) or CONTINUE (orange)
- **Model + Duration**: e.g. `claude-haiku-4-5 | 1234ms`
- **Reason**: judge's reasoning text
- **Prompt** (collapsible): full prompt sent to judge LLM
- **Raw Response** (collapsible): judge LLM's raw output
- **Usage**: token counts if available

## How It Works

1. `debug-dashboard-server.ts` polls `pi-debug.log` every 500ms via `fs.watchFile`
2. On size change, re-parses all JSON lines, diffs against cache, broadcasts delta via SSE
3. Browser receives `data: {entries: [...]}` events, appends to local array, re-renders sidebar
4. Clicking a sidebar item shows full detail in the main pane

## Comparison with Goal Trace Dashboard

| | Debug Dashboard (port 9848) | Goal Trace Dashboard (port 9847) |
|---|---|---|
| Data source | `pi-debug.log` (all messages) | `.pi/traces/*.jsonl` (trace events) |
| Shows judge details | Yes (prompt, response, verdict) | No |
| Shows continuation prompts | Yes | No |
| Shows tool calls | Yes (full content) | Partial (names only) |
| Real-time | Yes (SSE) | Yes (SSE) |

## Running in Background (tmux)

```bash
tmux new-session -d -s debug-dashboard "cd /mnt/e/code/Pi && npx tsx .pi/scripts/debug-dashboard-server.ts --port 9848"
```
