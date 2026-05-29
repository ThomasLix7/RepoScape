# RepoScape v3.0 — Correctness, Data Model, and Atomicity Pass

This specification supersedes the relevant sections of `update-spec-v2.md`. v2 set the architectural direction (incremental compile, stable communities, focus protocol, audit metadata, etc.); v3 closes the gaps between that direction and what the runtime actually does.

Three failure classes drove this revision:

1. **Silent no-ops.** The compiler bootstraps without aborting when its core dependency is misconfigured, so production runs can emit empty graphs and never tell the user.
2. **Cross-pass data loss.** The parser drops information (named import bindings, export specifier fields) that downstream passes (barrel unwrap, scoped call graph) require, so the spec's resolution chain is structurally unreachable.
3. **Non-atomic state mutation.** Compile and diff are split across transaction boundaries; eviction is split between the watcher and the compiler. Concurrent file events and `/api/insights/batch` calls can produce diffs that describe states that were never observed.

v3 fixes these as a coherent change set, not a stack of patches.

---

## 🧨 1. Parser Runtime Bootstrap — Fail Loud

### A. Core WASM Path

* **The Issue.** `compiler.ts` loads `node_modules/tree-sitter-wasms/out/tree-sitter.wasm`. That directory ships only **language grammars**. The web-tree-sitter **core runtime** lives at `node_modules/web-tree-sitter/tree-sitter.wasm`. `initParser` throws `ENOENT`, the catch logs and continues, `this.parser` stays `null`, and every `parseFile` returns early. The daemon serves an empty graph forever, with no surfaced error other than one line in `.reposcape/error.log`.
* **The Specification.**
  1. Core runtime path **must** be resolved as `node_modules/web-tree-sitter/tree-sitter.wasm`.
  2. Language grammar paths **must** be resolved under `node_modules/tree-sitter-wasms/out/<grammar>.wasm` (unchanged from v1).
  3. Both lookups **must** support pnpm/Yarn PnP and bin-script invocation. Because this project is ESM (`"type": "module"` in `package.json`), `require` is not a global. The resolver **must** bridge via `createRequire(import.meta.url)`:

     ```ts
     import { createRequire } from 'node:module';
     const require = createRequire(import.meta.url);
     const corePath = require.resolve('web-tree-sitter/tree-sitter.wasm', { paths: [cwd, __dirname, projectRoot] });
     const grammarsPkg = require.resolve('tree-sitter-wasms/package.json', { paths: [cwd, __dirname, projectRoot] });
     // grammars live at path.join(path.dirname(grammarsPkg), 'out', `${name}.wasm`)
     ```

     An implementation that reaches for a bare `require` global will crash with `ReferenceError: require is not defined` — the loudest possible version of the bug §1 was designed to prevent.
  4. On any resolution or read failure, the daemon **must abort startup with a non-zero exit code** and a one-line user-facing message naming the missing artifact. It must not enter the serve loop with a `null` parser.

### B. Startup Self-Check

After `compiler.init()`, the daemon **must** call a public `compiler.assertParserReady()` method whose contract is:

```ts
// new public API
compiler.assertParserReady(): void           // throws on any failure below
ParserRegistry.getLoadedLanguageCount(): number   // new public accessor
```

`assertParserReady()` checks, in order:

1. The compiler holds a non-null parser instance (private to the compiler — the assertion is the public surface).
2. `ParserRegistry.getLoadedLanguageCount() > 0`.
3. **Grammar-bound smoke test.** Set the TypeScript grammar on the parser, parse `const x = 1;`, assert `tree.rootNode.namedChildren[0].type === 'lexical_declaration'`. A non-null tree from an unset grammar is undefined behavior in tree-sitter and proves nothing — the smoke test must verify the grammar binding actually produced a meaningful AST shape.

Any failure raises the same fatal exit path as §1.A item 4. The intent is to convert silent no-op into loud crash before the HUD opens. The check uses only public methods so it's exercisable from `integration.test.ts` without poking compiler internals.

---

## 🪢 2. Unified Import Resolution Data Model

v1/v2 split parser, resolver, barrel unwrap, and call-graph scoping across three files. Each pass assumed information the previous pass did not preserve. v3 redefines the contract between them.

### A. Parser Output: `RawImportEntry`

Each `LanguageStrategy.parse` result **must** include a `rawImports: RawImportEntry[]` array. The entry is a discriminated union over `importKind`; `importedName` and `localName` are present only for kinds where they make semantic sense:

```ts
type RawImportEntry =
  | { kind: 'side-effect';  moduleSpecifier: string;                              source_location: string }
  | { kind: 'default';      moduleSpecifier: string; localName: string;           source_location: string }
  | { kind: 'named';        moduleSpecifier: string; importedName: string; localName: string; source_location: string }
  | { kind: 'namespace';    moduleSpecifier: string; localName: string;           source_location: string }
  | { kind: 'type-default'; moduleSpecifier: string; localName: string;           source_location: string }
  | { kind: 'type-named';   moduleSpecifier: string; importedName: string; localName: string; source_location: string };
```

Coverage requirements per kind:

| Kind            | Source syntax                          | PHYSICAL edge | Call-graph binding |
|-----------------|----------------------------------------|---------------|--------------------|
| `side-effect`   | `import './setup'`                     | yes           | none               |
| `default`       | `import foo from './a'`                | yes           | `foo` → `a:default` |
| `named`         | `import { foo as bar } from './a'`     | yes           | `bar` → `a:foo`    |
| `namespace`     | `import * as ns from './a'`            | yes           | `ns` → `a:<file>`  (member calls decompose) |
| `type-default`  | `import type Foo from './a'`           | no            | none               |
| `type-named`    | `import type { Foo } from './a'`       | no            | none               |

Dynamic `import('...')` is **out of scope for v3** and is not represented in `RawImportEntry`.

