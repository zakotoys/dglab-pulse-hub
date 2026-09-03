import type { OutputBundle, Plugin } from 'rollup';

export function findUnexpectedExternalImports(
  dependencies: Iterable<string>,
  emittedFileNames: ReadonlySet<string>,
  allowedExternalImports: ReadonlySet<string>
): string[] {
  return [...new Set(dependencies)]
    .filter(
      (dependency) => !emittedFileNames.has(dependency) && !allowedExternalImports.has(dependency)
    )
    .sort();
}

export function createExternalImportGuard(allowedExternalImports: readonly string[]): Plugin {
  const allowed = new Set(allowedExternalImports);

  return {
    name: 'external-import-guard',
    generateBundle(_options, bundle: OutputBundle) {
      const emittedFileNames = new Set(Object.keys(bundle));
      const dependencies = Object.values(bundle).flatMap((output) =>
        output.type === 'chunk' ? [...output.imports, ...output.dynamicImports] : []
      );
      const unexpected = findUnexpectedExternalImports(dependencies, emittedFileNames, allowed);

      if (unexpected.length > 0) {
        this.error(`Unexpected external imports in bundle: ${unexpected.join(', ')}`);
      }
    }
  };
}
