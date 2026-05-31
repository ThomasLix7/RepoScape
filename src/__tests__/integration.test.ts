import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { GraphCompiler } from '../server/compiler.js';
import { unwrapReexports } from '../server/resolver.js';
import { hashSourceFile } from '../server/cache.js';
import { RawImportEntry } from '../server/types.js';

describe('Integration — Acceptance Gate', () => {
  const projectRoot = path.resolve(import.meta.dirname, '..', '..');
  let compiler: GraphCompiler;

  beforeAll(async () => {
    compiler = new GraphCompiler(projectRoot);
    compiler.setScopeRoot(path.join(projectRoot, 'src', 'server'));
    await compiler.init();
  }, 30000);

  it('§1.B: assertParserReady() does not throw', () => {
    expect(() => compiler.assertParserReady()).not.toThrow();
  });

  it('§8.3: getNodes().length > 50 (sanity floor)', async () => {
    await compiler.compile();
    const nodes = compiler.getNodes();
    expect(nodes.length).toBeGreaterThan(50);
  });

  it('§8.3: No edge has source or target missing from nodes', async () => {
    const graph = await compiler.compile();
    const nodeIds = new Set(graph.nodes.map((n) => n.id));

    for (const edge of graph.edges) {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }
  });

  it('§8.3: Second compileAndDiff() produces zero net addedEdges/removedEdges', async () => {
    const { diff } = await compiler.compileAndDiff();

    expect(diff.addedEdges.length).toBe(0);
    expect(diff.updatedEdges.length).toBe(0);
    expect(diff.removedEdges.length).toBe(0);
    expect(diff.removedNodes.length).toBe(0);
  });

  it('§8.3: Resolver-driven coverage gate N/D >= 0.95', async () => {
    const graph = await compiler.compile();
    const resolver = compiler.getModuleResolver();

    const rawImports = compiler.getRawImports();
    const fileExportsCache = compiler.getFileExportsCache();

    const denominatorPairs = new Set<string>();
    for (const { caller, entry } of rawImports) {
      if (entry.kind === 'type-default' || entry.kind === 'type-named') continue;

      const targetFile = await resolver.resolve(caller, entry.moduleSpecifier);
      if (!targetFile) continue;

      let edgeTargetFile: string;
      switch (entry.kind) {
        case 'side-effect':
        case 'namespace':
          edgeTargetFile = targetFile;
          break;
        case 'default': {
          const resolved = unwrapReexports('default', targetFile, fileExportsCache);
          edgeTargetFile = resolved.filePath;
          break;
        }
        case 'named': {
          const resolved = unwrapReexports(entry.importedName, targetFile, fileExportsCache);
          edgeTargetFile = resolved.filePath;
          break;
        }
      }
      denominatorPairs.add(`${caller}→${edgeTargetFile!}`);
    }

    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    const numeratorPairs = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.relation !== 'imports' || edge.type !== 'PHYSICAL' || !edge.source_file) continue;
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
      const targetNode = graph.nodes.find((n) => n.id === edge.target);
      if (targetNode) {
        numeratorPairs.add(`${edge.source_file}→${targetNode.source_file}`);
      }
    }

    const D = denominatorPairs.size;
    const N = numeratorPairs.size;

    expect(D).toBeGreaterThan(0);
    expect(N / D).toBeGreaterThanOrEqual(0.95);
  });

  it('§4.B: Community map is deterministic across two consecutive compile() calls', async () => {
    await compiler.compile();
    const communities1 = new Map(compiler.getCommunities());
    const serialized1 = JSON.stringify(
      [...communities1.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    );

    await compiler.compile();
    const communities2 = new Map(compiler.getCommunities());
    const serialized2 = JSON.stringify(
      [...communities2.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    );

    expect(serialized1).toBe(serialized2);
  });

  it('§8.5: Compiler throws (not silently continues) when parser cannot initialize', async () => {
    const badCompiler = new GraphCompiler(projectRoot);
    expect(() => badCompiler.assertParserReady()).toThrow(/Parser instance is null/);
  });
});

