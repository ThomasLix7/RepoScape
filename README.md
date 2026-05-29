# RepoScape

Real-time codebase visualization with incremental compilation, call-graph resolution, and cognitive insight overlays.

RepoScape has two parts that install independently:

| Part | What it is | How to install |
|------|-----------|----------------|
| **The app** (`daemon` + HUD) | A local server that watches your repo, compiles the graph, and serves the HUD. Code that **runs**. | Run from source (below), or `npx reposcape` once published to npm. |
| **The skill** (`skills/reposcape/SKILL.md`) | Instructions that teach an AI agent how to talk to the running daemon over HTTP. Text the agent **reads**. | `npx skills add <github-username>/reposcape` |

The skill talks to the daemon purely over HTTP (`http://localhost:5173/api/*`), so it ships as a single `SKILL.md` — it does **not** bundle the app's source. Start the daemon the npm way; install the skill the skills way. They are complementary, not nested.

## Quick Start (run the app)

```bash
npm install
npm run build
npx reposcape
```

The HUD opens at `http://127.0.0.1:5173/hud.html?token=<session-token>`.

> Not yet published to npm. Until it is, run the daemon from a clone as above; `npx reposcape` will self-bootstrap once published.

## Install as an Agent Skill

RepoScape's skill lives at [`skills/reposcape/`](skills/reposcape/) and follows the [Agent Skills Open Standard](https://github.com/anthropics/skills/blob/main/spec/agent-skills-spec.md). Because it sits in a `skills/` subdirectory — isolated from the app's `src/`, `dist/`, and `node_modules/` — `npx skills` discovers and copies **only** that directory (~a single `SKILL.md`), never the app source.

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

Because the skill is isolated in `skills/reposcape/`, installing from this repo
copies only that directory — safe and fast:

```bash
npx skills add ./
```

`skills add` discovers the skill under `skills/`, so it copies just
`skills/reposcape/SKILL.md` (a few KB) into the agent's skills directory. It
does **not** touch `src/`, `dist/`, or `node_modules/`.

> **Historical note / why the subdirectory matters.** `skills add` copies the
> *directory that contains `SKILL.md`*, and its copy step skips only `.git`,
> `__pycache__`, and `__pypackages__` — not `node_modules` or its own output.
> If `SKILL.md` sat at the repo root, `skills add ./` would copy the entire
> ~250 MB `node_modules` tree and recurse into its own destination
> (`.agents/skills/reposcape/.agents/skills/reposcape/…`) until the disk filled.
> A `.skillignore` file does **not** help — the CLI ignores it. Keeping the
> skill under `skills/reposcape/` is what makes the install clean.

To rehearse a *real* end-user install from another tree:

```bash
cd /tmp/skill-test && npx skills add /Users/lihongtao/RepoScape
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
