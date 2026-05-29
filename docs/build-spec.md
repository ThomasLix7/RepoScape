# Build Specification - RepoScape (Live Vibe-Coding HUD & Visual Agent Skill)

This document is the master build specification for **RepoScape**—a real-time, interactive developer HUD and Coding Agent Skill. It defines the exact file tree, dependencies, CLI commands, API schemas, WS frame formats, and algorithmic implementations. All modules must be built strictly to these specifications without simplification.

---

## 🛠️ 1. Project Setup & Configuration

We establish RepoScape as a modern, pure ESM TypeScript Node package.

### 1.1 `package.json`
```json
{
  "name": "reposcape",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "reposcape": "./dist/server/daemon.js"
  },
  "scripts": {
    "build:hud": "vite build",
    "build:server": "tsc",
    "build": "npm run build:hud && npm run build:server",
    "dev:server": "tsc -w",
    "dev:hud": "vite",
    "test": "vitest run"
  },
  "dependencies": {
    "express": "^4.19.2",
    "ws": "^8.17.0",
    "chokidar": "^3.6.0",
    "graphology": "^0.25.4",
    "graphology-communities-louvain": "^2.0.1",
    "d3-force": "^3.0.0",
    "web-tree-sitter": "^0.22.2",
    "tree-sitter-wasms": "^0.1.11",
    "open": "^10.1.0",
    "dompurify": "^3.1.2",
    "js-yaml": "^4.1.0",
    "jsonc-parser": "^3.2.1",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/ws": "^8.5.10",
    "@types/node": "^20.12.7",
    "@types/d3-force": "^3.0.9",
    "@types/js-yaml": "^4.0.9",
    "typescript": "^5.4.5",
    "vite": "^5.2.8",
    "vitest": "^1.5.0",
    "@types/react": "^18.2.79",
    "@types/react-dom": "^18.2.25"
  }
}
```

### 1.2 `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "jsx": "react-jsx"
  },
  "include": ["src/**/*"]
}
```

---

## 🚀 2. Server & CLI Daemon (`daemon.ts` & `cli.ts`)

### 2.1 Single CLI Entrypoint
Running `npx reposcape` launches the Express/WS server, begins directory watching, and opens the visualizer HUD.

#### Headless & Open Browser Check
```typescript
import open from 'open';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

export async function launchHUD(port: number) {
  const isHeadless = process.env.CI === 'true' || !process.env.DISPLAY || !!process.env.SSH_CLIENT;
  const hudUrl = `http://127.0.0.1:${port}/hud.html`;
  
  if (isHeadless) {
    console.log(`\n🚀 HUD Server listening at ${hudUrl}`);
    console.log(`   (Headless environment detected - skipping browser auto-launch)\n`);
  } else {
    try {
      console.log(`\n🚀 HUD Server listening at ${hudUrl}`);
      console.log(`   Opening HUD visualizer in your browser...\n`);
      await open(hudUrl);
    } catch (err: any) {
      console.warn(`⚠️ Failed to auto-open browser: ${err.message}. Navigate manually to ${hudUrl}`);
    }
  }
}
```

### 2.2 Dev vs. Production Server Coexistence
*   **Development Mode**: 
    *   Vite runs on port `5173` hosting the hot-reloading frontend.
    *   Express daemon runs on port `5174`.
    *   `vite.config.ts` proxies `/api` and `/ws` to `http://localhost:5174`:
    ```typescript
    // vite.config.ts proxy snippet
    server: {
      proxy: {
        '/api': 'http://localhost:5174',
        '/ws': {
          target: 'ws://localhost:5174',
          ws: true
        }
      }
    }
    ```
*   **Production/Distribution Mode**:
    *   Vite is pre-compiled under `dist/hud/`.
    *   Express daemon runs on port `5173`, serving files statically via `express.static(path.join(__dirname, '../hud'))`, alongside the HTTP and WS APIs.

---

## 🔒 3. Session Security, Symlink Jail, and Schema Validation

### 3.1 Timing-Safe Local Session Token Authentication
To eliminate side-channel timing attack vulnerabilities during session token comparison:
1.  On boot, the daemon generates a cryptographically secure random session token and saves it:
    ```typescript
    import crypto from 'crypto';
    import fs from 'fs/promises';
    
    const token = crypto.randomBytes(32).toString('hex');
    await fs.mkdir('.reposcape', { recursive: true });
    await fs.writeFile('.reposcape/.session-token', token, 'utf-8');
    ```