**Python mapping** — Python has no default exports; `import x` binds a module namespace, not a symbol.

| Python syntax | Kind | Fields |
|---|---|---|
| `import x` | `namespace` | localName = `x` |
| `import x as y` | `namespace` | localName = `y` |
| `from x import y` | `named` | importedName = `y`, localName = `y` |
| `from x import y as z` | `named` | importedName = `y`, localName = `z` |
| `from x import *` | `side-effect` | (no useful binding for v3; full namespace-pollution semantics deferred to v3.1) |

This makes `x.foo()` correctly decompose through §5.B step 3 (namespace member call), which is the typical Python call pattern. Earlier draft text that mapped `import x` to `default` is rejected — Python has no semantic concept of default exports.

**Python cross-module resolution is deferred to v3.1.** v3's `ModuleResolver` pipeline (see §2.C) handles TS-style relative specifiers, TS path aliases, and the NodeNext `.js`→`.ts` rewrite. Python's typical imports are **bare** module/package references (`import os`, `from myapp.config import settings`) that would require a parallel `PythonModuleResolver` with project-root + `__init__.py` traversal and an optional `pythonPath` config analog to TS `baseUrl`. v3 explicitly scopes Python support to **intra-file extraction only**: Python files parse and contribute function/class nodes via `contains` edges within the file, but their `RawImportEntry` records are emitted with the correct kind and will resolve to `null` until v3.1 lands the Python resolver. The §2.G acceptance gate covers TS only. This is documented honestly rather than half-implemented.

The strategy **must not** synthesize a node ID for the imported module. Module resolution is the compiler's job, not the parser's.

**Default-export indexing.** When a strategy encounters `export default ...` it **must** record the node ID of the exported thing on its result:

```ts
interface ExtractionResult {
  // ...existing fields...
  defaultExportNodeId?: string;   // NEW — node ID for THIS file's default export, if any
}
```

* **Named declaration** (`export default function foo() {}`, `export default class Foo {}`): `defaultExportNodeId` is the ID of the `foo` function / `Foo` class node. The strategy **must** also emit that node and its `contains` edge — see "Exported declarations still emit nodes" below.
* **Identifier reference** (`export default foo;` where `foo` is a locally-declared function, class, or const in the same file): `defaultExportNodeId` is the ID of the **existing** local `foo` node. The strategy does **not** synthesize; it resolves the identifier against nodes already emitted from this file. Because `foo` may be hoisted, the resolution runs after the file's `traverse` completes (second pass over the recorded default exports). **Critical:** if `foo` is still unresolved after the second pass, the strategy **must not** synthesize a placeholder. Leave `defaultExportNodeId` undefined and call `appendErrorLog` with a `default-export-unresolved-identifier` tag. Synthesizing a `<file>:default` stub in this case hides one of two real conditions: (a) `foo` was imported from another module and re-exported as default — which should be modeled by emitting a `RawExportEntry` with `sourceFile`/`alias='default'`/`symbol='foo'` so `unwrapReexports` chases it; the parser **must** do this when it can detect that `foo` matches the local name of an import binding it already recorded — or (b) the user wrote broken code. Either way, a synthetic stub creates a fake call target downstream.
* **Anonymous expression** (`export default { ... }`, `export default 42`, `export default () => ...`): the strategy emits a synthetic node with ID `${fileNodeId}:default`, label `default`, file_type `code`, and `source_location` at the export statement. `defaultExportNodeId` is that synthetic ID. This is the **only** case where synthesis is allowed.

The compiler aggregates per-file `defaultExportNodeId` into a project-wide `defaultExports: Map<file, nodeId>` used by §2.D's edge-target unwrap and §5.B's binding resolution.

**Exported declarations still emit nodes.** The v2 parser strategy contained an `if (node.parent?.type !== 'export_statement')` guard that suppressed code-node emission for any function/class/method declaration whose parent was an `export_statement`. v3 **removes this guard**. The export-handling and node-emission paths are orthogonal: `rawExports` drives import resolution; nodes drive call-graph IDs. Without code nodes for exported symbols, `defaultExportNodeId` and named-export `fileBindings` lookups (§5.B `resolveBindingToNode`) return `null` for every export, and the entire import→call resolution chain silently fails.

The replacement rule: a function, class, method, or arrow-function declaration **always** emits a code node and its `contains` edge to the file node, regardless of whether its parent is an `export_statement`. The `export_statement` branch independently produces a `rawExports` entry and (if `default`) sets `defaultExportNodeId` to the node ID emitted by the underlying declaration.

**Anonymous callables on variable declarators.** A `variable_declarator` whose initializer is an **anonymous** callable — `arrow_function`, `function` (expression), or `class` (expression) — **must** still emit a code node, with the name read from the **declarator**, not the callable. This covers:

| Source                                | Name source                        | Emitted node label |
|---------------------------------------|------------------------------------|--------------------|
| `const foo = () => {}`                | declarator                         | `foo`              |
| `const foo = function() {}`           | declarator                         | `foo`              |
| `const Bar = class {}`                | declarator                         | `Bar`              |
| `export const foo = () => {}`         | declarator                         | `foo`              |
| `export const foo = function bar() {}` | declarator (`foo`), not callable name (`bar`) | `foo`     |

Implementation note for `TypeScriptStrategy`: when the callable-emission branch detects no identifier child on its own node, walk up to `node.parent` and check for `variable_declarator`; if found, read the declarator's `identifier` child as the name. Arrow functions and anonymous function expressions on bare declarators must not be silently skipped — without this rule, `export const foo = () => {}` would not appear in the call graph at all, and the v3 acceptance gate would catch nothing because the import-edge target lacks a binding-resolvable node.

### B. Cache Contract for Derived Parser Outputs

