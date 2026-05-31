import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, Server } from 'http';
import { createRoutes } from '../server/routes.js';
import { GraphCompiler } from '../server/compiler.js';
import { parseArchitectureRules } from '../server/boundaries.js';
import { generateSessionToken } from '../server/security.js';
import { GraphNode, GraphEdge } from '../server/types.js';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

describe('GET /api/boundaries', () => {
  let server: Server;
  let baseUrl: string;
  let token: string;
  let cleanup: () => void;
  let projectRoot: string;

  // widget → App → db/client. The ui→db edge is a violation; db/client's blast radius is
  // both ui files (App directly, widget transitively).
  const nodes: GraphNode[] = [
    { id: 'src_ui_app_tsx', label: 'App.tsx', file_type: 'code', source_file: 'src/ui/App.tsx' },
    { id: 'src_ui_widget_tsx', label: 'widget.tsx', file_type: 'code', source_file: 'src/ui/widget.tsx' },
    { id: 'src_db_client_ts', label: 'client.ts', file_type: 'code', source_file: 'src/db/client.ts' },
  ];
  const edges: GraphEdge[] = [
    { source: 'src_ui_app_tsx', target: 'src_db_client_ts', relation: 'imports', type: 'PHYSICAL', score: 1.0 },
    { source: 'src_ui_widget_tsx', target: 'src_ui_app_tsx', relation: 'imports', type: 'PHYSICAL', score: 1.0 },
    {
      source: 'src_ui_app_tsx',
      target: 'src_db_client_ts',
      relation: 'violates_boundary',
      type: 'SUSPICIOUS',
      score: 0.9,
      metadata: { rationale: 'ui must not import db' },
    },
  ];
  const rules = parseArchitectureRules({
    boundaries: [{ from: '^src/ui', to: '^src/db', pathKind: 'regex', severity: 'error', reason: 'ui→db' }],
  });

  beforeAll(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reposcape-bnd-'));
    token = await generateSessionToken(projectRoot);
    const compiler = {
      getNodes: () => nodes,
      getEdges: () => edges,
      getHubNodes: () => new Set<string>(),
      getArchitectureRules: () => rules,
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

  it('returns applicable rules, violations on the file, and blast radius', async () => {
    const res = await fetch(`${baseUrl}/api/boundaries?file=src/db/client.ts`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.rules).toHaveLength(1); // matched on the `to` side
    expect(body.rules[0].pathKind).toBe('regex');

    expect(body.violations).toHaveLength(1);
    expect(body.violations[0].severity).toBe('error');
    expect(body.violations[0].reason).toBe('ui must not import db');

    expect(body.blastRadius.dependents).toBe(2); // App (direct) + widget (transitive)
  });

  it('matches the from side and scopes blast radius per file', async () => {
    const res = await fetch(`${baseUrl}/api/boundaries?file=src/ui/App.tsx`, { headers: auth() });
    const body = await res.json();
    expect(body.rules).toHaveLength(1); // matched on the `from` side
    expect(body.violations).toHaveLength(1);
    expect(body.blastRadius.dependents).toBe(1); // only widget imports App
  });

  it('400 when file query param is missing', async () => {
    const res = await fetch(`${baseUrl}/api/boundaries`, { headers: auth() });
    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/boundaries?file=src/db/client.ts`);
    expect(res.status).toBe(401);
  });
});
