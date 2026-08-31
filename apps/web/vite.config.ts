import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { handleRollupWarning } from '../../scripts/rollup-warning.ts';

export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL('./', import.meta.url)),
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      onwarn: handleRollupWarning
    }
  }
});
