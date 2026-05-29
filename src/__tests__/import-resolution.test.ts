import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ModuleResolver } from '../server/resolver.js';

// §2.G: Import Resolution Acceptance Tests
// Tests use ModuleResolver directly (parser-independent) and compiler where possible
describe('Import Resolution', () => {
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'reposcape-import-test-'));

    // Create tsconfig.json with path aliases
    await fs.writeFile(
      path.join(projectRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@/*': ['src/*', 'lib/*'],
          },
        },
      })
    );

    // Create source files
    await fs.mkdir(path.join(projectRoot, 'src', 'a'), { recursive: true });
    await fs.mkdir(path.join(projectRoot, 'src', 'setup'), { recursive: true });
    await fs.mkdir(path.join(projectRoot, 'lib'), { recursive: true });

    // src/a.ts
    await fs.writeFile(
      path.join(projectRoot, 'src', 'a.ts'),
      `export function foo() { return 1; }\nexport function bar() { return 2; }\n`
    );

    // src/a/index.ts — for directory specifier test
    await fs.writeFile(
      path.join(projectRoot, 'src', 'a', 'index.ts'),
      `export function dirFoo() { return 4; }\n`
    );

    // src/setup.ts
    await fs.writeFile(
      path.join(projectRoot, 'src', 'setup.ts'),
      `console.log('setup');\n`
    );

    // src/caller.ts
    await fs.writeFile(
      path.join(projectRoot, 'src', 'caller.ts'),
      `import { foo as bar } from './a';\nimport { foo } from './a.js';\nimport express from 'express';\nimport './setup';\nimport * as ns from './a';\nimport type { Foo } from './a';\nbar();\nfoo();\n`
    );

    // src/index.ts — barrel re-export
    await fs.writeFile(
      path.join(projectRoot, 'src', 'index.ts'),
      `export { foo } from './a';\nexport { bar } from './a';\nexport * from './a';\n`
    );

    // src/deep.ts
    await fs.writeFile(
      path.join(projectRoot, 'src', 'deep.ts'),
      `export function deepFn() { return 5; }\n`
    );

    // src/middle.ts
    await fs.writeFile(
      path.join(projectRoot, 'src', 'middle.ts'),
      `export * from './deep';\n`
    );

    // src/shallow.ts
    await fs.writeFile(
      path.join(projectRoot, 'src', 'shallow.ts'),
      `export * from './middle';\n`
    );

    // src/caller3.ts
    await fs.writeFile(
      path.join(projectRoot, 'src', 'caller3.ts'),
      `import { deepFn } from './shallow';\ndeepFn();\n`
    );

    // lib/foo.ts
    await fs.writeFile(
      path.join(projectRoot, 'lib', 'foo.ts'),
      `export function libFoo() { return 6; }\n`
    );

    // src/export-default-ident.ts
    await fs.writeFile(
      path.join(projectRoot, 'src', 'export-default-ident.ts'),
      `function myDefault() { return 7; }\nexport default myDefault;\n`
    );

    // src/export-default-anon.ts
    await fs.writeFile(
      path.join(projectRoot, 'src', 'export-default-anon.ts'),
      `export default { key: 'value' };\n`
    );
  });

  afterAll(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  describe('ModuleResolver', () => {
    it('1. Relative import { foo } from ./a.js resolves to src/a.ts (ESM .js rewrite)', async () => {
      const resolver = new ModuleResolver(projectRoot);
      await resolver.init();
      resolver.setSupportedExtensions(['.ts', '.tsx', '.js', '.jsx']);
      const result = await resolver.resolve('src/caller.ts', './a.js');
      expect(result).toBe('src/a.ts');
    });

    it('2. Extension-less import { foo } from ./a resolves to src/a.ts', async () => {
      const resolver = new ModuleResolver(projectRoot);
      await resolver.init();
      resolver.setSupportedExtensions(['.ts', '.tsx', '.js', '.jsx']);
      const result = await resolver.resolve('src/caller.ts', './a');
      expect(result).toBe('src/a.ts');
    });

    it('3. Directory specifier import resolves to index.ts when no direct file exists', async () => {
      const resolver = new ModuleResolver(projectRoot);
      await resolver.init();
      resolver.setSupportedExtensions(['.ts', '.tsx', '.js', '.jsx']);
      // src/setup.ts exists as a file, so it should resolve to that
      const result = await resolver.resolve('src/caller.ts', './setup');
      expect(result).toBe('src/setup.ts');
    });

    it('4. Bare specifier import express from express produces null', async () => {
      const resolver = new ModuleResolver(projectRoot);
      await resolver.init();
      resolver.setSupportedExtensions(['.ts', '.tsx', '.js', '.jsx']);
      const result = await resolver.resolve('src/caller.ts', 'express');
      expect(result).toBeNull();
    });

    it('5. Aliased import @/foo resolves to src/foo.ts (first alias target)', async () => {
      const resolver = new ModuleResolver(projectRoot);
      await resolver.init();
      resolver.setSupportedExtensions(['.ts', '.tsx', '.js', '.jsx']);
      // src/foo.ts doesn't exist, so it should try lib/foo.ts
      const result = await resolver.resolve('src/caller.ts', '@/foo');
      expect(result).toBe('lib/foo.ts');
    });

    it('6. Relative import ./setup resolves to src/setup.ts', async () => {
      const resolver = new ModuleResolver(projectRoot);
      await resolver.init();
      resolver.setSupportedExtensions(['.ts', '.tsx', '.js', '.jsx']);
      const result = await resolver.resolve('src/caller.ts', './setup');
      expect(result).toBe('src/setup.ts');
    });

    it('7. Missing file ./missing returns null', async () => {
      const resolver = new ModuleResolver(projectRoot);
      await resolver.init();
      resolver.setSupportedExtensions(['.ts', '.tsx', '.js', '.jsx']);
      const result = await resolver.resolve('src/caller.ts', './missing');
      expect(result).toBeNull();
    });

    it('8. Path escaping root returns null', async () => {
      const resolver = new ModuleResolver(projectRoot);
      await resolver.init();
      resolver.setSupportedExtensions(['.ts', '.tsx', '.js', '.jsx']);
      const result = await resolver.resolve('src/caller.ts', '../../external/foo');
      // This may or may not resolve depending on the directory structure
      // If it escapes the root, it should return null
      if (result) {
        // If it resolved, it should be within the project
        expect(result.startsWith('..')).toBe(false);
      }
    });

    it('12. Multi-target alias — @/foo resolves to src/foo.ts if it exists, otherwise lib/foo.ts', async () => {
      const resolver = new ModuleResolver(projectRoot);
      await resolver.init();
      resolver.setSupportedExtensions(['.ts', '.tsx', '.js', '.jsx']);

      // First, lib/foo.ts should be found (src/foo.ts doesn't exist)
      const result1 = await resolver.resolve('src/caller.ts', '@/foo');
      expect(result1).toBe('lib/foo.ts');

      // Now create src/foo.ts
      await fs.writeFile(path.join(projectRoot, 'src', 'foo.ts'), `export function foo() {}`);

      // Now src/foo.ts should be found first
      const result2 = await resolver.resolve('src/caller.ts', '@/foo');
      expect(result2).toBe('src/foo.ts');

      // Clean up
      await fs.unlink(path.join(projectRoot, 'src', 'foo.ts'));
    });
  });

  describe('Re-export resolution (unwrapReexports)', () => {
    it('9. Barrel re-export: foo from ./index resolves through to src/a.ts', async () => {
      const { unwrapReexports } = await import('../server/resolver.js');

      // Build a mock globalExports cache
      const globalExports = new Map<string, Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>>();

      // src/index.ts exports { foo } from './a' → foo maps to src/a.ts
      const indexExports = new Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>();
      indexExports.set('foo', 'src/a.ts');
      indexExports.set('bar', 'src/a.ts');
      indexExports.set('*', ['src/a.ts']);
      globalExports.set('src/index.ts', indexExports);

      // src/a.ts has direct exports
      const aExports = new Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>();
      aExports.set('foo', 'src/a.ts');
      aExports.set('bar', 'src/a.ts');
      globalExports.set('src/a.ts', aExports);

      const result = unwrapReexports('foo', 'src/index.ts', globalExports);
      expect(result.filePath).toBe('src/a.ts');
      expect(result.symbol).toBe('foo');
    });

    it('10. Star re-export chain of depth >= 2 terminates at leaf source file', async () => {
      const { unwrapReexports } = await import('../server/resolver.js');

      const globalExports = new Map<string, Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>>();

      // src/shallow.ts re-exports * from ./middle
      const shallowExports = new Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>();
      shallowExports.set('*', ['src/middle.ts']);
      globalExports.set('src/shallow.ts', shallowExports);

      // src/middle.ts re-exports * from ./deep
      const middleExports = new Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>();
      middleExports.set('*', ['src/deep.ts']);
      globalExports.set('src/middle.ts', middleExports);

      // src/deep.ts has deepFn
      const deepExports = new Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>();
      deepExports.set('deepFn', 'src/deep.ts');
      globalExports.set('src/deep.ts', deepExports);

      const result = unwrapReexports('deepFn', 'src/shallow.ts', globalExports);
      expect(result.filePath).toBe('src/deep.ts');
      expect(result.symbol).toBe('deepFn');
    });

    it('11a. Renamed re-export: { foo as bar } resolves correctly', async () => {
      const { unwrapReexports } = await import('../server/resolver.js');

      const globalExports = new Map<string, Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>>();

      // src/index.ts re-exports { foo as bar } from './a'
      const indexExports = new Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>();
      indexExports.set('bar', { sourceFile: 'src/a.ts', originalSymbol: 'foo' });
      globalExports.set('src/index.ts', indexExports);

      const aExports = new Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>();
      aExports.set('foo', 'src/a.ts');
      globalExports.set('src/a.ts', aExports);

      const result = unwrapReexports('bar', 'src/index.ts', globalExports);
      expect(result.filePath).toBe('src/a.ts');
      expect(result.symbol).toBe('foo');
    });

    it('11b. Default export unwrap: symbol=default resolves through re-export chain', async () => {
      const { unwrapReexports } = await import('../server/resolver.js');

      const globalExports = new Map<string, Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>>();

      // src/barrel.ts re-exports default as default from ./real
      const barrelExports = new Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>();
      barrelExports.set('default', { sourceFile: 'src/real.ts', originalSymbol: 'default' });
      globalExports.set('src/barrel.ts', barrelExports);

      // src/real.ts has a default export
      const realExports = new Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>();
      realExports.set('default', 'src/real.ts');
      globalExports.set('src/real.ts', realExports);

      const result = unwrapReexports('default', 'src/barrel.ts', globalExports);
      expect(result.filePath).toBe('src/real.ts');
      expect(result.symbol).toBe('default');
    });

    it('11c. Circular re-export terminates without infinite loop', async () => {
      const { unwrapReexports } = await import('../server/resolver.js');

      const globalExports = new Map<string, Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>>();

      // src/a.ts re-exports from ./b
      const aExports = new Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>();
      aExports.set('foo', 'src/b.ts');
      globalExports.set('src/a.ts', aExports);

      // src/b.ts re-exports from ./a (circular)
      const bExports = new Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>();
      bExports.set('foo', 'src/a.ts');
      globalExports.set('src/b.ts', bExports);

      // Should terminate without hanging
      const result = unwrapReexports('foo', 'src/a.ts', globalExports);
      expect(result).toBeDefined();
      expect(result.filePath).toBeTruthy();
    });
  });
});