// §2.G items 5-8, 11, 14: End-to-end tests through the actual compiler
describe('Import Resolution — End-to-End (§2.G)', () => {
  let projectRoot: string;
  let compiler: GraphCompiler;

  beforeAll(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reposcape-e2e-test-'));

    // Create tsconfig.json
    await fs.writeFile(
      path.join(projectRoot, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } })
    );

    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });

    await fs.writeFile(
      path.join(projectRoot, 'src', 'a.ts'),
      `export function foo() { return 1; }
export function bar() { return 2; }
export default function defaultFn() { return 3; }
`
    );

    await fs.writeFile(
      path.join(projectRoot, 'src', 'setup.ts'),
      `console.log('setup');\n`
    );

    await fs.writeFile(
      path.join(projectRoot, 'src', 'caller.ts'),
      `import { foo as bar } from './a';
import './setup';
import * as ns from './a';
import type { Foo } from './a';
import defaultFn from './a';
bar();
foo();
defaultFn();
`
    );

    await fs.writeFile(
      path.join(projectRoot, 'src', 'default-named.ts'),
      `export default function namedDefault() { return 10; }\n`
    );

    await fs.writeFile(
      path.join(projectRoot, 'src', 'default-ident.ts'),
      `function localFn() { return 11; }
export default localFn;
`
    );

    await fs.writeFile(
      path.join(projectRoot, 'src', 'default-anon.ts'),
      `export default { key: 'value' };\n`
    );

    await fs.writeFile(
      path.join(projectRoot, 'src', 'index.ts'),
      `export { foo } from './a';
export { bar } from './a';
`
    );

    await fs.writeFile(
      path.join(projectRoot, 'src', 'barrel-caller.ts'),
      `import { foo } from './index';
foo();
`
    );

    await fs.writeFile(
      path.join(projectRoot, 'src', 'case-caller.ts'),
      `import * as MyNS from './a';
import DefaultFn from './a';
import { foo as MyFoo } from './a';
MyNS.foo();
DefaultFn();
MyFoo();
`
    );

    await fs.mkdir(path.join(projectRoot, 'docs'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, 'docs', 'architecture.md'),
      'Module A owns the core API used by callers.\n'
    );
    await fs.mkdir(path.join(projectRoot, '.reposcape', 'insights'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.reposcape', 'insights', `${hashSourceFile('docs/architecture.md')}.json`),
      JSON.stringify({
        nodes: [
          {
            id: 'concept_module_a_api',
            label: 'Module A API',
            file_type: 'concept',
            source_file: 'docs/architecture.md',
          },
          {
            id: 'concept_caller_contract',
            label: 'Caller Contract',
            file_type: 'concept',
            source_file: 'docs/architecture.md',
          },
        ],
        edges: [
          {
            source: 'concept_module_a_api',
            target: 'src_a.ts',
            relation: 'implements',
            type: 'COGNITIVE',
            score: 0.9,
            metadata: {
              rationale: 'The document describes module A as the API owner.',
              source_doc: 'docs/architecture.md#L1',
            },
          },
          {
            source: 'concept_caller_contract',
            target: 'src_caller.ts',
            relation: 'constrains',
            type: 'COGNITIVE',
            score: 0.8,
            metadata: {
              rationale: 'The document describes caller responsibilities.',
              source_doc: 'docs/architecture.md#L1',
            },
          },
        ],
      })
    );

    compiler = new GraphCompiler(projectRoot);
    await compiler.init();
    await compiler.compile();
  }, 30000);

  afterAll(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('§2.G.5: Aliased import { foo as bar } produces binding { file: src/a.ts, symbol: foo }', () => {
    const bindings = compiler.getFileBindings();
    const callerBindings = bindings.get('src/caller.ts');
    expect(callerBindings).toBeDefined();
    const barBinding = callerBindings!.get('bar');
    expect(barBinding).toBeDefined();
    expect(barBinding!.file).toBe('src/a.ts');
    expect(barBinding!.symbol).toBe('foo');
  });

  it('§2.G.6: Side-effect import ./setup produces PHYSICAL edge but no binding', () => {
    const bindings = compiler.getFileBindings();
    const callerBindings = bindings.get('src/caller.ts');
    expect(callerBindings?.has('setup')).toBe(false);

    const edges = compiler.getEdges();
    const setupEdge = edges.find(
      (e) => e.relation === 'imports' && e.source_file === 'src/caller.ts'
    );
    expect(setupEdge).toBeDefined();
  });

  it('§2.G.7: Namespace import * as ns produces binding { file: src/a.ts, symbol: * }', () => {
    const bindings = compiler.getFileBindings();
    const callerBindings = bindings.get('src/caller.ts');
    expect(callerBindings).toBeDefined();
    const nsBinding = callerBindings!.get('ns');
    expect(nsBinding).toBeDefined();
    expect(nsBinding!.symbol).toBe('*');
    expect(nsBinding!.file).toBe('src/a.ts');
  });

  it('§2.G.8: import type { Foo } produces no PHYSICAL edge and no binding', () => {
    const bindings = compiler.getFileBindings();
    const callerBindings = bindings.get('src/caller.ts');
    expect(callerBindings?.has('Foo')).toBe(false);
  });

  it('§2.G.9: Barrel re-export: import { foo } from ./index resolves to src/a.ts', () => {
    const bindings = compiler.getFileBindings();
    const callerBindings = bindings.get('src/barrel-caller.ts');
    expect(callerBindings).toBeDefined();
    const fooBinding = callerBindings!.get('foo');
    expect(fooBinding).toBeDefined();
    expect(fooBinding!.file).toBe('src/a.ts');
    expect(fooBinding!.symbol).toBe('foo');
  });

  it('§5.B: fileBindings keys are stored lowercase (case-insensitive lookup)', () => {
    const bindings = compiler.getFileBindings();
    const caseCaller = bindings.get('src/case-caller.ts');
    expect(caseCaller).toBeDefined();
    expect(caseCaller!.has('myns')).toBe(true);
    expect(caseCaller!.has('defaultfn')).toBe(true);
    expect(caseCaller!.has('myfoo')).toBe(true);
    expect(caseCaller!.has('MyNS')).toBe(false);
    expect(caseCaller!.has('DefaultFn')).toBe(false);
    expect(caseCaller!.has('MyFoo')).toBe(false);
  });

  it('§5.B: mixed-case imported bindings produce call edges', () => {
    const edges = compiler.getEdges();
    const callsFromCaseCaller = edges.filter(
      (e) => e.relation === 'calls' && e.source_file === 'src/case-caller.ts',
    );
    expect(callsFromCaseCaller.length).toBeGreaterThanOrEqual(2);

    const nodes = compiler.getNodes();
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    for (const edge of callsFromCaseCaller) {
      const targetNode = nodeById.get(edge.target);
      expect(targetNode?.source_file).toBe('src/a.ts');
    }
  });

  it('derives document nodes and contains edges from concept source files', async () => {
    const graph = await compiler.compile();
    const doc = graph.nodes.find(
      (n) => n.file_type === 'document' && n.source_file === 'docs/architecture.md'
    );
    const conceptA = graph.nodes.find((n) => n.id === 'concept_module_a_api');
    const conceptCaller = graph.nodes.find((n) => n.id === 'concept_caller_contract');

    expect(doc).toBeDefined();
    expect(conceptA).toBeDefined();
    expect(conceptCaller).toBeDefined();
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: doc!.id,
          target: 'concept_module_a_api',
          relation: 'contains',
          type: 'COGNITIVE',
          score: 1,
        }),
        expect.objectContaining({
          source: doc!.id,
          target: 'concept_caller_contract',
          relation: 'contains',
          type: 'COGNITIVE',
          score: 1,
        }),
      ])
    );
    expect(doc!.community).toBe(conceptA!.community);
    expect(doc!.community).toBe(conceptCaller!.community);
  });

  it('§2.G.11a: export default function namedDefault() → defaultExports points at named node', () => {
    const defaultExports = compiler.getDefaultExports();
    const nodeId = defaultExports.get('src/default-named.ts');
    expect(nodeId).toBeDefined();
    expect(nodeId).not.toContain(':default');
    expect(nodeId).toContain('nameddefault');
  });

  it('§2.G.11b: export default localFn (identifier) → defaultExports points at existing local node', () => {
    const defaultExports = compiler.getDefaultExports();
    const nodeId = defaultExports.get('src/default-ident.ts');
    expect(nodeId).toBeDefined();
    expect(nodeId).not.toContain(':default');
    expect(nodeId).toContain('localfn');
  });

  it('§2.G.11c: export default { ... } (anonymous) → defaultExports points at synthetic :default node', () => {
    const defaultExports = compiler.getDefaultExports();
    const nodeId = defaultExports.get('src/default-anon.ts');
    expect(nodeId).toBeDefined();
    expect(nodeId).toContain(':default');
  });

  it('§2.G.14: Warm-cache equivalence — same edges after cache rehydration', async () => {
    const cold = await compiler.compile();
    const coldImportsKeys = new Set(
      cold.edges.filter((e) => e.relation === 'imports').map((e) => `${e.source}->${e.target}_imports`)
    );
    const coldCallsKeys = new Set(
      cold.edges.filter((e) => e.relation === 'calls').map((e) => `${e.source}->${e.target}_calls`)
    );
    const coldDefaults = new Map(compiler.getDefaultExports());

    const compiler2 = new GraphCompiler(projectRoot);
    await compiler2.init();
    const warm = await compiler2.compile();

    const warmImportsKeys = new Set(
      warm.edges.filter((e) => e.relation === 'imports').map((e) => `${e.source}->${e.target}_imports`)
    );
    const warmCallsKeys = new Set(
      warm.edges.filter((e) => e.relation === 'calls').map((e) => `${e.source}->${e.target}_calls`)
    );
    const warmDefaults = new Map(compiler2.getDefaultExports());

    expect(warmImportsKeys).toEqual(coldImportsKeys);
    expect(warmCallsKeys).toEqual(coldCallsKeys);
    expect(warmDefaults).toEqual(coldDefaults);
  });
});
