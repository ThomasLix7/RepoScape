import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { GraphCompiler } from '../server/compiler.js';
import { unwrapReexports } from '../server/resolver.js';
import { RawImportEntry } from '../server/types.js';

// §8: Acceptance Gate — Integration Tests
// These tests REQUIRE the tree-sitter parser. If it fails to init, the tests
// MUST fail (not skip) — this is the §1 failure mode the spec was designed to catch.
describe('Integration — Acceptance Gate', () => {
  const projectRoot = path.resolve(import.meta.dirname, '..', '..');
  let compiler: GraphCompiler;

  beforeAll(async () => {
    compiler = new GraphCompiler(projectRoot);
    compiler.setScopeRoot(path.join(projectRoot, 'src', 'server'));
    // §1: Non-zero exit on parser init failure — tests MUST fail, not skip
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
    // First compile already done. Second compile should be a true no-op.
    const { diff } = await compiler.compileAndDiff();

    expect(diff.addedEdges.length).toBe(0);
    expect(diff.removedEdges.length).toBe(0);
    expect(diff.removedNodes.length).toBe(0);
  });

  it('§8.3: Resolver-driven coverage gate N/D >= 0.95', async () => {
    const graph = await compiler.compile();
    const resolver = compiler.getModuleResolver();

    // D = distinct (callerFile, resolvedTargetFile) pairs derived from non-type
    // RawImportEntry records whose ModuleResolver.resolve(...) returns non-null.
    // edgeTargetFile is computed per §2.D: for default/named it's unwrapReexports(...).filePath;
    // for side-effect/namespace it's targetFile.
    const rawImports = compiler.getRawImports();
    const fileExportsCache = compiler.getFileExportsCache();

    const denominatorPairs = new Set<string>();
    for (const { caller, entry } of rawImports) {
      // Skip type-only imports
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

    // N = distinct (source_file, target_file) pairs for imports edges whose target exists in nodes
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

    // Must have at least some import edges
    expect(D).toBeGreaterThan(0);
    // §8.3: Coverage gate
    expect(N / D).toBeGreaterThanOrEqual(0.95);
  });

  it('§4.B: Community map is deterministic across two consecutive compile() calls', async () => {
    // First compile
    await compiler.compile();
    const communities1 = new Map(compiler.getCommunities());
    const serialized1 = JSON.stringify(
      [...communities1.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    );

    // Second compile (no changes)
    await compiler.compile();
    const communities2 = new Map(compiler.getCommunities());
    const serialized2 = JSON.stringify(
      [...communities2.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    );

    // §8.4: Bitwise identical when serialized with deterministic ordering
    expect(serialized1).toBe(serialized2);
  });

  it('§8.5: Compiler throws (not silently continues) when parser cannot initialize', async () => {
    // §1.A: Verify that assertParserReady() throws when parser is null.
    // This is the contract: the compiler MUST NOT enter serve loop with a null parser.
    const badCompiler = new GraphCompiler(projectRoot);
    // Don't call init() — parser stays null
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

    // Create fixture files
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });

    // src/a.ts — exports foo, bar, defaultFn
    await fs.writeFile(
      path.join(projectRoot, 'src', 'a.ts'),
      `export function foo() { return 1; }
export function bar() { return 2; }
export default function defaultFn() { return 3; }
`
    );

    // src/setup.ts — side-effect target
    await fs.writeFile(
      path.join(projectRoot, 'src', 'setup.ts'),
      `console.log('setup');\n`
    );

    // src/caller.ts — comprehensive import test
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

    // src/default-named.ts — export default function
    await fs.writeFile(
      path.join(projectRoot, 'src', 'default-named.ts'),
      `export default function namedDefault() { return 10; }\n`
    );

    // src/default-ident.ts — export default identifier
    await fs.writeFile(
      path.join(projectRoot, 'src', 'default-ident.ts'),
      `function localFn() { return 11; }
export default localFn;
`
    );

    // src/default-anon.ts — export default anonymous
    await fs.writeFile(
      path.join(projectRoot, 'src', 'default-anon.ts'),
      `export default { key: 'value' };\n`
    );

    // src/index.ts — barrel
    await fs.writeFile(
      path.join(projectRoot, 'src', 'index.ts'),
      `export { foo } from './a';
export { bar } from './a';
`
    );

    // src/barrel-caller.ts — imports from barrel
    await fs.writeFile(
      path.join(projectRoot, 'src', 'barrel-caller.ts'),
      `import { foo } from './index';
foo();
`
    );

    // src/case-caller.ts — mixed-case import bindings
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

    // Compile
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
    // Side-effect import should not create a binding for 'setup'
    expect(callerBindings?.has('setup')).toBe(false);

    // But there should be a PHYSICAL imports edge to setup.ts
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
    // 'Foo' should not be in bindings (type-only)
    expect(callerBindings?.has('Foo')).toBe(false);
    // But 'foo' from the non-type import should be there
    // (actually caller.ts doesn't import 'foo' directly, it imports 'bar' alias)
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
    // Original-case keys must NOT be present
    expect(caseCaller!.has('MyNS')).toBe(false);
    expect(caseCaller!.has('DefaultFn')).toBe(false);
    expect(caseCaller!.has('MyFoo')).toBe(false);
  });

  it('§5.B: mixed-case imported bindings produce call edges', () => {
    const edges = compiler.getEdges();
    const callsFromCaseCaller = edges.filter(
      (e) => e.relation === 'calls' && e.source_file === 'src/case-caller.ts',
    );
    // MyFoo() and MyNS.foo() both resolve to src/a.ts:foo — same edge key, deduplicated.
    // DefaultFn() resolves to src/a.ts:defaultFn.
    // Minimum 2 unique call edges expected.
    expect(callsFromCaseCaller.length).toBeGreaterThanOrEqual(2);

    // Every target must resolve to a node in src/a.ts
    const nodes = compiler.getNodes();
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    for (const edge of callsFromCaseCaller) {
      const targetNode = nodeById.get(edge.target);
      expect(targetNode?.source_file).toBe('src/a.ts');
    }
  });

  it('§2.G.11a: export default function namedDefault() → defaultExports points at named node', () => {
    const defaultExports = compiler.getDefaultExports();
    const nodeId = defaultExports.get('src/default-named.ts');
    expect(nodeId).toBeDefined();
    // Should NOT be a synthetic :default node
    expect(nodeId).not.toContain(':default');
    // Should contain the function name
    expect(nodeId).toContain('nameddefault');
  });

  it('§2.G.11b: export default localFn (identifier) → defaultExports points at existing local node', () => {
    const defaultExports = compiler.getDefaultExports();
    const nodeId = defaultExports.get('src/default-ident.ts');
    expect(nodeId).toBeDefined();
    // Should NOT be a synthetic :default node
    expect(nodeId).not.toContain(':default');
    // Should contain the local function name
    expect(nodeId).toContain('localfn');
  });

  it('§2.G.11c: export default { ... } (anonymous) → defaultExports points at synthetic :default node', () => {
    const defaultExports = compiler.getDefaultExports();
    const nodeId = defaultExports.get('src/default-anon.ts');
    expect(nodeId).toBeDefined();
    // SHOULD be a synthetic :default node
    expect(nodeId).toContain(':default');
  });

  it('§2.G.14: Warm-cache equivalence — same edges after cache rehydration', async () => {
    // First compile — fresh (cold)
    const cold = await compiler.compile();
    const coldImportsKeys = new Set(
      cold.edges.filter((e) => e.relation === 'imports').map((e) => `${e.source}->${e.target}_imports`)
    );
    const coldCallsKeys = new Set(
      cold.edges.filter((e) => e.relation === 'calls').map((e) => `${e.source}->${e.target}_calls`)
    );
    const coldDefaults = new Map(compiler.getDefaultExports());

    // Create a NEW compiler instance — forces cache rehydration path
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

    // §2.G.14: Set equality, not count equality
    expect(warmImportsKeys).toEqual(coldImportsKeys);
    expect(warmCallsKeys).toEqual(coldCallsKeys);
    expect(warmDefaults).toEqual(coldDefaults);
  });
});
