import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { win32 } from 'node:path';

interface PackagedApp {
  readonly isPackaged: boolean;
  getVersion(): string;
}

interface RelaunchedProcess {
  unref(): void;
}

interface LaunchOptions {
  readonly cwd: string;
  readonly detached: true;
  readonly stdio: 'ignore';
  readonly windowsHide: false;
}

interface PortableRelaunchFileSystem {
  existsSync(path: string): boolean;
  readFileSync(path: string): Uint8Array;
  rmSync(path: string, options: { readonly recursive: true; readonly force: true }): void;
  cpSync(source: string, destination: string, options: { readonly recursive: true }): void;
  writeFileSync(path: string, contents: string): void;
}

export interface PortableRelaunchOperations {
  exists(path: string): boolean;
  readFile(path: string): Uint8Array;
  removeDirectory(path: string): void;
  copyDirectory(source: string, destination: string): void;
  writeFile(path: string, contents: string): void;
  launch(executable: string, options: LaunchOptions): RelaunchedProcess;
}

interface PortableRelaunchContext {
  readonly platform: NodeJS.Platform;
  readonly moduleUrl: string;
  readonly executablePath: string;
  readonly resourcesPath: string;
  readonly localAppData: string | undefined;
  readonly operations?: PortableRelaunchOperations;
}

export function createPortableRelaunchOperations(
  fileSystem: PortableRelaunchFileSystem,
  launch: (executable: string, options: LaunchOptions) => RelaunchedProcess
): PortableRelaunchOperations {
  return {
    exists: (path) => fileSystem.existsSync(path),
    readFile: (path) => fileSystem.readFileSync(path),
    removeDirectory: (path) => fileSystem.rmSync(path, { recursive: true, force: true }),
    copyDirectory: (source, destination) =>
      fileSystem.cpSync(source, destination, { recursive: true }),
    writeFile: (path, contents) => fileSystem.writeFileSync(path, contents),
    launch
  };
}

function defaultOperations(): PortableRelaunchOperations {
  // Electron's patched fs treats app.asar as a directory. The relocation needs
  // the archive itself, so all copy and verification work must use original-fs.
  const require = createRequire(import.meta.url);
  const fileSystem = require('original-fs') as PortableRelaunchFileSystem;
  return createPortableRelaunchOperations(fileSystem, (executable, options) =>
    spawn(executable, [], options)
  );
}

export function isParallelsSharedPath(path: string): boolean {
  if (/^file:\/\/(?:psf|mac)\//i.test(path)) return true;
  const normalized = path.replaceAll('/', '\\').toLowerCase();
  return (
    normalized.startsWith('\\\\psf\\') ||
    normalized.startsWith('\\\\mac\\') ||
    /^[a-z]:\\mac\\home(?:\\|$)/.test(normalized)
  );
}

function digest(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

export function relaunchPortableWindowsApp(
  app: PackagedApp,
  context: PortableRelaunchContext
): boolean {
  if (
    context.platform !== 'win32' ||
    !app.isPackaged ||
    ![context.moduleUrl, context.executablePath].some(isParallelsSharedPath)
  ) {
    return false;
  }
  if (
    context.localAppData === undefined ||
    !/^[a-z]:\\/i.test(context.localAppData) ||
    isParallelsSharedPath(context.localAppData)
  ) {
    throw new Error('LOCALAPPDATA must be a local Windows path.');
  }

  const operations = context.operations ?? defaultOperations();
  const sourceRoot = win32.dirname(context.executablePath);
  const sourceAsar = win32.join(context.resourcesPath, 'app.asar');
  const sourceDigest = digest(operations.readFile(sourceAsar));
  const destinationRoot = win32.join(
    context.localAppData,
    'DGLabPulseHub',
    'portable',
    `${app.getVersion()}-${sourceDigest.slice(0, 12)}`
  );
  const destinationExecutable = win32.join(destinationRoot, win32.basename(context.executablePath));
  const destinationAsar = win32.join(destinationRoot, 'resources', 'app.asar');
  const readyMarker = win32.join(destinationRoot, '.ready');

  let localCopyIsValid = false;
  if (operations.exists(readyMarker)) {
    try {
      localCopyIsValid = digest(operations.readFile(destinationAsar)) === sourceDigest;
    } catch {
      localCopyIsValid = false;
    }
  }

  if (!localCopyIsValid) {
    operations.removeDirectory(destinationRoot);
    operations.copyDirectory(sourceRoot, destinationRoot);
    if (digest(operations.readFile(destinationAsar)) !== sourceDigest) {
      operations.removeDirectory(destinationRoot);
      throw new Error('The local portable application copy failed verification.');
    }
    operations.writeFile(readyMarker, sourceDigest);
  }

  const child = operations.launch(destinationExecutable, {
    cwd: destinationRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();
  return true;
}

export function relaunchCurrentPortableWindowsApp(app: PackagedApp, moduleUrl: string): boolean {
  return relaunchPortableWindowsApp(app, {
    platform: process.platform,
    moduleUrl,
    executablePath: process.execPath,
    resourcesPath: process.resourcesPath,
    localAppData: process.env.LOCALAPPDATA
  });
}
