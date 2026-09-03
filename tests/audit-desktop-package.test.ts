import { describe, expect, it } from 'vitest';
import {
  assertDesktopBinaryArchitecture,
  packageFileErrors,
  validateAsarEntries
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

  it('reports missing platform runtime files', () => {
    expect(packageFileErrors('win32', new Set(['DGLab Pulse Hub.exe']))).toContain(
      'Missing resources/app.asar'
    );
  });

  it('requires built app entries and rejects source leakage in ASAR', () => {
    expect(
      validateAsarEntries([
        '/package.json',
        '/dist/main.js',
        '/dist/preload.cjs',
        '/dist/index.html',
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
        '\\dist\\renderer.js',
        '\\dist\\renderer.css'
      ])
    ).toEqual([]);
  });
});
