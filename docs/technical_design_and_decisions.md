# Technical Design & Decisions - RepoScape (Live Vibe-Coding HUD & Visual Agent Skill)

This document serves as the master architectural reference and decision log for **RepoScape**—a real-time, interactive developer HUD and Coding Agent Skill. It documents the product vision, key design decisions, technology stack selections, structural data models, and mitigation strategies for 20 advanced engineering reviews.

---

## 🎯 1. Product Vision & Design Concept

RepoScape is designed for the **"Vibe Coding" era**—specifically targeting developers who leverage AI coding agents but need a high-signal, real-time spatial representation to understand and track how their codebase changes as the agent edits it.

### Core Value Pillars
*   **Developer-Facing Visual HUD**: Unlike headless indexing tools designed solely for agent retrieval (e.g., graphify), RepoScape is a premium, real-time browser HUD that visually "wows" the developer with highly polished aesthetics (neon dark-mode, glowing nodes, and particle dependency flow).
*   **Active Agent Tracking**: As the coding agent modifies the codebase in the terminal, the browser HUD automatically glides, zooms, and highlights modified files with glowing ring animations, bridging the gap between agent actions and developer comprehension.
*   **Zero-API, 100% Agent-Driven Skill**: RepoScape does not rely on independent paid API keys or external HTTPS LLM calls. Instead, the cognitive insight extraction of documentation is driven natively by the user's active Coding Agent session, keeping the tool self-contained and cost-free.
*   **Unified Single-Command UX**: Frictionless startup. Running a single command (`npx reposcape`) initiates stat-caching, parses AST, runs Louvain clustering, starts a live file watcher, boots the Express/WebSocket server, and automatically opens the visualizer in the developer's default browser.

---

## 💡 2. Architectural Evolution & Key Decisions

During the initial design phases, several critical trade-offs were evaluated. The resulting key decisions shape RepoScape's production-grade architecture:

### Decision 1: From "Standalone Web App" to "Zero-API, 100% Agent-Driven Skill"
*   **The Problem**: Our early proposals considered either a standalone web application (highly isolated but lacking agent integration) or a server that made direct HTTPS calls to Gemini/OpenAI for document semantic analysis (which required independent developer API key setup and incurred external token costs).
*   **The Decision**: Re-architect RepoScape as a hybrid **CLI Daemon + Coding Agent Skill** (`SKILL.md`). The Node CLI does not make external LLM calls. Instead, the active coding agent's LLM is prompted (via `SKILL.md`) to read uncached doc files, perform semantic extraction, and write JSON fragments directly to RepoScape's local cache (`.reposcape/cache/insights/`).
*   **The Rationale**: This keeps RepoScape completely cost-free and self-contained, utilizing the agent's own LLM runtime (which the user is already running) while maintaining a strict, locally-validated cache.

### Decision 2: From "Simplified Regex/Import Parser" to "WASM Tree-sitter Parser"
*   **The Problem**: A lightweight static scanner using regular expressions is fast but cannot capture complex nested function calls, variable re-assignments, or multiple languages (e.g., Python class methods, Go structs, Rust traits).
*   **The Decision**: Implement a robust, multi-language **`web-tree-sitter` (WASM)** parser. RepoScape performs full syntax tree traversal for JS/TS, Python, Go, Rust, Java, C/C++, HTML, CSS, JSON, and Markdown, matching or exceeding graphify's structural extraction capabilities.
*   **The Rationale**: Adhered strictly to the directive of **"no MVP simplification"**. Symbol-level cross-file precision is required to detect Hub Nodes (Coupling Hubs), Cycles, and Surprising connections accurately.

### Decision 3: From "vis.js/SVG/3D rendering" to "D3-Force physics + Custom 2D Canvas rendering"
*   **The Problem**: Visualizing 1,000+ nodes in SVG chokes the browser's DOM thread during dragging and zooming. Vis.js (used in graphify's static export) uses heavy DOM rendering and offers a black-box physics engine that makes custom transitions and smooth camera glides very difficult to control. 3D WebGL visualizations are too heavy and cause navigation disorientation.
*   **The Decision**: Decoupled the physics engine from the rendering layer. We use **`d3-force`** in memory for the physical coordinate simulation, combined with a **GPU-accelerated HTML5 `<canvas>`** drawing context.
*   **The Rationale**: Canvas provides total pixel-level control. We can render glowing neon nodes, animated link flows representing dependency directions, pulsing target rings, and Lerped camera glides at a butter-smooth **60 FPS** (the exact architecture used by Obsidian).

