import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer, Server } from 'http';
import { createRoutes, RoutesHandle } from '../server/routes.js';
import { GraphCompiler } from '../server/compiler.js';
import { generateSessionToken, getSessionToken } from '../server/security.js';
import { GraphDiff, GraphNode, GraphEdge } from '../server/types.js';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

const MIN_TTL = 1000;
const MAX_TTL = 3600000;

function makeMockCompiler(nodes: GraphNode[] = [], edges: GraphEdge[] = []) {
  return {
    getNodes: () => nodes,
    getEdges: () => edges,
    getHubNodes: () => new Set<string>(),
    compile: async () => ({ nodes, edges }),
    compileAndDiff: async () => ({
      graph: { nodes, edges },
      diff: { addedNodes: [], removedNodes: [], updatedNodes: [], addedEdges: [], updatedEdges: [], removedEdges: [] },
    }),
  } as unknown as GraphCompiler;
}

describe('Routes', () => {
  let server: Server;
  let baseUrl: string;
  let token: string;
  let projectRoot: string;
  let cleanup: () => void;

  beforeAll(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reposcape-test-'));
    token = await generateSessionToken(projectRoot);

    const app = express();
    app.use(express.json());

    const compiler = makeMockCompiler();
    const handle = createRoutes(projectRoot, compiler);
    cleanup = handle.cleanup;
    app.use(handle.router);

    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    cleanup();
    server.close();
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  function authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  describe('POST /api/focus', () => {
    it('should accept a valid focus event', async () => {
      const res = await fetch(`${baseUrl}/api/focus`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          file: 'src/main.ts',
          timestamp: Date.now(),
        }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
    });

    it('should preserve optional impacted_nodes', async () => {
      const res = await fetch(`${baseUrl}/api/focus`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          file: 'src/auth.ts',
          activity: 'editing',
          timestamp: Date.now(),
          ttl: 30000,
          impacted_nodes: ['node_a', 'node_b'],
        }),
      });
      expect(res.status).toBe(200);

      const getRes = await fetch(`${baseUrl}/api/focus`, {
        headers: authHeaders(),
      });
      const body = await getRes.json();
      const found = body.focus.find((f: any) => f.file === 'src/auth.ts');
      expect(found).toBeDefined();
      expect(found.impacted_nodes).toEqual(['node_a', 'node_b']);
      expect(found.activity).toBe('editing');
    });

    it('should clamp TTL to minimum', async () => {
      const res = await fetch(`${baseUrl}/api/focus`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          file: 'src/low.ts',
          timestamp: Date.now(),
          ttl: 100,
        }),
      });
      expect(res.status).toBe(200);

      const getRes = await fetch(`${baseUrl}/api/focus`, {
        headers: authHeaders(),
      });
      const body = await getRes.json();
      const found = body.focus.find((f: any) => f.file === 'src/low.ts');
      expect(found).toBeDefined();
      expect(found.ttl).toBe(MIN_TTL);
    });

    it('should clamp TTL to maximum', async () => {
      const res = await fetch(`${baseUrl}/api/focus`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          file: 'src/high.ts',
          timestamp: Date.now(),
          ttl: 99999999,
        }),
      });
      expect(res.status).toBe(200);

      const getRes = await fetch(`${baseUrl}/api/focus`, {
        headers: authHeaders(),
      });
      const body = await getRes.json();
      const found = body.focus.find((f: any) => f.file === 'src/high.ts');
      expect(found).toBeDefined();
      expect(found.ttl).toBe(MAX_TTL);
    });

    it('should default TTL to 60000', async () => {
      const res = await fetch(`${baseUrl}/api/focus`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          file: 'src/default.ts',
          timestamp: Date.now(),
        }),
      });
      expect(res.status).toBe(200);

      const getRes = await fetch(`${baseUrl}/api/focus`, {
        headers: authHeaders(),
      });
      const body = await getRes.json();
      const found = body.focus.find((f: any) => f.file === 'src/default.ts');
      expect(found).toBeDefined();
      expect(found.ttl).toBe(60000);
    });

    it('should reject missing file', async () => {
      const res = await fetch(`${baseUrl}/api/focus`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ timestamp: Date.now() }),
      });
      expect(res.status).toBe(400);
    });

    it('should reject missing timestamp', async () => {
      const res = await fetch(`${baseUrl}/api/focus`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ file: 'src/main.ts' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/focus', () => {
    it('should return active focus events', async () => {
      await fetch(`${baseUrl}/api/focus`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          file: 'src/active.ts',
          timestamp: Date.now(),
          ttl: 60000,
        }),
      });

      const res = await fetch(`${baseUrl}/api/focus`, {
        headers: authHeaders(),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(Array.isArray(body.focus)).toBe(true);
      expect(body.focus.some((f: any) => f.file === 'src/active.ts')).toBe(true);
    });
  });

  describe('POST /api/tour', () => {
    it('should accept a valid tour and invoke the broadcast callback', async () => {
      const app4 = express();
      app4.use(express.json());
      const compiler4 = makeMockCompiler();
      let broadcastedTour: any = null;
      const handle4 = createRoutes(projectRoot, compiler4, undefined, undefined, (tour) => {
        broadcastedTour = tour;
      });
      app4.use(handle4.router);

      const server4 = createServer(app4);
      await new Promise<void>((resolve) => server4.listen(0, () => resolve()));
      const addr4 = server4.address();
      const port4 = typeof addr4 === 'object' && addr4 ? addr4.port : 0;
      const base4 = `http://127.0.0.1:${port4}`;

      const res = await fetch(`${base4}/api/tour`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          beats: [
            { say: 'Entry point is the daemon.', nodes: ['node_a', 'node_b'] },
            { say: 'It starts the websocket.', nodes: ['node_c'], lang: 'en-US' },
          ],
        }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(broadcastedTour).not.toBeNull();
      expect(broadcastedTour.beats).toHaveLength(2);

      handle4.cleanup();
      server4.close();
    });

    it('should reject a tour with no beats', async () => {
      const res = await fetch(`${baseUrl}/api/tour`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ beats: [] }),
      });
      expect(res.status).toBe(400);
    });

    it('should reject a beat missing say or nodes', async () => {
      const res = await fetch(`${baseUrl}/api/tour`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ beats: [{ say: 'no nodes field' }] }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/insights/batch', () => {
    it('should return refresh: cache_only when no broadcast function', async () => {
      const app2 = express();
      app2.use(express.json());
      const compiler2 = makeMockCompiler();
      const handle2 = createRoutes(projectRoot, compiler2);
      app2.use(handle2.router);

      const server2 = createServer(app2);
      await new Promise<void>((resolve) => {
        server2.listen(0, () => resolve());
      });
      const addr2 = server2.address();
      const port2 = typeof addr2 === 'object' && addr2 ? addr2.port : 0;
      const base2 = `http://127.0.0.1:${port2}`;

      const res = await fetch(`${base2}/api/insights/batch`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          extractions: [
            {
              file: 'docs/test.md',
              hash: 'abc123',
              nodes: [
                { id: 'concept_test', label: 'Test', file_type: 'concept', source_file: 'docs/test.md' },
              ],
              edges: [],
            },
          ],
        }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.results[0].status).toBe('ok');
      expect(body.refresh).toBe('cache_only');

      handle2.cleanup();
      server2.close();
    });

    it('should return refresh: queued when broadcast function provided', async () => {
      const app3 = express();
      app3.use(express.json());
      const compiler3 = makeMockCompiler();
      let broadcastCalled = false;
      const handle3 = createRoutes(projectRoot, compiler3, (_diff: GraphDiff) => {
        broadcastCalled = true;
      });
      app3.use(handle3.router);

      const server3 = createServer(app3);
      await new Promise<void>((resolve) => {
        server3.listen(0, () => resolve());
      });
      const addr3 = server3.address();
      const port3 = typeof addr3 === 'object' && addr3 ? addr3.port : 0;
      const base3 = `http://127.0.0.1:${port3}`;

      const res = await fetch(`${base3}/api/insights/batch`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          extractions: [
            {
              file: 'docs/test2.md',
              hash: 'def456',
              nodes: [
                { id: 'concept_test2', label: 'Test2', file_type: 'concept', source_file: 'docs/test2.md' },
              ],
              edges: [],
            },
          ],
        }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.results[0].status).toBe('ok');
      expect(body.refresh).toBe('queued');

      handle3.cleanup();
      server3.close();
    });

    it('should reject invalid chunk schema', async () => {
      const res = await fetch(`${baseUrl}/api/insights/batch`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          extractions: [
            {
              file: 'docs/bad.md',
              hash: 'bad',
              nodes: [],
              edges: [{ source: 'a', target: 'b', relation: 'x', type: 'INVALID', score: 0.5 }],
            },
          ],
        }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.results[0].status).toBe('invalid_schema');
    });

    it('should reject missing extractions array', async () => {
      const res = await fetch(`${baseUrl}/api/insights/batch`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('should accept chunks with valid metadata', async () => {
      const res = await fetch(`${baseUrl}/api/insights/batch`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          extractions: [
            {
              file: 'docs/meta.md',
              hash: 'meta123',
              nodes: [
                { id: 'concept_meta', label: 'Meta', file_type: 'concept', source_file: 'docs/meta.md' },
              ],
              edges: [
                {
                  source: 'concept_meta',
                  target: 'some_target',
                  relation: 'implements',
                  type: 'COGNITIVE',
                  score: 0.8,
                  metadata: {
                    rationale: 'This edge exists because of X',
                    source_doc: 'docs/meta.md#L10',
                  },
                },
              ],
            },
          ],
        }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.results[0].status).toBe('ok');
    });

    it('should reject chunks with invalid metadata shape', async () => {
      const res = await fetch(`${baseUrl}/api/insights/batch`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          extractions: [
            {
              file: 'docs/badmeta.md',
              hash: 'badmeta',
              nodes: [
                { id: 'concept_bad', label: 'Bad', file_type: 'concept', source_file: 'docs/badmeta.md' },
              ],
              edges: [
                {
                  source: 'concept_bad',
                  target: 'some_target',
                  relation: 'implements',
                  type: 'COGNITIVE',
                  score: 0.8,
                  metadata: {
                    rationale: 123,
                    source_doc: 'docs/badmeta.md',
                  },
                },
              ],
            },
          ],
        }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.results[0].status).toBe('invalid_schema');
    });

    it('should accept chunks without metadata (backward compatibility)', async () => {
      const res = await fetch(`${baseUrl}/api/insights/batch`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          extractions: [
            {
              file: 'docs/nometa.md',
              hash: 'nometa',
              nodes: [
                { id: 'concept_nometa', label: 'NoMeta', file_type: 'concept', source_file: 'docs/nometa.md' },
              ],
              edges: [
                {
                  source: 'concept_nometa',
                  target: 'some_target',
                  relation: 'implements',
                  type: 'COGNITIVE',
                  score: 0.8,
                },
              ],
            },
          ],
        }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.results[0].status).toBe('ok');
    });
  });

  describe('GET /api/health', () => {
    it('should return ok status', async () => {
      const res = await fetch(`${baseUrl}/api/health`, {
        headers: authHeaders(),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
    });
  });

  describe('Auth middleware', () => {
    it('should reject requests without auth header', async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.status).toBe(401);
    });

    it('should reject requests with invalid token', async () => {
      const res = await fetch(`${baseUrl}/api/health`, {
        headers: { Authorization: 'Bearer invalid_token' },
      });
      expect(res.status).toBe(401);
    });
  });
});