2.  Express Middleware comparing client tokens to host tokens in constant time:
    ```typescript
    import { Request, Response, NextFunction } from 'express';
    import crypto from 'crypto';
    
    export function authMiddleware(req: Request, res: Response, next: NextFunction) {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing session token' });
      }
      const clientToken = authHeader.split(' ')[1];
      
      const clientBuffer = Buffer.from(clientToken, 'utf-8');
      const tokenBuffer = Buffer.from(token, 'utf-8');
      
      if (
        clientBuffer.length !== tokenBuffer.length || 
        !crypto.timingSafeEqual(clientBuffer, tokenBuffer)
      ) {
        return res.status(401).json({ error: 'Unauthorized: Invalid session token' });
      }
      next();
    }
    ```

### 3.2 Symlink Jail Path Sandboxing
To prevent path-traversal vulnerabilities from exposing system files (e.g. `/etc/passwd`) via crafted symlinks, we resolve physical symlinks recursively using `fs.realpath` before sandboxing:
```typescript
import path from 'path';
import fs from 'fs/promises';

export async function sandboxPath(targetPath: string, projectRoot: string): Promise<string> {
  // Recursively resolve all symlinks, relative references, and directory jumps first
  const resolvedRoot = await fs.realpath(projectRoot);
  let resolved: string;
  try {
    resolved = await fs.realpath(targetPath);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // Fallback for newly created but not yet written files
      resolved = path.resolve(targetPath);
    } else {
      throw err;
    }
  }
  const relative = path.relative(resolvedRoot, resolved);
  
  const isOutside = relative.startsWith('..') || path.isAbsolute(relative);
  if (isOutside) {
    throw new Error(`Security Violation: Path is outside the sandbox root jail: ${targetPath} (resolves to: ${resolved})`);
  }
  return resolved;
}
```

### 3.3 Cognitive Cache JSON Schema Validation
Agent-written JSON files in `.reposcape/cache/insights/` are rigorously validated on compilation:
```typescript
import path from 'path';

export interface CognitiveChunk {
  nodes: { id: string; label: string; file_type: 'code' | 'document' | 'concept'; source_file: string }[];
  edges: { 
    source: string; 
    target: string; 
    relation: string; 
    type: 'PHYSICAL' | 'COGNITIVE' | 'SUSPICIOUS'; 
    score: number; // For PHYSICAL: Coupling strength; COGNITIVE: Confidence; SUSPICIOUS: Risk severity
  }[];
  hyperedges?: any[];
}

export function validateCognitiveChunk(chunk: any): chunk is CognitiveChunk {
  if (!chunk || typeof chunk !== 'object') return false;
  if (!Array.isArray(chunk.nodes) || !Array.isArray(chunk.edges)) return false;
  
  const validFileTypes = new Set(['code', 'document', 'concept']);
  const validEdgeTypes = new Set(['PHYSICAL', 'COGNITIVE', 'SUSPICIOUS']);
  
  for (const n of chunk.nodes) {
    if (typeof n.id !== 'string' || !n.id) return false;
    if (typeof n.label !== 'string') return false;
    if (typeof n.source_file !== 'string' || !n.source_file) return false;
    
    // Fast sandboxing check: reject path traversal jumps or absolute paths
    const isOutside = n.source_file.split(/[/\\]/).includes('..') || path.isAbsolute(n.source_file);
    if (isOutside) return false;
    
    if (!validFileTypes.has(n.file_type)) return false;
  }
  for (const e of chunk.edges) {
    if (typeof e.source !== 'string' || typeof e.target !== 'string') return false;
    if (typeof e.relation !== 'string') return false;
    if (!validEdgeTypes.has(e.type)) return false;
    if (typeof e.score !== 'number' || e.score < 0 || e.score > 1.0) return false;
  }
  return true;
}
```
*   **Security & Path Resolution Contract**: The `source_file` field in this schema is treated strictly as opaque attribution metadata and is never opened or loaded directly by the daemon. Any current or future code path in the daemon or compiler that resolves a `source_file` value to a filesystem operation (e.g. reading, unlinking, or querying stats) MUST first canonicalize and validate it using §3.2's `sandboxPath`.
*   **Quarantine Rule**: If a file fails validation, the daemon quarantines it to `.reposcape/cache/corrupted/` and logs a clean warning.

