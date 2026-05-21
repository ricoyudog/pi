---
type: memory
created: 2026-05-21
---

# MEMORY — Hard Constraints

> AI agent must obey these every session. Never expires.

## Project Identity
- **Name**: Pi
- **Purpose**: Interactive coding agent CLI and agent runtime with tool calling, state management, and unified multi-provider LLM API
- **Stack**: TypeScript, Node.js (>=22.19.0), npm workspaces (monorepo), Biome (lint/format), tsgo (type check), Vitest (test)

## Hard Constraints
- No `any` types unless absolutely necessary
- NEVER use inline imports (no `await import()`, no `import("pkg").Type`)
- NEVER remove or downgrade code to fix type errors; upgrade the dependency instead
- Use only erasable TypeScript syntax (no enum, namespace, parameter properties, import/export =)
- NEVER modify `packages/ai/src/models.generated.ts` directly
- NEVER commit unless user asks
- NEVER run `npm run build` or `npm test`
- No emojis in commits, issues, PR comments, or code
- All keybindings must be configurable
- Single-line helper functions with a single call site are forbidden; inline them
- Always ask before removing functionality or code that appears intentional

## Preferences
- Keep answers short and concise; technical prose only
- After code changes: `npm run check` (full output, fix all errors/warnings/infos)
- Run tests from the package root, not the repo root
- Use `git add <specific-files>` only, never `git add -A` or `git add .`
- Write full comments to temp file and use `--body-file` for gh issue/PR comments
