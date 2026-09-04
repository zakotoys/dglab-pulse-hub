import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

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
  readonly makers?: Array<{
    readonly name?: string;
    readonly config?: { readonly icon?: string; readonly title?: string };
  }>;
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
  it('uses NSIS with selectable install location and shortcuts', async () => {
    const config = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8');
    expect(config).toContain('oneClick: false');
    expect(config).toContain('allowToChangeInstallationDirectory: true');
    expect(config).toContain('createDesktopShortcut: true');
    expect(config).toContain('include: installer.nsh');
    const script = await readFile(new URL('../installer.nsh', import.meta.url), 'utf8');
    expect(script).toContain('Page custom TaskbarPinPageCreate TaskbarPinPageLeave');
    expect(script).toContain('固定到任务栏');
  });
});

describe('Linux packages', () => {
  it('builds distribution packages and a portable AppImage', async () => {
    const config = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8');
    expect(config).toContain('linux:');
    expect(config).toContain('- AppImage');
    expect(config).toContain('- deb');
    expect(config).toContain('- rpm');
    expect(config).toContain('category: Utility');
    expect(config).toContain('executableName: dglab-pulse-hub');
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
