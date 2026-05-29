# RepoScape

Real-time codebase visualization with incremental compilation, call-graph resolution, and cognitive insight overlays.

## Quick Start

```bash
npm install
npm run build
npx reposcape
```

The HUD opens at `http://127.0.0.1:5173/hud.html?token=<session-token>`.

## Install as an Agent Skill

RepoScape ships as a standard [Agent Skills Open Standard](https://github.com/anthropics/skills/blob/main/spec/agent-skills-spec.md). Install it with `npx skills`:

**Default (single agent, auto-detected):**

```bash
npx skills add <github-username>/reposcape
```

Installs into whichever agent `npx skills` detects in the current project (Claude Code, Cursor, Windsurf, Copilot, Aider, OpenCode, Codex, etc.).

**Multi-agent fan-out (replaces the old `--bootstrap` behavior):**

```bash
npx skills add <github-username>/reposcape \
  -a claude-code,cursor,windsurf,copilot,aider
```

This is the explicit replacement for the deleted `--bootstrap` flag.

**Pinned version (recommended for reproducibility):**

```bash
npx skills add <github-username>/reposcape@v4.0.0
```

Pins to a git tag or commit SHA. Encouraged for CI and shared dev environments.

### Migrating from `--bootstrap` (pre-v4)

The old `--bootstrap` flag wrote skill files to five locations. To clean up after upgrading:

* `.cursor/rules/reposcape.mdc` — delete the file.
* `.windsurf/rules/reposcape.mdc` — delete the file.
* `.claude/rules` — remove the block between `REPOSCAPE AGENT SKILL - DO NOT EDIT START` and `REPOSCAPE AGENT SKILL - DO NOT EDIT END`.
* `.github/copilot-instructions.md` — remove the same marker block.
* `.aider.instruction.md` — remove the same marker block.

### Iterating on `SKILL.md` locally

To test skill edits locally before pushing:

```bash
npx skills add ./
```

## API Authentication

All API endpoints (including `/api/health`) require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <session-token>
```

The session token is written to `.reposcape/.session-token` on daemon start. External health monitors must include this header — unauthenticated requests receive `401 Unauthorized`.

## CLI Flags

| Flag | Description |
|------|-------------|
| `--force` | Skip project size guard |
| `--scope <dir>` | Limit scan to a subdirectory |

## Development

```bash
npm run dev          # Start daemon + Vite dev server (uses concurrently)
npm run build        # Build HUD (Vite) + server (tsc)
npm test             # Run test suite (vitest)
```
