import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, Server } from 'http';
import { createRoutes } from '../server/routes.js';
import { GraphCompiler } from '../server/compiler.js';
import { generateSessionToken } from '../server/security.js';
import { GraphNode, GraphEdge } from '../server/types.js';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

describe('GET /api/violations', () => {
  let server: Server;
  let baseUrl: string;
  let token: string;
  let cleanup: () => void;
  let projectRoot: string;

  const nodes: GraphNode[] = [
    { id: 'src_hud_app_tsx', label: 'App.tsx', file_type: 'code', source_file: 'src/hud/App.tsx' },
    { id: 'src_server_compiler_ts', label: 'compiler.ts', file_type: 'code', source_file: 'src/server/compiler.ts' },
  ];
  const edges: GraphEdge[] = [
    { source: 'src_hud_app_tsx', target: 'src_server_compiler_ts', relation: 'imports', type: 'PHYSICAL', score: 1.0 },
    {
      source: 'src_hud_app_tsx',
      target: 'src_server_compiler_ts',
      relation: 'violates_boundary',
      type: 'SUSPICIOUS',
      score: 0.9,
      metadata: { rationale: 'view must not import server' },
    },
    {
      source: 'src_server_compiler_ts',
      target: 'src_hud_app_tsx',
      relation: 'circular_dependency',
      type: 'SUSPICIOUS',
      score: 0.5,
      metadata: { rationale: 'cycle' },
    },
  ];

  beforeAll(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reposcape-viol-'));
    token = await generateSessionToken(projectRoot);
    const compiler = {
      getNodes: () => nodes,
      getEdges: () => edges,
      getHubNodes: () => new Set<string>(),
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

  it('exposes SUSPICIOUS edges with severity, reason, and node details', async () => {
    const res = await fetch(`${baseUrl}/api/violations`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.violations).toHaveLength(2);

    const boundary = body.violations.find((v: any) => v.relation === 'violates_boundary');
    expect(boundary.severity).toBe('error'); // score >= 0.8
    expect(boundary.reason).toBe('view must not import server');
    expect(boundary.source.file).toBe('src/hud/App.tsx');
    expect(boundary.target.label).toBe('compiler.ts');

    const cycle = body.violations.find((v: any) => v.relation === 'circular_dependency');
    expect(cycle.severity).toBe('warn'); // score < 0.8
  });

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/violations`);
    expect(res.status).toBe(401);
  });
});
