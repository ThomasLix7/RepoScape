# RepoScape v4.0 — Distribution Alignment with the Agent Skills Open Standard

This specification supersedes the "Transitioning RepoScape to a Standard Agent Skill" draft. v3 closed correctness gaps in the daemon; v4 retires RepoScape's self-hosted skill installer (`bootstrap.ts` + `--bootstrap` CLI flag) and aligns distribution with the **Agent Skills Open Standard** (Anthropic, 2025-12-18) and its de facto package manager **`npx skills`** (vercel-labs/skills).

The previous draft proposed moving `SKILL.md` into `skills/reposcape/`. That move is **reversed** in v4 after auditing the `npx skills` resolver: for a single-skill repository, `SKILL.md` at the repo root is the canonical layout and is what the shorthand `npx skills add <user>/reposcape` resolves to. Nesting under `skills/<name>/` is reserved for multi-skill repositories (e.g. `vercel-labs/skills` itself).

Three goals drive this revision:

1. **Stop maintaining a bespoke installer.** `src/server/bootstrap.ts` reimplements marker-block injection, isolated-file writes, and per-platform YAML frontmatter for five IDE/agent platforms. The ecosystem now has a maintained tool (`npx skills`) that does this and more (versioned refs, multi-skill discovery, `-a` agent targeting).
2. **Be installable by the standard tool.** A user typing `npx skills add <user>/reposcape` must succeed with zero flags.
3. **Don't silently break existing users.** Old `--bootstrap` runs wrote files to five locations. Removing the command must leave a documented cleanup path, not orphaned marker blocks.

---

## 🧭 1. Layout Decision — `SKILL.md` Stays at the Repo Root

### A. The Resolver Rule

`npx skills add <user>/<repo>` invokes vercel-labs/skills, which resolves a skill source by:

1. Checking for `SKILL.md` at the repository root → treat as a **single-skill repository**, install it directly.
2. Otherwise, scanning `skills/*/SKILL.md` → treat as a **multi-skill repository**, require `--skill <name>` or `--list` to disambiguate.
3. Otherwise, accepting an explicit subpath URL (`/tree/main/path/to/skill`).

### B. The Specification

* RepoScape **must** keep `SKILL.md` at the repository root.
* `SKILL.md` **must not** be moved to `skills/reposcape/SKILL.md` in this revision. That layout is reserved for a future multi-skill expansion (e.g. a debug or scaffold companion skill) and **must not** be introduced preemptively.
* The YAML frontmatter **must** continue to declare `name` and `description` (both required by the Agent Skills spec). Current content is compliant and remains unchanged in v4.
* The body of `SKILL.md` is unchanged from its v3 form. v4 is a distribution change, not a content change.

### C. Rationale Recorded

A previous draft argued that moving `SKILL.md` into `skills/reposcape/` would *enable* `npx skills add user/reposcape`. The opposite is true: that move *requires* users to pass `--skill reposcape` or the longer `tree/main/skills/reposcape` URL. This rationale is recorded here so the move is not re-proposed without first changing the repository to a true multi-skill layout.

---

## 🗑️ 2. Removal of the Self-Hosted Installer

### A. Files to Delete

* `src/server/bootstrap.ts` — entire file.
* `src/__tests__/bootstrap.test.ts` — entire file.

### B. CLI Surface to Remove

In `src/server/daemon.ts`, the block currently at lines 187–192:

```ts
if (process.argv.includes('--bootstrap') || process.argv.includes('install-skills')) {
  const { bootstrapSkills } = await import('./bootstrap.js');
  await bootstrapSkills(projectRoot);
  process.exit(0);
}
```

**must** be removed in full. Note that `bootstrapSkills` is imported dynamically *inside* the conditional — there is **no top-level import statement to clean up**. A prior draft instructed removing a top-level import; that instruction was incorrect and is rescinded.

### C. Reference Audit (Required Before Merge)

A pre-merge grep **must** confirm no remaining references:

```bash
grep -rn "bootstrap" src/ --include="*.ts"
grep -rn "bootstrapSkills" src/ --include="*.ts"
grep -rn "install-skills" src/ --include="*.ts"
```

Expected result after the change: zero matches. As of the audit run for this spec, the only references outside `bootstrap.ts` itself were the daemon block above and the dedicated test file — both deleted by §2.A and §2.B.

### D. Build Artifact Hygiene

The repository ships a committed `dist/` directory. After source removal:

* `dist/server/bootstrap.js` (and any `.d.ts` / `.map` siblings) **must** be removed.
* `npm run build` **must** be re-run and the resulting `dist/` committed in the same change set, so a stale `dist/server/bootstrap.js` cannot be reached by `npx reposcape --bootstrap` from an already-installed copy.

---

## 📦 3. Documentation Alignment

### A. README.md — CLI Flags Table

Remove the `--bootstrap` row entirely. The table after the change reads only:

| Flag | Description |
|------|-------------|
| `--force` | Skip project size guard |
| `--scope <dir>` | Limit scan to a subdirectory |

