import { extractFile, listPackage } from '@electron/asar';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type DesktopPlatform = 'darwin' | 'win32';
type DesktopArchitecture = 'arm64' | 'x64';

const WINDOWS_RUNTIME_FILES = [
  'DGLab Pulse Hub.exe',
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'd3dcompiler_47.dll',
  'dxcompiler.dll',
  'dxil.dll',
  'ffmpeg.dll',
  'icudtl.dat',
  'locales/en-US.pak',
  'locales/zh-CN.pak',
  'resources.pak',
  'resources/app.asar',
  'snapshot_blob.bin',
  'v8_context_snapshot.bin',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'vulkan-1.dll'
] as const;

const MAC_RUNTIME_FILES = [
  'DGLab Pulse Hub.app/Contents/Info.plist',
  'DGLab Pulse Hub.app/Contents/MacOS/DGLab Pulse Hub',
  'DGLab Pulse Hub.app/Contents/Resources/app.asar',
  'DGLab Pulse Hub.app/Contents/Frameworks/Electron Framework.framework/Versions/A/' +
    'Electron Framework',
  'DGLab Pulse Hub.app/Contents/Frameworks/DGLab Pulse Hub Helper (GPU).app/Contents/MacOS/' +
    'DGLab Pulse Hub Helper (GPU)',
  'DGLab Pulse Hub.app/Contents/Frameworks/DGLab Pulse Hub Helper (Renderer).app/Contents/' +
    'MacOS/DGLab Pulse Hub Helper (Renderer)'
] as const;

const ASAR_RUNTIME_FILES = [
  '/package.json',
  '/dist/main.js',
  '/dist/preload.cjs',
  '/dist/index.html',
  '/dist/renderer.js',
  '/dist/renderer.css'
] as const;

const PE_MACHINES: Readonly<Record<number, DesktopArchitecture>> = {
  0x8664: 'x64',
  0xaa64: 'arm64'
};

const MACH_CPU_TYPES: Readonly<Record<number, DesktopArchitecture>> = {
  0x01000007: 'x64',
  0x0100000c: 'arm64'
};

function binaryArchitecture(bytes: Buffer, platform: DesktopPlatform): DesktopArchitecture {
  if (platform === 'win32') {
    if (bytes.length < 70 || bytes.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('Invalid Windows PE binary.');
    }
    const peOffset = bytes.readUInt32LE(0x3c);
    if (
      peOffset + 6 > bytes.length ||
      bytes.toString('binary', peOffset, peOffset + 4) !== 'PE\0\0'
    ) {
      throw new Error('Invalid Windows PE header.');
    }
    const architecture = PE_MACHINES[bytes.readUInt16LE(peOffset + 4)];
    if (architecture === undefined) throw new Error('Unsupported Windows PE architecture.');
    return architecture;
  }

  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error('Invalid 64-bit macOS Mach-O binary.');
  }
  const architecture = MACH_CPU_TYPES[bytes.readUInt32LE(4)];
  if (architecture === undefined) throw new Error('Unsupported macOS Mach-O architecture.');
  return architecture;
}

export function assertDesktopBinaryArchitecture(
  bytes: Buffer,
  platform: DesktopPlatform,
  expected: DesktopArchitecture
): void {
  const actual = binaryArchitecture(bytes, platform);
  if (actual !== expected)
    throw new Error(`Architecture mismatch: expected ${expected}, found ${actual}.`);
}

export function packageFileErrors(
  platform: DesktopPlatform,
  relativeFiles: ReadonlySet<string>
): string[] {
  const required = platform === 'win32' ? WINDOWS_RUNTIME_FILES : MAC_RUNTIME_FILES;
  return required.filter((file) => !relativeFiles.has(file)).map((file) => `Missing ${file}`);
}

export function validateAsarEntries(entries: readonly string[]): string[] {
  const normalizedEntries = entries.map((entry) => entry.replaceAll('\\', '/'));
  const entrySet = new Set(normalizedEntries);
  const errors = ASAR_RUNTIME_FILES.filter((file) => !entrySet.has(file)).map(
    (file) => `Missing ASAR entry ${file}`
  );
  for (const entry of normalizedEntries) {
    if (/\.(?:d\.ts|map|ts)$/.test(entry) || /^\/(?:src|test)(?:\/|$)/.test(entry)) {
      errors.push(`Source file leaked into ASAR: ${entry}`);
    }
  }
  return errors;
}

async function listRelativeFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listRelativeFiles(root, path)));
    else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
  }
  return files;
}

function binaryPaths(platform: DesktopPlatform, files: readonly string[]): string[] {
  if (platform === 'win32') {
    return files.filter((file) => !file.includes('/') && /\.(?:dll|exe)$/.test(file));
  }
  return MAC_RUNTIME_FILES.filter(
    (file) => file.includes('/MacOS/') || file.endsWith('/Electron Framework')
  );
}

export async function auditDesktopPackage(
  packageDirectory: string,
  platform: DesktopPlatform,
  architecture: DesktopArchitecture,
  expectedVersion: string
): Promise<void> {
  const files = await listRelativeFiles(packageDirectory);
  const errors = packageFileErrors(platform, new Set(files));

  for (const binaryPath of binaryPaths(platform, files)) {
    try {
      assertDesktopBinaryArchitecture(
        await readFile(join(packageDirectory, binaryPath)),
        platform,
        architecture
      );
    } catch (error) {
      errors.push(`${binaryPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const asarPath = join(
    packageDirectory,
    platform === 'win32' ? 'resources/app.asar' : 'DGLab Pulse Hub.app/Contents/Resources/app.asar'
  );
  try {
    errors.push(...validateAsarEntries(listPackage(asarPath)));
    const manifest = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8')) as {
      main?: unknown;
      version?: unknown;
    };
    if (manifest.main !== './dist/main.js')
      errors.push('Packaged manifest has an invalid main entry.');
    if (manifest.version !== expectedVersion) {
      errors.push(`Packaged version is ${String(manifest.version)}, expected ${expectedVersion}.`);
    }
  } catch (error) {
    errors.push(
      `Unable to inspect app.asar: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (errors.length > 0) throw new Error(`Desktop package audit failed:\n- ${errors.join('\n- ')}`);
}

async function main(): Promise<void> {
  const [platform, architecture, packageDirectory] = process.argv.slice(2);
  if (
    (platform !== 'darwin' && platform !== 'win32') ||
    (architecture !== 'arm64' && architecture !== 'x64') ||
    packageDirectory === undefined
  ) {
    throw new Error('Usage: audit-desktop-package <darwin|win32> <arm64|x64> <directory>');
  }
  const rootManifest = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof rootManifest.version !== 'string') throw new Error('Root package version is invalid.');

  await auditDesktopPackage(
    resolve(packageDirectory),
    platform,
    architecture,
    rootManifest.version
  );
  process.stdout.write(
    `Desktop package audit passed: ${basename(packageDirectory)} (${platform}/${architecture})\n`
  );
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  await main();
}