### 3.4 Cognitive Insights Cache Producer Specification
*   **The Producer**: The active **Coding Agent** executing workspace edits is the sole creator of the insights cache.
*   **Prompt Orchestration**: RepoScape bundles an agent-facing system prompt in `SKILL.md`. When the agent initializes, it reads `SKILL.md` which instructs it to document logical relationships and architectural rationales as it reads/edits.
*   **Dual Ingestion Channels**:
    1.  **Direct API channel (Primary)**: The agent runs terminal pings (e.g. via `curl` or a simple node helper) to post bulk extractions directly to `POST /api/insights/batch`.
    2.  **File writing fallback (Constrained environment)**: If process execution or network connections are blocked, the agent directly writes JSON files under `.reposcape/cache/insights/` using the filename hashing rule:
        `filename = crypto.createHash('sha256').update(relativeSourceFilePath).digest('hex') + '.json'`
        *   **Relative Path Anchor**: The `relativeSourceFilePath` MUST be relative to the canonical project root resolved via §3.2, and MUST use the POSIX forward-slash separator `/` on all platforms (including Windows) to guarantee cross-platform hash parity.
        *   **Concurrency Write Lock**: To avoid race-conditions under concurrent agent runs, the file writing fallback channel MUST execute writes via the atomic locking utility `writeCacheAtomic(filePath, content)` defined in §4.4.
        For example, insights derived from `docs/architecture.md` are saved exactly as `.reposcape/cache/insights/5ef81b...json`.
*   **Targeted Deletion Sync**: If the agent deletes `docs/architecture.md`, the Chokidar file watcher triggers an unlink event, computes the `sha256('docs/architecture.md')` (POSIX normalized), and directly unlinks `.reposcape/cache/insights/5ef81b...json` to dynamically remove the nodes from the graph.
*   **Boot-Time Reconciliation Scan**: To clean up ghost nodes when files were deleted while the daemon was offline, the compiler runs a reconciliation sweep on boot: for every JSON file under `.reposcape/cache/insights/`, it reads the `source_file` field of its nodes/edges, checks their physical existence on disk (validating path confinement via §3.2), and automatically deletes the cached `.json` file if the corresponding source file is missing.

---

## ⚡ 4. Parsing, Caching, and Symbol Resolution Strategies

### 4.1 `web-tree-sitter` WASM Node.js Loader
We load WASM runtimes natively from local buffers to prevent browser `fetch()` polyfill failures:
```typescript
import Parser from 'web-tree-sitter';
import fs from 'fs/promises';
import path from 'path';

export async function initParser(wasmPath: string): Promise<Parser> {
  const wasmBinary = await fs.readFile(wasmPath);
  await Parser.init({
    locateFile: () => wasmPath,
    wasmBinary: wasmBinary
  });
  return new Parser();
}
```

### 4.2 Language Strategy Pattern Registry
To decouple multi-language parsing rules from core compilation files:
```typescript
export interface ExtractionResult {
  nodes: any[];
  edges: any[];
  rawCalls: { caller_nid: string; callee: string; is_member_call: boolean; source_location: string }[];
}

export interface LanguageStrategy {
  parse(sourceText: string, parser: Parser, filePath: string): ExtractionResult;
}

export class ParserRegistry {
  private static strategies = new Map<string, LanguageStrategy>();
  
  public static register(ext: string, strategy: LanguageStrategy) {
    ParserRegistry.strategies.set(ext, strategy);
  }
  
  public static get(ext: string): LanguageStrategy | undefined {
    return ParserRegistry.strategies.get(ext);
  }
}
```

### 4.3 Safe Config Comments Stripping
To avoid hash breaking on dynamic string patterns or comment scopes inside JSONC and YAML, we use standard parser libraries instead of brittle regex replacement blocks:
```typescript
import yaml from 'js-yaml';
import { parse as parseJsonc } from 'jsonc-parser';

export function getCanonicalConfigHash(text: string, ext: string): string {
  if (ext === '.json' || ext === '.jsonc') {
    // Leverage safe, production-grade jsonc-parser to strip comments and extract standard JS objects
    const obj = parseJsonc(text);
    return JSON.stringify(obj);
  }
  if (ext === '.yaml' || ext === '.yml') {
    const obj = yaml.load(text);
    return JSON.stringify(obj);
  }
  return text;
}
```