describe('Graph context endpoints', () => {
  let server: Server;
  let baseUrl: string;
  let token: string;
  let projectRoot: string;
  let cleanup: () => void;

  const nodes: GraphNode[] = [
    { id: 'src_a_ts', label: 'a.ts', file_type: 'code', source_file: 'src/a.ts' },
    { id: 'src_a_ts:foo', label: 'foo', file_type: 'code', source_file: 'src/a.ts', source_location: 'L1' },
    { id: 'src_a_ts:bar.baz', label: 'baz', file_type: 'code', source_file: 'src/a.ts', source_location: 'L5' },
    { id: 'src_a_ts:other.baz', label: 'baz', file_type: 'code', source_file: 'src/a.ts', source_location: 'L9' },
    { id: 'src_b_ts', label: 'b.ts', file_type: 'code', source_file: 'src/b.ts' },
    { id: 'src_b_ts:qux', label: 'qux', file_type: 'code', source_file: 'src/b.ts', source_location: 'L2' },
  ];
  const edges: GraphEdge[] = [
    { source: 'src_a_ts', target: 'src_a_ts:foo', relation: 'contains', type: 'PHYSICAL', score: 1 },
    { source: 'src_a_ts', target: 'src_a_ts:bar.baz', relation: 'contains', type: 'PHYSICAL', score: 1 },
    { source: 'src_a_ts', target: 'src_a_ts:other.baz', relation: 'contains', type: 'PHYSICAL', score: 1 },
    { source: 'src_a_ts:foo', target: 'src_b_ts:qux', relation: 'calls', type: 'PHYSICAL', score: 1 },
    { source: 'src_b_ts', target: 'src_b_ts:qux', relation: 'contains', type: 'PHYSICAL', score: 1 },
    { source: 'src_a_ts', target: 'src_b_ts', relation: 'circular_dependency', type: 'SUSPICIOUS', score: 0.5 },
  ];
  const communities = new Map<string, number>([
    ['src_a_ts', 0], ['src_a_ts:foo', 0], ['src_a_ts:bar.baz', 0], ['src_a_ts:other.baz', 0],
    ['src_b_ts', 1], ['src_b_ts:qux', 1],
  ]);

  beforeAll(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reposcape-ctx-'));
    token = await generateSessionToken(projectRoot);
    const compiler = {
      getNodes: () => nodes,
      getEdges: () => edges,
      getHubNodes: () => new Set<string>(['src_a_ts', 'src_b_ts']),
      getCommunities: () => communities,
    } as unknown as GraphCompiler;

    const app = express();
    app.use(express.json());
    const handle = createRoutes(projectRoot, compiler);
    cleanup = handle.cleanup;
    app.use(handle.router);
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    cleanup();
    server.close();
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  describe('GET /api/graph/overview', () => {
    it('returns a compact community map by default', async () => {
      const res = await fetch(`${baseUrl}/api/graph/overview`, { headers: auth() });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      const text = await res.text();
      expect(text).toContain('GRAPH 6 nodes, 6 edges, 2 communities');
      expect(text).toContain('COMMUNITY 0');
      expect(text).toContain('hub=');
    });

    it('returns structured data with format=json', async () => {
      const res = await fetch(`${baseUrl}/api/graph/overview?format=json`, { headers: auth() });
      const body = await res.json();
      expect(body.communities).toHaveLength(2);
      expect(body.communities[0].size).toBeGreaterThanOrEqual(body.communities[1].size);
    });
  });

  describe('GET /api/graph/neighborhood', () => {
    it('returns the compact local subgraph around a node', async () => {
      const res = await fetch(`${baseUrl}/api/graph/neighborhood?node=src_a_ts:foo&depth=1`, { headers: auth() });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('NEIGHBORHOOD root=src_a_ts:foo depth=1');
      expect(text).toContain('NODE src_a_ts:foo');
      expect(text).toContain('NODE src_b_ts:qux'); // 1-hop neighbor via calls edge
      expect(text).not.toContain('circular_dependency'); // SUSPICIOUS edges excluded
    });

    it('returns JSON with format=json', async () => {
      const res = await fetch(`${baseUrl}/api/graph/neighborhood?node=src_a_ts&depth=2&format=json`, { headers: auth() });
      const body = await res.json();
      expect(body.root).toBe('src_a_ts');
      expect(body.nodes.map((n: GraphNode) => n.id)).toContain('src_a_ts');
      expect(body.edges.every((e: GraphEdge) => e.type !== 'SUSPICIOUS')).toBe(true);
    });

    it('truncates to the token budget but always keeps the root first', async () => {
      // budget is clamped to a floor of 100 tokens (~400 chars), which fits only
      // part of this 6-node graph, so we expect a partial result led by the root.
      const res = await fetch(`${baseUrl}/api/graph/neighborhood?node=src_a_ts&depth=2&format=json&budget=1`, { headers: auth() });
      const body = await res.json();
      expect(body.truncated).toBe(true);
      expect(body.nodes.length).toBeGreaterThanOrEqual(1);
      expect(body.nodes.length).toBeLessThan(6);
      expect(body.nodes[0].id).toBe('src_a_ts');
    });

    it('404s for an unknown node with a resolve hint', async () => {
      const res = await fetch(`${baseUrl}/api/graph/neighborhood?node=does_not_exist`, { headers: auth() });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.hint).toContain('/api/graph/resolve');
    });

    it('400s when node param is missing', async () => {
      const res = await fetch(`${baseUrl}/api/graph/neighborhood`, { headers: auth() });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/graph/resolve', () => {
    it('resolves a symbol to all matching node ids (overload-safe)', async () => {
      const res = await fetch(`${baseUrl}/api/graph/resolve?file=src/a.ts&symbol=baz`, { headers: auth() });
      const body = await res.json();
      expect(body.candidates.map((c: any) => c.id).sort()).toEqual(['src_a_ts:bar.baz', 'src_a_ts:other.baz']);
    });

    it('resolves a qualified symbol by its last segment', async () => {
      const res = await fetch(`${baseUrl}/api/graph/resolve?file=src/b.ts&symbol=BarClass.qux`, { headers: auth() });
      const body = await res.json();
      expect(body.candidates.map((c: any) => c.id)).toEqual(['src_b_ts:qux']);
    });

    it('returns the file node id when no symbol is given', async () => {
      const res = await fetch(`${baseUrl}/api/graph/resolve?file=./src/a.ts`, { headers: auth() });
      const body = await res.json();
      expect(body.id).toBe('src_a_ts');
    });

    it('400s when file param is missing', async () => {
      const res = await fetch(`${baseUrl}/api/graph/resolve?symbol=foo`, { headers: auth() });
      expect(res.status).toBe(400);
    });

    it('404s for an unknown file', async () => {
      const res = await fetch(`${baseUrl}/api/graph/resolve?file=src/nope.ts`, { headers: auth() });
      expect(res.status).toBe(404);
    });
  });
});
