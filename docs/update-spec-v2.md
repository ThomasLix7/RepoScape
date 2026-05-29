# RepoScape v2.0 - Real-Time (Live) HUD & Copilot Specification

This specification documents the strategic engineering blueprint to push **RepoScape** to the absolute limit of **Real-Time (Live) Co-Programming capability**. By transforming the visualizer from a static "offline architecture scanner" into a low-latency "Live Vibe-Coding HUD" (targeting sub-100ms processing times for targeted local file updates), we build a high-fidelity visual companion that reacts dynamically to saved-file modifications, automated focus events from integration plugins, and low-frequency agent milestone events.

---

## 🧬 1. Ultra-Low Latency Incremental Compiler

To sustain live visualization on active codebases without UI freezing or lag, the compiler must minimize processing overhead:

### A. State Eviction Sweep (Eradicating Ghost Nodes)
*   **The Issue**: Incremental compiles set entry pairs in map buffers (`this.nodes` and `this.edges`) but never clean historical states when files are renamed or functions are deleted.
*   **The Specification**: Before re-parsing any modified file, or during a file delete event, the compiler **must** run an **eviction sweep** that unlinks all nodes and edges where `source_file === relativeFilePath`. This ensures the in-memory graph is a perfect reflection of the physical disk.

### B. Persistent Dependency Caches (Unbroken Barrel Resolution)
*   **The Issue**: Clearing `globalExports` and `rawImports` on each compile run causes re-export resolutions to fail for unchanged files, degrading barrel tracing silently.
*   **The Specification**: The compiler must persist `fileExportsCache` and `fileImportsCache` maps in memory. Only dirty files update these caches on compile. On every compile iteration, `globalExports` and `rawImports` are fully aggregated from the caches, guaranteeing zero-degradation re-export unwrapping.

---

## 📡 2. Real-Time WebSocket & State Synchronization

### A. Edge Key Unification (Multi-Relation Support)
*   **Specification**: Unify the edge keying protocol globally to `${source}->${target}_${relation}` across the Compiler, Watcher diffing, WebSocket payload, and HUD state map. This allows the system to represent and diff multiple distinct relationships between identical nodes (e.g. contains + imports + calls) without key collisions.

### B. Bidirectional Heartbeat Watchdog (Half-Open Defenses)
*   **The Issue**: If a network connection is lost or the daemon crashes without sending a standard FIN/RST packet, the client socket enters a "half-open" state, hanging in "connected" status forever.
*   **The Specification**: The HUD WebSocket client must implement a **watchdog timer**. When sending a `ping`, set a timeout (e.g. 5 seconds). If the daemon fails to reply with a `pong` within this limit, the client must immediately close the socket locally and trigger the exponential backoff reconnection loop.

### C. Focus Event Synchronization Protocol (Action State Sync)
*   **The Concept**: Enabling visual synchronizations as the AI agent navigates the workspace or answers queries, resolving the physical context barrier between the terminal and browser.
*   **The Specification**: High-frequency focus and activity synchronization is handled transparently by the environment/harness wrappers or IDE extensions (e.g., intercepting `view_file` or `open_file` tool calls before execution and sending background heartbeats). The agent itself is **not** obligated to trigger focus on every routine file read/write. It may only fire `/api/focus` or `/api/agent-activity` manually for low-frequency milestones or explicit, customized architectural demonstrations (avoiding brittle shell curls).
*   **Daemon Action**: The Daemon registers the focus event locally, updating the state for active graph streaming and enabling down-stream client highlight propagation.

---

## 🛡️ 3. Project Size Guard & Deterministic Limits