### 4.4 Deadlock-Free Exclusive Cache Write Locks
To avoid permanent process hanging when a lock file remains on disk after unexpected daemon terminations, we introduce stale-lock checking (unlinking files older than 10 seconds):
```typescript
export async function writeCacheAtomic(filePath: string, content: string) {
  const lockFile = `${filePath}.lock`;
  
  // Stale Lock Check: If lock file exists and is older than 10 seconds, force cleanup
  try {
    const stat = await fs.stat(lockFile);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > 10000) {
      await fs.unlink(lockFile).catch(() => {});
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }

  let retries = 10;
  while (retries > 0) {
    try {
      const handle = await fs.open(lockFile, 'wx');
      await handle.close();
      break;
    } catch (err) {
      retries--;
      if (retries === 0) throw new Error(`Could not acquire cache file lock for: ${filePath}`);
      await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * 90));
    }
  }
  
  try {
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, filePath);
  } finally {
    await fs.unlink(lockFile).catch(() => {});
  }
}
```

### 4.5 Recursive Barrel Re-Export Unwrapping with Symbol Renaming
Resolves imports that go through unified barrel directories (e.g. `./components/index.ts` re-exporting `/Foo` as `/Bar`), returning a `{ filePath, symbol }` tuple to prevent tracking breaks:
```typescript
export interface ResolvedExport {
  filePath: string;
  symbol: string;
}

export function unwrapReexports(
  importedSymbol: string, 
  targetFile: string, 
  globalExports: Map<string, Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>> 
  // file -> (exportedName -> { sourceFile, originalSymbol } | absoluteSourcePath | array of paths for star re-exports)
): ResolvedExport {
  let currentFile = targetFile;
  let currentSymbol = importedSymbol;
  let visited = new Set<string>();

  while (true) {
    const key = `${currentFile}::${currentSymbol}`;
    if (visited.has(key)) break; // Circular export guard
    visited.add(key);

    const fileExports = globalExports.get(currentFile);
    if (!fileExports) break;

    const mapping = fileExports.get(currentSymbol);
    if (mapping) {
      if (typeof mapping === 'string') {
        currentFile = mapping;
        // Symbol is preserved in default absolute path re-exports
      } else if (!Array.isArray(mapping)) {
        currentFile = mapping.sourceFile;
        currentSymbol = mapping.originalSymbol; // Trace symbol renaming (export { foo as bar })
      }
      continue;
    }
    
    // Check namespace star re-exports
    const starSource = fileExports.get('*');
    if (starSource) {
      if (typeof starSource === 'string') {
        currentFile = starSource;
        continue;
      } else if (Array.isArray(starSource)) {
        // Look ahead to find which star-exported file contains or re-exports the target symbol
        let found = false;
        for (const source of starSource) {
          const subExports = globalExports.get(source);
          if (subExports && (subExports.has(currentSymbol) || subExports.has('*'))) {
            currentFile = source;
            found = true;
            break;
          }
        }
        if (found) continue;
      }
    }
    break;
  }
  return { filePath: currentFile, symbol: currentSymbol };
}
```

### 4.6 Dynamic Out-Degree Hub Node Pruning
Ensures high-degree structural nodes do not clutter D3 simulation with thousands of visual spring lines:
```typescript
export function identifyHubNodes(nodes: any[], edges: any[]): Set<string> {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
  }
  
  const values = Array.from(degree.values());
  if (values.length === 0) return new Set();
  
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  
  const cutoff = mean + 5 * stdDev; // 5 Standard deviations
  const hubNodes = new Set<string>();
  for (const [nid, deg] of degree.entries()) {
    if (deg > cutoff && deg > 50) { // Require minimum of 50 links
      hubNodes.add(nid);
    }
  }
  return hubNodes;
}
```

### 4.7 SUSPICIOUS Edge Detection Heuristics
SUSPICIOUS edges are compiled via two complementary ingestion pathways, representing static physical cycles and cognitive anti-pattern warnings:

*   **Graph Topology Specifications**: RepoScape maintains the physical architecture graph as a **`DirectedGraph` (graphology)**. The cycle detection algorithm runs directly on this directed graph. For Louvain community clustering (§5.1), the daemon internally projects this into an **undirected graph** (aggregating bidirectional edge weights) before execution.

