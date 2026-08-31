import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { operationEnvelopeSchema } from '@dglab-pulse-hub/contracts';

const VALID_TEXT =
  'Dungeonlab+pulse:0,1,8=27,7,32,3,1/0-1,50-0,100-1';
const TRUSTED_URL = new URL('../src/index.html', import.meta.url).toString();

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>();
  const dialog = {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showMessageBoxSync: vi.fn(() => 1)
  };
  const historyReset = vi.fn();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>) => {
      handlers.set(channel, handler);
    })
  };
  class MockBrowserWindow {
    public readonly webContents = {
      setWindowOpenHandler: vi.fn(),
      loadFile: vi.fn(),
      send: historyReset
    };
    public loadFile = vi.fn(() => Promise.resolve());
    public show = vi.fn();
    public once = vi.fn();
    public on = vi.fn();
  }
  return {
    handlers,
    dialog,
    historyReset,
    ipcMain,
    BrowserWindow: MockBrowserWindow,
    app: {
      whenReady: vi.fn(() => Promise.resolve()),
      on: vi.fn()
    },
    session: {
      defaultSession: {
        webRequest: { onHeadersReceived: vi.fn() }
      }
    }
  };
});

vi.mock('electron', () => ({
  app: mocks.app,
  BrowserWindow: mocks.BrowserWindow,
  dialog: mocks.dialog,
  ipcMain: mocks.ipcMain,
  session: mocks.session
}));

const directories: string[] = [];

