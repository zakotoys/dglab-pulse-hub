import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { inspectPulse, toOperationDto } from '@dglab-pulse-hub/application';
import { operationEnvelopeSchema, type OperationEnvelopeDto } from '@dglab-pulse-hub/contracts';
import { runCli } from '../apps/cli/src/index.js';
import { buildServer } from '../apps/api/src/server.js';

const VALID_TEXT = 'Dungeonlab+pulse:0,1,8=27,7,32,3,1/0-1,50-0,100-1';
const INVALID_TEXT = 'not-a-pulse';

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>();
  const dialog = {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showMessageBoxSync: vi.fn(() => 1)
  };
  const Menu = {
    buildFromTemplate: vi.fn((template: unknown) => template),
    setApplicationMenu: vi.fn()
  };
  class MockBrowserWindow {
    public static getAllWindows = vi.fn(() => []);
    public readonly webContents = {
      setWindowOpenHandler: vi.fn(),
      loadFile: vi.fn()
    };
    public loadFile = vi.fn(() => Promise.resolve());
    public show = vi.fn();
    public once = vi.fn();
    public on = vi.fn();
  }
  return {
    handlers,
    dialog,
    ipcMain: {
      handle: vi.fn(
        (channel: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>) => {
          handlers.set(channel, handler);
        }
      )
    },
    BrowserWindow: MockBrowserWindow,
    Menu,
    app: {
      whenReady: vi.fn(() => Promise.resolve()),
      on: vi.fn(),
      quit: vi.fn(),
      setName: vi.fn(),
      getLocale: vi.fn(() => 'en-US'),
      getPath: vi.fn(() => join(tmpdir(), 'pulse-hub-cross-end-workspace'))
    },
    session: {
      defaultSession: {
        webRequest: { onHeadersReceived: vi.fn() }
      }
    }
  };
});

vi.mock('electron', () => electronMock);

const temporaryDirectories: string[] = [];
const trustedSenderUrl = new URL('../apps/desktop/src/index.html', import.meta.url).toString();
const desktopWorkspace = join(tmpdir(), 'pulse-hub-cross-end-workspace');

async function cliEnvelope(path: string, expectedExitCode: number): Promise<OperationEnvelopeDto> {
  let output = '';
  const code = await runCli(['inspect', path, '--json'], {
    stdout: {
      write: (value: string) => {
        output += value;
      }
    },
    stderr: { write: () => undefined }
  });
  expect(code).toBe(expectedExitCode);
  const value: unknown = JSON.parse(output);
  expect(operationEnvelopeSchema.safeParse(value).success).toBe(true);
  return value as OperationEnvelopeDto;
}

async function httpEnvelope(text: string, displayName: string): Promise<OperationEnvelopeDto> {
  const app = buildServer();
  try {
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/inspect',
      headers: { 'content-type': 'application/json' },
      payload: { text, displayName }
    });
    expect(response.statusCode).toBe(text === VALID_TEXT ? 200 : 422);
    const value: unknown = response.json();
    expect(operationEnvelopeSchema.safeParse(value).success).toBe(true);
    return value as OperationEnvelopeDto;
  } finally {
    await app.close();
  }
}

async function ipcEnvelope(path: string): Promise<OperationEnvelopeDto> {
  const workspaceRoot = join(desktopWorkspace, 'Pulse Hub');
  await mkdir(workspaceRoot, { recursive: true });
  await copyFile(path, join(workspaceRoot, 'sample.pulse'));
  const handler = electronMock.handlers.get('pulse:workspace-open');
  expect(handler).toBeDefined();
  const value: unknown = await handler?.(
    { senderFrame: { url: trustedSenderUrl } },
    { relativePath: 'sample.pulse' }
  );
  expect(operationEnvelopeSchema.safeParse(value).success).toBe(true);
  return value as OperationEnvelopeDto;
}

function directEnvelope(text: string, displayName: string): OperationEnvelopeDto {
  const result = toOperationDto(
    inspectPulse(text, {
      input: { displayName, bytes: Buffer.byteLength(text, 'utf8') }
    })
  );
  expect(operationEnvelopeSchema.safeParse(result).success).toBe(true);
  return result;
}

describe('cross-end operation contract', () => {
  beforeAll(async () => {
    await rm(desktopWorkspace, { recursive: true, force: true });
    await import('../apps/desktop/src/main.js');
    await Promise.resolve();
  });

  afterAll(async () => {
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    }
    await rm(desktopWorkspace, { recursive: true, force: true });
  });

  it.each([
    ['accepted pulse', VALID_TEXT, 0, 200],
    ['rejected pulse', INVALID_TEXT, 2, 422]
  ])(
    'produces the same %s envelope through every entry point',
    async (_label, text, expectedExitCode, expectedHttpStatus) => {
      const directory = await mkdtemp(join(tmpdir(), 'pulse-contract-'));
      temporaryDirectories.push(directory);
      const path = join(directory, 'sample.pulse');
      await writeFile(path, text, 'utf8');

      const direct = directEnvelope(text, 'sample.pulse');
      const cli = await cliEnvelope(path, expectedExitCode);
      const http = await httpEnvelope(text, 'sample.pulse');
      expect(http.status === 'success' ? 200 : 422).toBe(expectedHttpStatus);
      const ipc = await ipcEnvelope(path);

      expect(cli).toEqual(direct);
      expect(http).toEqual(direct);
      expect(ipc).toEqual(direct);
    }
  );
});