1. **Pathway A: Daemon-Driven Static Cycle Detection (Iterative Tarjan SCC Detector)**
   The compiler automatically runs an in-memory strongly connected components (SCC) analysis to isolate circular import loops (e.g., `A ➔ B ➔ C ➔ A`). 
   *   **Dynamic Risk Score**: Rather than a flat 1.0, the risk `score` scales dynamically with the size of the cycle: `score = Math.min(1.0, 0.4 + 0.1 * cycleLength)`. This ensures localized 2-node mutual recursion (`score = 0.6`) has lower visual urgency than a massive 6-node layer-spanning cycle (`score = 1.0`).
   *   **Iterative Call-Stack Safety**: To prevent Node.js `RangeError: Maximum call stack size exceeded` stack crashes on deeply coupled networks (even in smaller repositories with circular dependencies), the cycle detector is implemented strictly using an **iterative traversal model emulating the DFS frame stack on the heap**.
   ```typescript
    export function detectCycleEdges(nodes: string[], edges: { source: string; target: string }[]): Map<string, number> {
      const adj = new Map<string, string[]>();
      for (const e of edges) {
        if (!adj.has(e.source)) adj.set(e.source, []);
        adj.get(e.source)!.push(e.target);
      }

      const index = new Map<string, number>();
      const lowlink = new Map<string, number>();
      const onStack = new Set<string>();
      const stack: string[] = [];
      let idx = 0;
      const cycleEdges = new Map<string, number>(); // Stores edge key ("source->target") -> risk score

      interface DFSFrame {
        u: string;
        neighbors: string[];
        nextNeighborIndex: number;
      }

      const visited = new Set<string>();

      for (const startNode of nodes) {
        if (visited.has(startNode)) continue;

        const dfsStack: DFSFrame[] = [{
          u: startNode,
          neighbors: adj.get(startNode) || [],
          nextNeighborIndex: 0
        }];

        while (dfsStack.length > 0) {
          const frame = dfsStack[dfsStack.length - 1];
          const u = frame.u;

          if (frame.nextNeighborIndex === 0) {
            visited.add(u);
            index.set(u, idx);
            lowlink.set(u, idx);
            idx++;
            stack.push(u);
            onStack.add(u);
          }

          if (frame.nextNeighborIndex < frame.neighbors.length) {
            const v = frame.neighbors[frame.nextNeighborIndex];
            frame.nextNeighborIndex++;

            if (!visited.has(v)) {
              dfsStack.push({
                u: v,
                neighbors: adj.get(v) || [],
                nextNeighborIndex: 0
              });
            } else if (onStack.has(v)) {
              lowlink.set(u, Math.min(lowlink.get(u)!, index.get(v)!));
            }
          } else {
            dfsStack.pop();
            if (dfsStack.length > 0) {
              const parentFrame = dfsStack[dfsStack.length - 1];
              const p = parentFrame.u;
              lowlink.set(p, Math.min(lowlink.get(p)!, lowlink.get(u)!));
            }

            if (lowlink.get(u) === index.get(u)) {
              const component: string[] = [];
              while (true) {
                const w = stack.pop()!;
                onStack.delete(w);
                component.push(w);
                if (w === u) break;
              }

              if (component.length > 1) {
                const compSet = new Set(component);
                const riskScore = Math.min(1.0, 0.4 + 0.1 * component.length);
                for (const src of component) {
                  const neighbors = adj.get(src) || [];
                  for (const dst of neighbors) {
                    if (compSet.has(dst)) {
                      cycleEdges.set(`${src}->${dst}`, riskScore);
                    }
                  }
                }
              }
            }
          }
        }
      }
      return cycleEdges;
    }
   ```

2. **Pathway B: Agent-Asserted Cognitive Boundary Crossings**
   The active coding agent explicitly flags architectural violations (e.g. circular layers, layer leakage, or violating domain confinement rules) based on project-wide boundaries. The agent writes these directly as `SUSPICIOUS` edges with custom severity `score` values via `POST /api/insights/batch` or local cache JSON files.

---

## 📈 5. Visualizer HUD & Rendering Specifications

