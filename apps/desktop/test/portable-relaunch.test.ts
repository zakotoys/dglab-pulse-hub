import { describe, expect, it, vi } from 'vitest';
import {
  createPortableRelaunchOperations,
  isParallelsSharedPath,
  relaunchPortableWindowsApp,
  type PortableRelaunchOperations
} from '../src/portable-relaunch.js';

describe('portable Windows relaunch', () => {
  it('uses one raw filesystem implementation for archive verification and copying', () => {
    const fileSystem = {
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => Buffer.from('asar')),
      rmSync: vi.fn(),
      cpSync: vi.fn(),
      writeFileSync: vi.fn()
    };
    const launch = vi.fn(() => ({ unref: vi.fn() }));
    const operations = createPortableRelaunchOperations(fileSystem, launch);

    operations.exists('ready');
    operations.readFile('resources\\app.asar');
    operations.removeDirectory('destination');
    operations.copyDirectory('source', 'destination');
    operations.writeFile('ready', 'digest');
    operations.launch('app.exe', {
      cwd: 'destination',
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });

    expect(fileSystem.existsSync).toHaveBeenCalledWith('ready');
    expect(fileSystem.readFileSync).toHaveBeenCalledWith('resources\\app.asar');
    expect(fileSystem.rmSync).toHaveBeenCalledWith('destination', {
      recursive: true,
      force: true
    });
    expect(fileSystem.cpSync).toHaveBeenCalledWith('source', 'destination', { recursive: true });
    expect(fileSystem.writeFileSync).toHaveBeenCalledWith('ready', 'digest');
    expect(launch).toHaveBeenCalledWith('app.exe', expect.objectContaining({ detached: true }));
  });

  it.each([
    'file://psf/Home/Downloads/app/resources/app.asar/dist/main.js',
    '\\\\Mac\\Home\\Downloads\\app\\DGLab Pulse Hub.exe',
    'C:\\Mac\\Home\\Downloads\\app\\DGLab Pulse Hub.exe'
  ])('recognizes a Parallels shared path: %s', (path) => {
    expect(isParallelsSharedPath(path)).toBe(true);
  });

  it.each([
    'C:\\Program Files\\DGLab Pulse Hub\\DGLab Pulse Hub.exe',
    'C:\\Users\\rem\\AppData\\Local\\DGLabPulseHub\\portable\\app.exe'
  ])('keeps a local Windows path in place: %s', (path) => {
    expect(isParallelsSharedPath(path)).toBe(false);
  });

  it('copies, verifies, and launches a shared packaged app from LOCALAPPDATA', () => {
    const unref = vi.fn();
    const operations: PortableRelaunchOperations = {
      exists: vi.fn(() => false),
      readFile: vi.fn(() => Buffer.from('packaged app')),
      removeDirectory: vi.fn(),
      copyDirectory: vi.fn(),
      writeFile: vi.fn(),
      launch: vi.fn(() => ({ unref }))
    };

    const relaunched = relaunchPortableWindowsApp(
      { isPackaged: true, getVersion: () => '0.0.6' },
      {
        platform: 'win32',
        moduleUrl: 'file://psf/Home/Downloads/app/resources/app.asar/dist/main.js',
        executablePath: 'C:\\Mac\\Home\\Downloads\\app\\DGLab Pulse Hub.exe',
        resourcesPath: 'C:\\Mac\\Home\\Downloads\\app\\resources',
        localAppData: 'C:\\Users\\rem\\AppData\\Local',
        operations
      }
    );

    expect(relaunched).toBe(true);
    expect(operations.copyDirectory).toHaveBeenCalledWith(
      'C:\\Mac\\Home\\Downloads\\app',
      expect.stringMatching(
        /^C:\\Users\\rem\\AppData\\Local\\DGLabPulseHub\\portable\\0\.0\.6-[a-f0-9]{12}$/
      )
    );
    expect(operations.launch).toHaveBeenCalledWith(
      expect.stringMatching(/\\DGLab Pulse Hub\.exe$/),
      expect.objectContaining({ detached: true })
    );
    expect(unref).toHaveBeenCalledOnce();
  });

  it('does nothing outside a packaged Windows app on a shared path', () => {
    const operations = {
      exists: vi.fn(),
      readFile: vi.fn(),
      removeDirectory: vi.fn(),
      copyDirectory: vi.fn(),
      writeFile: vi.fn(),
      launch: vi.fn()
    };

    expect(
      relaunchPortableWindowsApp(
        { isPackaged: false, getVersion: () => '0.0.6' },
        {
          platform: 'win32',
          moduleUrl: 'file://psf/Home/app/main.js',
          executablePath: 'C:\\Mac\\Home\\app.exe',
          resourcesPath: 'C:\\Mac\\Home\\resources',
          localAppData: 'C:\\Users\\rem\\AppData\\Local',
          operations
        }
      )
    ).toBe(false);
    expect(operations.readFile).not.toHaveBeenCalled();
  });

  it('verifies a cached local copy before reusing it', () => {
    const operations: PortableRelaunchOperations = {
      exists: vi.fn(() => true),
      readFile: vi.fn(() => Buffer.from('same packaged app')),
      removeDirectory: vi.fn(),
      copyDirectory: vi.fn(),
      writeFile: vi.fn(),
      launch: vi.fn(() => ({ unref: vi.fn() }))
    };

    expect(
      relaunchPortableWindowsApp(
        { isPackaged: true, getVersion: () => '0.0.6' },
        {
          platform: 'win32',
          moduleUrl: 'file://psf/Home/Downloads/app/resources/app.asar/dist/main.js',
          executablePath: 'C:\\Mac\\Home\\Downloads\\app\\DGLab Pulse Hub.exe',
          resourcesPath: 'C:\\Mac\\Home\\Downloads\\app\\resources',
          localAppData: 'C:\\Users\\rem\\AppData\\Local',
          operations
        }
      )
    ).toBe(true);
    expect(operations.readFile).toHaveBeenCalledTimes(2);
    expect(operations.copyDirectory).not.toHaveBeenCalled();
  });
});
