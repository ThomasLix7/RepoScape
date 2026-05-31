import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { authMiddleware } from './security.js';
import { validateCognitiveChunk, validateTour } from './security.js';
import { writeCacheAtomic, ensureDir, hashSourceFile } from './cache.js';
import { GraphCompiler } from './compiler.js';
import { compileRulePattern } from './boundaries.js';
import { appendErrorLog } from './logger.js';
import { FocusEvent, BatchInsightsRequest, GraphDiff, Tour, GraphNode, GraphEdge } from './types.js';

export interface RoutesHandle {
  router: Router;
  cleanup: () => void;
}

const MIN_TTL = 1000;
const MAX_TTL = 3600000;

function buildAdjacency(edges: GraphEdge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const e of edges) {
    if (e.type === 'SUSPICIOUS') continue;
    link(e.source, e.target);
    link(e.target, e.source);
  }
  return adj;
}

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

// Blast radius: file nodes that transitively import `startNodeId`, via reverse BFS over
// PHYSICAL `imports` edges (source imports target). The persuasive "why a rule matters" count.
function importDependents(edges: GraphEdge[], startNodeId: string): Set<string> {
  const rev = new Map<string, string[]>();
  for (const e of edges) {
    if (e.type === 'PHYSICAL' && e.relation === 'imports') {
      if (!rev.has(e.target)) rev.set(e.target, []);
      rev.get(e.target)!.push(e.source);
    }
  }
  const seen = new Set<string>();
  const queue = [startNodeId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const src of rev.get(cur) ?? []) {
      if (!seen.has(src)) {
        seen.add(src);
        queue.push(src);
      }
    }
  }
  return seen;
}

const compactNode = (n: GraphNode): string =>
  `NODE ${n.id} | ${n.label} [${n.source_location ?? 'file'}]`;
const compactEdge = (e: GraphEdge): string =>
  `EDGE ${e.source} --${e.relation}--> ${e.target}`;

