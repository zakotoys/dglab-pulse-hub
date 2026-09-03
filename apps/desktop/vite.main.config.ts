import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { createExternalImportGuard } from '../../scripts/rollup-external-guard.ts';
import { handleRollupWarning } from '../../scripts/rollup-warning.ts';

const sourceDirectory = fileURLToPath(new URL('./src/', import.meta.url));
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
      input: fileURLToPath(new URL('./src/main.ts', import.meta.url)),
      external: allowedExternalImports,
      onwarn: handleRollupWarning,
      output: {
        format: 'es',
        entryFileNames: 'main.js',
        chunkFileNames: 'main-[name].js'
      }
    }
  },
  resolve: {
    conditions: ['node', 'import', 'default']
  }
});