`FileExtractionCache` (in `types.ts`) **must** carry every per-file parser output that downstream resolution passes read. v2 cached only `{ nodes, edges, rawCalls, rawExports }`; v3 adds:

```ts
interface FileExtractionCache {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rawCalls: RawCallEntry[];
  rawExports: RawExportEntry[];
  rawImports: RawImportEntry[];        // NEW — feeds §2.D resolution pass
  defaultExportNodeId?: string;        // NEW — same shape as ExtractionResult.defaultExportNodeId
}
```

The warm-restart rehydration path in `compiler.parseFile`'s cache-hit branch **must** restore all three new fields into the same in-memory accumulators that fresh parses feed (analogous to how v2 already restores `rawCalls`):

* `rawImports` → the per-file accumulator that §2.D's resolution pass iterates.
* `defaultExportNodeId` → the project-wide `defaultExports: Map<file, nodeId>` index consumed by §2.D and §5.B.
* (`rawExports` already restored in v2; behavior unchanged.)

Without this, default-import call resolution and import-edge synthesis diverge silently between cold-parse and warm-rehydrate paths. Both classes of bug land as test pass-on-cold, fail-on-warm — the worst kind to debug.

### C. Path Resolution

The compiler owns a `ModuleResolver` that converts `(callerFile, moduleSpecifier)` → `projectRelativePath | null`. The pipeline is **strictly ordered**. Steps 1 and 2 are two alternative ways to produce an **absolute filesystem candidate**; steps 3-4 are candidate transformations; step 5 is the only step that touches the filesystem to confirm existence:

1. **Path-alias rewrite** (non-relative specifiers only). If `compilerOptions.paths` in `tsconfig.json` matches the specifier, emit an **ordered list of absolute filesystem candidates** — one per target pattern in the alias mapping.
   - `tsconfig.paths` legally maps one alias to **multiple targets**: `"@/*": ["src/*", "lib/*", "vendor/*"]`. The resolver tries each in array order. Steps 3-5 run on each candidate; the first one that survives is accepted, and the remaining candidates are discarded.
   - Each target is joined against `path.resolve(dirname(tsconfigPath), tsconfig.compilerOptions.baseUrl ?? '.')`. The `baseUrl` is conventionally relative to the tsconfig.json's directory, **not** projectRoot — for a top-level tsconfig they coincide, but nested tsconfigs (monorepos, `packages/*`) differ.
   - If no alias matches the specifier, no candidate is emitted and the specifier falls through to step 5 (most bare packages take this path).
2. **Relative resolution.** If the specifier starts with `./` or `../`, resolve against `path.resolve(projectRoot, path.dirname(callerFile), specifier)`. Anchoring against `projectRoot` is explicit because `callerFile` is a **project-relative POSIX path** everywhere else in v3 (e.g. `src/server/x.ts`); a naive `path.resolve(path.dirname(callerFile), specifier)` would fall back to `process.cwd()`, which is usually but not always correct. Output: an **absolute filesystem candidate**. Continue to step 3.
3. **ESM `.js`/`.jsx` source rewrite.** If the candidate ends in `.js`, try `.ts` then `.tsx` (in that order) at the same path; first existing sibling wins. If the candidate ends in `.jsx`, try `.tsx` then `.ts`. If no sibling exists, leave the candidate unchanged. No-op for any other extension. This step runs **before** existence checking because NodeNext-style `import x from './foo.js'` is the typical case in this codebase, and step 4 below would otherwise reject the candidate.
4. **Extension / index fallback** (existence-checking step). If the candidate ends in a registered extension AND the file exists, accept it. Otherwise try, in `ParserRegistry.getSupportedExtensions()` order, `<candidate><ext>` and then `<candidate>/index<ext>`. First hit wins. If no variant exists on disk, this candidate fails — under step 1 the resolver moves to the next alias-target candidate; under step 2 it falls through to step 6.
5. **Sandbox check.** Any candidate surviving step 4 **must** satisfy `const rel = path.relative(projectRoot, candidate); !rel.startsWith('..') && !path.isAbsolute(rel)`. The second clause catches Windows different-drive paths (e.g. `projectRoot = C:\proj`, candidate = `D:\external\foo` — `path.relative` returns the candidate verbatim because there's no shared root, which doesn't start with `..` and would otherwise pass). Candidates that escape return `null` for this attempt; the resolver moves to the next alias-target candidate (step 1) or to step 6 (step 2).
6. **Unresolved fallthrough.** Anything that produced no candidate (no alias hit, not relative) OR whose candidates all failed steps 4-5 returns `null`. Bare packages and out-of-root paths are not part of the project graph.

Worked examples:

| Specifier (in `src/server/x.ts`) | After step 1/2 | After step 3 | After step 4 | After step 5 | Final |
|---|---|---|---|---|---|
| `./security.js` | `/proj/src/server/security.js` | `/proj/src/server/security.ts` | exists, accept | in-root, accept | `src/server/security.ts` |
| `./security` | `/proj/src/server/security` | no-op | `<…>.ts` exists | in-root | `src/server/security.ts` |
| `./hud` (dir with `index.tsx`) | `/proj/src/server/hud` | no-op | `<…>/index.tsx` exists | in-root | `src/server/hud/index.tsx` |
| `@/server/security` (alias) | `/proj/src/server/security` | no-op | `<…>.ts` exists | in-root | `src/server/security.ts` |
| `./Button.jsx` (only `Button.tsx`) | `/proj/.../Button.jsx` | `/proj/.../Button.tsx` | exists, accept | in-root | `src/.../Button.tsx` |
| `express` | no candidate | — | — | — | `null` |
| `./missing.js` (no `.ts`/`.tsx` sibling) | `/proj/src/server/missing.js` | no-op | none exist | — | `null` |
| `../../external/foo` (escapes root) | `/proj-parent/external/foo` | no-op | `<…>.ts` exists | escapes root | `null` |

