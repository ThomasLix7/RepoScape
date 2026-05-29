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

The command is always the same shape; what changes is the `--agent` target and where the skill lands:

```bash
npx skills add <github-username>/reposcape --agent <agent>
```

> **Recommended: always pass `--agent` explicitly.** Bare `npx skills add …` relies on auto-detection that **only works when you run it from inside that agent's own session** (it keys off env vars the agent sets — `CLAUDECODE`, `CURSOR_TRACE_ID`, `OPENCODE_CLIENT`, …). Run it from a plain terminal and nothing is detected; run it inside Cursor and it silently installs to `.agents/skills/` only — which is **not** where Claude Code looks. This is the #1 reason `/reposcape` shows up as "no matching command".

### Where the skill installs

What lets an agent *find* the skill is the directory it lands in — and that's the only thing that differs between agents. Most of them share one directory, so they group like this:

| Install dir (project) | Read by | `--agent` token |
|-----------------------|---------|-----------------|
| `.claude/skills/` | **Claude Code** | `claude-code` |
| `.agents/skills/` | Cursor, Codex, Gemini CLI, GitHub Copilot, Antigravity, Cline, and most others (the shared default) | any of `cursor` / `codex` / `gemini-cli` / `github-copilot` … |
| `.opencode/skills/` | **OpenCode** (see caveat below) | — copy manually |
| `.windsurf/skills/` | Windsurf | `windsurf` |
| `.roo/skills/` | Roo Code | `roo` |
| `.aider-desk/skills/` | AiderDesk | `aider-desk` |

**Upshot:** one install into `.agents/skills/` is read by Cursor, Codex, Gemini, Copilot, Antigravity and the rest of that group at once — but **Claude Code reads `.claude/skills/`, so it always needs its own `--agent claude-code` install.** That one separation is the #1 reason `/reposcape` shows up as "no matching command."

> **OpenCode caveat (verified by behavior, not docs).** OpenCode's docs claim it also searches `.agents/skills/`, but in practice (at least some versions) it only picks up its **own** `.opencode/skills/`. Since `skills add --agent opencode` writes to `.agents/skills/` — which that OpenCode ignores — copy the skill into the native dir directly:
> ```bash
> mkdir -p .opencode/skills/reposcape && cp skills/reposcape/SKILL.md .opencode/skills/reposcape/
> ```

Add `-g` for a global install (`~/.claude/skills/` for Claude Code, honoring `CLAUDE_CONFIG_DIR`; per-agent home dirs for the rest). Run `npx skills list` for all 50+ supported agents and `npx skills add --help` for tokens.

**Multi-agent fan-out (replaces the old `--bootstrap` behavior):**

```bash
npx skills add <github-username>/reposcape \
  --agent claude-code,cursor,codex,gemini-cli,github-copilot
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
copies only that directory — safe and fast. Pass `--agent` explicitly so it
lands where your agent actually reads it (for Claude Code, `.claude/skills/`):

```bash
npx skills add ./ --agent claude-code -s reposcape -y
```

`skills add` discovers the skill under `skills/`, so it copies just
`skills/reposcape/SKILL.md` (a few KB) into the agent's skills directory. It
does **not** touch `src/`, `dist/`, or `node_modules/`.

> **Heads-up: it copies, it doesn't symlink.** After editing `skills/reposcape/SKILL.md`
> you must re-run the command above to refresh the installed copy (e.g. `.claude/skills/reposcape/`),
> or the agent keeps reading the stale version. `/reposcape` is picked up without
> restarting the session once the file exists under `.claude/skills/`.

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
