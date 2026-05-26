---
type: wiki
updated: 2026-05-26
status: completed
---

# Plan: Publish pi-goal-hermes to Community [COMPLETED]

> Detailed execution plan for extracting pi-goal-hermes into a standalone GitHub repo and publishing to pi.dev/packages.

## Result

Published successfully on 2026-05-23.

| Item | Value |
|------|-------|
| GitHub | https://github.com/ricoyudog/pi-goal-hermes |
| npm | https://www.npmjs.com/package/@ricoyudog/pi-goal-hermes |
| Version | 0.1.0 |
| Install | `pi install npm:@ricoyudog/pi-goal-hermes` |
| Package size | 9.6 kB (9 files) |
| pi.dev gallery | https://pi.dev/packages/@ricoyudog/pi-goal-hermes |

### Decisions Made

| # | Question | Decision |
|---|----------|----------|
| 1 | Package scope | `@ricoyudog/pi-goal-hermes` (scoped) |
| 2 | GitHub account | `ricoyudog` |
| 3 | File layout | Flat root (simpler) |
| 4 | npm account | `ricoyudog` |
| 5 | Mono-repo relationship | Keep local copy in `.pi/extensions/` for development |
| 6 | Gallery media | Plain first, no video/image yet |

### Notes

- The goal architecture is inspired by and ported from [Hermes](https://github.com/anthropics/hermes)'s goal continuation system
- No build step required - Pi loads TypeScript directly via jiti
- Peer deps use `"*"` range as per official Pi package docs
- `pi install npm:@ricoyudog/pi-goal-hermes` tested and confirmed working

---

## Overview

| Item | Value |
|------|-------|
| Package name | `pi-goal-hermes` (or `@<org>/pi-goal-hermes`) |
| Type | extension |
| Source files | 7 TS files (~1050 LOC) + 1 test file |
| Peer deps | `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` |
| Runtime deps | None (only Node built-ins: `node:crypto`) |
| Install command | `pi install npm:pi-goal-hermes` |

---

## Phase 1: Create GitHub Repository

### 1.1 Create repo on GitHub

```bash
gh repo create <org>/pi-goal-hermes --public --description "Goal-driven autonomous continuation for Pi coding agent" --license MIT
```

### 1.2 Initial repo structure

```
pi-goal-hermes/
├── package.json
├── README.md
├── LICENSE              (MIT)
├── .gitignore
├── extensions/
│   ├── index.ts
│   ├── goal-manager.ts
│   ├── judge-service.ts
│   ├── goal-state.ts
│   ├── event-renderer.ts
│   └── continuation-prompt.ts
└── test/
    └── goal-manager.test.ts
```

Note: Using `extensions/` directory (convention-based) instead of flat root with explicit manifest. Both work - explicit manifest is simpler for single-directory packages.

Alternative (simpler, matches current structure):
```
pi-goal-hermes/
├── package.json
├── README.md
├── LICENSE
├── .gitignore
├── index.ts
├── goal-manager.ts
├── judge-service.ts
├── goal-state.ts
├── event-renderer.ts
├── continuation-prompt.ts
└── test/
    └── goal-manager.test.ts
```

---

## Phase 2: Prepare package.json

```json
{
  "name": "pi-goal-hermes",
  "version": "0.1.0",
  "description": "Goal-driven autonomous continuation for Pi - set a goal and let the agent work until done, with LLM-based judge evaluation",
  "type": "module",
  "keywords": ["pi-package", "pi", "extension", "goal", "autonomous", "continuation"],
  "license": "MIT",
  "author": "<your-name-or-org>",
  "repository": {
    "type": "git",
    "url": "https://github.com/<org>/pi-goal-hermes.git"
  },
  "homepage": "https://github.com/<org>/pi-goal-hermes#readme",
  "bugs": {
    "url": "https://github.com/<org>/pi-goal-hermes/issues"
  },
  "files": [
    "index.ts",
    "goal-manager.ts",
    "judge-service.ts",
    "goal-state.ts",
    "event-renderer.ts",
    "continuation-prompt.ts",
    "README.md",
    "LICENSE"
  ],
  "pi": {
    "extensions": ["./index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*"
  }
}
```

Key changes from current:
- Removed `"private": true`
- Added `keywords` with `pi-package`
- Added `description`, `author`, `repository`, `homepage`, `bugs`
- Added `files` whitelist (excludes test/ from npm tarball)
- Changed peer dep versions from `^0.75.3` to `"*"`

---

## Phase 3: Write README.md

README should cover:
1. One-line description + banner/screenshot (optional)
2. Installation: `pi install npm:pi-goal-hermes`
3. Usage: `/goal set <description>` slash command
4. Commands reference: `/goal status|pause|resume|stop|done|clear`
5. Subgoal commands: `/subgoal add|list|remove|clear`
6. How it works (judge evaluation loop, turn budget)
7. Configuration (maxTurns)
8. License

---

## Phase 4: Code Migration

### 4.1 Copy source files

Copy from `.pi/extensions/pi-goal-hermes/` to new repo root:
- `index.ts`
- `goal-manager.ts`
- `judge-service.ts`
- `goal-state.ts`
- `event-renderer.ts`
- `continuation-prompt.ts`

### 4.2 Fix imports (if directory changes)

If keeping flat structure (root-level files), imports stay the same:
```typescript
import { ... } from "./goal-state.ts";
```

If moving to `extensions/` subdirectory, imports also stay the same (relative paths unchanged).

### 4.3 Copy test file

- `goal-manager.test.ts` → `test/goal-manager.test.ts`
- Update import paths in test to point to `../` instead of `./`

### 4.4 Verify no mono-repo-specific assumptions

Current code uses only:
- `@earendil-works/pi-ai` (streamSimple, types)
- `@earendil-works/pi-coding-agent` (ExtensionAPI, ExtensionContext, etc.)
- `@earendil-works/pi-tui` (Box, Text)
- `node:crypto` (randomUUID)

No mono-repo workspace paths or internal imports - clean separation already.

---

## Phase 5: Add Auxiliary Files

### 5.1 LICENSE (MIT)

Standard MIT license text with year and copyright holder.

### 5.2 .gitignore

```
node_modules/
*.tgz
```

### 5.3 Optional: tsconfig.json (type checking only)

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["*.ts", "test/*.ts"]
}
```

Note: No build step needed. Pi loads TypeScript directly via jiti.

---

## Phase 6: Test Locally

### 6.1 Install as local path in Pi

```bash
pi install /path/to/pi-goal-hermes
```

### 6.2 Verify extension loads

- Start pi session
- Run `/goal set test goal` 
- Check status bar shows goal active
- Verify judge evaluation fires after turn

### 6.3 Test with temporary flag

```bash
pi -e /path/to/pi-goal-hermes
```

---

## Phase 7: Publish to npm

### 7.1 Login to npm

```bash
npm login
```

### 7.2 Dry run

```bash
npm publish --dry-run
```

Verify:
- Only intended files are included
- Package size is reasonable
- No secrets/env files leaked

### 7.3 Publish

```bash
npm publish
# (add --access public if using scoped @org/ name)
```

### 7.4 Verify

```bash
npm view pi-goal-hermes
```

Check https://pi.dev/packages for listing (may take a few minutes).

---

## Phase 8: Post-publish

### 8.1 Test installation from npm

```bash
pi install npm:pi-goal-hermes
```

### 8.2 Update this mono-repo

In `.pi/extensions/pi-goal-hermes/`, either:
- **Option A**: Delete the local copy, add `npm:pi-goal-hermes` to `.pi/settings.json`
- **Option B**: Keep local copy as development source, publish from here

### 8.3 Optional: Add gallery preview

Add screenshot or demo video to repo, then update package.json:
```json
{
  "pi": {
    "extensions": ["./index.ts"],
    "image": "https://raw.githubusercontent.com/<org>/pi-goal-hermes/main/docs/screenshot.png"
  }
}
```

### 8.4 Share on Discord

Post in the pi Discord community channel.

---

## Open Decisions (Need Your Input)

| # | Question | Options |
|---|----------|---------|
| 1 | **Package scope** | `pi-goal-hermes` (unscoped) vs `@<org>/pi-goal-hermes` |
| 2 | **GitHub org** | Personal account vs organization |
| 3 | **File layout** | Flat root (simpler) vs `extensions/` directory |
| 4 | **npm account** | Which npm account to publish under? |
| 5 | **Mono-repo relationship** | Keep local dev copy here, or fully migrate out? |
| 6 | **Gallery media** | Add screenshot/video, or publish plain first? |

---

## Effort Estimate

| Phase | Effort |
|-------|--------|
| 1. Create repo | 5 min |
| 2. package.json | 5 min |
| 3. README | 20-30 min |
| 4. Code migration | 10 min |
| 5. Auxiliary files | 5 min |
| 6. Local testing | 10 min |
| 7. Publish | 5 min |
| 8. Post-publish | 10 min |
| **Total** | **~1-1.5 hours** |