`ModuleResolver` is pure aside from a cached `tsconfig.json` (loaded once at init; `dirname(tsconfigPath)`, `baseUrl`, and `paths` extracted). Final output is a **project-relative POSIX path** (the absolute candidate is converted via `path.relative(projectRoot, ...)`) or `null`. Unresolved imports produce no edge and no binding.

### D. Compiler Resolution Pass

The compiler replaces `resolveBarrelImports` and the `imports`-edge synthesis in `parseFile` with a single pass that runs **after** all files have been parsed and after §E re-export resolution has populated `fileExportsCache` with project-relative paths:

```
for each RawImportEntry e from caller C:
  targetFile = ModuleResolver.resolve(C, e.moduleSpecifier)
  if targetFile == null: continue                          // bare or unresolvable

  // Type-only imports: no PHYSICAL edge, no binding
  if e.kind in {'type-default', 'type-named'}:
    continue

  callerFileNodeId = nodeIdForFile(C)

  // Compute the PHYSICAL edge target. Default/named unwrap through the export chain
  // so that import { foo } from './index' produces an edge to the LEAF (src/a.ts),
  // not to the barrel. Side-effect and namespace target the module as a whole.
  switch e.kind:
    case 'side-effect':
      edgeTargetFile = targetFile                          // whole-module dependency
      // no binding
    case 'namespace':
      edgeTargetFile = targetFile                          // whole-module dependency
      fileBindings[C][e.localName] = { file: targetFile, symbol: '*' }
                                                            // member calls decomposed in §5.B
    case 'default':
      resolved = unwrapReexports('default', targetFile, fileExportsCache)
      edgeTargetFile = resolved.filePath
      fileBindings[C][e.localName] = { file: resolved.filePath, symbol: resolved.symbol }
    case 'named':
      resolved = unwrapReexports(e.importedName, targetFile, fileExportsCache)
      edgeTargetFile = resolved.filePath
      fileBindings[C][e.localName] = { file: resolved.filePath, symbol: resolved.symbol }

  targetFileNodeId = nodeIdForFile(edgeTargetFile)
  emit edge { callerFileNodeId -> targetFileNodeId, relation: 'imports',
              type: 'PHYSICAL', score: 1.0, source_file: C, source_location: e.source_location }
```

* The PHYSICAL edge target is **resolved post-unwrap** for `default`/`named`. This makes barrel re-exports transparent: `import { foo } from './index'` produces an edge `caller → src/a.ts`, satisfying §2.G test 9.
* For `side-effect` there is no specific symbol to chase through the barrel — the dependency is the barrel file itself. Edge target is `targetFile`.
* For `namespace`, the whole module is the dependency. Edge target is `targetFile`. Star re-export resolution happens lazily at call-graph time via §5.B's decomposition; the import edge does not try to point at every star-re-exported leaf.
* `unwrapReexports` is now called with the **actual imported binding**, not the hardcoded `'*'` placeholder. The named, rename, and star branches of `resolver.ts` all become reachable.
* `fileBindings` replaces the over-broad `fileImports` map. Only explicitly imported names are eligible for call resolution. The `'*'` symbol marker for namespace bindings is consumed only by §5.B's member-call decomposition.
* The compiler also maintains a `defaultExports: Map<file, nodeId>` index, populated during parsing (see §2.A). It maps every file that has a `export default` declaration to the corresponding node — either the named function/class whose declaration carried `default`, or a synthetic `<fileNodeId>:default` node for anonymous exports. This index is consumed by §5.B when resolving bindings whose `symbol === 'default'` to a node ID.
* Type-only kinds produce no PHYSICAL edge and no binding. They may resurface as COGNITIVE `type-imports` edges in v3.1; not v3.

### E. Re-Export `sourceFile` Resolution and Type-Only Exports

`RawExportEntry` carries the **raw module specifier** in `sourceFile` (e.g. `"./a"`). `globalExports` / `fileExportsCache` are keyed by **project-relative paths**. Without resolution, `unwrapReexports` searches the cache for `"./a"`, misses, and bails — every barrel test fails silently.

`RawExportEntry` also gains an `exportKind` discriminator to keep type-only re-exports out of the value-time cache that powers runtime import/call resolution:

```ts
interface RawExportEntry {
  symbol: string;
  alias?: string;
  sourceFile?: string;
  isStar?: boolean;
  exportKind: 'value' | 'type';   // NEW — TS only; JS/Python default 'value'
}
```

Specification:

* `compiler.updateExportsCache(relativePath, rawExports)` **must** run each `entry.sourceFile` (when present) through `ModuleResolver.resolve(relativePath, entry.sourceFile)` before storing. If the specifier resolves to `null` (bare package, unknown path), the entry is **dropped** — not stored as the raw specifier. A re-export pointing into `node_modules` is not part of the project graph.
* Star re-exports (`isStar: true`) follow the same rule: each accumulated `sourceFile` in the `'*'` array is a resolved project path, never a raw specifier.
* **Type-only exports are skipped from `fileExportsCache`.** Entries with `exportKind: 'type'` (`export type { Foo }`, `export type { Foo } from './a'`) must not populate the value-time cache that import/call resolution consumes — they would otherwise create phantom value bindings that the compiler can't follow at runtime. v3.1 may introduce a parallel `fileTypeExportsCache` to drive COGNITIVE type-edges; for v3, type-only exports are simply dropped.
* The same resolution rule applies to imports throughout, including for the §C extension/index fallback — `export * from './a'` resolves identically to `import * from './a'`.

### F. Export Specifier Parsing

`TypeScriptStrategy` **must** read `export_specifier` children via `childForFieldName('name')` and `childForFieldName('alias')` rather than positional `find(c => c.type === 'identifier')`. The same applies to import specifiers and named binding extraction. Positional access is brittle against grammar revisions, type-only specifiers, and default exports.

