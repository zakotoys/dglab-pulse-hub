import { app, BrowserWindow, Menu, session } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applicationMenuTemplate,
  resolveApplicationLocale,
  type ApplicationLocale
} from './application-menu.js';
import { confirmClose } from './ipc-support.js';
import { DocumentStore } from './document-store.js';
import { registerIpc } from './ipc.js';
import { LocalPulseWorkspace } from './local-workspace.js';
import { relaunchCurrentPortableWindowsApp } from './portable-relaunch.js';

const currentDirectory = fileURLToPath(new URL('.', import.meta.url));
let mainWindow: BrowserWindow | null = null;
const documents = new DocumentStore();

function canClose(): boolean {
  return confirmClose(mainWindow, () => documents.hasUnsavedChanges());
}

function installApplicationMenu(locale: ApplicationLocale): void {
  const menuTemplate = applicationMenuTemplate(process.platform, locale);
  Menu.setApplicationMenu(menuTemplate === null ? null : Menu.buildFromTemplate(menuTemplate));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: join(currentDirectory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Electron's loadFile can reject when the packaged renderer assets are
  // missing. Keep that failure inside the desktop lifecycle instead of
  // producing an unhandled rejection (which also makes startup testable).
  const loadFile = mainWindow.loadFile;
  if (typeof loadFile === 'function') {
    void Promise.resolve(loadFile.call(mainWindow, join(currentDirectory, 'index.html'))).catch(
      () => undefined
    );
  }
  mainWindow.on('close', (event) => {
    if (!canClose()) event.preventDefault();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    documents.clear();
  });
}

function startApplication(): void {
  app.setName('DGLab Pulse Hub');
  app.whenReady().then(() => {
    installApplicationMenu(resolveApplicationLocale(app.getLocale()));
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
              "img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; " +
              "frame-ancestors 'none'"
          ]
        }
      });
    });
    const workspace = new LocalPulseWorkspace(join(app.getPath('documents'), 'Pulse Hub'));
    registerIpc({
      currentDirectory,
      documents,
      workspace,
      confirmClose: canClose,
      updateApplicationMenu: installApplicationMenu
    });
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

if (relaunchCurrentPortableWindowsApp(app, import.meta.url)) app.exit(0);
else startApplication();
