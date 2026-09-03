import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { createExternalImportGuard } from '../../scripts/rollup-external-guard.ts';

const outputDirectory = fileURLToPath(new URL('./dist/', import.meta.url));
const nodeBuiltins = builtinModules.flatMap((moduleName) => [moduleName, 'node:' + moduleName]);
const allowedExternalImports = ['electron', ...nodeBuiltins];

export default defineConfig({
  ssr: {
    noExternal: true
  },
  plugins: [createExternalImportGuard(allowedExternalImports)],
  build: {
    outDir: outputDirectory,
    emptyOutDir: false,
    target: 'node24',
    ssr: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./src/preload.ts', import.meta.url)),
      external: allowedExternalImports,
      output: {
        format: 'cjs',
        entryFileNames: 'preload.cjs',
        chunkFileNames: 'preload-[name].cjs'
      }
    }
  }
});
