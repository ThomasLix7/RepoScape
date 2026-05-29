# RepoScape v5.0 — Skill/App Separation and the `skills/reposcape/` Layout

This specification supersedes **§1 (Layout Decision)**, **§3.D (Local Development Workflow)**, and the SKILL.md-relocation non-goal in **§5** of [`update-spec-v4.md`](./update-spec-v4.md). All other v4 clauses — the bootstrap removal (§2), the install-pattern docs (§3.A–C), and the verification plan (§4) — remain in force.

v4 mandated raising any SKILL.md relocation as a v5 proposal rather than folding it into v4. This is that proposal, and it is **accepted**.

---

## 🧭 1. Why v4 §1 No Longer Holds

v4 §1 concluded that `SKILL.md` **must** stay at the repository root, on the premise that nesting it under `skills/<name>/` turns RepoScape into a "multi-skill repository" that forces users to pass `--skill <name>`. That premise was **incomplete in one respect and incorrect in another**:

1. **It did not model skill/app cohabitation.** RepoScape is, in one repository, both a runnable Node application (`daemon` + HUD + `src/` + `dist/` + `node_modules/`) **and** an agent skill (`SKILL.md`). v4 reasoned about `SKILL.md` placement in the abstract and never accounted for what `npx skills` actually copies when the skill source *is* the root of a full Node project. We now follow the same structure as the `hyperframes` skill, which keeps its `SKILL.md` and reference files isolated from the application/CLI it talks to.

2. **The resolver claim is empirically false for a single skill.** v4 §1.A/§1.C asserted that `skills/*/SKILL.md` requires `--skill` disambiguation. Auditing the current `npx skills` resolver (`vercel-labs/skills`, CLI 1.5.9) shows `discoverSkills` only requires disambiguation when **more than one** skill is discovered. A repository with exactly one skill under `skills/<name>/` installs with **zero flags**. See §3.

### The decisive defect in v4: a self-contradiction

v4 §3.D **mandated** documenting `npx skills add ./` as the contributor's local-development loop. With `SKILL.md` at the repo root (v4 §1.B), that exact command is destructive:

* `skills add` copies the directory **containing** `SKILL.md` into the destination.
* Its copy step (`copyDirectory`) skips only `.git`, `__pycache__`, and `__pypackages__` — **not** `node_modules`, and **not** its own output directory.
* Pointed at the repo root, it therefore copies the ~250 MB `node_modules` tree and recurses into its own destination — `.agents/skills/reposcape/.agents/skills/reposcape/…` — until the disk fills.
* A `.skillignore` file does **not** help; the CLI ignores it.

v4 thus simultaneously required the root layout **and** the `add ./` loop, which together are unusable. v5 resolves the contradiction by isolating the skill source.

---

## 📐 2. Layout Specification

* `SKILL.md` **must** live at `skills/reposcape/SKILL.md`.
* The repository root **must not** contain a `SKILL.md` (a root `SKILL.md` is resolved as a "whole-repo" single-skill source and causes the §1 bloat/recursion defect).
* The YAML frontmatter is unchanged: `name: reposcape`, plus `description`. `name` **must** remain `reposcape` so the install names the skill directory `reposcape`.
* The skill body is unchanged from v4/v3. v5 is a layout/distribution change, not a content change.
* `skills/reposcape/` **may** later gain `references/` or `scripts/` subtrees (as `hyperframes` does); none are required now.

### Resolver behavior relied upon

`npx skills add <source>` runs `discoverSkills(basePath)`:

1. If `basePath/SKILL.md` exists → returns that one skill with `path = basePath` (the whole repo). **Avoided** by §2 (no root SKILL.md).
2. Otherwise it searches priority directories including `basePath/skills` → finds `skills/reposcape/SKILL.md`, sets `path = skills/reposcape`.
3. `copyDirectory(skill.path, dest)` copies **only** `skills/reposcape/`.

---

## ✅ 3. Verification

### A. Performed (local-path install)

From an isolated scratch repository:

```bash
mkdir -p /tmp/rs-skill-test && cd /tmp/rs-skill-test && git init -q
npx --yes skills add /absolute/path/to/RepoScape --yes
```

Result (CLI 1.5.9):

* Exit 0.
* `Installed 1 skill` — **zero `--skill` flags required**.
* Destination contained **only** `.agents/skills/reposcape/SKILL.md` (with per-agent symlinks, e.g. Claude Code).
* Total install size **92 KB** — no `src/`, `dist/`, or `node_modules/`, and no recursion.

### B. Outstanding (GitHub shorthand)

The live shorthand `npx skills add <user>/reposcape` has **not** been executed end-to-end because RepoScape is not yet pushed/published. Post-clone discovery uses the identical `discoverSkills` code path exercised in §3.A, so confidence is high but not empirically closed. Before relying on the shorthand in published docs, run §3.A's verification against the GitHub source once the repo is pushed.

---

## 📦 4. Documentation Alignment (supersedes v4 §3.D)

`README.md` → **"Iterating on `SKILL.md` locally"** now documents `npx skills add ./` as **safe**, because the skill source is the isolated `skills/reposcape/` directory rather than the repo root. The historical recursion hazard is retained as a note explaining *why* the subdirectory matters. The two-part "app (npm) vs skill (skills)" framing is added to the README header so the separation is explicit.

---

## 📋 5. Change-Set Summary

| File | Action |
|---|---|
| `SKILL.md` (root) | **Move** → `skills/reposcape/SKILL.md` (content unchanged) |
| `README.md` — header | **Add** app/skill separation table + npm-publish note |
| `README.md` — "Install as an Agent Skill" | **Update** to note `skills/reposcape/` isolation |
| `README.md` — "Iterating on SKILL.md locally" | **Rewrite** — `npx skills add ./` is now safe; historical hazard recorded |
| `docs/update-spec-v4.md` | **Unchanged** — retained as historical record; §1, §3.D, §5-relocation-clause superseded by this document |

---

## 🚫 6. Explicit Non-Goals (unchanged from v4)

v5 does **not** publish RepoScape to npm, change daemon/parser/compiler/HUD runtime behavior, or add `references/`/`scripts/` subtrees. npm publishing remains a separate, future step; until then the daemon runs from a clone.
