import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

interface ForgeMaker {
  readonly name?: string;
  readonly config?: { loadingGif?: string; setupIcon?: string };
}

const require = createRequire(import.meta.url);
const forge = require('../forge.config.cjs') as { makers?: ForgeMaker[] };

describe('Windows installer', () => {
  it('uses branded icons and a compact custom loading animation', async () => {
    const squirrel = forge.makers?.find((maker) => maker.name === '@electron-forge/maker-squirrel');
    expect(squirrel?.config?.setupIcon).toMatch(/dglab-pulse-hub-icon\.ico$/);
    expect(basename(squirrel?.config?.loadingGif ?? '')).toBe('dglab-pulse-hub-install.gif');

    const bytes = await readFile(squirrel?.config?.loadingGif ?? '');
    expect(bytes.toString('ascii', 0, 6)).toBe('GIF89a');
    expect(bytes.readUInt16LE(6)).toBe(268);
    expect(bytes.readUInt16LE(8)).toBe(167);
    expect(bytes.byteLength).toBeLessThan(50_000);
  });
});