### G. Acceptance Tests

A new test file `src/__tests__/import-resolution.test.ts` **must** cover:

1. Relative `import { foo } from './a.js'` resolves to `src/a.ts` (ESM `.js` rewrite).
2. Extension-less `import { foo } from './a'` resolves to `src/a.ts`.
3. Directory specifier `import { foo } from './a'` resolves to `src/a/index.ts`.
4. Bare specifier `import express from 'express'` produces no edge.
5. Aliased `import { foo as bar } from './a'` produces an edge to `src/a.ts` AND records `fileBindings[caller]['bar'] = { file: 'src/a.ts', symbol: 'foo' }`.
6. Side-effect `import './setup'` produces a PHYSICAL edge but no binding.
7. Namespace `import * as ns from './a'` produces a PHYSICAL edge and `fileBindings[caller]['ns'] = { file: 'src/a.ts', symbol: '*' }`.
8. `import type { Foo } from './a'` produces **no** PHYSICAL edge and **no** binding.
9. Barrel re-export: `src/index.ts` re-exports `foo` from `./a`; a caller importing `foo` from `./index` resolves through to `src/a.ts`.
10. Star re-export chain of depth ≥ 2 terminates at the leaf source file.
11. Default-export shape coverage — three sub-cases:
    - `export default function foo() {}` → `defaultExports[file]` points at the `foo` function node; a caller's `import f from './file'` produces a binding to that same node.
    - `export default foo;` (identifier referencing a local declaration) → `defaultExports[file]` points at the **existing** local `foo` node, NOT a synthetic `<file>:default`.
    - `export default { ... }` (anonymous) → `defaultExports[file]` points at a synthetic `<fileNodeId>:default` node.
12. Multi-target alias — `tsconfig.paths` declares `"@/*": ["src/*", "lib/*"]`. A caller importing from `@/foo` where `src/foo.ts` exists resolves there; if `src/foo.ts` is removed but `lib/foo.ts` exists, the same import resolves to `lib/foo.ts`. Order matters.
13. **Resolver-driven coverage gate.** Run one full compile on this project's own `src/server/`. Define both denominator and numerator over **distinct `(callerFile, resolvedTargetFile)` pairs**, not raw entries, because v3 collapses multi-binding imports (`import { a, b, c } from './m'`) into a single `imports` edge:

    - `D` = the count of distinct `(callerFile, edgeTargetFile)` pairs derived from non-type `RawImportEntry` records whose `ModuleResolver.resolve(...)` returns non-null. `edgeTargetFile` is computed per §2.D: for `default`/`named` it's `unwrapReexports(...).filePath`; for `side-effect`/`namespace` it's `targetFile`.
    - `N` = the count of distinct `(source_file, target_file)` pairs for `imports` edges whose target node exists in `nodes`.
    - Assert `N / D ≥ 0.95`.

    Grep-based oracles are explicitly rejected — they over-count bare, dynamic, side-effect, and type-only imports that the resolver intentionally excludes, AND they don't account for multi-binding collapse.
14. **Warm-cache equivalence.** This is the contract test for §2.B. Sequence:
    1. Compile fresh against a fixture project. Snapshot:
       - `importsKeys = new Set(edges.filter(e => e.relation === 'imports').map(e => \`${e.source}->${e.target}_imports\`))`
       - `callsKeys = new Set(edges.filter(e => e.relation === 'calls').map(e => \`${e.source}->${e.target}_calls\`))`
       - `defaultsMap = new Map(...)` mirroring `defaultExports`
    2. Compile again with **no file changes on disk**. Every file's stat-index entry matches; every per-file parse takes the cache-rehydration branch.
    3. Snapshot the same three structures.
    4. Assert **set equality** (not count equality):
       - `importsKeys` from snapshot 1 ≡ `importsKeys` from snapshot 3.
       - `callsKeys` from snapshot 1 ≡ `callsKeys` from snapshot 3.
       - `defaultsMap` from snapshot 1 deep-equals the one from snapshot 3.

    Equal counts with different keys would pass a count-only check vacuously — a fresh compile emitting `[a→b, c→d]` and a warm-rehydrated compile emitting `[a→x, c→y]` have the same count and the wrong edges. The contract is **same edges**, not "same number of edges".

    Without this test, the cache contract section ships broken cold-only — the warm path silently emits an empty or mis-targeted import graph and call-graph scoping degrades to the v2 unique-global fallback for every file.

---

## ⚛ 3. Atomic Compile and Diff

### A. `compileAndDiff()` is the Public Mutation Path

The compiler **must** expose:

```ts
compileAndDiff(): Promise<{ graph: GraphState; diff: GraphDiff }>
compile():        Promise<GraphState>
```

Both methods are thin transaction wrappers that each enqueue **exactly once**. The actual work lives in a private `compileInternal()` that **must not** call `enqueue` itself. Schematically:

```ts
private async compileInternal(): Promise<GraphState> { /* ... real work ... */ }

async compile(): Promise<GraphState> {
  return this.enqueue(() => this.compileInternal());
}

async compileAndDiff(): Promise<{ graph: GraphState; diff: GraphDiff }> {
  return this.enqueue(async () => {
    const prev = snapshotGraph(this.nodes, this.edges);   // see deep-clone contract below
    const graph = await this.compileInternal();           // NOT this.compile()
    const diff = diffGraphs(prev, graph);
    return { graph, diff };
  });
}
```

Why the carve-out: if `compileAndDiff()` were implemented as `enqueue(async () => { ...; await this.compile(); ... })`, the inner `this.compile()` would call `enqueue` again on the same `transactionQueue` — which is currently blocked waiting for the outer `compileAndDiff()` to resolve. Self-deadlock. The `compileInternal` split makes the invariant structural: only one `enqueue` per public call, ever.

