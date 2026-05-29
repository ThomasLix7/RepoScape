import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/hud'),
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist/hud'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/hud/hud.html'),
    },
  },
  server: {
    port: 5173,
    // Fail loudly if 5173 is taken instead of silently falling back to 5174 —
    // that fallback collides with the daemon (REPOSCAPE_PORT=5174) and also
    // breaks the /api + /ws proxy below, which hard-points at 5174.
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:5174',
      '/ws': {
        target: 'ws://127.0.0.1:5174',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
