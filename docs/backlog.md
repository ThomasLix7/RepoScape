# RepoScape Backlog

This backlog records upcoming feature improvements, architectural enhancements, and user requests to expand the capabilities and flexibility of **RepoScape**.

---

## 🎯 Proposed Features

### 1. 🌐 Flexible Installation Modes (Global vs. Project-Specific)
* **Goal**: Allow developers to choose between a localized, project-specific Agent Skill setup and a unified, global installation.
* **Details**:
  * **Project-Level (Default)**: Keeps configuration files (`.cursor/rules/`, `.claude/rules`, etc.) inside the project's root folder, making it version-control friendly and strictly sandboxed.
  * **Global Mode**: Installs rules to the user's global IDE directories (e.g., Cursor's global rule paths, Aider's home directory instructions, or shell-wide configurations) so that RepoScape's agent skill is active across all opened codebases without needing a per-project `--bootstrap`.
* **Action Items**:
  * Add a `--global` flag to the bootstrap CLI (`npx reposcape --bootstrap --global`).
  * Implement directory resolution for global IDE application support paths (macOS, Linux, Windows).
  * Update the security daemon to dynamically validate session tokens across multiple global worktrees.

---

### 2. 🔍 Granular Scope Configuration (Whole Repo vs. Packages/Dirs)
* **Goal**: Provide developers with the ability to limit visual compiling, tracking, and indexing to specific scopes.
* **Details**:
  * **Whole Repository (Full Scan)**: Scans and renders the entire codebase from the repository root (current default behavior).
  * **Scoped Subdirectory / Package**: Restricts the watcher, WASM parser, and Canvas renderer to specific directories, subfolders, or package roots (extremely valuable for large monorepos, `pnpm` workspaces, or massive codebases).
* **Action Items**:
  * Expand the `--scope <dir>` CLI option to dynamically filter watched paths inside `chokidar` and target lists in `compiler.ts`.
  * Support `.reposcapeignore` or configuration-driven scope arrays inside `.reposcape/config.json`.
  * Enhance HUD rendering to hide/collapse out-of-scope physical or cognitive edges gracefully.