describe('Electron IPC boundary', () => {
  beforeAll(async () => {
    await import('../src/main.js');
    await Promise.resolve();
  });

  afterAll(async () => {
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns a validated cancellation envelope without source content', async () => {
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const handler = mocks.handlers.get('pulse:open');
    expect(handler).toBeDefined();
    const result = await handler?.({ senderFrame: { url: TRUSTED_URL } });
    expect(operationEnvelopeSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ status: 'cancelled', result: null });
    expect(JSON.stringify(result)).not.toContain('sourceText');
  });

  it('binds export to the opened digest and validates the returned envelope', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-desktop-'));
    directories.push(directory);
    const input = join(directory, 'source.pulse');
    const output = join(directory, 'exported.pulse');
    await writeFile(input, VALID_TEXT, 'utf8');
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [input] });
    const open = mocks.handlers.get('pulse:open');
    const opened = await open?.({ senderFrame: { url: TRUSTED_URL } });
    expect(operationEnvelopeSchema.safeParse(opened).success).toBe(true);
    expect(opened).not.toHaveProperty('sourceText');
    const digest = (opened as { result?: { sourceDigest?: unknown } }).result?.sourceDigest;
    expect(typeof digest).toBe('string');

    mocks.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: output });
    const exportHandler = mocks.handlers.get('pulse:export');
    const exported = await exportHandler?.(
      { senderFrame: { url: TRUSTED_URL } },
      { sourceDigest: digest, displayName: 'out.pulse' }
    );
    expect(operationEnvelopeSchema.safeParse(exported).success).toBe(true);
    expect(exported).toMatchObject({ status: 'success' });
    expect(await readFile(output, 'utf8')).toContain('Dungeonlab+pulse:');
  });

  it('rejects unknown export request fields as a contract-safe envelope', async () => {
    const handler = mocks.handlers.get('pulse:export');
    const result = await handler?.(
      { senderFrame: { url: TRUSTED_URL } },
      { sourceText: VALID_TEXT }
    );
    expect(operationEnvelopeSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ status: 'rejected', result: null });
  });

  it('does not trust file-like remote IPC senders', async () => {
    const handler = mocks.handlers.get('pulse:open');
    await expect(handler?.({ senderFrame: { url: 'file://remote-host/app/index.html' } })).rejects.toThrow(
      'Untrusted IPC sender.'
    );
  });

  it('keeps edit and assist bytes private while refreshing the current snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-desktop-edit-'));
    directories.push(directory);
    const input = join(directory, 'source.pulse');
    await writeFile(input, VALID_TEXT, 'utf8');
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [input] });
    const open = mocks.handlers.get('pulse:open');
    const opened = await open?.({ senderFrame: { url: TRUSTED_URL } });
    const digest = (opened as { result?: { sourceDigest?: unknown } }).result?.sourceDigest;
    expect(typeof digest).toBe('string');
    const edit = mocks.handlers.get('pulse:edit');
    const edited = await edit?.(
      { senderFrame: { url: TRUSTED_URL } },
      { sourceDigest: digest, command: { kind: 'strength', sectionIndex: 0, pointIndex: 1, value: 60 } }
    );
    expect(operationEnvelopeSchema.safeParse(edited).success).toBe(true);
    expect(edited).toMatchObject({ operation: 'edit', status: 'success' });
    expect(JSON.stringify(edited)).not.toContain('Dungeonlab+pulse:');

    const inspect = mocks.handlers.get('pulse:inspect-current');
    const refreshed = await inspect?.({ senderFrame: { url: TRUSTED_URL } });
    expect(refreshed).toMatchObject({ operation: 'inspect', status: 'success' });
    const nextDigest = (refreshed as { result?: { sourceDigest?: unknown } }).result?.sourceDigest;
    expect(nextDigest).not.toBe(digest);

    const assist = mocks.handlers.get('pulse:assist');
    const unreviewed = await assist?.(
      { senderFrame: { url: TRUSTED_URL } },
      { sourceDigest: nextDigest, sectionIndex: 0, startPointIndex: 0, endPointIndex: 2, startStrength: 10, endStrength: 90, reviewed: false }
    );
    expect(unreviewed).toMatchObject({ operation: 'edit', status: 'rejected', result: null });

    const exportHandler = mocks.handlers.get('pulse:export');
    const sourceExport = await exportHandler?.(
      { senderFrame: { url: TRUSTED_URL } },
      { sourceDigest: nextDigest, displayName: 'edited-source.pulse', format: 'pulse-text', mode: 'source' }
    );
    expect(sourceExport).toMatchObject({ operation: 'export', status: 'rejected', result: null });
  });

  it('supports guarded undo/redo history with branch truncation and no byte leakage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-desktop-history-'));
    directories.push(directory);
    const input = join(directory, 'history.pulse');
    await writeFile(input, VALID_TEXT, 'utf8');
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [input] });

    const open = mocks.handlers.get('pulse:open');
    const opened = await open?.({ senderFrame: { url: TRUSTED_URL } });
    const digest0 = (opened as { result?: { sourceDigest?: unknown } }).result?.sourceDigest;
    expect(typeof digest0).toBe('string');

    const edit = mocks.handlers.get('pulse:edit');
    const firstEdit = await edit?.(
      { senderFrame: { url: TRUSTED_URL } },
      { sourceDigest: digest0, command: { kind: 'strength', sectionIndex: 0, pointIndex: 1, value: 60 } }
    );
    expect(firstEdit).toMatchObject({ operation: 'edit', status: 'success' });
    const inspected1 = await mocks.handlers.get('pulse:inspect-current')?.({ senderFrame: { url: TRUSTED_URL } });
    const digest1 = (inspected1 as { result?: { sourceDigest?: unknown } }).result?.sourceDigest;
    const point1 = (inspected1 as { result?: { stream?: { points?: Array<{ intensityDecimal?: string }> } } }).result?.stream?.points?.[1]?.intensityDecimal;
    expect(point1).toBe('60');

    const secondEdit = await edit?.(
      { senderFrame: { url: TRUSTED_URL } },
      { sourceDigest: digest1, command: { kind: 'strength', sectionIndex: 0, pointIndex: 1, value: 70 } }
    );
    expect(secondEdit).toMatchObject({ operation: 'edit', status: 'success' });
    const inspected2 = await mocks.handlers.get('pulse:inspect-current')?.({ senderFrame: { url: TRUSTED_URL } });
    const digest2 = (inspected2 as { result?: { sourceDigest?: unknown } }).result?.sourceDigest;
    expect((inspected2 as { result?: { stream?: { points?: Array<{ intensityDecimal?: string }> } } }).result?.stream?.points?.[1]?.intensityDecimal).toBe('70');

    const undo = mocks.handlers.get('pulse:undo');
    const undone = await undo?.({ senderFrame: { url: TRUSTED_URL } }, { sourceDigest: digest2 });
    expect(operationEnvelopeSchema.safeParse(undone).success).toBe(true);
    expect(undone).toMatchObject({ operation: 'undo', status: 'success' });
    expect(JSON.stringify(undone)).not.toContain('Dungeonlab+pulse:');
    expect((undone as { result?: { sourceDigest?: unknown; stream?: { points?: Array<{ intensityDecimal?: string }> } } }).result?.sourceDigest).toBe(digest1);
    expect((undone as { result?: { stream?: { points?: Array<{ intensityDecimal?: string }> } } }).result?.stream?.points?.[1]?.intensityDecimal).toBe('60');

    const redo = mocks.handlers.get('pulse:redo');
    const redone = await redo?.({ senderFrame: { url: TRUSTED_URL } }, { sourceDigest: digest1 });
    expect(redone).toMatchObject({ operation: 'redo', status: 'success' });
    expect((redone as { result?: { sourceDigest?: unknown } }).result?.sourceDigest).toBe(digest2);

    const backAgain = await undo?.({ senderFrame: { url: TRUSTED_URL } }, { sourceDigest: digest2 });
    expect(backAgain).toMatchObject({ operation: 'undo', status: 'success' });
    const branchBase = (backAgain as { result?: { sourceDigest?: unknown } }).result?.sourceDigest;
    const branchEdit = await edit?.(
      { senderFrame: { url: TRUSTED_URL } },
      { sourceDigest: branchBase, command: { kind: 'strength', sectionIndex: 0, pointIndex: 1, value: 80 } }
    );
    expect(branchEdit).toMatchObject({ operation: 'edit', status: 'success' });
    const branched = await mocks.handlers.get('pulse:inspect-current')?.({ senderFrame: { url: TRUSTED_URL } });
    const branchDigest = (branched as { result?: { sourceDigest?: unknown } }).result?.sourceDigest;
    expect((branched as { result?: { stream?: { points?: Array<{ intensityDecimal?: string }> } } }).result?.stream?.points?.[1]?.intensityDecimal).toBe('80');

    const staleRedo = await redo?.({ senderFrame: { url: TRUSTED_URL } }, { sourceDigest: branchDigest });
    expect(staleRedo).toMatchObject({ operation: 'redo', status: 'rejected', result: null });
    const staleUndo = await undo?.({ senderFrame: { url: TRUSTED_URL } }, { sourceDigest: digest2 });
    expect(staleUndo).toMatchObject({ operation: 'undo', status: 'rejected', result: null });

    const toOriginal = await undo?.({ senderFrame: { url: TRUSTED_URL } }, { sourceDigest: branchDigest });
    expect(toOriginal).toMatchObject({ operation: 'undo', status: 'success' });
    const originalAgain = (toOriginal as { result?: { sourceDigest?: unknown } }).result?.sourceDigest;
    expect(originalAgain).toBe(digest1);
    const toInitial = await undo?.({ senderFrame: { url: TRUSTED_URL } }, { sourceDigest: originalAgain });
    expect(toInitial).toMatchObject({ operation: 'undo', status: 'success' });
    const noEarlier = await undo?.(
      { senderFrame: { url: TRUSTED_URL } },
      { sourceDigest: (toInitial as { result?: { sourceDigest?: unknown } }).result?.sourceDigest }
    );
    expect(noEarlier).toMatchObject({ operation: 'undo', status: 'rejected', result: null });
  });

  it('still confirms closing after the renderer clears its explicit dirty flag', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-desktop-close-'));
    directories.push(directory);
    const input = join(directory, 'source.pulse');
    await writeFile(input, VALID_TEXT, 'utf8');
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [input] });
    const open = mocks.handlers.get('pulse:open');
    const opened = await open?.({ senderFrame: { url: TRUSTED_URL } });
    const digest = (opened as { result?: { sourceDigest?: unknown } }).result?.sourceDigest;
    expect(typeof digest).toBe('string');

    const edit = mocks.handlers.get('pulse:edit');
    const edited = await edit?.(
      { senderFrame: { url: TRUSTED_URL } },
      { sourceDigest: digest, command: { kind: 'strength', sectionIndex: 0, pointIndex: 1, value: 61 } }
    );
    expect(edited).toMatchObject({ operation: 'edit', status: 'success' });

    const markDirty = mocks.handlers.get('pulse:mark-dirty');
    await markDirty?.({ senderFrame: { url: TRUSTED_URL } }, { dirty: false });
    mocks.dialog.showMessageBoxSync.mockReturnValueOnce(0);
    mocks.dialog.showOpenDialog.mockClear();
    const attemptedOpen = await open?.({ senderFrame: { url: TRUSTED_URL } });
    expect(attemptedOpen).toMatchObject({ operation: 'inspect', status: 'cancelled', result: null });
    expect(mocks.dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it('refuses QR export to the opened source path without changing source bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-desktop-qr-source-'));
    directories.push(directory);
    const input = join(directory, 'source.pulse');
    await writeFile(input, VALID_TEXT, 'utf8');
    const before = await readFile(input);
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [input] });
    const open = mocks.handlers.get('pulse:open');
    const opened = await open?.({ senderFrame: { url: TRUSTED_URL } });
    const digest = (opened as { result?: { sourceDigest?: unknown } }).result?.sourceDigest;
    expect(typeof digest).toBe('string');

    mocks.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: input });
    const exportHandler = mocks.handlers.get('pulse:export');
    const exported = await exportHandler?.(
      { senderFrame: { url: TRUSTED_URL } },
      { sourceDigest: digest, format: 'qr-envelope', displayName: 'source.txt' }
    );
    expect(exported).toMatchObject({ operation: 'export', status: 'rejected', result: null });
    expect((exported as { diagnostics?: readonly { code: string }[] }).diagnostics?.some((item) => item.code === 'PULSE_EXPORT_BLOCKED')).toBe(true);
    expect(await readFile(input)).toEqual(before);
  });

  it('refreshes snapshots after a confirmed pulse-text source overwrite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-desktop-overwrite-'));
    directories.push(directory);
    const input = join(directory, 'source.pulse');
    await writeFile(input, VALID_TEXT, 'utf8');
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [input] });
    const open = mocks.handlers.get('pulse:open');
    const opened = await open?.({ senderFrame: { url: TRUSTED_URL } });
    const digest = (opened as { result?: { sourceDigest?: unknown } }).result?.sourceDigest;
    const edit = mocks.handlers.get('pulse:edit');
    const edited = await edit?.(
      { senderFrame: { url: TRUSTED_URL } },
      { sourceDigest: digest, command: { kind: 'strength', sectionIndex: 0, pointIndex: 1, value: 62 } }
    );
    expect(edited).toMatchObject({ operation: 'edit', status: 'success' });
    const editedSnapshot = await mocks.handlers.get('pulse:inspect-current')?.({ senderFrame: { url: TRUSTED_URL } });
    const editedDigest = (editedSnapshot as { result?: { sourceDigest?: unknown } }).result?.sourceDigest;
    expect(typeof editedDigest).toBe('string');

    mocks.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: input });
    mocks.dialog.showMessageBoxSync.mockReturnValueOnce(1);
    mocks.historyReset.mockClear();
    const exportHandler = mocks.handlers.get('pulse:export');
    const exported = await exportHandler?.(
      { senderFrame: { url: TRUSTED_URL } },
      { sourceDigest: editedDigest, format: 'pulse-text', mode: 'canonical', displayName: 'source.pulse' }
    );
    expect(exported).toMatchObject({ operation: 'export', status: 'success' });
    expect(mocks.historyReset).toHaveBeenCalledWith(
      'pulse:history-reset',
      expect.objectContaining({ operation: 'inspect', status: 'success' })
    );
    expect(JSON.stringify(mocks.historyReset.mock.calls[0]?.[1])).not.toContain(VALID_TEXT);
    const inspected = await mocks.handlers.get('pulse:inspect-current')?.({ senderFrame: { url: TRUSTED_URL } });
    expect(inspected).toMatchObject({ operation: 'inspect', status: 'success' });
    const refreshedDigest = (inspected as { result?: { sourceDigest?: unknown } }).result?.sourceDigest;
    expect(typeof refreshedDigest).toBe('string');
    const undoAfterSave = await mocks.handlers.get('pulse:undo')?.(
      { senderFrame: { url: TRUSTED_URL } },
      { sourceDigest: refreshedDigest }
    );
    expect(undoAfterSave).toMatchObject({ operation: 'undo', status: 'rejected', result: null });
    mocks.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: join(directory, 'copy.pulse') });
    const sourceMode = await exportHandler?.(
      { senderFrame: { url: TRUSTED_URL } },
      { sourceDigest: refreshedDigest, format: 'pulse-text', mode: 'source', displayName: 'copy.pulse' }
    );
    expect(sourceMode).toMatchObject({ operation: 'export', status: 'success' });
  });

  it('renders SVG, PNG, and JPG previews from the current snapshot without exposing bytes or paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-desktop-preview-'));
    directories.push(directory);
    const input = join(directory, 'source.pulse');
    await writeFile(input, VALID_TEXT, 'utf8');
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [input] });
    const open = mocks.handlers.get('pulse:open');
    const opened = await open?.({ senderFrame: { url: TRUSTED_URL } });
    const digest = (opened as { result?: { sourceDigest?: unknown } }).result?.sourceDigest;
    expect(typeof digest).toBe('string');
    const streamDigest = (opened as { result?: { stream?: { digest?: unknown } } }).result?.stream?.digest;
    expect(typeof streamDigest).toBe('string');
    const render = mocks.handlers.get('pulse:render-preview');
    expect(render).toBeDefined();
    for (const format of ['svg', 'png', 'jpg'] as const) {
      const output = join(directory, 'preview.' + format);
      mocks.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: output });
      const result = await render?.(
        { senderFrame: { url: TRUSTED_URL } },
        { sourceDigest: digest, displayName: 'source.pulse', format }
      );
      expect(operationEnvelopeSchema.safeParse(result).success).toBe(true);
      expect(result).toMatchObject({ operation: 'render', status: 'success' });
      const metadata = (result as { result?: Record<string, unknown> }).result;
      expect(metadata).toMatchObject({ format, streamDigest });
      expect(metadata).not.toHaveProperty('bytes');
      expect(metadata).not.toHaveProperty('path');
      expect(JSON.stringify(result)).not.toContain(VALID_TEXT);
      const bytes = await readFile(output);
      expect(bytes.byteLength).toBeGreaterThan(16);
      if (format === 'svg') {
        expect(bytes.toString('utf8')).toContain('<svg');
      } else if (format === 'png') {
        expect([...bytes.subarray(0, 4)]).toEqual([137, 80, 78, 71]);
      } else {
        expect([...bytes.subarray(0, 2)]).toEqual([255, 216]);
      }
    }
  });

  it('fails closed for unsupported, cancelled, and conflicting preview exports', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-desktop-preview-failure-'));
    directories.push(directory);
    const input = join(directory, 'source.pulse');
    await writeFile(input, VALID_TEXT, 'utf8');
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [input] });
    const open = mocks.handlers.get('pulse:open');
    const opened = await open?.({ senderFrame: { url: TRUSTED_URL } });
    const digest = (opened as { result?: { sourceDigest?: unknown } }).result?.sourceDigest;
    const render = mocks.handlers.get('pulse:render-preview');
    const unsupported = await render?.(
      { senderFrame: { url: TRUSTED_URL } },
      { sourceDigest: digest, format: 'bmp' }
    );
    expect(unsupported).toMatchObject({ operation: 'render', status: 'rejected', result: null });
    mocks.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: undefined });
    const cancelled = await render?.(
      { senderFrame: { url: TRUSTED_URL } },
      { sourceDigest: digest, format: 'svg' }
    );
    expect(cancelled).toMatchObject({ operation: 'render', status: 'cancelled', result: null });
    const conflict = join(directory, 'existing.svg');
    await writeFile(conflict, 'keep', 'utf8');
    mocks.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: conflict });
    const conflicted = await render?.(
      { senderFrame: { url: TRUSTED_URL } },
      { sourceDigest: digest, format: 'svg' }
    );
    expect(operationEnvelopeSchema.safeParse(conflicted).success).toBe(true);
    expect(conflicted).toMatchObject({ operation: 'render', status: 'rejected', result: null });
    expect(await readFile(conflict, 'utf8')).toBe('keep');
  });

  it('returns contract-safe diff and batch results through the local adapter', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-desktop-batch-'));
    directories.push(directory);
    const first = join(directory, 'one.pulse');
    const second = join(directory, 'two.pulse');
    await writeFile(first, VALID_TEXT, 'utf8');
    await writeFile(second, VALID_TEXT.replace('50-0', '42-0'), 'utf8');

    const open = mocks.handlers.get('pulse:open');
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [first] });
    const opened = await open?.({ senderFrame: { url: TRUSTED_URL } });
    const digest = (opened as { result?: { sourceDigest?: unknown } }).result?.sourceDigest;

    const diff = mocks.handlers.get('pulse:diff');
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [second] });
    const compared = await diff?.({ senderFrame: { url: TRUSTED_URL } }, { sourceDigest: digest });
    expect(operationEnvelopeSchema.safeParse(compared).success).toBe(true);
    expect(compared).toMatchObject({ operation: 'diff', status: 'success' });
    expect(JSON.stringify(compared)).not.toContain(VALID_TEXT);

    const batchInspect = mocks.handlers.get('pulse:batch-inspect');
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [first, second] });
    const batch = await batchInspect?.({ senderFrame: { url: TRUSTED_URL } });
    expect(operationEnvelopeSchema.safeParse(batch).success).toBe(true);
    expect(batch).toMatchObject({ operation: 'batch', status: 'success' });
    expect((batch as { result?: { items?: unknown[] } }).result?.items).toHaveLength(2);

    const batchExport = mocks.handlers.get('pulse:batch-export');
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [first] });
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [directory] });
    const exported = await batchExport?.({ senderFrame: { url: TRUSTED_URL } }, { mode: 'canonical', overwrite: true });
    expect(operationEnvelopeSchema.safeParse(exported).success).toBe(true);
    expect(exported).toMatchObject({ operation: 'batch', status: 'success' });
  });

  it('uses the batch operation name when batch selection is cancelled', async () => {
    const batchInspect = mocks.handlers.get('pulse:batch-inspect');
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const inspected = await batchInspect?.({ senderFrame: { url: TRUSTED_URL } });
    expect(inspected).toMatchObject({ operation: 'batch', status: 'cancelled', result: null });

    const batchExport = mocks.handlers.get('pulse:batch-export');
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const exported = await batchExport?.({ senderFrame: { url: TRUSTED_URL } }, {});
    expect(exported).toMatchObject({ operation: 'batch', status: 'cancelled', result: null });
    expect(operationEnvelopeSchema.safeParse(inspected).success).toBe(true);
    expect(operationEnvelopeSchema.safeParse(exported).success).toBe(true);
  });

  it('rejects a non-boolean batch overwrite flag before opening files', async () => {
    const batchExport = mocks.handlers.get('pulse:batch-export');
    mocks.dialog.showOpenDialog.mockClear();
    const rejected = await batchExport?.(
      { senderFrame: { url: TRUSTED_URL } },
      { overwrite: 'yes' }
    );
    expect(operationEnvelopeSchema.safeParse(rejected).success).toBe(true);
    expect(rejected).toMatchObject({ operation: 'batch', status: 'rejected', result: null });
    expect(mocks.dialog.showOpenDialog).not.toHaveBeenCalled();
  });
});
