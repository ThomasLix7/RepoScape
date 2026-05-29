import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import Parser from 'web-tree-sitter';
import { GraphNode, GraphEdge, CacheVersion, ExtractionResult, FileExtractionCache, RawExportEntry, RawImportEntry, GraphDiff } from './types.js';
import { validateCognitiveChunk, sandboxPath } from './security.js';
import { appendErrorLog } from './logger.js';
import { hashSourceFile, ensureDir, fileExists, writeCacheAtomic } from './cache.js';
import { ParserRegistry, initParser, registerDefaultStrategies, resolveGrammarPath } from './parser.js';
import { detectCycleEdges } from './cycles.js';
import { identifyHubNodes, unwrapReexports, ModuleResolver } from './resolver.js';
import { runLouvainClustering, stabilizeCommunities } from './community.js';

interface StatEntry {
  mtimeMs: number;
  size: number;
}

interface StatIndex {
  [filePath: string]: StatEntry;
}

const LANGUAGE_WASM_MAP: Record<string, string> = {
  '.ts': 'tree-sitter-typescript.wasm',
  '.tsx': 'tree-sitter-tsx.wasm',
  '.js': 'tree-sitter-javascript.wasm',
  '.jsx': 'tree-sitter-javascript.wasm',
  '.py': 'tree-sitter-python.wasm',
  '.go': 'tree-sitter-go.wasm',
  '.rs': 'tree-sitter-rust.wasm',
  '.java': 'tree-sitter-java.wasm',
  '.c': 'tree-sitter-c.wasm',
  '.cpp': 'tree-sitter-cpp.wasm',
  '.h': 'tree-sitter-cpp.wasm',
};

// §5.A: Generic labels — stored lowercase, lookup is case-insensitive
const GENERIC_LABELS = new Set([
  'map', 'get', 'set', 'init', 'push', 'pop', 'foreach', 'filter', 'reduce',
  'find', 'some', 'every', 'includes', 'slice', 'splice', 'concat', 'join',
  'sort', 'reverse', 'flat', 'flatmap', 'keys', 'values', 'entries', 'length',
  'tostring', 'valueof', 'constructor', 'prototype', 'apply', 'call', 'bind',
  'then', 'catch', 'finally', 'resolve', 'reject', 'all', 'race',
  'assign', 'freeze', 'isarray', 'parse', 'stringify',
]);

// §3.A: Deep-clone graph state for atomic diff
function snapshotGraph(nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>) {
  return {
    nodes: new Map(Array.from(nodes, ([k, v]) => [k, structuredClone(v)])),
    edges: new Map(Array.from(edges, ([k, v]) => [k, structuredClone(v)])),
  };
}

// §3.B: Shared diff function — pure, referentially transparent
export function diffGraphs(
  prev: { nodes: Map<string, GraphNode>; edges: Map<string, GraphEdge> },
  curr: { nodes: GraphNode[]; edges: GraphEdge[] }
): GraphDiff {
  const newNodesMap = new Map(curr.nodes.map((n) => [n.id, n]));
  const newEdgesMap = new Map(
    curr.edges.map((e) => [`${e.source}->${e.target}_${e.relation}`, e])
  );

  const addedNodes = curr.nodes.filter((n) => !prev.nodes.has(n.id));
  const removedNodes = [...prev.nodes.keys()].filter((id) => !newNodesMap.has(id));
  const updatedNodes = curr.nodes
    .filter((n) => {
      const old = prev.nodes.get(n.id);
      return old && JSON.stringify(old) !== JSON.stringify(n);
    })
    .map((n) => ({ ...n }));

  const addedEdges = curr.edges.filter(
    (e) => !prev.edges.has(`${e.source}->${e.target}_${e.relation}`)
  );
  const removedEdges = [...prev.edges.keys()].filter((key) => !newEdgesMap.has(key));

  return { addedNodes, removedNodes, updatedNodes, addedEdges, removedEdges };
}

