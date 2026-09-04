import { extractFile, listPackage } from '@electron/asar';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import * as PeLibrary from 'pe-library';
import * as ResEdit from 'resedit';

type DesktopPlatform = 'darwin' | 'linux' | 'win32';
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
  'DGLab Pulse Hub.app/Contents/Resources/dglab-pulse-hub-icon.icns',
  'DGLab Pulse Hub.app/Contents/Frameworks/Electron Framework.framework/Versions/A/' +
    'Electron Framework',
  'DGLab Pulse Hub.app/Contents/Frameworks/DGLab Pulse Hub Helper (GPU).app/Contents/MacOS/' +
    'DGLab Pulse Hub Helper (GPU)',
  'DGLab Pulse Hub.app/Contents/Frameworks/DGLab Pulse Hub Helper (Renderer).app/Contents/' +
    'MacOS/DGLab Pulse Hub Helper (Renderer)'
] as const;

const LINUX_RUNTIME_FILES = [
  'chrome-sandbox',
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'chrome_crashpad_handler',
  'icudtl.dat',
  'libffmpeg.so',
  'libvk_swiftshader.so',
  'libvulkan.so.1',
  'locales/en-US.pak',
  'locales/zh-CN.pak',
  'resources.pak',
  'resources/app.asar',
  'snapshot_blob.bin',
  'v8_context_snapshot.bin',
  'vk_swiftshader_icd.json'
] as const;

const ASAR_RUNTIME_FILES = [
  '/package.json',
  '/dist/main.js',
  '/dist/preload.cjs',
  '/dist/index.html',
  '/dist/dglab-pulse-hub-icon.png',
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

const ELF_MACHINES: Readonly<Record<number, DesktopArchitecture>> = {
  0x3e: 'x64',
  0xb7: 'arm64'
};

const execFileAsync = promisify(execFile);
const OBSOLETE_MAC_METADATA_KEYS = [
  'NSAppTransportSecurity',
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription'
] as const;

export function macInfoErrors(info: Readonly<Record<string, unknown>>): string[] {
  const expected = {
    CFBundleDisplayName: 'DGLab Pulse Hub',
    CFBundleExecutable: 'DGLab Pulse Hub',
    CFBundleIconFile: 'dglab-pulse-hub-icon.icns',
    CFBundleIdentifier: 'com.zakotoys.dglab-pulse-hub',
    CFBundleName: 'DGLab Pulse Hub',
    LSApplicationCategoryType: 'public.app-category.utilities',
    NSHumanReadableCopyright: 'Copyright (c) ZakoToys'
  } as const;
  const errors: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    if (info[key] !== value) errors.push(`Invalid macOS metadata ${key}: ${String(info[key])}`);
  }
  for (const key of OBSOLETE_MAC_METADATA_KEYS) {
    if (key in info) errors.push(`Obsolete macOS metadata is present: ${key}`);
  }
  return errors;
}

export function windowsInfoErrors(
  info: Readonly<Record<string, unknown>>,
  expectedVersion: string
): string[] {
  const expected = {
    CompanyName: 'ZakoToys',
    FileDescription: 'DGLab Pulse Hub',
    FileVersion: expectedVersion,
    InternalName: 'DGLab Pulse Hub',
    LegalCopyright: 'Copyright (c) ZakoToys',
    OriginalFilename: 'DGLab Pulse Hub.exe',
    ProductName: 'DGLab Pulse Hub',
    ProductVersion: expectedVersion
  };
  return Object.entries(expected)
    .filter(([key, value]) => info[key] !== value)
    .map(([key]) => `Invalid Windows metadata ${key}: ${String(info[key])}`);
}

