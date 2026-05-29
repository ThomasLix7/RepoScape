import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Load web-tree-sitter and tree-sitter-wasms natively
    server: {
      deps: {
        external: ['web-tree-sitter', 'tree-sitter-wasms'],
      },
    },
  },
  // Resolve TS imports with .js extension
  resolve: {
    conditions: ['import', 'module', 'default'],
  },
});