export class GraphCompiler {
  private projectRoot: string;
  private scopeRoot: string | null = null;
  private nodes: Map<string, GraphNode> = new Map();
  private edges: Map<string, GraphEdge> = new Map();
  private communities: Map<string, number> = new Map();
  private hubNodes: Set<string> = new Set();
  private parser: any = null;
  private transactionQueue: Promise<void> = Promise.resolve();
  private rawCalls: ExtractionResult['rawCalls'] = [];
  // §2.D: fileBindings replaces fileImports — only explicit imports
  private fileBindings: Map<string, Map<string, { file: string; symbol: string }>> = new Map();
  // §2.D: defaultExports index — file → nodeId
  private defaultExports: Map<string, string> = new Map();
  // §1B: Persistent dependency caches — survive across compile runs
  private fileExportsCache: Map<string, Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>> = new Map();
  private isFirstCompile = true;
  // §2.C: Module resolver
  private moduleResolver: ModuleResolver;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.moduleResolver = new ModuleResolver(projectRoot);
  }

  setScopeRoot(scopeRoot: string | null): void {
    this.scopeRoot = scopeRoot;
  }

  getScopeRoot(): string | null {
    return this.scopeRoot;
  }

  // §1.B: Startup self-check — public API
  assertParserReady(): void {
    if (!this.parser) {
      throw new Error('FATAL: Parser instance is null after init()');
    }
    const langCount = ParserRegistry.getLoadedLanguageCount();
    if (langCount === 0) {
      throw new Error('FATAL: No language grammars loaded');
    }
    // Grammar-bound smoke test
    const tsLang = ParserRegistry.getLanguage('.ts');
    if (tsLang) {
      this.parser.setLanguage(tsLang);
      const tree = this.parser.parse('const x = 1;');
      if (!tree || !tree.rootNode) {
        throw new Error('FATAL: Parser smoke test failed — null tree');
      }
      const firstNamed = tree.rootNode.namedChildren[0];
      if (!firstNamed || firstNamed.type !== 'lexical_declaration') {
        throw new Error(
          `FATAL: Parser smoke test failed — expected 'lexical_declaration', got '${firstNamed?.type}'`
        );
      }
    }
  }

  async init(): Promise<void> {
    registerDefaultStrategies();
    await this.moduleResolver.init();
    this.moduleResolver.setSupportedExtensions(ParserRegistry.getSupportedExtensions());

    // §4.A: Migrate insights from cache/insights/ to insights/
    await this.migrateInsights();

    try {
      // §1.A: Core runtime from web-tree-sitter, not tree-sitter-wasms
      this.parser = await initParser(this.projectRoot);
    } catch (err: any) {
      // §1.A: Abort on failure — don't enter serve loop with null parser
      const msg = `FATAL: Failed to init tree-sitter parser: ${err.message}`;
      await appendErrorLog(this.projectRoot, msg);
      throw new Error(msg);
    }

    if (this.parser) {
      for (const [ext, file] of Object.entries(LANGUAGE_WASM_MAP)) {
        try {
          const grammarPath = resolveGrammarPath(this.projectRoot, file);
          const lang = await Parser.Language.load(grammarPath);
          ParserRegistry.setLanguage(ext, lang);
        } catch (err: any) {
          await appendErrorLog(this.projectRoot, `Failed to load grammar ${file}: ${err.message}`);
        }
      }
    }

    // §1.B: Abort if no grammars loaded
    if (ParserRegistry.getLoadedLanguageCount() === 0) {
      const msg = 'FATAL: No language grammars could be loaded';
      await appendErrorLog(this.projectRoot, msg);
      throw new Error(msg);
    }

    await this.checkCacheVersion();
    await this.loadPersistedCommunities();
    await this.reconciliationScan();
  }

  // §4.A: Insights migration from cache/insights/ to insights/
  private async migrateInsights(): Promise<void> {
    const legacyDir = path.join(this.projectRoot, '.reposcape', 'cache', 'insights');
    const targetDir = path.join(this.projectRoot, '.reposcape', 'insights');

    try {
      const files = await fs.readdir(legacyDir);
      if (files.length === 0) return;

      await ensureDir(targetDir);
      let collisions = 0;

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const legacyPath = path.join(legacyDir, file);
        const targetPath = path.join(targetDir, file);

        try {
          const targetExists = await fileExists(targetPath);
          if (!targetExists) {
            await fs.rename(legacyPath, targetPath);
          } else {
            const legacyStat = await fs.stat(legacyPath);
            const targetStat = await fs.stat(targetPath);
            if (legacyStat.mtimeMs > targetStat.mtimeMs) {
              await fs.rename(legacyPath, targetPath);
            } else {
              await fs.unlink(legacyPath);
            }
            collisions++;
          }
        } catch {
          // skip individual file errors
        }
      }

      // Clean up empty legacy dir
      try {
        const remaining = await fs.readdir(legacyDir);
        if (remaining.length === 0) {
          await fs.rmdir(legacyDir);
        }
      } catch {
        // dir doesn't exist or not empty
      }

      if (collisions > 0) {
        await appendErrorLog(this.projectRoot, `Insights migration resolved ${collisions} collision(s) by mtime`);
      }
    } catch {
      // legacy dir doesn't exist — no migration needed
    }
  }

  private async checkCacheVersion(): Promise<void> {
    const cacheDir = path.join(this.projectRoot, '.reposcape', 'cache');
    const versionPath = path.join(cacheDir, 'version.json');

    try {
      const raw = await fs.readFile(versionPath, 'utf-8');
      const cached: CacheVersion = JSON.parse(raw);
      if (cached.graph_version !== '1.0.0') {
        // §4.A: Only delete cache/, not insights/
        await fs.rm(cacheDir, { recursive: true, force: true });
        await ensureDir(cacheDir);
        await appendErrorLog(
          this.projectRoot,
          `Cache flushed: graph_version mismatch (${cached.graph_version} → 1.0.0)`
        );
      }
    } catch {
      // No cached version → first run
    }
  }

  // §4.B: Load persisted communities
  private async loadPersistedCommunities(): Promise<void> {
    const communitiesPath = path.join(this.projectRoot, '.reposcape', 'cache', 'communities.json');
    try {
      const raw = await fs.readFile(communitiesPath, 'utf-8');
      const entries = JSON.parse(raw) as [string, number][];
      this.communities = new Map(entries);
    } catch {
      // No persisted communities — first run
    }
  }

  // §4.B: Save communities deterministically
  private async savePersistedCommunities(): Promise<void> {
    const communitiesPath = path.join(this.projectRoot, '.reposcape', 'cache', 'communities.json');
    const cacheDir = path.join(this.projectRoot, '.reposcape', 'cache');
    await ensureDir(cacheDir);
    // §4.B: Deterministic ordering — sort node IDs lexicographically
    const sorted = [...this.communities.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    await writeCacheAtomic(communitiesPath, JSON.stringify(sorted));
  }

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.transactionQueue = this.transactionQueue.then(async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  // §3.A: compileAndDiff is the public mutation path
  async compileAndDiff(): Promise<{ graph: { nodes: GraphNode[]; edges: GraphEdge[] }; diff: GraphDiff }> {
    return this.enqueue(async () => {
      const prev = snapshotGraph(this.nodes, this.edges);
      const graph = await this.compileInternal();
      const diff = diffGraphs(prev, graph);
      return { graph, diff };
    });
  }

  // §3.A: compile is the non-diff path
  async compile(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    return this.enqueue(() => this.compileInternal());
  }

  // §3.A: Private — the real work, must not call enqueue itself
  private async compileInternal(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const cacheDir = path.join(this.projectRoot, '.reposcape', 'cache');
    const insightsDir = path.join(this.projectRoot, '.reposcape', 'insights');
    const astCacheDir = path.join(cacheDir, 'ast');
    await ensureDir(insightsDir);
    await ensureDir(astCacheDir);

    const statIndexPath = path.join(cacheDir, 'stat-index.json');
    let statIndex: StatIndex = {};
    try {
      const raw = await fs.readFile(statIndexPath, 'utf-8');
      statIndex = JSON.parse(raw);
    } catch {
      statIndex = {};
    }

    const newStatIndex: StatIndex = {};
    const sourceFiles = await this.findSourceFiles();

    // §6: Build source_file → node/edge id index for O(1) eviction
    const sourceToNodeIds = new Map<string, Set<string>>();
    const sourceToEdgeKeys = new Map<string, Set<string>>();
    for (const [id, node] of this.nodes.entries()) {
      if (!sourceToNodeIds.has(node.source_file)) sourceToNodeIds.set(node.source_file, new Set());
      sourceToNodeIds.get(node.source_file)!.add(id);
    }
    for (const [key, edge] of this.edges.entries()) {
      const src = edge.source_file || '';
      if (!src) continue;
      if (!sourceToEdgeKeys.has(src)) sourceToEdgeKeys.set(src, new Set());
      sourceToEdgeKeys.get(src)!.add(key);
    }

    this.rawCalls = [];
    // §2.D: Reset per-compile accumulators
    this.fileBindings.clear();

    // §1: On first compile of this process, skip stat-index optimization and parse everything
    const forceFullParse = this.isFirstCompile;
    this.isFirstCompile = false;

    // Accumulate rawImports for resolution pass
    const allRawImports: { caller: string; entry: RawImportEntry }[] = [];

    for (const filePath of sourceFiles) {
      try {
        const stat = await fs.stat(filePath);
        const relativePath = path.relative(this.projectRoot, filePath).replace(/\\/g, '/');
        newStatIndex[relativePath] = { mtimeMs: stat.mtimeMs, size: stat.size };

        const cached = statIndex[relativePath];

        if (!forceFullParse && cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          // §1: File unchanged — rehydrate from per-file AST cache
          const astCachePath = path.join(astCacheDir, `${hashSourceFile(relativePath)}.json`);
          try {
            const cachedRaw = await fs.readFile(astCachePath, 'utf-8');
            const extraction: FileExtractionCache = JSON.parse(cachedRaw);
            for (const node of extraction.nodes) this.nodes.set(node.id, node);
            for (const edge of extraction.edges) {
              const edgeId = `${edge.source}->${edge.target}_${edge.relation}`;
              this.edges.set(edgeId, edge);
            }
            this.rawCalls.push(...extraction.rawCalls);
            // §2.B: Rehydrate rawImports and defaultExportNodeId from cache
            if (extraction.rawImports) {
              for (const entry of extraction.rawImports) {
                allRawImports.push({ caller: relativePath, entry });
              }
            }
            if (extraction.defaultExportNodeId) {
              this.defaultExports.set(relativePath, extraction.defaultExportNodeId);
            }
            // §2.E: Rehydrate exports cache with full async resolution
            await this.updateExportsCacheAsync(relativePath, extraction.rawExports || []);
          } catch {
            // Cache miss — parse fresh
            this.evictByIndex(relativePath, sourceToNodeIds, sourceToEdgeKeys);
            await this.parseFile(filePath, relativePath, astCacheDir, allRawImports);
          }
          continue;
        }

        // §2, #9: Evict stale state for this file (no cascade)
        this.evictByIndex(relativePath, sourceToNodeIds, sourceToEdgeKeys);

        await this.parseFile(filePath, relativePath, astCacheDir, allRawImports);
      } catch (err: any) {
        await appendErrorLog(this.projectRoot, `Error parsing ${filePath}: ${err.message}`);
      }
    }

    // §3: Evict state for deleted files
    for (const oldPath of Object.keys(statIndex)) {
      if (!(oldPath in newStatIndex)) {
        this.evictByIndex(oldPath, sourceToNodeIds, sourceToEdgeKeys);
        // Clean up AST cache for deleted file
        const astCachePath = path.join(astCacheDir, `${hashSourceFile(oldPath)}.json`);
        await fs.unlink(astCachePath).catch(() => {});
        // §2.D: Clean up defaultExports for deleted files
        this.defaultExports.delete(oldPath);
      }
    }

    // Prune edges with missing endpoints (dangling from eviction)
    for (const [key, edge] of this.edges.entries()) {
      if (!this.nodes.has(edge.source) || !this.nodes.has(edge.target)) {
        this.edges.delete(key);
      }
    }

    await this.loadCognitiveInsights(insightsDir);

    // §2.D: Resolution pass — runs after all files parsed and exports cache populated
    await this.resolveImports(allRawImports);

    // §5.B: Call-graph resolution using fileBindings
    this.resolveCallGraph();

    const allEdges = Array.from(this.edges.values());
    const physicalEdges = allEdges.filter((e) => e.type === 'PHYSICAL');
    const nodeIds = Array.from(this.nodes.keys());

    // Purge stale SUSPICIOUS edges before cycle detection
    for (const [key, edge] of this.edges.entries()) {
      if (edge.type === 'SUSPICIOUS') {
        this.edges.delete(key);
      }
    }

    const cycleEdges = detectCycleEdges(
      nodeIds,
      physicalEdges.map((e) => ({ source: e.source, target: e.target }))
    );

    for (const [edgeKey, riskScore] of cycleEdges.entries()) {
      const [src, dst] = edgeKey.split('->');
      const suspiciousId = `sus_${edgeKey}`;
      this.edges.set(suspiciousId, {
        source: src,
        target: dst,
        relation: 'circular_dependency',
        type: 'SUSPICIOUS',
        score: riskScore,
      });
    }

    this.hubNodes = identifyHubNodes(
      Array.from(this.nodes.values()),
      allEdges.filter((e) => e.type === 'PHYSICAL')
    );

    try {
      const newCommunities = runLouvainClustering(
        Array.from(this.nodes.keys()),
        physicalEdges
      );
      this.communities = stabilizeCommunities(newCommunities, this.communities);
      for (const [nodeId, communityId] of this.communities.entries()) {
        const node = this.nodes.get(nodeId);
        if (node) node.community = communityId;
      }
      // §4.B: Persist communities
      await this.savePersistedCommunities();
    } catch (err: any) {
      await appendErrorLog(this.projectRoot, `Louvain clustering failed: ${err.message}`);
    }

    await fs.writeFile(statIndexPath, JSON.stringify(newStatIndex, null, 2), 'utf-8');
    await this.saveVersion();

    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
    };
  }

  // §2, §6: O(1) eviction using source_file index — no cascade
  private evictByIndex(
    relativePath: string,
    sourceToNodeIds: Map<string, Set<string>>,
    sourceToEdgeKeys: Map<string, Set<string>>
  ): void {
    const nodeIds = sourceToNodeIds.get(relativePath);
    if (nodeIds) {
      for (const id of nodeIds) this.nodes.delete(id);
      sourceToNodeIds.delete(relativePath);
    }
    const edgeKeys = sourceToEdgeKeys.get(relativePath);
    if (edgeKeys) {
      for (const key of edgeKeys) this.edges.delete(key);
      sourceToEdgeKeys.delete(relativePath);
    }
    // §1B: Evict dependency caches for this file
    this.fileExportsCache.delete(relativePath);
    this.fileBindings.delete(relativePath);
    this.defaultExports.delete(relativePath);
  }

  private async parseFile(
    filePath: string,
    relativePath: string,
    astCacheDir: string,
    allRawImports: { caller: string; entry: RawImportEntry }[]
  ): Promise<void> {
    const ext = path.extname(filePath);
    const strategy = ParserRegistry.get(ext);
    if (!strategy || !this.parser) return;

    const lang = ParserRegistry.getLanguage(ext);
    if (lang) {
      this.parser.setLanguage(lang);
    }

    const sourceText = await fs.readFile(filePath, 'utf-8');
    const result = strategy.parse(sourceText, this.parser, relativePath);

    for (const node of result.nodes) {
      this.nodes.set(node.id, node);
    }
    for (const edge of result.edges) {
      const edgeId = `${edge.source}->${edge.target}_${edge.relation}`;
      this.edges.set(edgeId, edge);
    }

    this.rawCalls.push(...result.rawCalls);

    // §2.A: Collect rawImports for resolution pass
    for (const entry of result.rawImports) {
      allRawImports.push({ caller: relativePath, entry });
    }

    // §2.A: Track defaultExportNodeId
    if (result.defaultExportNodeId) {
      this.defaultExports.set(relativePath, result.defaultExportNodeId);
    }

    // §1B: Update dependency caches from rawExports
    await this.updateExportsCacheAsync(relativePath, result.rawExports);

    // §1: Persist per-file extraction to AST cache for cold-start rehydration
    const astCachePath = path.join(astCacheDir, `${hashSourceFile(relativePath)}.json`);
    const cacheEntry: FileExtractionCache = {
      nodes: result.nodes,
      edges: result.edges,
      rawCalls: result.rawCalls,
      rawExports: result.rawExports,
      rawImports: result.rawImports,
      defaultExportNodeId: result.defaultExportNodeId,
    };
    await writeCacheAtomic(astCachePath, JSON.stringify(cacheEntry));
  }

  // §2.E: Update exports cache — resolve sourceFile through ModuleResolver
  private async updateExportsCacheAsync(relativePath: string, rawExports: RawExportEntry[]): Promise<void> {
    const exports = new Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>();
    for (const entry of rawExports) {
      // §2.E: Skip type-only exports
      if (entry.exportKind === 'type') continue;

      if (entry.isStar && entry.sourceFile) {
        // §2.E: Resolve star re-export sourceFile through full ModuleResolver
        const resolved = await this.moduleResolver.resolve(relativePath, entry.sourceFile);
        if (!resolved) continue; // Drop unresolvable re-exports
        const existing = exports.get('*');
        if (Array.isArray(existing)) {
          existing.push(resolved);
        } else if (existing) {
          exports.set('*', [existing as string, resolved]);
        } else {
          exports.set('*', [resolved]);
        }
      } else if (entry.sourceFile) {
        // §2.E: Named re-export from another file — resolve sourceFile through full ModuleResolver
        const resolved = await this.moduleResolver.resolve(relativePath, entry.sourceFile);
        if (!resolved) continue; // Drop unresolvable re-exports
        if (entry.alias) {
          exports.set(entry.alias, { sourceFile: resolved, originalSymbol: entry.symbol });
        } else {
          exports.set(entry.symbol, resolved);
        }
      } else {
        // Direct export from this file
        exports.set(entry.symbol, relativePath);
      }
    }
    this.fileExportsCache.set(relativePath, exports);
  }

  // §2.D: Resolution pass — runs after all files parsed
  private async resolveImports(allRawImports: { caller: string; entry: RawImportEntry }[]): Promise<void> {
    for (const { caller, entry } of allRawImports) {
      const targetFile = await this.moduleResolver.resolve(caller, entry.moduleSpecifier);
      if (!targetFile) continue; // bare or unresolvable

      // Type-only imports: no PHYSICAL edge, no binding
      if (entry.kind === 'type-default' || entry.kind === 'type-named') continue;

      const callerFileNodeId = this.findFileNodeId(caller);
      if (!callerFileNodeId) continue;

      let edgeTargetFile: string;

      switch (entry.kind) {
        case 'side-effect':
          edgeTargetFile = targetFile;
          break;
        case 'namespace':
          edgeTargetFile = targetFile;
          if (!this.fileBindings.has(caller)) this.fileBindings.set(caller, new Map());
          this.fileBindings.get(caller)!.set(entry.localName, { file: targetFile, symbol: '*' });
          break;
        case 'default': {
          const resolved = unwrapReexports('default', targetFile, this.fileExportsCache);
          edgeTargetFile = resolved.filePath;
          if (!this.fileBindings.has(caller)) this.fileBindings.set(caller, new Map());
          this.fileBindings.get(caller)!.set(entry.localName, { file: resolved.filePath, symbol: resolved.symbol });
          break;
        }
        case 'named': {
          const resolved = unwrapReexports(entry.importedName, targetFile, this.fileExportsCache);
          edgeTargetFile = resolved.filePath;
          if (!this.fileBindings.has(caller)) this.fileBindings.set(caller, new Map());
          this.fileBindings.get(caller)!.set(entry.localName, { file: resolved.filePath, symbol: resolved.symbol });
          break;
        }
      }

      const targetFileNodeId = this.findFileNodeId(edgeTargetFile!);
      if (!targetFileNodeId) continue;

      const edgeId = `${callerFileNodeId}->${targetFileNodeId}_imports`;
      this.edges.set(edgeId, {
        source: callerFileNodeId,
        target: targetFileNodeId,
        relation: 'imports',
        type: 'PHYSICAL',
        score: 1.0,
        source_file: caller,
        source_location: entry.source_location,
      });
    }
  }

  // Helper: find the file-level node for a given source_file path
  private findFileNodeId(sourceFile: string): string | undefined {
    for (const [id, node] of this.nodes.entries()) {
      if (node.source_file === sourceFile && !node.source_location) {
        return id;
      }
    }
    return undefined;
  }

  // §5.B: Resolve binding to node ID
  private resolveBindingToNode(
    binding: { file: string; symbol: string },
    localFunctions: Map<string, Map<string, string>>
  ): string | null {
    if (binding.symbol === 'default') {
      return this.defaultExports.get(binding.file) || null;
    }
    const fileFuncs = localFunctions.get(binding.file);
    if (!fileFuncs) return null;
    return fileFuncs.get(binding.symbol.toLowerCase()) || null;
  }

  // §5.B: Scoped call graph resolution — local → imported binding → namespace member → unique global
  private resolveCallGraph(): void {
    // Build local functions map: file → label → node ID (case-insensitive)
    const localFunctions = new Map<string, Map<string, string>>();
    for (const [id, node] of this.nodes.entries()) {
      if (node.file_type === 'code' && node.source_location) {
        const file = node.source_file;
        if (!localFunctions.has(file)) localFunctions.set(file, new Map());
        localFunctions.get(file)!.set(node.label.toLowerCase(), id);
      }
    }

    // Build global label frequency map for unique-global fallback
    const globalLabelFreq = new Map<string, number>();
    const globalLabelToId = new Map<string, string>();
    for (const [id, node] of this.nodes.entries()) {
      if (node.file_type === 'code' && node.source_location) {
        const label = node.label.toLowerCase();
        globalLabelFreq.set(label, (globalLabelFreq.get(label) || 0) + 1);
        globalLabelToId.set(label, id);
      }
    }

    for (const call of this.rawCalls) {
      const calleeName = call.callee;
      const callerFile = this.nodes.get(call.caller_nid)?.source_file;
      if (!callerFile) continue;

      if (call.is_member_call) {
        // §5.B: Namespace member call decomposition
        const parts = calleeName.split('.');
        if (parts.length === 2) {
          const [ns, member] = parts;
          const nsKey = ns.toLowerCase();
          const bindings = this.fileBindings.get(callerFile);
          const binding = bindings?.get(nsKey);
          if (binding && binding.symbol === '*') {
            // Namespace binding — decompose member call
            const resolved = unwrapReexports(member, binding.file, this.fileExportsCache);
            const targetId = this.resolveBindingToNode(
              { file: resolved.filePath, symbol: resolved.symbol },
              localFunctions
            );
            if (targetId && targetId !== call.caller_nid) {
              const edgeId = `${call.caller_nid}->${targetId}_calls`;
              if (!this.edges.has(edgeId)) {
                this.edges.set(edgeId, {
                  source: call.caller_nid,
                  target: targetId,
                  relation: 'calls',
                  type: 'PHYSICAL',
                  score: 1.0,
                  source_file: callerFile,
                  source_location: call.source_location,
                });
              }
            }
            continue;
          }
        }
        // Fall through for non-namespace member calls
        const memberName = calleeName.split('.').pop()!;
        const memberKey = memberName.toLowerCase();
        if (GENERIC_LABELS.has(memberKey)) continue;

        // Step 1: Local function
        const locals = localFunctions.get(callerFile);
        if (locals?.has(memberKey)) {
          const targetId = locals.get(memberKey)!;
          if (targetId !== call.caller_nid) {
            const edgeId = `${call.caller_nid}->${targetId}_calls`;
            if (!this.edges.has(edgeId)) {
              this.edges.set(edgeId, {
                source: call.caller_nid,
                target: targetId,
                relation: 'calls',
                type: 'PHYSICAL',
                score: 1.0,
                source_file: callerFile,
                source_location: call.source_location,
              });
            }
          }
          continue;
        }

        // Step 2: Explicit imported binding
        const bindings = this.fileBindings.get(callerFile);
        const binding = bindings?.get(memberKey);
        if (binding) {
          const targetId = this.resolveBindingToNode(binding, localFunctions);
          if (targetId && targetId !== call.caller_nid) {
            const edgeId = `${call.caller_nid}->${targetId}_calls`;
            if (!this.edges.has(edgeId)) {
              this.edges.set(edgeId, {
                source: call.caller_nid,
                target: targetId,
                relation: 'calls',
                type: 'PHYSICAL',
                score: 1.0,
                source_file: callerFile,
                source_location: call.source_location,
              });
            }
          }
          continue;
        }

        // Step 4: Unique global
        if (globalLabelFreq.get(memberKey) === 1) {
          const targetId = globalLabelToId.get(memberKey)!;
          if (targetId !== call.caller_nid) {
            const edgeId = `${call.caller_nid}->${targetId}_calls`;
            if (!this.edges.has(edgeId)) {
              this.edges.set(edgeId, {
                source: call.caller_nid,
                target: targetId,
                relation: 'calls',
                type: 'PHYSICAL',
                score: 0.8,
                source_file: callerFile,
                source_location: call.source_location,
              });
            }
          }
        }
      } else {
        // Non-member call
        const calleeKey = calleeName.toLowerCase();
        if (GENERIC_LABELS.has(calleeKey)) continue;

        // Step 1: Local function in same file
        const locals = localFunctions.get(callerFile);
        if (locals?.has(calleeKey)) {
          const targetId = locals.get(calleeKey)!;
          if (targetId !== call.caller_nid) {
            const edgeId = `${call.caller_nid}->${targetId}_calls`;
            if (!this.edges.has(edgeId)) {
              this.edges.set(edgeId, {
                source: call.caller_nid,
                target: targetId,
                relation: 'calls',
                type: 'PHYSICAL',
                score: 1.0,
                source_file: callerFile,
                source_location: call.source_location,
              });
            }
          }
          continue;
        }

        // Step 2: Explicit imported binding
        const bindings = this.fileBindings.get(callerFile);
        const binding = bindings?.get(calleeKey);
        if (binding) {
          const targetId = this.resolveBindingToNode(binding, localFunctions);
          if (targetId && targetId !== call.caller_nid) {
            const edgeId = `${call.caller_nid}->${targetId}_calls`;
            if (!this.edges.has(edgeId)) {
              this.edges.set(edgeId, {
                source: call.caller_nid,
                target: targetId,
                relation: 'calls',
                type: 'PHYSICAL',
                score: 1.0,
                source_file: callerFile,
                source_location: call.source_location,
              });
            }
          }
          continue;
        }

        // Step 3: Unique global non-generic match
        if (globalLabelFreq.get(calleeKey) === 1) {
          const targetId = globalLabelToId.get(calleeKey)!;
          if (targetId !== call.caller_nid) {
            const edgeId = `${call.caller_nid}->${targetId}_calls`;
            if (!this.edges.has(edgeId)) {
              this.edges.set(edgeId, {
                source: call.caller_nid,
                target: targetId,
                relation: 'calls',
                type: 'PHYSICAL',
                score: 0.8,
                source_file: callerFile,
                source_location: call.source_location,
              });
            }
          }
        }
      }
    }
  }

  // §7.B: Bounded concurrency pool for cognitive chunk validation
  private async loadCognitiveInsights(insightsDir: string): Promise<void> {
    try {
      const files = await fs.readdir(insightsDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(insightsDir, file);
        try {
          const raw = await fs.readFile(filePath, 'utf-8');
          let chunk: any;
          try {
            chunk = JSON.parse(raw);
          } catch {
            await fs.unlink(filePath).catch(() => {});
            await appendErrorLog(this.projectRoot, `Deleted corrupted cache file: ${file}`);
            continue;
          }

          if (!validateCognitiveChunk(chunk)) {
            const corruptedDir = path.join(this.projectRoot, '.reposcape', 'cache', 'corrupted');
            await ensureDir(corruptedDir);
            await fs.rename(filePath, path.join(corruptedDir, file));
            await appendErrorLog(this.projectRoot, `Quarantined invalid cognitive cache: ${file}`);
            continue;
          }

          // §7.B: Bounded concurrency pool with short-circuit
          const hasMissingSource = await this.validateChunkSources(chunk);
          if (hasMissingSource) {
            await fs.unlink(filePath).catch(() => {});
            continue;
          }

          for (const node of chunk.nodes) {
            this.nodes.set(node.id, {
              ...node,
              file_type: node.file_type as GraphNode['file_type'],
            });
          }
          for (const edge of chunk.edges) {
            const edgeId = `cog_${edge.source}->${edge.target}_${edge.relation}`;
            this.edges.set(edgeId, {
              ...edge,
              type: edge.type as GraphEdge['type'],
            });
          }
        } catch (err: any) {
          await appendErrorLog(
            this.projectRoot,
            `Error loading cognitive cache ${file}: ${err.message}`
          );
        }
      }
    } catch {
      // insightsDir doesn't exist yet
    }
  }

  // §7.B: Bounded concurrency pool with short-circuit for source validation
  private async validateChunkSources(chunk: any): Promise<boolean> {
    const concurrency = Math.min(8, os.cpus().length);
    let hasMissingSource = false;
    let inFlight = 0;
    let index = 0;
    const nodes = chunk.nodes as { source_file: string }[];

    return new Promise<boolean>((resolve) => {
      const scheduleNext = () => {
        while (inFlight < concurrency && index < nodes.length && !hasMissingSource) {
          const node = nodes[index++];
          inFlight++;
          const sourcePath = path.join(this.projectRoot, node.source_file);
          sandboxPath(sourcePath, this.projectRoot)
            .then(() => fileExists(sourcePath))
            .then((exists) => {
              if (!exists) hasMissingSource = true;
            })
            .catch(() => {
              hasMissingSource = true;
            })
            .finally(() => {
              inFlight--;
              if (hasMissingSource && inFlight === 0) {
                resolve(true);
              } else if (index >= nodes.length && inFlight === 0) {
                resolve(hasMissingSource);
              } else if (!hasMissingSource) {
                scheduleNext();
              }
            });
        }
        // If nothing was scheduled and we're done
        if (index >= nodes.length && inFlight === 0) {
          resolve(hasMissingSource);
        }
      };
      scheduleNext();
    });
  }

  private async reconciliationScan(): Promise<void> {
    const insightsDir = path.join(this.projectRoot, '.reposcape', 'insights');
    try {
      const files = await fs.readdir(insightsDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(insightsDir, file);
        try {
          const raw = await fs.readFile(filePath, 'utf-8');
          let chunk: any;
          try {
            chunk = JSON.parse(raw);
          } catch {
            await fs.unlink(filePath).catch(() => {});
            continue;
          }

          if (!chunk.nodes || !Array.isArray(chunk.nodes)) continue;

          let modified = false;
          const validNodes: typeof chunk.nodes = [];
          const validEdges: typeof chunk.edges = [];

          for (const node of chunk.nodes) {
            if (!node.source_file) {
              modified = true;
              continue;
            }
            const sourcePath = path.join(this.projectRoot, node.source_file);
            try {
              await sandboxPath(sourcePath, this.projectRoot);
              const exists = await fileExists(sourcePath);
              if (exists) {
                validNodes.push(node);
              } else {
                modified = true;
              }
            } catch {
              modified = true;
            }
          }

          if (chunk.edges && Array.isArray(chunk.edges)) {
            const validNodeIds = new Set(validNodes.map((n: any) => n.id));
            for (const edge of chunk.edges) {
              if (validNodeIds.has(edge.source) && validNodeIds.has(edge.target)) {
                validEdges.push(edge);
              } else {
                modified = true;
              }
            }
          }

          if (modified) {
            if (validNodes.length === 0) {
              await fs.unlink(filePath).catch(() => {});
            } else {
              const cleanedChunk = { ...chunk, nodes: validNodes, edges: validEdges };
              await writeCacheAtomic(filePath, JSON.stringify(cleanedChunk, null, 2));
            }
          }
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // directory doesn't exist
    }
  }

  async findSourceFiles(): Promise<string[]> {
    const extensions = ParserRegistry.getSupportedExtensions();
    const results: string[] = [];
    const ignoreDirs = new Set(['node_modules', '.git', '.reposcape', 'dist', 'build', '.next']);

    const walk = async (dir: string) => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (ignoreDirs.has(entry.name)) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name);
            if (extensions.includes(ext)) {
              results.push(fullPath);
            }
          }
        }
      } catch {
        // skip unreadable dirs
      }
    };

    // §3: Walk from scopeRoot if set, otherwise projectRoot
    await walk(this.scopeRoot || this.projectRoot);
    return results;
  }

  private async saveVersion(): Promise<void> {
    const cacheDir = path.join(this.projectRoot, '.reposcape', 'cache');
    await ensureDir(cacheDir);
    const versionPath = path.join(cacheDir, 'version.json');

    let gitHead = 'unknown';
    try {
      const headPath = path.join(this.projectRoot, '.git', 'HEAD');
      gitHead = (await fs.readFile(headPath, 'utf-8')).trim();
      if (gitHead.startsWith('ref: ')) {
        const refPath = path.join(this.projectRoot, '.git', gitHead.slice(5).trim());
        try {
          gitHead = (await fs.readFile(refPath, 'utf-8')).trim();
        } catch {
          // keep HEAD ref
        }
      }
    } catch {
      // no git
    }

    const version: CacheVersion = {
      graph_version: '1.0.0',
      git_head_commit: gitHead,
    };
    await writeCacheAtomic(versionPath, JSON.stringify(version, null, 2));
  }

  getNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  getEdges(): GraphEdge[] {
    return Array.from(this.edges.values());
  }

  getHubNodes(): Set<string> {
    return this.hubNodes;
  }

  getCommunities(): Map<string, number> {
    return this.communities;
  }

  getDefaultExports(): Map<string, string> {
    return this.defaultExports;
  }

  getFileBindings(): Map<string, Map<string, { file: string; symbol: string }>> {
    return this.fileBindings;
  }

  getModuleResolver(): ModuleResolver {
    return this.moduleResolver;
  }
}