function iconDigest(item: {
  readonly bin?: ArrayBuffer;
  generate?: () => ArrayBuffer;
  isRaw: () => boolean;
}): string {
  const bytes = item.isRaw() ? item.bin : item.generate?.();
  if (bytes === undefined) throw new Error('Invalid icon resource.');
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

  if (platform === 'linux') {
    if (
      bytes.length < 20 ||
      !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      bytes[4] !== 2 ||
      bytes[5] !== 1
    ) {
      throw new Error('Invalid 64-bit little-endian Linux ELF binary.');
    }
    const architecture = ELF_MACHINES[bytes.readUInt16LE(18)];
    if (architecture === undefined) throw new Error('Unsupported Linux ELF architecture.');
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
  const required =
    platform === 'win32'
      ? WINDOWS_RUNTIME_FILES
      : platform === 'darwin'
        ? MAC_RUNTIME_FILES
        : LINUX_RUNTIME_FILES;
  const errors = required
    .filter((file) => !relativeFiles.has(file))
    .map((file) => `Missing ${file}`);
  if (
    platform === 'linux' &&
    !relativeFiles.has('DGLab Pulse Hub') &&
    !relativeFiles.has('dglab-pulse-hub')
  ) {
    errors.push('Missing Linux application executable');
  }
  if (
    platform === 'darwin' &&
    relativeFiles.has('DGLab Pulse Hub.app/Contents/Resources/electron.icns')
  ) {
    errors.push('Obsolete Electron icon resource is present.');
  }
  return errors;
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
  if (platform === 'linux') {
    return files.filter(
      (file) =>
        !file.includes('/') &&
        (file === 'DGLab Pulse Hub' ||
          file === 'dglab-pulse-hub' ||
          file === 'chrome-sandbox' ||
          file === 'chrome_crashpad_handler' ||
          /\.so(?:\.\d+)*$/.test(file))
    );
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
    platform === 'darwin' ? 'DGLab Pulse Hub.app/Contents/Resources/app.asar' : 'resources/app.asar'
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

  if (platform === 'darwin') {
    const infoPath = join(packageDirectory, 'DGLab Pulse Hub.app', 'Contents', 'Info.plist');
    try {
      const { stdout } = await execFileAsync('plutil', ['-convert', 'json', '-o', '-', infoPath]);
      errors.push(...macInfoErrors(JSON.parse(stdout) as Record<string, unknown>));
    } catch (error) {
      errors.push(`Unable to inspect macOS metadata: ${errorMessage(error)}`);
    }
  }

  if (platform === 'win32') {
    try {
      const executable = PeLibrary.NtExecutable.from(
        await readFile(join(packageDirectory, 'DGLab Pulse Hub.exe'))
      );
      const resources = PeLibrary.NtExecutableResource.from(executable);
      const versionInfo = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)[0];
      const language = versionInfo?.getAllLanguagesForStringValues()[0];
      if (versionInfo === undefined || language === undefined) {
        errors.push('Windows version metadata is missing.');
      } else {
        errors.push(...windowsInfoErrors(versionInfo.getStringValues(language), expectedVersion));
      }

      const sourceIcon = ResEdit.Data.IconFile.from(
        await readFile(resolve('apps/desktop/assets/dglab-pulse-hub-icon.ico'))
      );
      const iconGroup = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)[0];
      if (iconGroup === undefined) {
        errors.push('Windows executable icon is missing.');
      } else {
        const expectedIcons = sourceIcon.icons.map(({ data }) => iconDigest(data));
        const embeddedIcons = iconGroup.getIconItemsFromEntries(resources.entries).map(iconDigest);
        if (JSON.stringify(embeddedIcons) !== JSON.stringify(expectedIcons)) {
          errors.push('Windows executable icon does not match the project icon.');
        }
      }
    } catch (error) {
      errors.push(`Unable to inspect Windows branding: ${errorMessage(error)}`);
    }
  }

  if (errors.length > 0) throw new Error(`Desktop package audit failed:\n- ${errors.join('\n- ')}`);
}

async function main(): Promise<void> {
  const [platform, architecture, packageDirectory] = process.argv.slice(2);
  if (
    (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') ||
    (architecture !== 'arm64' && architecture !== 'x64') ||
    packageDirectory === undefined
  ) {
    throw new Error('Usage: audit-desktop-package <darwin|linux|win32> <arm64|x64> <directory>');
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