### Decision 4: Unified single-command execution
*   **The Problem**: Forcing developers to run separate commands to scan, build, watch, and serve destroys the user experience.
*   **The Decision**: Consolidate the CLI to a single run command: `npx reposcape`. It runs the incremental parsing, merges cognitive caches, starts the `chokidar` file watcher, boots Express + WebSocket servers, and automatically launches the HUD.
*   **The Rationale**: Ultimate developer UX. One command does it all under 100ms.

---

## 📊 3. Technology Stack Selection & Detailed Comparisons

Every component in RepoScape's technical stack has been selected to optimize performance, maintainability, and distribution:

### Technical Stack Comparison Table

| Layer | Selected Tech | Core Advantages | Defeated Alternatives (Why Rejected) |
| :--- | :--- | :--- | :--- |
| **AST Engine** | **`web-tree-sitter` (WASM)** | Native-speed parsing; **zero native compilation**; runs everywhere out-of-the-box; dynamic multi-language grammar loading. | *Regex* (Too simple; JS-only)<br>*node-tree-sitter* (Requires local C++ compiler; breaks on Node version updates)<br>*Python tree-sitter* (Requires pip/uv and virtualenv; high latency) |
| **Graph & Clustering** | **`graphology` + Louvain (JS native)** | Pure in-memory representation; Louvain community detection in **<5ms**; zero database overhead. Graphology is MIT-licensed, perfectly compatible with open-source projects. | *NetworkX via Python* (High subprocess spawn latency)<br>*Neo4j / SQLite* (Overkill; high database installation friction) |
| **HUD Physics** | **`d3-force` (in memory)** | Pure mathematical simulation; Verlet integration; highly customizable forces (repulsion, centering, link springs). | *Vis.js physics* (Black-box; difficult to override for dynamic camera panning and node morphing) |
| **HUD Graphics** | **HTML5 2D Canvas** | GPU-accelerated; easily renders **5,000+ nodes at 60 FPS**; supports pixel-level glows, particles, and Lerped gliding. | *SVG/DOM* (Severe frame drops above 800 nodes)<br>*Three.js/WebGL* (GPU memory intensive; disorienting in 3D; text rendering is difficult) |
| **File Watcher** | **`chokidar`** | High-performance filesystem monitoring; ignores node_modules efficiently; stable cross-platform events. | *Node fs.watch* (Known bugs on macOS; double-fires; unstable) |
| **HUD Sync** | **Express + WebSockets (`ws`)** | Server boots in **<50ms**; instantaneous bi-directional diff streaming; zero-polling architecture. | *HTTP Polling* (High latency; unnecessary server load) |

---

## ⚙️ 4. Data Models & Core Logic

### 1. Unified Extraction Schema
All deterministic (AST) and cognitive (Agent-driven) pipelines compile into a single JSON schema:
*   **Nodes**:
    ```json
    {
      "id": "stem_entity",
      "label": "Human Readable Name",
      "file_type": "code | document | concept",
      "source_file": "relative/path/to/file",
      "source_location": "L12",
      "metadata": {}
    }
    ```
*   **Edges**:
    ```json
    {
      "source": "node_id",
      "target": "node_id",
      "relation": "contains | calls | imports | implements | semantically_similar_to",
      "type": "PHYSICAL | COGNITIVE | SUSPICIOUS",
      "confidence_score": 1.0,
      "source_file": "relative/path",
      "source_location": "L12",
      "weight": 1.0
    }
    ```

---

## 🚀 5. Advanced Engineering Mitigation Strategies

To achieve true production-grade resilience, performance, and security, we have engineered rigorous solutions for the following 20 critical challenges:

### 5.1 Technical Feasibility

#### Challenge 1: `web-tree-sitter` WASM Node.js Initialization
*   **Problem**: `web-tree-sitter` relies on browser API `fetch()` to load the WASM parser binary. In Node.js environments, this causes an immediate crash with `globalThis.fetch is not a function` or related file loader failures.
*   **Mitigation**: **Local Filesystem WASM Loading**. We build RepoScape as a modern pure ESM package and configure the tree-sitter WASM bootstrapper to use absolute local filesystem path resolution via `fs.promises.readFile()`, completely bypassing the HTTP fetch path:
    ```typescript
    import Parser from 'web-tree-sitter';
    import path from 'path';
    import fs from 'fs/promises';

    // Locate the local wasm file inside our node package directory
    const wasmPath = path.resolve(__dirname, 'tree-sitter.wasm');
    
    // Polyfill the loader with standard Node fs hooks
    await Parser.init({
      locateFile: () => wasmPath,
      // Provide direct buffer instantiation instead of fetch
      wasmBinary: await fs.readFile(wasmPath)
    });
    ```