### 5.1 Louvain Modular Stabilization with Explicit Resolution
Ensures community modular assignments preserve ID and color structures on incremental compilation:
```typescript
import louvain from 'graphology-communities-louvain';

export function stabilizeCommunities(
  newCommunities: Map<string, number>, // node -> communityId
  oldCommunities: Map<string, number>
): Map<string, number> {
  const newSets = new Map<number, Set<string>>();
  const oldSets = new Map<number, Set<string>>();
  
  for (const [node, cid] of newCommunities.entries()) {
    if (!newSets.has(cid)) newSets.set(cid, new Set<string>());
    newSets.get(cid)!.add(node);
  }
  for (const [node, cid] of oldCommunities.entries()) {
    if (!oldSets.has(cid)) oldSets.set(cid, new Set<string>());
    oldSets.get(cid)!.add(node);
  }
  
  // Calculate greedy overlaps using Jaccard Similarity index
  const mappings = new Map<number, number>();
  const usedOld = new Set<number>();
  
  const overlaps: { score: number; newCid: number; oldCid: number }[] = [];
  for (const [newCid, newSet] of newSets.entries()) {
    for (const [oldCid, oldSet] of oldSets.entries()) {
      const intersection = new Set([...newSet].filter(x => oldSet.has(x)));
      const union = new Set([...newSet, ...oldSet]);
      const jaccard = intersection.size / union.size;
      if (jaccard > 0) {
        overlaps.push({ score: jaccard, newCid, oldCid });
      }
    }
  }
  
  overlaps.sort((a, b) => b.score - a.score);
  for (const match of overlaps) {
    if (!mappings.has(match.newCid) && !usedOld.has(match.oldCid)) {
      mappings.set(match.newCid, match.oldCid);
      usedOld.add(match.oldCid);
    }
  }
  
  let nextCid = 0;
  const stabilized = new Map<string, number>();
  for (const [node, newCid] of newCommunities.entries()) {
    let finalCid = mappings.get(newCid);
    if (finalCid === undefined) {
      while (usedOld.has(nextCid)) nextCid++;
      mappings.set(newCid, nextCid);
      usedOld.add(nextCid);
      finalCid = nextCid;
    }
    stabilized.set(node, finalCid);
  }
  return stabilized;
}

// Louvain computation explicitly locking resolution and seed:
export function runLouvainClustering(graph: any): Map<string, number> {
  // Classic LCG seeded random generator to guarantee 100% determinism (no external dependencies)
  let seed = 42;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const result = louvain(graph, {
    resolution: 1.0,      // Strictly locked resolution parameter
    rng: rng              // Custom seeded RNG for absolute reproducibility
  });
  return new Map(Object.entries(result));
}
```

### 5.2 Active API & Focus Contracts
*   `POST /api/focus`
*   `POST /api/agent-activity`
Focus and thoughts update pings have dynamic timestamping and high-reliability structures:
```json
{
  "file": "relative/path/to/App.tsx",
  "activity": "Refactoring session validation",
  "timestamp": 1716839736000,
  "ttl": 60000
}
```
*   `POST /api/insights/batch`
Batch ingestion aggregates cognitive thought/thought-relation extractions:
```json
{
  "extractions": [
    {
      "file": "docs/architecture.md",
      "hash": "sha256...",
      "nodes": [
        { "id": "architecture_visualizer", "label": "Canvas Visualizer", "file_type": "concept", "source_file": "docs/architecture.md" }
      ],
      "edges": [
        { "source": "architecture_visualizer", "target": "components_graphcanvas", "relation": "references", "type": "COGNITIVE", "score": 1.0 }
      ]
    }
  ]
}
```

### 5.3 WebSocket Heartbeats, Graph Diffs, and Client Reconnections
WebSocket frames handle live structural updates:
*   **Heartbeat**: Client sends a ping `{ "type": "ping" }` every 30 seconds. Server responds `{ "type": "pong" }`. If server fails to pong, client unlinks and reconnects.
*   **Diff Payload**:
    ```json
    {
      "type": "diff",
      "diff": {
        "addedNodes": [],
        "removedNodes": [],
        "updatedNodes": [], // Array of { id: string, ...partial fields } (e.g. activity, focus, or metadata changes). Client merges these into existing nodes.
        "addedEdges": [],
        "removedEdges": []
      }
    }
    ```
