import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { handleRollupWarning } from '../../scripts/rollup-warning.ts';

const sourceDirectory = fileURLToPath(new URL('./src/', import.meta.url));
const outputDirectory = fileURLToPath(new URL('./dist/', import.meta.url));
const nodeBuiltins = builtinModules.flatMap((moduleName) => [moduleName, 'node:' + moduleName]);

export default defineConfig({
  ssr: {
    noExternal: ['zod', 'jpeg-js', 'pngjs', 'qrcode']
  },
  build: {
    outDir: outputDirectory,
    emptyOutDir: false,
    target: 'node24',
    ssr: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./src/main.ts', import.meta.url)),
      external: ['electron', ...nodeBuiltins],
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