**`snapshotGraph` must deep-clone.** `compileInternal` mutates node objects **in place** — Louvain assigns `node.community = id`, focus state writes `node.focus` / `node.activity`, etc. A shallow snapshot like `{ nodes: new Map(this.nodes), edges: new Map(this.edges) }` copies the Map containers but keeps the same value references; in-place mutations during the compile then bleed into the "previous" snapshot, and `diffGraphs` sees zero `updatedNodes` because both maps now point at the post-mutation objects.

Specification:

```ts
function snapshotGraph(nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>) {
  return {
    nodes: new Map(Array.from(nodes, ([k, v]) => [k, structuredClone(v)])),
    edges: new Map(Array.from(edges, ([k, v]) => [k, structuredClone(v)])),
  };
}
```

`structuredClone` is required because nodes carry nested `metadata: Record<string, any>` and other fields that may be non-primitive. A spread `{ ...v }` is insufficient for those cases. The cost is bounded — Louvain runs at the end of every compile so position/community/focus fields are the only meaningful mutations to capture, but the deep-clone contract holds regardless of which fields ship.

Callers (watcher, `/api/insights/batch`) **must not** snapshot state outside a transaction and then call `compile()`. The pre-v3 pattern of "snapshot → enqueue → diff" is removed.

### B. Shared `diffGraphs(old, new)`

The diffing logic currently duplicated between `watcher.ts` and `routes.ts` **must** be extracted to a single pure function in `compiler.ts` (or a new `diff.ts`). Both call sites consume the same implementation. The function returns `GraphDiff` and is referentially transparent.

### C. Watcher Owns Intent, Not Mutation

* `FileWatcher.handleEvent` **must** record intent (`pendingChanges`, `pendingDeletes`) and call `compileAndDiff()` on flush. It **must not** call `compiler.handleFileDelete(...)` directly.
* `compiler.handleFileDelete` is removed from the public API. Deletion is detected by the stat-index diff inside `compile()` and processed atomically with all other changes.
* This eliminates the v2 double-eviction race between immediate `handleFileDelete` and the queued `compile()`.

### D. Background Recompile Errors Must Log

Every fire-and-forget compile invocation (e.g. the recompile triggered by `/api/insights/batch`) **must** route rejections through `appendErrorLog`. `.catch(() => {})` is forbidden. The HUD continuing to show a stale graph because the recompile silently threw is the worst-case observable.

---

## 🗂 4. Persistence Layout — User Data vs. Derived Cache

The `.reposcape/` directory is reorganized to make user-authored state structurally separate from derivable state.

```
.reposcape/
├── .session-token              # per-launch, regenerated each run
├── error.log[.1.2.3]           # rotated, derivable
├── insights/                   # USER DATA — agent-produced cognitive chunks
│   └── <sha256(source_file)>.json
└── cache/                      # DERIVABLE — wiped on graph_version mismatch
    ├── version.json
    ├── stat-index.json
    ├── communities.json        # NEW (see §4.B)
    └── ast/
        └── <sha256(source_file)>.json
```

### A. Insights Are Never Wiped by Version Bumps

* The `checkCacheVersion` routine **must** delete only `.reposcape/cache/`, never `.reposcape/insights/`.
* `routes.ts` insight writes target `.reposcape/insights/<hash>.json`.
* The cognitive chunk reconciliation scan (currently `compiler.reconciliationScan`) reads from the new path.

**Migration recipe** (runs once at `compiler.init` if `.reposcape/cache/insights/` exists):

This is user data, not derivable cache. Single `fs.rename` is insufficient because `.reposcape/insights/` may already exist (mixed v2/v3 worktrees) and same-hash collisions are possible (same source_file, two chunk vintages).

```
ensureDir(.reposcape/insights/)
collisions = 0
for each file f in .reposcape/cache/insights/:
  target = .reposcape/insights/<basename(f)>
  if not exists(target):
    fs.rename(f, target)
  else:
    legacyMtime = stat(f).mtimeMs
    targetMtime = stat(target).mtimeMs
    if legacyMtime > targetMtime:
      fs.rename(f, target)        // newer legacy wins, overwrites target
    else:
      fs.unlink(f)                 // target already newer, drop legacy
    collisions += 1
if .reposcape/cache/insights/ is now empty:
  fs.rmdir(.reposcape/cache/insights/)
if collisions > 0:
  appendErrorLog(`Insights migration resolved ${collisions} collision(s) by mtime`)
```

The whole migration runs **before** `checkCacheVersion`, so a v2→v3 first run preserves insights even when the version bump is the trigger for upgrading.

### B. Communities Are Persisted

* The stabilized `communities` map **must** be serialized to `.reposcape/cache/communities.json` at the end of every successful `compile()` and loaded back at `compiler.init()`.
* On load, the in-memory `communities` field is populated before the first compile, so `stabilizeCommunities` has a real anchor for Jaccard mapping rather than starting from `{}`. This fulfills v2 §5.1's "stable across runs" promise across process restarts, not only intra-process.
* Serialization order **must** be deterministic (sort node IDs lexicographically before write) so that file equality across runs is a meaningful signal in tests.

### C. Session Token Lifecycle

Token lifecycle is owned by `daemon.ts` orchestrating `security.ts`. The compiler **must not** touch `.session-token` — that's a cross-layer leak v3 explicitly closes.

* `security.ts` **must** expose `unlinkStaleToken(projectRoot): Promise<void>` alongside `generateSessionToken(...)`.
* `daemon.ts` **must** call `security.unlinkStaleToken(projectRoot)` **before** invoking the project-size guard. Any token from a prior aborted run is gone before we even ask the user whether to continue.
* On guard `proceed: true`, `daemon.ts` calls `security.generateSessionToken(projectRoot)` and proceeds to listen.
* On guard `proceed: false`, no token is generated and `daemon.ts` exits 0. Disk is clean.
* `compiler.init()` is unchanged with respect to tokens — it doesn't know they exist.