*   **Sequential Graph Mutation Queue**:
    To prevent data race conditions and guarantee in-memory graph consistency, all compile and mutation requests—including tree-sitter AST delta recompiles, Chokidar file watcher deletion unlinks, and cognitive insights ingestion via either the Express API or file fallbacks—MUST be serialized sequentially through a single, central asynchronous transaction queue in the daemon server before broadcasting WebSocket diffs.
    *   **Chokidar Watcher Storm Debounce & Batching**: To prevent Chokidar watcher "storms" (such as during a git checkout or branch switch where thousands of files mutate rapidly) from flooding the transaction queue and causing HUD latency stutters, the file watcher MUST execute a **100ms debounce window**. All file creation, change, and deletion events occurring within this 100ms window are aggregated into a single, unified "Batch Compile Task" before being pushed to the mutation queue.
*   **Client Hook with Cap-Limit Backoff Reconnection**:
    ```typescript
    // Inside React HUD Visualizer Client Connection Manager
    export interface HUDConnection {
      close: () => void;
    }

    export function connectHUD(
      onDiff: (diff: any) => void, 
      onStatusChange: (status: string, attemptsLeft?: number) => void
    ): HUDConnection {
      let ws: WebSocket | null = null;
      let reconnectDelay = 1000;
      let reconnectAttempts = 0;
      const MAX_RECONNECT_ATTEMPTS = 50; // Cap to prevent infinite loops on permanent offline
      let pingInterval: any = null;
      let isClosed = false;

      function connect() {
        if (isClosed) return;
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          onStatusChange('failed_permanently', 0);
          console.error("❌ WebSocket reconnect failed permanently after 50 attempts. Please restart Daemon.");
          return;
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
        
        ws.onopen = () => {
          if (isClosed) {
            ws?.close();
            return;
          }
          reconnectDelay = 1000; // Reset backoff
          reconnectAttempts = 0;
          onStatusChange('connected');
          
          // Start Heartbeat Pings
          pingInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ping' }));
            }
          }, 30000);
        };
        
        ws.onmessage = (event) => {
          if (isClosed) return;
          const msg = JSON.parse(event.data);
          if (msg.type === 'pong') return; // Heartbeat healthy
          if (msg.type === 'diff') {
            onDiff(msg.diff);
          }
        };
        
        ws.onclose = () => {
          if (pingInterval) clearInterval(pingInterval);
          if (isClosed) return;
          
          reconnectAttempts++;
          onStatusChange('disconnected', MAX_RECONNECT_ATTEMPTS - reconnectAttempts);
          
          // Exponential Reconnect Backoff capped at 16s
          setTimeout(() => {
            if (!isClosed) {
              reconnectDelay = Math.min(reconnectDelay * 2, 16000);
              connect();
            }
          }, reconnectDelay);
        };
      }

      connect();

      return {
        close: () => {
          isClosed = true;
          if (pingInterval) clearInterval(pingInterval);
          if (ws) {
            ws.onopen = null;
            ws.onmessage = null;
            ws.onclose = null;
            ws.close();
          }
        }
      };
    }
    ```

### 5.4 HUD Viewport Culling & LOD Thresholds
*   **DOMPurify Sidebar Sanitization**: Nodes/Edges metadata or markup tags written in markdown descriptions inside tooltips/sidebars are **rendered strictly in React JSX** or sanitized client-side using `DOMPurify.sanitize()` prior to mounting to prevent XSS. Server-side remains raw text.
*   **Frustum Bounding Check**: Bounding box mapping skips off-screen node drawing:
    ```typescript
    const isVisible = 
      node.x + node.size >= viewport.xMin &&
      node.x - node.size <= viewport.xMax &&
      node.y + node.size >= viewport.yMin &&
      node.y - node.size <= viewport.yMax;
    ```
*   **LOD Zoom Rules**:
    *   `zoom < 0.3`: Render only nodes as simple circles (no text labels, no edge flows). Hub Nodes always render visually at all zoom levels (since they serve as critical structural anchor points), but their dense incoming/outgoing PHYSICAL edges are excluded from D3 force-simulation spring calculations to prevent visual clutter and simulation lag.
    *   `0.3 <= zoom < 0.7`: Render nodes; render labels strictly for flagged Hub Nodes.
    *   `zoom >= 0.7`: Full rendering (glows, labels, dynamic flowing data particles, and warning pulses for SUSPICIOUS connections).
