import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const outputDirectory = fileURLToPath(new URL('./dist/', import.meta.url));

export default defineConfig({
  build: {
    outDir: outputDirectory,
    emptyOutDir: false,
    target: 'node24',
    ssr: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./src/preload.ts', import.meta.url)),
      external: ['electron'],
      output: {
        format: 'cjs',
        entryFileNames: 'preload.cjs',
        chunkFileNames: 'preload-[name].cjs'
      }
    }
  }
});