---

## 🧹 5. Call-Graph Hygiene

### A. Generic Label Set Is Case-Insensitive

* `GENERIC_LABELS` entries **must** be stored lowercase. The lookup key is `calleeKey.toLowerCase()`. The current mix of camelCase entries (`forEach`, `flatMap`, `toString`) silently misses every camelCase generic call and pollutes the graph.
* Recommended additions: `then`, `catch`, `finally`, `resolve`, `reject`, `assign`, `freeze`, `isarray`, `parse`, `stringify`.

### B. Scoping Uses `fileBindings`, Not `fileImports`

Per §2.D, the call-graph pass consumes the explicit-binding map produced during import resolution. It **must not** treat every code symbol in an imported file as importable in the caller.

**Binding → node ID helper.** Both the binding-lookup branch and the namespace-decomposition branch resolve `{ file, symbol }` to a node ID through a single helper:

```
resolveBindingToNode(binding, localFunctions, defaultExports):
  if binding.symbol == 'default':
    return defaultExports.get(binding.file)               // file → nodeId (see §2.D)
  return localFunctions.get(binding.file)?.get(binding.symbol.toLowerCase())
                                                          // case-insensitive symbol lookup
```

`localFunctions: Map<file, Map<labelLower, nodeId>>` is unchanged from v2. `defaultExports: Map<file, nodeId>` is the index built per §2.A's default-export indexing rule. If the helper returns `null`, the call edge is dropped (no fallback to global match — by this step we already have an explicit binding, the symbol just doesn't exist in the target file, which is a real error and shouldn't be papered over with a wrong global hit).

**Resolution order** (per call site):

1. **Local function in same file** — label match against `localFunctions[callerFile]`.
2. **Explicit imported binding** — exact `localName` match against `fileBindings[callerFile]`. If hit, run `resolveBindingToNode(binding, localFunctions, defaultExports)` and emit the call edge to its result.
3. **Namespace member call** — callee of the form `ns.foo`. If `fileBindings[callerFile]['ns'] = { file: F, symbol: '*' }`, decompose: `resolved = unwrapReexports('foo', F, fileExportsCache)`, then `resolveBindingToNode({ file: resolved.filePath, symbol: resolved.symbol }, ...)`. If any step fails, fall through to step 4.
4. **Unique global non-generic match** — single-node `globalLabelToId` hit AND label not in `GENERIC_LABELS`. Score 0.8 (v2 §7 floor retained).

Step 4 **must** be skipped when more than one node shares the label. Steps 1-3 emit at score 1.0; step 4 at 0.8.

### C. Call Edges Carry `source_file`

Every emitted call edge **must** set `source_file` to the caller's file. Eviction by the `sourceToEdgeKeys` index then covers call edges too, removing the v2 carve-out that call edges were recomputed every compile.

---

## 🖼 6. HUD Rendering Performance

### A. Layout Decoupled From Render Loop

* The ad-hoc O(n²) force pass currently inside `CanvasRenderer.render` **must** be removed.
* Replace with `d3-force` (already declared in `package.json` but unused). The simulation runs in a dedicated `setInterval`/`requestIdleCallback` loop at a fixed timestep (default 30 Hz). The render loop reads `node.x`/`node.y` and draws — it does not mutate positions.
* On reaching the alpha-decay threshold, the simulation pauses. It wakes **only** on a non-empty `GraphDiff` (added/removed/updated nodes or edges) or an explicit "re-layout" UI action. Camera zoom/pan **must not** wake the simulation — layout is world-space (`node.x`, `node.y` are graph coordinates), camera changes are viewport-only and affect the renderer's projection, not node positions. Waking d3-force on every wheel/drag event would burn CPU continuously during navigation and cause visible position drift while the user is just looking around.

### B. Camera Spring Uses `dt`

* `updateCamera()` **must** accept a `dtMs` argument and scale forces by `dtMs / 16.67`. The render loop computes `dt` from `performance.now()`. This removes the v1/v2 behavior where 144 Hz displays oscillate harder than 60 Hz displays.
* The stiffness/damping constants stay at `k = 0.08`, `c = 2·√k`.

### C. Focus Timer Cleanup

* `App.tsx`'s `handleFocus` **must** track every scheduled `setTimeout` in a ref-backed Set and clear them in the effect's cleanup. Long-running sessions leak one timer per focus event in v2.
* The focus expiry deadline is stored on the node (`focusTtl`); the timer only triggers a re-render to drop expired `focus: true` flags. A single shared interval may replace per-event timers.

### D. Edge Detection Honors Visibility Filters

**Required renderer invariant.** `CanvasRenderer` **must** persist the latest `RenderOptions` it was passed (`this.currentOptions = options` at the top of every `render()` call) and use that persisted state for **all** interaction filtering, including `findEdgeAt`. The latest visibility toggles are the single source of truth for what is interactive; there is no separate "interaction filter" map.

**Required behavior.** `findEdgeAt` **must** iterate over every edge type with a per-type gate against the persisted `currentOptions.show*`:

* `PHYSICAL` edges considered only when `currentOptions.showPhysical`.
* `COGNITIVE` edges considered only when `currentOptions.showCognitive` (extends v2 §4 — unchanged in spirit).
* `SUSPICIOUS` edges considered only when `currentOptions.showSuspicious`.

Toggled-off edges are non-interactive. Toggled-on PHYSICAL/SUSPICIOUS edges open a basic detail card (source, target, relation, score, source_location). The COGNITIVE branch keeps its richer audit-trail pop-up (v2 §4) unchanged.