export function createRoutes(
  projectRoot: string,
  compiler: GraphCompiler,
  broadcastDiff?: (diff: GraphDiff) => void,
  broadcastFocus?: (event: { file: string; activity?: string; impacted_nodes?: string[] }) => void,
  broadcastTour?: (tour: Tour) => void
): RoutesHandle {
  const router = Router();

  const focusRegistry = new Map<string, FocusEvent>();

  const focusCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [file, event] of focusRegistry.entries()) {
      if (now - event.timestamp > event.ttl) {
        focusRegistry.delete(file);
      }
    }
  }, 5000);

  router.use(authMiddleware);

  router.get('/api/graph', async (_req: Request, res: Response) => {
    try {
      const nodes = compiler.getNodes();
      const edges = compiler.getEdges();
      res.json({ nodes, edges });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Architectural Safety Radar: SUSPICIOUS edges are kept out of the visual graph
  // (overview/neighborhood) but are queryable here for CLI/CI/agent checks.
  router.get('/api/violations', (_req: Request, res: Response) => {
    try {
      const nodeById = new Map(compiler.getNodes().map((n) => [n.id, n]));
      const describe = (id: string) => {
        const n = nodeById.get(id);
        return { id, label: n?.label, file: n?.source_file };
      };
      const violations = compiler
        .getEdges()
        .filter((e) => e.type === 'SUSPICIOUS')
        .map((e) => ({
          relation: e.relation,
          severity: e.score >= 0.8 ? 'error' : 'warn',
          score: e.score,
          reason: e.metadata?.rationale ?? '',
          source: describe(e.source),
          target: describe(e.target),
        }));
      res.json({ violations });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // §Radar: scoped boundary briefing for one file — the rules that touch it, the current
  // violations on it, and its blast radius. The in-loop steering signal for an agent
  // about to edit the file (locality a flat rules file can't give).
  router.get('/api/boundaries', (req: Request, res: Response) => {
    try {
      const file = normalizeRelPath(String(req.query.file ?? ''));
      if (!file) {
        res.status(400).json({ error: 'Missing required query param: file' });
        return;
      }

      const applicable = compiler.getArchitectureRules().boundaries.filter((r) => {
        const kind = r.pathKind ?? 'glob';
        try {
          return compileRulePattern(r.from, kind).test(file) || compileRulePattern(r.to, kind).test(file);
        } catch {
          return false;
        }
      });

      const nodes = compiler.getNodes();
      const nodeById = new Map(nodes.map((n) => [n.id, n]));
      const describe = (id: string) => {
        const n = nodeById.get(id);
        return { id, label: n?.label, file: n?.source_file };
      };
      const touchesFile = (id: string) => {
        const sf = nodeById.get(id)?.source_file;
        return !!sf && normalizeRelPath(sf) === file;
      };

      const violations = compiler
        .getEdges()
        .filter((e) => e.type === 'SUSPICIOUS' && e.relation === 'violates_boundary')
        .filter((e) => touchesFile(e.source) || touchesFile(e.target))
        .map((e) => ({
          severity: e.score >= 0.8 ? 'error' : 'warn',
          score: e.score,
          reason: e.metadata?.rationale ?? '',
          source: describe(e.source),
          target: describe(e.target),
        }));

      const fileNode = nodes.find((n) => normalizeRelPath(n.source_file) === file && !n.source_location);
      const dependents = fileNode ? importDependents(compiler.getEdges(), fileNode.id).size : 0;

      res.json({ file, rules: applicable, violations, blastRadius: { dependents } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/focus', async (req: Request, res: Response) => {
    try {
      const event: FocusEvent = req.body;
      if (!event.file || !event.timestamp) {
        res.status(400).json({ error: 'Missing required fields: file, timestamp' });
        return;
      }
      event.ttl = Math.max(MIN_TTL, Math.min(MAX_TTL, event.ttl || 60000));
      focusRegistry.set(event.file, event);

      if (broadcastFocus) {
        broadcastFocus({ file: event.file, activity: event.activity, impacted_nodes: event.impacted_nodes });
      }

      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/agent-activity', async (req: Request, res: Response) => {
    try {
      const { file, activity, timestamp, ttl } = req.body;
      if (!file || !activity) {
        res.status(400).json({ error: 'Missing required fields: file, activity' });
        return;
      }
      focusRegistry.set(file, { file, activity, timestamp: timestamp || Date.now(), ttl: ttl || 60000 });

      if (broadcastFocus) {
        broadcastFocus({ file, activity });
      }

      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/focus', async (_req: Request, res: Response) => {
    const now = Date.now();
    const active: FocusEvent[] = [];
    for (const [file, event] of focusRegistry.entries()) {
      if (now - event.timestamp <= event.ttl) {
        active.push(event);
      }
    }
    res.json({ focus: active });
  });

  router.post('/api/tour', (req: Request, res: Response) => {
    try {
      if (!validateTour(req.body)) {
        res.status(400).json({ error: 'Invalid tour: expected { beats: [{ say, nodes[] }] }' });
        return;
      }
      if (broadcastTour) broadcastTour(req.body);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/insights/batch', async (req: Request, res: Response) => {
    try {
      const body: BatchInsightsRequest = req.body;
      if (!body.extractions || !Array.isArray(body.extractions)) {
        res.status(400).json({ error: 'Missing extractions array' });
        return;
      }

      const insightsDir = path.join(projectRoot, '.reposcape', 'insights');
      await ensureDir(insightsDir);

      const results: { file: string; status: string }[] = [];
      let anySuccess = false;

      for (const extraction of body.extractions) {
        const chunk = {
          nodes: extraction.nodes,
          edges: extraction.edges,
          hyperedges: extraction.hyperedges,
        };

        if (!validateCognitiveChunk(chunk)) {
          results.push({ file: extraction.file, status: 'invalid_schema' });
          continue;
        }

        const normalizedPath = extraction.file.replace(/\\/g, '/');
        const hash = hashSourceFile(normalizedPath);
        const cachePath = path.join(insightsDir, `${hash}.json`);

        try {
          await writeCacheAtomic(cachePath, JSON.stringify(chunk, null, 2));
          results.push({ file: extraction.file, status: 'ok' });
          anySuccess = true;
        } catch (err: any) {
          results.push({ file: extraction.file, status: 'lock_failed', error: err.message } as any);
          await appendErrorLog(projectRoot, `Lock failed for insight ${extraction.file}: ${err.message}`);
        }
      }

      if (anySuccess && broadcastDiff) {
        compiler.compileAndDiff().then(({ diff }) => {
          broadcastDiff!({
            ...diff,
            hubNodes: Array.from(compiler.getHubNodes()),
          });
        }).catch((err: any) => {
          appendErrorLog(projectRoot, `Background recompile after insights batch failed: ${err.message}`);
        });
        res.json({ results, refresh: 'queued' });
      } else {
        res.json({ results, refresh: 'cache_only' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Whole-repo community-level overview
  router.get('/api/graph/overview', (req: Request, res: Response) => {
    try {
      const nodes = compiler.getNodes();
      const edges = compiler.getEdges();
      const communities = compiler.getCommunities();
      const hubs = compiler.getHubNodes();
      const adj = buildAdjacency(edges);
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const degree = (id: string) => adj.get(id)?.size ?? 0;

      const groups = new Map<number, string[]>();
      for (const [nid, cid] of communities.entries()) {
        if (!groups.has(cid)) groups.set(cid, []);
        groups.get(cid)!.push(nid);
      }

      const community = [...groups.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([cid, members]) => {
          const ranked = members.slice().sort((a, b) => degree(b) - degree(a));
          const hub = ranked.find((id) => hubs.has(id)) ?? ranked[0];
          return {
            id: cid,
            size: members.length,
            hub: byId.get(hub)?.label ?? hub,
            hub_id: hub,
            top: ranked.slice(0, 5).map((id) => byId.get(id)?.label ?? id),
          };
        });

      if (req.query.format === 'json') {
        res.json({
          nodes: nodes.length,
          edges: edges.length,
          communities: community,
        });
        return;
      }

      const text = [
        `GRAPH ${nodes.length} nodes, ${edges.length} edges, ${groups.size} communities`,
        ...community.map(
          (c) => `COMMUNITY ${c.id} (${c.size} nodes) hub=${c.hub} | ${c.top.join(', ')}`
        ),
      ].join('\n');
      res.type('text/plain').send(text);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Token-budgeted neighborhood subgraph
  router.get('/api/graph/neighborhood', (req: Request, res: Response) => {
    try {
      const nodeId = String(req.query.node ?? '');
      if (!nodeId) {
        res.status(400).json({ error: 'Missing required query param: node' });
        return;
      }
      const depth = Math.max(1, Math.min(5, parseInt(String(req.query.depth ?? '2'), 10) || 2));
      const format = String(req.query.format ?? 'compact');
      const budget = Math.max(100, Math.min(50000, parseInt(String(req.query.budget ?? '1500'), 10) || 1500));

      const nodes = compiler.getNodes();
      const edges = compiler.getEdges();
      const byId = new Map(nodes.map((n) => [n.id, n]));
      if (!byId.has(nodeId)) {
        res.status(404).json({
          error: `Unknown node: ${nodeId}`,
          hint: 'Look up the id with /api/graph/resolve?file=<relative path>&symbol=<name>',
        });
        return;
      }

      const adj = buildAdjacency(edges);
      const dist = new Map<string, number>([[nodeId, 0]]);
      let frontier = [nodeId];
      for (let d = 1; d <= depth; d++) {
        const next: string[] = [];
        for (const u of frontier) {
          for (const v of adj.get(u) ?? []) {
            if (!dist.has(v)) {
              dist.set(v, d);
              next.push(v);
            }
          }
        }
        frontier = next;
      }

      const degree = (id: string) => adj.get(id)?.size ?? 0;
      const ranked = [...dist.keys()].sort(
        (a, b) => dist.get(a)! - dist.get(b)! || degree(b) - degree(a)
      );

      // Greedily keep closest nodes until the token budget is spent.
      const charBudget = budget * 4;
      const kept: string[] = [];
      let used = 0;
      let truncated = false;
      for (const id of ranked) {
        const n = byId.get(id)!;
        const cost = format === 'json' ? JSON.stringify(n).length : compactNode(n).length + 1;
        if (kept.length > 0 && used + cost > charBudget) {
          truncated = true;
          break;
        }
        kept.push(id);
        used += cost;
      }
      const keptSet = new Set(kept);
      const subEdges = edges.filter(
        (e) => e.type !== 'SUSPICIOUS' && keptSet.has(e.source) && keptSet.has(e.target)
      );

      if (format === 'json') {
        res.json({
          root: nodeId,
          depth,
          truncated,
          nodes: kept.map((id) => byId.get(id)),
          edges: subEdges,
        });
        return;
      }

      const subNodes = kept.map((id) => byId.get(id)!);
      const lines = [
        `NEIGHBORHOOD root=${nodeId} depth=${depth} | ${subNodes.length} nodes, ${subEdges.length} edges${truncated ? ' (truncated to budget)' : ''}`,
        ...subNodes.map(compactNode),
        ...subEdges.map(compactEdge),
      ];
      res.type('text/plain').send(lines.join('\n'));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Resolve file and symbol to deterministic node IDs
  router.get('/api/graph/resolve', (req: Request, res: Response) => {
    try {
      const file = normalizeRelPath(String(req.query.file ?? ''));
      const symbol = String(req.query.symbol ?? '').trim();
      if (!file) {
        res.status(400).json({ error: 'Missing required query param: file' });
        return;
      }

      const nodes = compiler.getNodes();
      const inFile = nodes.filter((n) => normalizeRelPath(n.source_file) === file);
      if (inFile.length === 0) {
        res.status(404).json({ error: `No nodes found for file: ${file}` });
        return;
      }

      if (!symbol) {
        // Return file node ID if no symbol given
        const fileNode = inFile.find((n) => !n.id.includes(':')) ?? inFile[0];
        res.json({ file, id: fileNode.id, candidates: [fileNode.id] });
        return;
      }

      const wanted = symbol.split('.').pop()!.toLowerCase();
      const matches = inFile.filter((n) => n.label.toLowerCase() === wanted);
      res.json({
        file,
        symbol,
        candidates: matches.map((n) => ({ id: n.id, label: n.label, source_location: n.source_location })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  return {
    router,
    cleanup: () => clearInterval(focusCleanupInterval),
  };
}