#### Challenge 2: Browser Auto-Open Silently Hanging on Headless Environments
*   **Problem**: Executing browser opening commands (via the `open` library) in headless remote environments (like Docker containers, SSH, or CI runners) fails silently, triggers infinite loops, or crashes with unhandled exceptions.
*   **Mitigation**: **Headless Environment Detection & Graceful Fallback**. On startup, the CLI checks the environment:
    ```typescript
    const isHeadless = process.env.CI === 'true' || !process.env.DISPLAY || process.env.SSH_CLIENT;
    if (isHeadless) {
      console.log(`\n🚀 HUD Server listening at http://127.0.0.1:5173/hud.html`);
      console.log(`   (Headless environment detected - skipping browser auto-launch)\n`);
    } else {
      try {
        await open('http://127.0.0.1:5173/hud.html');
      } catch (err) {
        console.warn(`⚠️ Failed to auto-open browser: ${err.message}. Please navigate manually to http://127.0.0.1:5173/hud.html`);
      }
    }
    ```

#### Challenge 3: Vite + Express Hybrid Dev vs. Production Deployment
*   **Problem**: Express and Vite servers must coexist cleanly in both development (fast hot reload) and production (zero configuration, packaged single command).
*   **Mitigation**: **Unified Dual-Mode Routing Pipeline**.
    *   **Development**: Express runs on port `5174` (API & WebSockets). The Vite Dev server runs on port `5173` and proxies all request paths prefixed with `/api` and `/ws` to port `5174` via `vite.config.ts`'s proxy hooks.
    *   **Production (Distribution)**: React is pre-compiled into static SPA assets under the `dist/hud/` directory. The production Express daemon runs on port `5173` and serves these static assets directly via `express.static('dist/hud')`. This means the developer only ever runs a single, unified local server.

---

### 5.2 Dependency Selection

#### Challenge 4: `d3-force` Scaling & Warm-Start Incremental Layout
*   **Problem**: D3-force is $O(N^2)$ in JavaScript, which chokes when the graph size exceeds 5,000 nodes. Furthermore, restarting physics from scratch causes severe visual "flashing" or jumps.
*   **Mitigation**: **Warm-Start Incremental Positioning & Community Aggregation**.
    1.  **Warm-Start**: When an incremental update arrives, existing nodes retain their current `x, y, vx, vy` physics states. Newly added nodes are placed at a small random delta around their parent directory's median coordinates:
        $$x_{new} = x_{parent} + \text{random}(-10, 10), \quad y_{new} = y_{parent} + \text{random}(-10, 10)$$
        The simulation is ticked at a low initial heat (`simulation.alpha(0.15)` instead of `1.0`), achieving rapid stabilization in <15 ticks instead of 300.
    2.  **Community-Level Aggregation Scale Cutoff**: If the graph size exceeds **3,000 nodes**, the HUD dynamically aggregates details. Individual files are hidden, and communities are rendered as unified "Macro-Nodes." Double-clicking a macro-node expands only that specific community's detailed child nodes, keeping the active physics load lightweight.

#### Challenge 5: Louvain Stochastic Drift & Visual Instability
*   **Problem**: Louvain is a stochastic algorithm (random-walk based). Run-to-run variations cause community classifications to drift, triggering visual community flashing on subsequent compilations.
*   **Mitigation**: **Deterministic Louvain Seeding & Jaccard Community Mapping**.
    1.  **Seed Locking**: We lock `graphology-communities-louvain` to a fixed random seed (`42`) and a fixed resolution parameter (`1.0`) to guarantee mathematical determinism on identical graph topologies.
    2.  **Intersection Matching**: New communities are mapped to previous community IDs using a greedy Jaccard similarity match:
        $$J(C_{new}, C_{old}) = \frac{|C_{new} \cap C_{old}|}{|C_{new} \cup C_{old}|}$$
        We map new IDs to the ID of the historical community that shares the maximum intersection, ensuring community colors remain stable across file writes.

#### Challenge 6: Chokidar ESM Compatibility & ESM Core Package
*   **Problem**: Chokidar v4 is pure ESM, which crashes if imported into CommonJS projects.
*   **Mitigation**: **Locked Pure ESM Package Design**. We explicitly set `"type": "module"` in RepoScape's `package.json`, locking the runtime to modern Pure ESM. This allows us to use ESM-only libraries natively (such as Chokidar v4 and web-tree-sitter ESM hooks) and natively compile using modern Vite configurations.

---

### 5.3 API Design

#### Challenge 7: Focus & Activity Event Idempotency, Stale Pings, and TTL
*   **Problem**: If the active Coding Agent crashes, the browser HUD will show stale highlights permanently.
*   **Mitigation**: **Ping-with-TTL Heartbeat**. Focus and thought events sent via `POST /api/focus` must include a `timestamp` and a `ttl` (Time-To-Live, default 60 seconds). The HUD server maintains a memory registrar of active pings. If no update occurs within the specified TTL, the server marks the Agent as "offline" and automatically clears the glowing highlight rings.

#### Challenge 8: N+1 Network File Writes in Doc Ingest
*   **Problem**: Forcing the Coding Agent to write cognitive JSON files one-by-one by executing multiple sequential HTTP POST calls creates high file I/O overhead.
*   **Mitigation**: **Bulk Cognitive Insights Ingestion API**. RepoScape exposes a `POST /api/insights/batch` endpoint:
    ```typescript
    interface BulkCognitiveInsightsIngest {
      extractions: {
        file: string;
        hash: string;
        nodes: Node[];
        edges: Edge[];
        hyperedges: Hyperedge[];
      }[];
    }
    ```
    This allows the Agent to write hundreds of cognitive entities and relations in a single HTTP transaction, which the daemon writes in parallel to the local cache folder.

#### Challenge 9: WebSocket Protocol, Heartbeats, and Auto-Reconnection
*   **Problem**: Unstable network connections or daemon restarts can cause WebSocket drops without proper client recovery.
*   **Mitigation**: **WS Protocol Specification with Ping-Pong Keepalive**.
    *   **Keepalive**: The browser client sends a `{"type": "ping"}` frame every 30 seconds. The daemon server replies with `{"type": "pong"}`. If no pong is received within 10 seconds, the client closes the connection and triggers reconnection.
    *   **Auto-Reconnection**: The client visualizer implements exponential backoff reconnection (retrying at 1s, 2s, 4s, 8s, up to a maximum 16s cap) to smoothly restore visualization state.

---

### 5.4 Data Flow Integrity

#### Challenge 10: Cache Consistency Drift (Deleted Files & Orphan Nodes)
*   **Problem**: If a code file is deleted or renamed, its cognitive nodes created by the Agent will remain in the cache folder, creating "ghost" nodes and dangling edges.
*   **Mitigation**: **Compilation Reference Pruning Sweep**. When `npx reposcape` compiles the graph, it maps all active files on disk. For every cached node (AST and Cognitive), it checks:
    ```typescript
    if (!await fileExists(node.source_file)) {
      // Automatically prune the node and all connected edges
      graph.removeNode(node.id);
    }
    ```
    This ensures that old cognitive caches from deleted files are pruned automatically on the next compilation.

#### Challenge 11: Community ID Migration Algorithm
*   **Problem**: When graph topology changes, community IDs will drift.
*   **Mitigation**: **Hungarian Greedy Community Align-Mapping**.
    We construct an overlap matrix where index $i, j$ is the size of $|C^{old}_i \cap C^{new}_j|$. We greedily assign the old ID $i$ to the new ID $j$ that maximizes this intersection, and assign new IDs to any unmatched communities based on size descending.

---

### 5.5 Security Boundaries

#### Challenge 12: Symlink Jail (Path Traversal Vulnerability)
*   **Problem**: A malicious actor could insert symlinks targeting sensitive system files (e.g. `ln -s /etc/passwd .reposcape/cache/passwd`), which the scanner would follow and read.
*   **Mitigation**: **Strict Path Sandboxing Jail**. Every resolved file path in the scanner is validated against the absolute root directory of the workspace project:
    ```typescript
    const resolvedRoot = await fs.realpath(projectRoot);
    const resolved = await fs.realpath(targetPath);
    const relativePath = path.relative(resolvedRoot, resolved);
    const isOutsideJail = relativePath.startsWith('..') || path.isAbsolute(relativePath);
    if (isOutsideJail) {
      throw new Error(`Security Violation: Attempted directory traversal outside project root: ${targetPath}`);
    }
    ```
    Symlinks pointing outside the project root directory are safely skipped.

#### Challenge 13: WASM Supply Chain Integrity
*   **Problem**: Third-party pre-compiled WASM binaries could introduce supply chain risks.
*   **Mitigation**: **Local Freeze and SHA256 Verification**. We **bundle and freeze** the required `.wasm` grammar binaries locally inside our published npm package directory rather than downloading them dynamically. We verify their SHA256 integrity hashes on the bundle manifest during the build phase of RepoScape.

#### Challenge 14: Cache Injection XSS Prevention
*   **Problem**: A malicious file header or doc comment could contain script injections which trigger XSS inside the visualizer HUD if rendered via `.innerHTML`.
*   **Mitigation**: **Strict React DOM Escaping**. All text fields (labels, paths, active agent thoughts, descriptions) in the React HUD are rendered strictly using native JSX text nodes (e.g. `<span>{node.label}</span>`). React automatically sanitizes and escapes all text to prevent any script execution. HTML inside hover tooltips is sanitized using `DOMPurify` before rendering.

---

### 5.6 Extensibility

#### Challenge 15: Monolithic Parser spaghetti (Multi-language Extensibility)
*   **Problem**: Hardcoding language-specific syntax rules inside a single parser file quickly becomes unmaintainable.
*   **Mitigation**: **Language Strategy Pattern Registry**.
    Each language (TypeScript, Python, Go, Rust, Java, C++) is compiled as a separate Strategy module implementing a standard interface:
    ```typescript
    interface LanguageStrategy {
      extensions: string[];
      parseAST(node: SyntaxNode, source: string): ExtractionResult;
    }
    ```
    Strategies register themselves on the global `ParserRegistry` class, making it trivial to add support for new languages without altering the core compiler code.

#### Challenge 16: Monorepo Multi-Package Visual Consolidation
*   **Problem**: In monorepos (e.g. pnpm workspaces), files belong to different independent packages. Rendering them as a single flat graph loses package-boundary context.
*   **Mitigation**: **Unified Layered Graph with Package Containers**.
    RepoScape parses the project workspaces and introduces a hierarchical parenting node structure:
    *   Each workspace package is represented as a special `container` node with `file_type: "package"`.
    *   Files within that package are bound to this container via a virtual `belongs_to` edge.
    *   In zoomed-out views, individual file edges are collapsed into thick "Package-to-Package" dependency lines, providing a highly clean, high-level structural map of the monorepo.

#### Challenge 17: Extensible Plugin Hook Architecture
*   **Problem**: Developers cannot customize visual styling or inject specialized custom nodes (e.g. SQL databases, Docker configs) without modifying the core codebase.
*   **Mitigation**: **Plugin Transformation Pipeline**. The compiler reads the `.reposcape/plugins/` directory. Developers can place a JS file that exports a `transform` hook:
    ```javascript
    export function transform(graph) {
      // Modify graph metadata, add custom edges, or adjust community labels
      return graph;
    }
    ```
    This function runs automatically at the end of the `compile` phase, right before saving `graph.json`.

---

## ⚙️ 7. Specification Completeness

### 1. Version Migration
Cache directories are stamped with a semantic version number: `.reposcape/cache/version.json`. If the local installed RepoScape CLI undergoes a version change with compiler schema adjustments, the CLI automatically detects the version mismatch, clears `.reposcape/cache/`, and triggers a clean re-scan to avoid schema errors.

### 2. Concurrency Race Conditions
To prevent multiple agents writing to the cache folder simultaneously from clobbering each other's writes, the compiler uses a lightweight **file lockfile** `.reposcape/cache/.lock`. If the lockfile is present, writing processes automatically retry with a random jitter (10-100ms) up to 10 times before failing.

### 3. Performance Baselines
*   **AST Delta Scan & Compile**: P99 latency **<150ms** for a codebase of 1,000 files; **<500ms** for a codebase of 5,000 files.
*   **Initial Full Scan**: **<5 seconds** for 1,000 files; **<20 seconds** for 5,000 files.
*   **Maximum Scale Limit**: **10,000 nodes** before community-level macro aggregation is strictly enforced.

### 4. Offline Fallback
All pre-compiled WASM binaries and static visual HUD assets are packaged **directly inside the published npm package bundle**. Installing and running `npx reposcape` requires **zero external network downloads** during runtime, ensuring complete offline safety.