---

## 🧰 7. Smaller Correctness Items

### A. Per-Source Error Telemetry Hygiene

* `sandboxPath` error messages **must not** echo the user-supplied input verbatim. Log a stable identifier (e.g. `sha256(input).slice(0,12)`) and the resolved path only. The localhost-only deployment limits today's risk but the log file is a recoverable artifact.

### B. Cognitive Chunk Hot-Path Concurrency

* The cognitive cache load in `compiler.loadCognitiveInsights` validates each chunk sequentially. For chunks with hundreds of nodes the per-node `await fileExists` checks dominate compile time.
* Specification: replace the sequential inner loop with a **bounded concurrency pool** (default `Math.min(8, os.cpus().length)`) running `sandboxPath + fileExists` per node. The pool **must** support short-circuit semantics via a shared `hasMissingSource` flag: once any node fails, in-flight checks finish naturally but no new ones are scheduled, and the chunk is rejected without waiting for the remaining queue to drain.
* `Promise.all` is **not** acceptable here. It rejects on first failure but does not stop in-flight work, and it has no concurrency cap — a 5k-node chunk would open 5k concurrent fs descriptors. The bounded pool with a short-circuit flag is the correct primitive.

### C. Lock File Contention

`writeCacheAtomic` retries up to 10 times with 10–100 ms jitter — about a 1-second ceiling. Within a single `/api/insights/batch` writes are sequential, so that batch's own writes never contend. Across overlapping endpoints there are **three** writable paths exposed to true concurrency:

| Path | Concurrent writers |
|------|-------------------|
| `cache/stat-index.json` | compiler (one per `compileInternal`); watcher and tests may read concurrently |
| `cache/version.json` | compiler only; written at the end of every `compileInternal` |
| `insights/<hash>.json` | **multiple concurrent `/api/insights/batch` calls** targeting the same source file |

The `insights/<hash>.json` path is the most exposed: two agents (or two skill invocations) hitting `/api/insights/batch` concurrently for chunks that reference the same `source_file` will produce the same hashed filename and race on the lock.

Specification:

* Raise the retry ceiling to 30 attempts (~3 s worst case at the current jitter).
* On lock-acquisition exhaustion, return a per-entry failure to the caller — `{ status: 'lock_failed', file, error: 'timeout after 30 attempts' }` — and log via `appendErrorLog`. Do **not** introduce an in-process deferred-retry queue: that would carry user data in volatile memory with no durability guarantee across process exits, which is worse than telling the agent the write failed.
* `/api/insights/batch` is already a retryable endpoint at the agent layer. Retry policy belongs there, not in the daemon's volatile state.
* `cache/ast/<hash>.json` is single-writer (compiler only inside `compileInternal`) and is not exposed to true concurrency — no change needed.

### D. `dev` Script Lifecycle

* `package.json` `dev` script **must** propagate SIGINT/SIGTERM to both the daemon and Vite child processes. The current `tsx watch ... & vite` form orphans the daemon when Vite exits. Replace with `concurrently` or a small `scripts/dev.mjs` wrapper that traps the parent signal.

### E. Health Endpoint Documentation

* `/api/health` sits behind `authMiddleware`. `SKILL.md` already specifies that the agent sends `Authorization: Bearer <token>` for the health probe; this is correct. No code change. Specification: add a `README.md` snippet that states health requires the bearer token, so external monitors don't probe expecting a 200.

---

## 🧪 8. Acceptance Gate

A v3 release **must** pass all of the following before tagging:

1. `npm run build` succeeds without warnings.
2. `npm test` — all v2 tests pass plus the new `import-resolution.test.ts` (§2.G).
3. A new `src/__tests__/integration.test.ts` boots the compiler against `src/` itself and asserts:
   - `compiler.assertParserReady()` does not throw (§1.B).
   - `getNodes().length > 50` (sanity floor).
   - The resolver-driven coverage gate from §2.G item 11: `N/D ≥ 0.95` where both N and D are counted over **distinct `(callerFile, resolvedTargetFile)` pairs** over non-type resolver-resolved imports — not raw entries, not grep matches.
   - No edge has `source` or `target` missing from `nodes` after compile.
   - Re-running `compileAndDiff()` immediately after the first call produces zero net `addedEdges`/`removedEdges` — the second compile is a true no-op when nothing on disk changed.
4. The community map after two consecutive `compile()` calls is **bitwise identical** when serialized through the deterministic ordering of §4.B.
5. A small adversarial test that injects a malformed `tree-sitter.wasm` path and confirms the daemon exits non-zero before opening the WS listener (§1.B).

---

## Out of Scope (Tracked for v3.1+)

* Replacing the `Map<string, string | { sourceFile; originalSymbol } | string[]>` cache value with a tagged union (`ExportTarget`). Style/readability — defer to v3.1 once §2 is stable.
* Multi-tenant insight sharing across project roots.
* HUD persistence of camera position across reloads.
* Non-ASCII identifier collision in `makeNodeId` (SHA prefix already disambiguates per-file; same-file collisions are vanishingly rare).
* Replacing the ad-hoc `transactionQueue` with a typed work-queue abstraction.

---

## Summary of Behavioral Changes Visible to Users

* The daemon now **refuses to start** when its parser cannot initialize. Empty graphs are no longer a silent failure mode.
* Import edges actually resolve. The "cognitive graph" stops being a node cloud and starts being a graph.
* Call edges are scoped, not globbed. Demo recordings will look meaningfully cleaner.
* Cognitive insights survive across `graph_version` bumps.
* Community IDs are stable across daemon restarts, not only within one process.
* The HUD stays responsive past ~500 nodes.

All other v1/v2 contracts — WS message shapes, REST routes, security model, marker-block bootstrap protocol, audit metadata schema — are unchanged.