*   **Dynamic Edge Type Rendering & Control Rules**:
    *   **PHYSICAL (Static AST physical dependencies)**: Rendered as high-intensity, solid cyan (`#00f3ff`) glowing links, with high-velocity data particles flowing along the connection representing code-level dependency directions.
    *   **COGNITIVE (AI Cognitive associative links)**: Rendered as semi-transparent, purple (`#bd93f9`) dashed lines with slowly drifting micro-light particles, representing conceptual connections derived by agent cognitive thought mappings.
    *   **SUSPICIOUS (High-Risk/Structural warnings)**: Rendered as a pulsing, glowing orange (`#ffb86c`) dotted line. Clicking on the line opens a warning tooltip showing the agent's doubt description and structural coupling warning.
    *   **Interactive Sidebar Filters**: The HUD sidebar includes a multi-toggle "Dependency Filter" allowing developers to toggle visibility for each category of edges (e.g., viewing strictly static PHYSICAL structure vs. full COGNITIVE/SUSPICIOUS neural net).

### 5.5 Critically Damped Camera Spring Damping Equations
Smooth gliding transitions:
$$\text{Force} = -k \cdot (\text{CameraPos} - \text{TargetPos}) - c \cdot \text{Velocity}$$
Where:
*   Stiffness $k = 0.08$
*   Damping coefficient $c = 0.4$ (yields a critically damped coefficient of $2\sqrt{km}$ preventing overshoot wobbles).

---

## 🧪 6. Graph Versioning, Error Recoveries, and Performance Baselines

### 6.1 Two-Tier Cache Validation & Alignment
1.  A global cache version metadata file is generated at `.reposcape/cache/version.json`:
    ```json
    {
      "graph_version": "1.0.0",
      "git_head_commit": "sha256..."
    }
    ```
2.  **Decoupled Invalidation Policy**:
    *   **Tier 1: Git HEAD changes**: If the daemon detects the Git HEAD commit has changed but `graph_version` remains identical, it triggers **only an incremental compile** (re-parsing only the code files whose size/mtime hashes differ from `.reposcape/cache/stat-index.json`; all other files load from cached AST/Cognitive JSONs, restoring the graph in **<100ms**).
    *   **Tier 2: Schema version changes**: If `graph_version` undergoes a version mismatch (meaning RepoScape has updated its AST grammar structures), the daemon triggers a **complete cache flush** (automatically deleting all directories under `.reposcape/cache/` to force a clean re-scan).

### 6.2 Pipeline Failure Fallbacks
*   **AST Parse Failures**: If structural parsing throws exceptions, the daemon logs the error to `.reposcape/error.log` (retaining the previous cached representation), and prints a non-blocking warning banner in the HUD.
*   **Cache Invalidation**: Any structurally unparseable cache files are deleted immediately, falling back to a direct, fresh AST parse.

### 6.3 Logging Rotation Strategy
To prevent `.reposcape/error.log` from growing indefinitely and consuming local disk storage, the daemon checks the file size before appending. If the log exceeds **5 MiB**, it rolls it over to `error.log.1` (deleting the oldest log):
```typescript
export async function appendErrorLog(message: string) {
  const logPath = '.reposcape/error.log';
  
  // Ensure the parent directory exists to avoid ENOENT crashes
  await fs.mkdir(path.dirname(logPath), { recursive: true }).catch(() => {});
  
  try {
    const stat = await fs.stat(logPath);
    if (stat.size > 5 * 1024 * 1024) { // 5 MiB cap
      // Shift older logs to keep up to 3 historic backups
      await fs.rename('.reposcape/error.log.2', '.reposcape/error.log.3').catch(() => {});
      await fs.rename('.reposcape/error.log.1', '.reposcape/error.log.2').catch(() => {});
      await fs.rename(logPath, '.reposcape/error.log.1').catch(() => {});
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
  
  const timestamp = new Date().toISOString();
  await fs.appendFile(logPath, `[${timestamp}] ${message}\n`, 'utf-8');
}
```

### 6.4 Performance Baselines
*   **AST Scan & Compile P99 Latency**:
    *   `Files <= 1000`: `< 150ms`
    *   `Files <= 5000`: `< 500ms`
*   **Visual HUD Frame Rate (FPS) Baseline**:
    *   `Nodes <= 1000`: **60 FPS**
    *   `1000 < Nodes <= 3000`: **>45 FPS**
    *   `Nodes > 3000`: Automated community macro-level aggregation takes over to preserve visual fluid speed.
*   **Offline Fallback**: Pre-compiled WASM runtimes and built Visual HUD template index assets are compiled *inside the published npm package folder*, guaranteeing zero-network installation dependencies.
