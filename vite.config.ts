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
    proxy: {
      '/api': 'http://localhost:5174',
      '/ws': {
        target: 'ws://localhost:5174',
        ws: true,
      },
    },
  },
});
