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
    // Prevent port 5173 fallback colliding with daemon on 5174
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
