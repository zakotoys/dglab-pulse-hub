import { describe, expect, it } from 'vitest';
import {
  assertDesktopBinaryArchitecture,
  macInfoErrors,
  packageFileErrors,
  validateAsarEntries,
  windowsInfoErrors
} from '../scripts/audit-desktop-package.js';

function pe(machine: number): Buffer {
  const bytes = Buffer.alloc(128);
  bytes.write('MZ');
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write('PE\0\0', 64, 'binary');
  bytes.writeUInt16LE(machine, 68);
  return bytes;
}

function macho(cpuType: number): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(cpuType, 4);
  return bytes;
}

function elf(machine: number): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46]);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}

describe('desktop package audit', () => {
  it('accepts matching Windows PE architectures and rejects a mixed binary', () => {
    expect(() => assertDesktopBinaryArchitecture(pe(0xaa64), 'win32', 'arm64')).not.toThrow();
    expect(() => assertDesktopBinaryArchitecture(pe(0x8664), 'win32', 'arm64')).toThrow(
      /expected arm64, found x64/
    );
  });

  it('accepts matching macOS Mach-O architectures', () => {
    expect(() =>
      assertDesktopBinaryArchitecture(macho(0x0100000c), 'darwin', 'arm64')
    ).not.toThrow();
    expect(() => assertDesktopBinaryArchitecture(macho(0x01000007), 'darwin', 'x64')).not.toThrow();
  });

  it('accepts matching Linux ELF architectures and rejects a mixed binary', () => {
    expect(() => assertDesktopBinaryArchitecture(elf(0xb7), 'linux', 'arm64')).not.toThrow();
    expect(() => assertDesktopBinaryArchitecture(elf(0x3e), 'linux', 'x64')).not.toThrow();
    expect(() => assertDesktopBinaryArchitecture(elf(0x3e), 'linux', 'arm64')).toThrow(
      /expected arm64, found x64/
    );
  });

  it('reports missing platform runtime files', () => {
    expect(packageFileErrors('win32', new Set(['DGLab Pulse Hub.exe']))).toContain(
      'Missing resources/app.asar'
    );
  });

  it('requires the branded macOS icon resource', () => {
    expect(packageFileErrors('darwin', new Set())).toContain(
      'Missing DGLab Pulse Hub.app/Contents/Resources/dglab-pulse-hub-icon.icns'
    );
    expect(
      packageFileErrors('darwin', new Set(['DGLab Pulse Hub.app/Contents/Resources/electron.icns']))
    ).toContain('Obsolete Electron icon resource is present.');
  });

  it('reports missing Linux runtime files', () => {
    expect(packageFileErrors('linux', new Set(['DGLab Pulse Hub']))).toContain(
      'Missing resources/app.asar'
    );
    expect(packageFileErrors('linux', new Set(['resources/app.asar']))).toContain(
      'Missing Linux application executable'
    );
    expect(packageFileErrors('linux', new Set(['DGLab Pulse Hub']))).not.toContain(
      'Missing Linux application executable'
    );
    expect(packageFileErrors('linux', new Set(['dglab-pulse-hub']))).not.toContain(
      'Missing Linux application executable'
    );
  });

  it('accepts branded macOS metadata and rejects obsolete Electron defaults', () => {
    const info = {
      CFBundleDisplayName: 'DGLab Pulse Hub',
      CFBundleExecutable: 'DGLab Pulse Hub',
      CFBundleIconFile: 'dglab-pulse-hub-icon.icns',
      CFBundleIdentifier: 'com.zakotoys.dglab-pulse-hub',
      CFBundleName: 'DGLab Pulse Hub',
      LSApplicationCategoryType: 'public.app-category.utilities',
      NSHumanReadableCopyright: 'Copyright (c) ZakoToys'
    };
    expect(macInfoErrors(info)).toEqual([]);
    expect(
      macInfoErrors({
        ...info,
        NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
        NSCameraUsageDescription: 'Electron default'
      })
    ).toEqual([
      'Obsolete macOS metadata is present: NSAppTransportSecurity',
      'Obsolete macOS metadata is present: NSCameraUsageDescription'
    ]);
  });

  it('accepts branded Windows metadata and rejects Electron defaults', () => {
    const info = {
      CompanyName: 'ZakoToys',
      FileDescription: 'DGLab Pulse Hub',
      FileVersion: '0.0.8',
      InternalName: 'DGLab Pulse Hub',
      LegalCopyright: 'Copyright (c) ZakoToys',
      OriginalFilename: 'DGLab Pulse Hub.exe',
      ProductName: 'DGLab Pulse Hub',
      ProductVersion: '0.0.8'
    };
    expect(windowsInfoErrors(info, '0.0.8')).toEqual([]);
    expect(windowsInfoErrors({ ...info, ProductName: 'Electron' }, '0.0.8')).toContain(
      'Invalid Windows metadata ProductName: Electron'
    );
  });

  it('requires built app entries and rejects source leakage in ASAR', () => {
    expect(
      validateAsarEntries([
        '/package.json',
        '/dist/main.js',
        '/dist/preload.cjs',
        '/dist/index.html',
        '/dist/dglab-pulse-hub-icon.png',
        '/dist/renderer.js',
        '/dist/renderer.css',
        '/src/main.ts'
      ])
    ).toEqual(['Source file leaked into ASAR: /src/main.ts']);
  });

  it('accepts ASAR entries returned with Windows path separators', () => {
    expect(
      validateAsarEntries([
        '\\package.json',
        '\\dist\\main.js',
        '\\dist\\preload.cjs',
        '\\dist\\index.html',
        '\\dist\\dglab-pulse-hub-icon.png',
        '\\dist\\renderer.js',
        '\\dist\\renderer.css'
      ])
    ).toEqual([]);
  });
});
