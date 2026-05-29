import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { authMiddleware } from './security.js';
import { validateCognitiveChunk } from './security.js';
import { writeCacheAtomic, ensureDir, hashSourceFile } from './cache.js';
import { GraphCompiler } from './compiler.js';
import { appendErrorLog } from './logger.js';
import { FocusEvent, BatchInsightsRequest, GraphDiff } from './types.js';

export interface RoutesHandle {
  router: Router;
  cleanup: () => void;
}

const MIN_TTL = 1000;
const MAX_TTL = 3600000;

export function createRoutes(
  projectRoot: string,
  compiler: GraphCompiler,
  broadcastDiff?: (diff: GraphDiff) => void,
  broadcastFocus?: (event: { file: string; activity?: string; impacted_nodes?: string[] }) => void
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

  router.post('/api/focus', async (req: Request, res: Response) => {
    try {
      const event: FocusEvent = req.body;
      if (!event.file || !event.timestamp) {
        res.status(400).json({ error: 'Missing required fields: file, timestamp' });
        return;
      }
      event.ttl = Math.max(MIN_TTL, Math.min(MAX_TTL, event.ttl || 60000));
      focusRegistry.set(event.file, event);

      // §2C: Broadcast focus event to HUD clients
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

      // §2C: Broadcast agent activity to HUD clients
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

  router.post('/api/insights/batch', async (req: Request, res: Response) => {
    try {
      const body: BatchInsightsRequest = req.body;
      if (!body.extractions || !Array.isArray(body.extractions)) {
        res.status(400).json({ error: 'Missing extractions array' });
        return;
      }

      // §4.A: Insights go to .reposcape/insights/ (user data, not cache)
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
          // §7.C: Return per-entry failure on lock exhaustion
          results.push({ file: extraction.file, status: 'lock_failed', error: err.message } as any);
          await appendErrorLog(projectRoot, `Lock failed for insight ${extraction.file}: ${err.message}`);
        }
      }

      if (anySuccess && broadcastDiff) {
        // §3.A: Use compileAndDiff for atomic diff
        compiler.compileAndDiff().then(({ diff }) => {
          broadcastDiff!({
            ...diff,
            hubNodes: Array.from(compiler.getHubNodes()),
          });
        }).catch((err: any) => {
          // §3.D: Log errors, don't silently swallow
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

  router.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  return {
    router,
    cleanup: () => clearInterval(focusCleanupInterval),
  };
}