### B. README.md — New Section: "Install as an Agent Skill"

Add a section placed immediately after **Quick Start**, before **API Authentication**. It **must** cover three install patterns, in this order:

1. **Default (single agent, auto-detected):**

   ```bash
   npx skills add <github-username>/reposcape
   ```

   Installs into whichever agent `npx skills` detects in the current project (Claude Code, Cursor, Windsurf, Copilot, Aider, OpenCode, Codex, etc.).

2. **Multi-agent fan-out (replaces the old `--bootstrap` behavior):**

   ```bash
   npx skills add <github-username>/reposcape \
     -a claude-code,cursor,windsurf,copilot,aider
   ```

   This is the explicit replacement for the deleted `--bootstrap` flag. The README **must** call this out by name so users migrating from `--bootstrap` find it.

3. **Pinned version (recommended for reproducibility):**

   ```bash
   npx skills add <github-username>/reposcape@v4.0.0
   ```

   Pins to a git tag or commit SHA. Encouraged for CI and shared dev environments.

### C. README.md — Migration Note for Existing Users

A short subsection titled **"Migrating from `--bootstrap` (pre-v4)"** **must** be added. It lists the file paths the old installer wrote to, so users can remove them manually:

* `.cursor/rules/reposcape.mdc` — delete the file.
* `.windsurf/rules/reposcape.mdc` — delete the file.
* `.claude/rules` — remove the block between `REPOSCAPE AGENT SKILL - DO NOT EDIT START` and `REPOSCAPE AGENT SKILL - DO NOT EDIT END`.
* `.github/copilot-instructions.md` — remove the same marker block.
* `.aider.instruction.md` — remove the same marker block.

v4 does **not** ship an automated uninstaller. The cost of writing and testing one for a feature being deleted exceeds the benefit; the marker blocks are self-identifying and trivially greppable.

### D. Local Development Workflow

A subsection titled **"Iterating on `SKILL.md` locally"** **must** document the local-path install used during skill development:

```bash
npx skills add ./
```

This is the loop a contributor uses to test edits before pushing. It must be documented because there is no longer a `--bootstrap` to fall back on.

---

## ✅ 4. Verification Plan

### A. Automated

1. **TypeScript build** — `npm run build` succeeds with zero references to the deleted module.
2. **Test suite** — `npm test` passes. The expected suite count drops by exactly the number of cases in the deleted `bootstrap.test.ts`; no other test file is modified.
3. **Reference audit** — the three `grep` commands in §2.C all return zero matches.
4. **Dist hygiene** — `find dist -name 'bootstrap*'` returns zero results after `npm run build`.

### B. Manual — Skill Installation Smoke Test

The PR **must not** be merged without one successful end-to-end install via the standard tool. Run from a scratch directory:

```bash
mkdir /tmp/reposcape-smoke && cd /tmp/reposcape-smoke
npx skills add /absolute/path/to/fervent-rutherford
```

Verify:

1. The command exits 0.
2. The destination skill directory (location depends on the detected agent — e.g. `~/.claude/skills/reposcape/` for Claude Code) contains `SKILL.md`.
3. The installed `SKILL.md` is byte-identical to the repo's root `SKILL.md`.

A second pass **must** confirm multi-agent install:

```bash
npx skills add /absolute/path/to/fervent-rutherford \
  -a claude-code,cursor
```

and verify both target locations receive the file.

### C. Manual — Frontmatter Compliance

Inspect the repo-root `SKILL.md` and confirm:

* The file begins with `---` on line 1.
* `name:` and `description:` are present in the frontmatter.
* `name:` matches the repository name (`reposcape`) — required by `npx skills` for shorthand resolution.

---

## 🚫 5. Explicit Non-Goals

To prevent scope creep, v4 **does not**:

* Move `SKILL.md` into a subdirectory (see §1).
* Ship an automated uninstaller for pre-v4 marker blocks (see §3.C).
* Introduce a `scripts/` or `references/` subtree under the skill (the spec permits these, but RepoScape has no current need).
* Publish RepoScape to the npm `skills` registry mirror or any other distribution channel beyond GitHub.
* Change runtime behavior of the daemon, parser, compiler, or HUD. v4 is a distribution-layer change only.

---

## 📋 6. Change-Set Summary

| File | Action |
|---|---|
| `SKILL.md` (root) | **Keep** — no content change |
| `src/server/bootstrap.ts` | **Delete** |
| `src/__tests__/bootstrap.test.ts` | **Delete** |
| `src/server/daemon.ts` (lines 187–192) | **Delete block** |
| `dist/server/bootstrap.*` | **Delete + rebuild** |
| `README.md` — CLI flags table | **Remove `--bootstrap` row** |
| `README.md` — install section | **Add** (3 patterns + migration note + local-dev loop) |

Any deviation from this table (in particular, relocating `SKILL.md`) **must** be raised as a v5 proposal, not folded into the v4 change set.
