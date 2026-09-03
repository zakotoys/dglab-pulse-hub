import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

interface ForgeMaker {
  readonly name?: string;
  readonly config?: {
    icon?: string;
    loadingGif?: string;
    setupIcon?: string;
    title?: string;
  };
}

interface ForgeConfig {
  readonly packagerConfig?: {
    readonly appBundleId?: string;
    readonly appCategoryType?: string;
    readonly appCopyright?: string;
    readonly afterExtract?: unknown[];
    readonly executableName?: string;
    readonly extendInfo?: Record<string, unknown>;
    readonly icon?: string;
    readonly win32metadata?: Record<string, unknown>;
  };
  readonly makers?: ForgeMaker[];
}

const require = createRequire(import.meta.url);
const forge = require('../forge.config.cjs') as ForgeConfig;

describe('Desktop package branding', () => {
  it('uses product-owned names, identifiers, icons, and executable metadata', () => {
    expect(forge.packagerConfig).toMatchObject({
      appBundleId: 'com.zakotoys.dglab-pulse-hub',
      appCategoryType: 'public.app-category.utilities',
      appCopyright: 'Copyright (c) ZakoToys',
      afterExtract: [expect.any(Function)],
      executableName: 'DGLab Pulse Hub',
      extendInfo: { CFBundleIconFile: 'dglab-pulse-hub-icon.icns' },
      win32metadata: {
        CompanyName: 'ZakoToys',
        FileDescription: 'DGLab Pulse Hub',
        InternalName: 'DGLab Pulse Hub',
        OriginalFilename: 'DGLab Pulse Hub.exe',
        ProductName: 'DGLab Pulse Hub'
      }
    });
    expect(forge.packagerConfig?.icon).toMatch(/dglab-pulse-hub-icon$/);
  });
});

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

describe('macOS disk image', () => {
  it('uses the product name and branded volume icon', () => {
    const dmg = forge.makers?.find((maker) => maker.name === '@electron-forge/maker-dmg');
    expect(dmg?.config).toMatchObject({
      title: 'DGLab Pulse Hub',
      icon: expect.stringMatching(/dglab-pulse-hub-icon\.icns$/)
    });
  });
});
