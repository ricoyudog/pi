---
type: wiki
updated: 2026-05-23
---

# Publishing Pi Packages to pi.dev/packages

> Research on how to publish our pi-goal-hermes extension to the community package registry.

## Summary

Pi packages are **npm packages** with a `pi` manifest in `package.json`. The gallery at [pi.dev/packages](https://pi.dev/packages) automatically indexes any npm package tagged with the `pi-package` keyword. There is no separate approval process or proprietary registry - it is purely npm-based.

## How It Works

1. Package is published to **npm** (standard `npm publish`)
2. pi.dev/packages automatically discovers packages with the `pi-package` keyword
3. Users install via `pi install npm:<package-name>`

## Required package.json Structure

```json
{
  "name": "pi-goal-hermes",
  "version": "0.1.0",
  "description": "Goal-driven continuation extension for Pi - set goals and let the agent work autonomously until done",
  "type": "module",
  "keywords": ["pi-package"],
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/<org>/pi-goal-hermes"
  },
  "pi": {
    "extensions": ["./index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

### Key Fields

| Field | Purpose |
|-------|---------|
| `keywords: ["pi-package"]` | **Required** for pi.dev gallery discovery |
| `pi.extensions` | Declares which files are extension entry points |
| `pi.skills` | Optional: declare skill directories |
| `pi.prompts` | Optional: declare prompt template directories |
| `pi.themes` | Optional: declare theme directories |
| `pi.video` | Optional: MP4 URL for gallery preview (autoplays on hover) |
| `pi.image` | Optional: PNG/JPEG/GIF/WebP URL for gallery preview |

### peerDependencies

Core pi packages should be listed as peerDependencies with `"*"` range (NOT bundled):
- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

## Package Types in Gallery

The gallery shows these types as tags:
- **extension** - Code that hooks into agent lifecycle
- **skill** - SKILL.md-based capabilities
- **prompt** - Prompt templates (.md files)
- **theme** - Visual themes (.json files)
- **package** - Generic (multiple types or unspecified)

## Convention Directories (if no `pi` manifest)

If the `pi` key is omitted from package.json, pi auto-discovers:
- `extensions/` - loads `.ts` and `.js` files
- `skills/` - recursively finds `SKILL.md` folders
- `prompts/` - loads `.md` files
- `themes/` - loads `.json` files

## Publishing Steps

1. **Remove `"private": true`** from package.json
2. **Add `"keywords": ["pi-package"]`** for gallery discovery
3. **Add metadata**: description, repository, license, author
4. **Choose npm scope**: either unscoped (`pi-goal-hermes`) or scoped (`@org/pi-goal-hermes`)
5. **Ensure npm account** exists and is logged in (`npm login`)
6. **Publish**: `npm publish` (or `npm publish --access public` for scoped packages)
7. **Verify** on pi.dev/packages (appears within minutes)

## What We Need to Change (pi-goal-hermes)

Current `package.json`:
```json
{
  "name": "pi-goal-hermes",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": "^0.75.3",
    "@earendil-works/pi-coding-agent": "^0.75.3"
  }
}
```

Changes needed:
1. Remove `"private": true`
2. Add `"keywords": ["pi-package"]`
3. Add `"description"` field
4. Add `"license": "MIT"` (or appropriate license)
5. Add `"repository"` field pointing to the source repo
6. Add `"author"` field
7. Change peerDependencies versions to `"*"` (per official docs)
8. Consider: should this live in its own repo or be published from the mono-repo?
9. Consider: add `pi.image` or `pi.video` for gallery preview

## Installation by Users

Once published, users install with:
```bash
pi install npm:pi-goal-hermes
```

Or for project-local:
```bash
pi install -l npm:pi-goal-hermes
```

## Key Technical Details

- **No build step required** - Pi loads TypeScript directly via `jiti` at runtime
- **No review/approval process** - packages are auto-indexed once published with the `pi-package` keyword
- **Security model** - extensions run with full system access; users must review source before installing
- **`files` field** - use in package.json to control what gets published to npm (whitelist)
- **Gallery stats** - 2,988+ packages currently; top package has 110K downloads/month

## Open Questions

- Should we publish under a scoped name like `@our-org/pi-goal-hermes`?
- Does the extension need its own repository, or can we publish from the mono-repo?
- What license to use?
- Do we want to add gallery preview media (image/video)?
- Should we add a README.md in the package for npm page display?

## References

- [Official package docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Official extensions docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [pi.dev/packages gallery](https://pi.dev/packages)
- [npm publish docs](https://docs.npmjs.com/cli/v10/commands/npm-publish)
- [Official package template](https://github.com/S1M0N38/pi-package-template) - minimal starter
- [Reference implementation](https://github.com/badlogic/pi-package-test) - shows bundling, filtering, globs
- [pi-extensions-skill](https://github.com/Dwsy/pi-extensions-skill) - comprehensive extension dev guide
- [pi-browser-template](https://github.com/FredySandoval/pi-browser-template) - Chrome extension integration template
