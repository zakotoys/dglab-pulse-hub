import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { handleRollupWarning } from '../../scripts/rollup-warning.ts';

const sourceDirectory = fileURLToPath(new URL('./src/', import.meta.url));
const outputDirectory = fileURLToPath(new URL('./dist/', import.meta.url));

export default defineConfig({
  root: sourceDirectory,
  build: {
    outDir: outputDirectory,
    emptyOutDir: false,
    rollupOptions: {
      input: fileURLToPath(new URL('./src/renderer.ts', import.meta.url)),
      onwarn: handleRollupWarning,
      output: {
        entryFileNames: 'renderer.js',
        assetFileNames: '[name][extname]'
      }
    }
  }
});