*   **The Concept**: Protecting the local compiler's resource consumption and preventing memory/CPU exhaustion when operating on massive legacy or monorepos.
*   **The Specification**: 
    1.  **Daemon Physical Safety Gating (Primary)**: The RepoScape Daemon compiler must deterministically protect itself. During startup, if the project size exceeds `500` source files or `2,000,000` words, the CLI daemon prints a warning banner and lists the top 5 first-level subdirectories. Instead of a hard halt (which would conflict with the product's 1,000 and 5,000 file performance baselines), it prints a prominent warning and prompts the user interactively (or logs a configurable scoped-scan warning) allowing them to confirm a whole-workspace scan or choose a scoped scanning root.
    2.  **Agent Semantic Safety Gating (Secondary)**: The Agent's `SKILL.md` instructs the Agent on how to scope its own semantic and cognitive doc sweeps to prevent LLM context bloating. It does not delegate compiler resource protection to the Agent.

---

## 🩺 4. Honest Audit Trail (Rationale & Context Metadata)

*   **The Concept**: Giving every cognitive connection a clear, auditable reasoning context to build deep user trust in the visualizer's "Architecture Doctor" diagnostics.
*   **The Specification**: When the coding agent extracts cognitive concepts from documentation, each edge **should** include a `metadata` payload when available carrying:
    -   `rationale`: A detailed explanation of why the semantic relationship exists.
    -   `source_doc`: The precise file path and line number of the text source.
*   **Future HUD Visualizer Integration**: In future visualizer versions, when the developer clicks any `COGNITIVE` (dashed purple) edge in the sidebar, the panel will extract this metadata and render an **Honest Audit Trail pop-up** showing the AI's logic and the exact source line reference.

---

## 📈 5. Louvain mod-Stabilization & Undirected Projection

*   **Specification**: When projecting the directed graph into an undirected one for Louvain community detection, the system **must** explicitly construct `new Graph({ type: 'undirected' })`.
*   **Modularity Weight Aggregation**: If bidirectional edges (e.g. `A ➔ B` and `B ➔ A`) both exist, the system must sum their edge weights into a single undirected edge: `weight = existingWeight + incomingWeight` instead of dropping the second edge, ensuring mathematically precise community modularity.

---

## 🔒 6. Referer Leak Protection (Session Security Shield)

*   **The Issue**: Having the session token in the query parameters (`?token=...`) exposes it to external domains via the `Referer` header if the developer clicks external links in the HUD.
*   **The Specifications**:
    1.  **no-referrer Directive**: In `hud.html` header, embed `<meta name="referrer" content="no-referrer">` to block the browser from sending referrers to external domains.
    2.  **History API Cleansing**: In the HUD client `App.tsx`, immediately after extracting the token on boot, programmatically wipe the query parameters from the browser address bar using the History API:
        ```typescript
        window.history.replaceState({}, document.title, window.location.pathname);
        ```

---

## 🧼 7. Call Graph Target Scoping (Noisy Edge Prevention)

*   **The Issue**: Matching calls target nodes strictly by lowercase label global scan creates thousands of false call edges for high-frequency generic functions (e.g., `map`, `get`, `init`).
*   **The Specification**: Restrict the call resolution scope inside `compiler.ts`:
    1.  First search for local functions matching the callee label inside the same caller file.
    2.  If not found, search the set of explicitly imported symbols in that file.
    3.  Only fall back to global match if the callee matches a known unique global class/module, avoiding noise.

---

## 🔌 8. AI Agent Multi-Ecosystem Bootstrapping & Delimiter Injection Specification

To achieve zero-friction, auto-discovery skill loading across all mainstream coding agents without clobbering developer configurations, the RepoScape Daemon must implement an explicit, non-destructive bootstrapping protocol:

### A. Explicit User Bootstrap (CLI Opt-In Only)
The daemon **must never** perform silent, automatic boot-time overwriting of rule files in the project root. Instead, bootstrapping is triggered explicitly by the developer via a command-line setup (e.g., `npx reposcape --bootstrap` or `npx reposcape install-skills`). 

### B. Isolated Rules for Multi-Rule Platforms
For modern development platforms that support dedicated, multi-rule directories (like Cursor IDE), the bootstrapper must create a completely isolated rule file in the rules folder, leaving any pre-existing root configuration files untouched:
1.  **Cursor IDE**: Write to `.cursor/rules/reposcape.mdc` (Isolated rule file with YAML frontmatter).
2.  **Windsurf IDE**: Write to `.windsurf/rules/reposcape.mdc` (Or equivalent isolated path).

### C. Non-Destructive Block Injection for Single-Rule Platforms
For platforms that only support a single global rules file in the workspace, the bootstrapper **MUST NOT** overwrite the file. Instead, it must implement a **Marker Block / Delimiter Injection** mechanism to append the skill content safely while preserving the developer's original configurations:
1.  **Claude Code**: Inject into `.claude/rules` (or `.clauderules` in root).
2.  **GitHub Copilot**: Inject into `.github/copilot-instructions.md` (creating `.github/` folder if missing).
3.  **Aider / OpenCode**: Inject into `.aider.instruction.md` in root.

#### Delimiter Matching Protocol:
Every injection must be strictly wrapped inside unique, easily parsable start/end comments:
```markdown
# ====================================================
# === REPOSCAPE AGENT SKILL - DO NOT EDIT START ===
# ====================================================
[SKILL.md Contents Here]
# ====================================================
# === REPOSCAPE AGENT SKILL - DO NOT EDIT END ===
# ====================================================
```
*   **Check Existence**: If the target file does not exist, write the block directly.
*   **Safe Append**: If the target file exists but lacks the marker block, append it to the end of the file.
*   **Hot Update**: If the target file exists and already contains the marker block, update *only* the contents within the start and end delimiters, keeping the developer's original text above and below the block completely intact.

### D. Cross-Platform Fallback Safety (Robustness Guard)
*   **The Issue**: Windows platforms restrict standard symlink creation unless the developer shell has elevated Administrator privileges or developer mode is active.
*   **The Specification**: 
    1.  **For Isolated Rule Files**: The bootstrapping logic must attempt `fs.symlink` first to establish a dynamic reference. If it encounters a permission error (`EPERM` or `ERR_METHOD_NOT_IMPLEMENTED`), it must automatically fall back to **atomic copy** (`fs.copyFile`, `fs.writeFile`) to prevent startup crashes.
    2.  **For Single-Rule Files**: **Standard symlinking is strictly prohibited** to prevent overwriting or clobbering pre-existing rule files. The bootstrapping sweep must **exclusively** use the non-destructive **Marker Block / Delimiter Injection** mechanism described in Section 8.C.
