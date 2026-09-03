import { describe, expect, it } from 'vitest';
import { findUnexpectedExternalImports } from '../scripts/rollup-external-guard.js';

describe('Rollup external import guard', () => {
  it('rejects package imports while allowing runtime modules and emitted chunks', () => {
    const dependencies = ['electron', 'node:fs', 'main-shared.js', 'dijkstrajs', 'dijkstrajs'];

    expect(
      findUnexpectedExternalImports(
        dependencies,
        new Set(['main-shared.js']),
        new Set(['electron', 'node:fs'])
      )
    ).toEqual(['dijkstrajs']);
  });
});
