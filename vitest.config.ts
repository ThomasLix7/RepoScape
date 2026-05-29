import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // §1.A: web-tree-sitter uses CJS and tree-sitter-wasms ships WASM files.
    // These need to be loaded natively by Node.js, not transformed by vitest.
    server: {
      deps: {
        external: ['web-tree-sitter', 'tree-sitter-wasms'],
      },
    },
  },
  // Ensure TypeScript source with .js extensions resolves correctly
  resolve: {
    conditions: ['import', 'module', 'default'],
  },
});
