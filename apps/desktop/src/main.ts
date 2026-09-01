import { app, BrowserWindow, dialog, ipcMain, session, type SaveDialogOptions } from 'electron';
import { join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyPulseAssist,
  applyPulseEdit,
  atomicWriteFile,
  decodeQr,
  diffPulses,
  exportBatch,
  exportPulse,
  inspectBatch,
  inspectPulse,
  operationResult,
  readInputFile,
  renderPreviewImage,
  sanitizeDisplayName,
  toOperationDto,
  type AssistOptions,
  type BatchData,
  type BatchExportInput,
  type BatchInput,
  type EditCommand,
  type EditData,
  type ExportData,
  type InspectData,
  type OperationResult
} from '@dglab-pulse-hub/application';
import {
  DIAGNOSTIC_CODES,
  normalizeDecimal,
  location,
  makeDiagnostic,
  sourceSpan,
  type Diagnostic
} from '@dglab-pulse-hub/core';
import type { OperationEnvelopeDto } from '@dglab-pulse-hub/contracts';

const currentDirectory = fileURLToPath(new URL('.', import.meta.url));
let mainWindow: BrowserWindow | null = null;

interface SourceSnapshot {
  readonly digest: string;
  readonly content: Uint8Array;
  readonly path: string;
}

// Keep both the immutable import snapshot and the current working bytes in the
// privileged process only. The renderer receives only the current digest as an
// opaque reference for later operations.
let sourceSnapshot: SourceSnapshot | null = null;
let originalSnapshot: SourceSnapshot | null = null;
let documentDirty = false;
let openSequence = 0;
let historySnapshots: SourceSnapshot[] = [];
let historyCursor = -1;

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
    if (!confirmClose()) event.preventDefault();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    sourceSnapshot = null;
    originalSnapshot = null;
    documentDirty = false;
    historySnapshots = [];
    historyCursor = -1;
  });
}

function trustedSender(event: Electron.IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:' || (parsed.hostname !== '' && parsed.hostname !== 'localhost'))
      return false;
    return resolve(fileURLToPath(parsed)) === resolve(join(currentDirectory, 'index.html'));
  } catch {
    return false;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}

function confirmClose(): boolean {
  if (!hasUnsavedChanges() || mainWindow === null) return true;
  const confirm = (
    dialog as unknown as {
      showMessageBoxSync?: (window: BrowserWindow, options: Record<string, unknown>) => number;
    }
  ).showMessageBoxSync;
  if (typeof confirm !== 'function') return false;
  return (
    confirm(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Close without saving'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unsaved changes',
      message: 'Close without saving the current pulse?'
    }) === 1
  );
}

function ipcDiagnostic(
  code: string,
  severity: Diagnostic['severity'],
  stage: Diagnostic['stage'],
  message: string,
  field?: string
): Diagnostic {
  return makeDiagnostic(
    code,
    severity,
    stage,
    message,
    location('$', undefined, field === undefined ? {} : { field })
  );
}

function rejectedIpc(message: string, code: string = DIAGNOSTIC_CODES.EXPORT_BLOCKED): unknown {
  return toOperationDto(
    operationResult('export', 'rejected', null, [ipcDiagnostic(code, 'error', 'export', message)])
  );
}

function cancelledIpc(
  operation:
    'inspect' | 'export' | 'write-file' | 'edit' | 'diff' | 'batch' | 'render' | 'undo' | 'redo',
  diagnostics: readonly Diagnostic[] = []
): unknown {
  return toOperationDto(
    operationResult(operation, 'cancelled', null, [
      ...diagnostics,
      ipcDiagnostic(
        DIAGNOSTIC_CODES.TASK_CANCELLED,
        'info',
        'task',
        operation === 'inspect'
          ? 'Open operation was cancelled.'
          : operation === 'export'
            ? 'Export operation was cancelled.'
            : operation === 'write-file'
              ? 'Artifact save was cancelled.'
              : operation === 'diff'
                ? 'Diff operation was cancelled.'
                : operation === 'batch'
                  ? 'Batch operation was cancelled.'
                  : operation === 'render'
                    ? 'Preview rendering was cancelled.'
                    : operation === 'undo'
                      ? 'Undo operation was cancelled.'
                      : operation === 'redo'
                        ? 'Redo operation was cancelled.'
                        : 'Edit operation was cancelled.'
      )
    ])
  );
}

function failedIpc(
  operation:
    'inspect' | 'export' | 'write-file' | 'edit' | 'diff' | 'batch' | 'render' | 'undo' | 'redo',
  code: string,
  stage: Diagnostic['stage'],
  message: string
): unknown {
  return toOperationDto(
    operationResult(operation, 'failed', null, [ipcDiagnostic(code, 'error', stage, message)])
  );
}

function rejectedOperation(
  operation: string,
  message: string,
  code: string = DIAGNOSTIC_CODES.TASK_INVALID_TRANSITION,
  stage: Diagnostic['stage'] = 'task'
): unknown {
  return toOperationDto(
    operationResult(operation, 'rejected', null, [ipcDiagnostic(code, 'error', stage, message)])
  );
}

function previewDisplayName(value: string | undefined, format: 'svg' | 'png' | 'jpg'): string {
  const fallback = 'pulse-preview.' + format;
  if (value === undefined) return fallback;
  const sanitized = sanitizeDisplayName(value);
  const withoutKnownExtension = sanitized.replace(/\.(?:pulse|txt|svg|png|jpe?g)$/i, '');
  const stem = withoutKnownExtension.length > 0 ? withoutKnownExtension : 'pulse-preview';
  return stem + '.' + format;
}

function nativeOverwriteConfirmation():
  Pick<SaveDialogOptions, 'properties'> | Record<string, never> {
  return process.platform === 'linux' ? { properties: ['showOverwriteConfirmation'] } : {};
}

function indexedOutputPath(filePath: string, index: number): string {
  if (index === 0) return filePath;
  const target = parse(filePath);
  return join(target.dir, target.name + ' (' + index + ')' + target.ext);
}

async function writeAvailableOutput(
  filePath: string,
  bytes: Uint8Array,
  overwrite = false
): Promise<Awaited<ReturnType<typeof atomicWriteFile>>> {
  if (overwrite) return atomicWriteFile(filePath, bytes, { overwrite: true });
  for (let index = 0; ; index += 1) {
    const written = await atomicWriteFile(indexedOutputPath(filePath, index), bytes, {
      overwrite: false
    });
    const conflict =
      written.status === 'rejected' &&
      written.diagnostics.some((item) => item.code === DIAGNOSTIC_CODES.ADAPTER_CONFLICT);
    if (!conflict) return written;
  }
}

function digestPayload(payload: unknown): string | null {
  if (
    !plainObject(payload) ||
    typeof payload.sourceDigest !== 'string' ||
    !/^[0-9a-f]{16}$/i.test(payload.sourceDigest)
  )
    return null;
  return payload.sourceDigest;
}

function currentSnapshot(digest: string): SourceSnapshot | null {
  return sourceSnapshot !== null && sourceSnapshot.digest === digest ? sourceSnapshot : null;
}

function copySnapshot(snapshot: SourceSnapshot): SourceSnapshot {
  return Object.freeze({
    digest: snapshot.digest,
    content: new Uint8Array(snapshot.content),
    path: snapshot.path
  });
}

function resetDocumentHistory(snapshot: SourceSnapshot): void {
  const initial = copySnapshot(snapshot);
  sourceSnapshot = copySnapshot(initial);
  originalSnapshot = copySnapshot(initial);
  historySnapshots = [copySnapshot(initial)];
  historyCursor = 0;
  documentDirty = false;
}

function recordCurrentSnapshot(): void {
  if (sourceSnapshot === null) return;
  const next = copySnapshot(sourceSnapshot);
  historySnapshots = [...historySnapshots.slice(0, historyCursor + 1), next];
  historyCursor = historySnapshots.length - 1;
  documentDirty = true;
  sourceSnapshot = copySnapshot(next);
}

function selectHistorySnapshot(index: number): SourceSnapshot | null {
  const snapshot = historySnapshots[index];
  if (snapshot === undefined) return null;
  const selected = copySnapshot(snapshot);
  sourceSnapshot = selected;
  historyCursor = index;
  documentDirty = originalSnapshot === null || selected.digest !== originalSnapshot.digest;
  return selected;
}

function renameOperation(
  operation: 'undo' | 'redo',
  envelope: OperationEnvelopeDto
): OperationEnvelopeDto {
  return Object.freeze({ ...envelope, operation });
}

function hasUnsavedChanges(): boolean {
  return (
    documentDirty ||
    (sourceSnapshot !== null &&
      originalSnapshot !== null &&
      sourceSnapshot.digest !== originalSnapshot.digest)
  );
}

function updateCurrentSnapshot(
  content: Uint8Array,
  path: string,
  dirty: boolean
): OperationResult<InspectData> {
  const inspected = inspectPulse(content, {
    input: {
      displayName: sanitizeDisplayName(path.split(/[\\/]/).pop() ?? 'pulse.pulse'),
      bytes: content.byteLength
    }
  });
  if (inspected.status === 'success' && inspected.data !== null) {
    sourceSnapshot = Object.freeze({
      digest: inspected.data.sourceDigest,
      content: new Uint8Array(content),
      path: resolve(path)
    });
    documentDirty = dirty;
  }
  return inspected;
}

async function readSelectedBatchFiles(
  properties: ('openFile' | 'multiSelections')[] = ['openFile', 'multiSelections']
): Promise<
  | { readonly inputs: readonly BatchInput[]; readonly paths: readonly string[] }
  | { readonly cancelled: true }
  | { readonly error: unknown }
> {
  const selected = await dialog.showOpenDialog({
    properties,
    filters: [{ name: 'Pulse files', extensions: ['pulse', 'txt'] }]
  });
  if (selected.canceled || selected.filePaths.length === 0) return { cancelled: true };
  const inputs: BatchInput[] = [];
  for (const path of selected.filePaths) {
    const read = await readInputFile(path);
    if (read.status === 'success' && read.data !== null) {
      inputs.push({ displayName: read.data.displayName, content: read.data.content });
    } else {
      inputs.push({
        displayName: sanitizeDisplayName(path.split(/[\\/]/).pop() ?? 'pulse.pulse'),
        content: new Uint8Array(),
        diagnostics: read.diagnostics
      });
    }
  }
  return { inputs: Object.freeze(inputs), paths: Object.freeze([...selected.filePaths]) };
}

function validAssistPayload(value: Record<string, unknown>): AssistOptions | null {
  const fields = [
    'sectionIndex',
    'startPointIndex',
    'endPointIndex',
    'startStrength',
    'endStrength'
  ] as const;
  if (value.reviewed !== true) return null;
  if (!fields.every((field) => typeof value[field] === 'number' && Number.isFinite(value[field])))
    return null;
  const sectionIndex = value.sectionIndex as number;
  const startPointIndex = value.startPointIndex as number;
  const endPointIndex = value.endPointIndex as number;
  const startStrength = value.startStrength as number;
  const endStrength = value.endStrength as number;
  if (
    ![sectionIndex, startPointIndex, endPointIndex].every(
      (number) => Number.isSafeInteger(number) && number >= 0
    ) ||
    startPointIndex >= endPointIndex ||
    ![startStrength, endStrength].every((number) => number >= 0 && number <= 100)
  )
    return null;
  return {
    sectionIndex,
    startPointIndex,
    endPointIndex,
    startStrength,
    endStrength,
    reviewed: true
  };
}

function validIpcIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Normalize the renderer's small JSON command into the application command.
 * The renderer never gets to construct a source span or inject a model. */
function parseIpcEditCommand(value: Record<string, unknown>): EditCommand | null {
  if (
    !onlyKeys(value, [
      'kind',
      'sectionIndex',
      'pointIndex',
      'value',
      'startIndex',
      'endIndex',
      'atIndex',
      'anchor'
    ]) ||
    typeof value.kind !== 'string' ||
    !validIpcIndex(value.sectionIndex)
  )
    return null;
  const sectionIndex = value.sectionIndex;
  switch (value.kind) {
    case 'strength':
      return validIpcIndex(value.pointIndex) &&
        typeof value.value === 'number' &&
        Number.isFinite(value.value) &&
        value.value >= 0 &&
        value.value <= 100
        ? { kind: 'strength', sectionIndex, pointIndex: value.pointIndex, value: value.value }
        : null;
    case 'anchor':
      return validIpcIndex(value.pointIndex) && (value.value === 0 || value.value === 1)
        ? { kind: 'anchor', sectionIndex, pointIndex: value.pointIndex, value: value.value }
        : null;
    case 'frequency':
      return validIpcIndex(value.startIndex) &&
        validIpcIndex(value.endIndex) &&
        value.startIndex <= 83 &&
        value.endIndex <= 83
        ? {
            kind: 'frequency',
            sectionIndex,
            startIndex: value.startIndex,
            endIndex: value.endIndex
          }
        : null;
    case 'duration':
      return validIpcIndex(value.value) && value.value <= 99
        ? { kind: 'duration', sectionIndex, value: value.value }
        : null;
    case 'remove-point':
      return validIpcIndex(value.pointIndex)
        ? { kind: 'remove-point', sectionIndex, pointIndex: value.pointIndex }
        : null;
    case 'add-point': {
      const strength = value.value;
      const anchor = value.anchor;
      const atIndex = value.atIndex;
      if (
        typeof strength !== 'number' ||
        !Number.isFinite(strength) ||
        strength < 0 ||
        strength > 100 ||
        (anchor !== 0 && anchor !== 1) ||
        (atIndex !== undefined && !validIpcIndex(atIndex))
      )
        return null;
      const decimal = normalizeDecimal(strength.toFixed(6));
      return {
        kind: 'add-point',
        sectionIndex,
        point: Object.freeze({
          strength: Number(decimal),
          strengthDecimal: decimal,
          strengthRaw: decimal,
          anchor,
          sourceSpan: sourceSpan('', 0, 0)
        }),
        ...(atIndex === undefined ? {} : { atIndex })
      };
    }
    default:
      return null;
  }
}

function registerIpc(): void {
  ipcMain.handle('pulse:open', async (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted IPC sender.');
    if (!confirmClose()) return cancelledIpc('inspect');
    const requestSequence = ++openSequence;
    try {
      const selected = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Pulse files', extensions: ['pulse', 'txt'] }]
      });
      if (selected.canceled || selected.filePaths[0] === undefined) {
        return cancelledIpc('inspect');
      }
      const selectedPath = selected.filePaths[0];
      const read = await readInputFile(selectedPath);
      if (read.status !== 'success' || read.data === null) {
        return toOperationDto(read);
      }
      const inspected = inspectPulse(read.data.content, {
        input: { displayName: read.data.displayName, bytes: read.data.byteSize }
      });
      if (inspected.status === 'success' && inspected.data !== null) {
        if (requestSequence === openSequence) {
          resetDocumentHistory(
            Object.freeze({
              digest: inspected.data.sourceDigest,
              content: new Uint8Array(read.data.content),
              path: resolve(selectedPath)
            })
          );
        }
      }
      return toOperationDto(inspected);
    } catch {
      return failedIpc(
        'inspect',
        DIAGNOSTIC_CODES.ADAPTER_READ,
        'adapter',
        'Unable to open the selected pulse file.'
      );
    }
  });

  ipcMain.handle('pulse:inspect-current', async (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted IPC sender.');
    const snapshot = sourceSnapshot;
    if (snapshot === null)
      return rejectedOperation(
        'inspect',
        'No pulse document is open.',
        DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE,
        'adapter'
      );
    try {
      const inspected = inspectPulse(snapshot.content, {
        input: {
          displayName: sanitizeDisplayName(snapshot.path.split(/[\\/]/).pop() ?? 'pulse.pulse'),
          bytes: snapshot.content.byteLength
        }
      });
      return toOperationDto(inspected);
    } catch {
      return failedIpc(
        'inspect',
        DIAGNOSTIC_CODES.ADAPTER_READ,
        'adapter',
        'The current pulse could not be inspected.'
      );
    }
  });

  ipcMain.handle('pulse:decode-qr', async (event, payload: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted IPC sender.');
    if (!plainObject(payload) || !onlyKeys(payload, ['text']) || typeof payload.text !== 'string') {
      return rejectedOperation(
        'qr-decode',
        'QR content must be text.',
        DIAGNOSTIC_CODES.QR_PREFIX,
        'qr'
      );
    }
    try {
      const decoded = decodeQr(payload.text);
      if (!decoded.accepted || decoded.pulseText === null) {
        return toOperationDto(operationResult('qr-decode', 'rejected', null, decoded.diagnostics));
      }
      const content = new TextEncoder().encode(decoded.pulseText);
      const inspected = inspectPulse(content, {
        input: { displayName: 'decoded.pulse', bytes: content.byteLength }
      });
      if (inspected.status === 'success' && inspected.data !== null) {
        resetDocumentHistory(
          Object.freeze({
            digest: inspected.data.sourceDigest,
            content,
            path: resolve(join(currentDirectory, 'decoded.pulse'))
          })
        );
      }
      return toOperationDto(
        operationResult('inspect', inspected.status, inspected.data, [
          ...decoded.diagnostics,
          ...inspected.diagnostics
        ])
      );
    } catch {
      return failedIpc(
        'inspect',
        DIAGNOSTIC_CODES.ADAPTER_READ,
        'adapter',
        'QR content could not be decoded.'
      );
    }
  });

  ipcMain.handle('pulse:edit', async (event, payload: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted IPC sender.');
    if (!plainObject(payload) || !onlyKeys(payload, ['sourceDigest', 'command']))
      return rejectedOperation(
        'edit',
        'Edit request contains unsupported fields.',
        DIAGNOSTIC_CODES.EDIT_VALUE,
        'semantic'
      );
    const digest = digestPayload(payload);
    if (digest === null)
      return rejectedOperation(
        'edit',
        'Edit request must identify the opened source.',
        DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE,
        'adapter'
      );
    const snapshot = currentSnapshot(digest);
    if (snapshot === null)
      return rejectedOperation(
        'edit',
        'The opened source is no longer available.',
        DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE,
        'adapter'
      );
    if (!plainObject(payload.command))
      return rejectedOperation(
        'edit',
        'Edit request must contain a command.',
        DIAGNOSTIC_CODES.EDIT_VALUE,
        'semantic'
      );
    const command = parseIpcEditCommand(payload.command);
    if (command === null)
      return rejectedOperation(
        'edit',
        'Edit command is invalid.',
        DIAGNOSTIC_CODES.EDIT_VALUE,
        'semantic'
      );
    try {
      const edited = applyPulseEdit(snapshot.content, { command });
      if (edited.status !== 'success' || edited.data === null) return toOperationDto(edited);
      const inspected = updateCurrentSnapshot(edited.data.bytes, snapshot.path, true);
      if (inspected.status !== 'success' || inspected.data === null) {
        sourceSnapshot = snapshot;
        documentDirty = true;
        return failedIpc(
          'edit',
          DIAGNOSTIC_CODES.EXPORT_ROUNDTRIP_MISMATCH,
          'export',
          'The edited pulse could not be re-inspected.'
        );
      }
      recordCurrentSnapshot();
      return toOperationDto(edited);
    } catch {
      return failedIpc(
        'edit',
        DIAGNOSTIC_CODES.EDIT_VALUE,
        'semantic',
        'The pulse edit could not be applied.'
      );
    }
  });

  ipcMain.handle('pulse:assist', async (event, payload: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted IPC sender.');
    if (
      !plainObject(payload) ||
      !onlyKeys(payload, [
        'sourceDigest',
        'sectionIndex',
        'startPointIndex',
        'endPointIndex',
        'startStrength',
        'endStrength',
        'reviewed'
      ])
    )
      return rejectedOperation(
        'edit',
        'Assist request contains unsupported fields.',
        DIAGNOSTIC_CODES.EDIT_VALUE,
        'semantic'
      );
    const digest = digestPayload(payload);
    if (digest === null)
      return rejectedOperation(
        'edit',
        'Assist request must identify the opened source.',
        DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE,
        'adapter'
      );
    const snapshot = currentSnapshot(digest);
    if (snapshot === null)
      return rejectedOperation(
        'edit',
        'The opened source is no longer available.',
        DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE,
        'adapter'
      );
    const options = validAssistPayload(payload);
    if (options === null)
      return rejectedOperation(
        'edit',
        'Assist requires explicit review and valid endpoints.',
        DIAGNOSTIC_CODES.EDIT_NOT_REVIEWED,
        'semantic'
      );
    try {
      const edited = applyPulseAssist(snapshot.content, options);
      if (edited.status !== 'success' || edited.data === null) return toOperationDto(edited);
      const inspected = updateCurrentSnapshot(edited.data.bytes, snapshot.path, true);
      if (inspected.status !== 'success' || inspected.data === null) {
        sourceSnapshot = snapshot;
        documentDirty = true;
        return failedIpc(
          'edit',
          DIAGNOSTIC_CODES.EXPORT_ROUNDTRIP_MISMATCH,
          'export',
          'The assisted pulse could not be re-inspected.'
        );
      }
      recordCurrentSnapshot();
      return toOperationDto(edited);
    } catch {
      return failedIpc(
        'edit',
        DIAGNOSTIC_CODES.EDIT_VALUE,
        'semantic',
        'The assisted pulse could not be applied.'
      );
    }
  });

  const registerHistoryHandler = (
    channel: 'pulse:undo' | 'pulse:redo',
    operation: 'undo' | 'redo',
    direction: -1 | 1
  ): void => {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      if (!trustedSender(event)) throw new Error('Untrusted IPC sender.');
      if (!plainObject(payload) || !onlyKeys(payload, ['sourceDigest'])) {
        return rejectedOperation(
          operation,
          operation === 'undo'
            ? 'Undo request contains unsupported fields.'
            : 'Redo request contains unsupported fields.',
          DIAGNOSTIC_CODES.EDIT_VALUE,
          'semantic'
        );
      }
      const digest = digestPayload(payload);
      if (digest === null) {
        return rejectedOperation(
          operation,
          operation === 'undo'
            ? 'Undo request must identify the opened source.'
            : 'Redo request must identify the opened source.',
          DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE,
          'adapter'
        );
      }
      if (sourceSnapshot === null || originalSnapshot === null || historyCursor < 0) {
        return rejectedOperation(
          operation,
          'No pulse history is available.',
          DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE,
          'adapter'
        );
      }
      if (sourceSnapshot.digest !== digest) {
        return rejectedOperation(
          operation,
          'The opened source changed before the history operation completed.',
          DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE,
          'adapter'
        );
      }
      const targetIndex = historyCursor + direction;
      const target = historySnapshots[targetIndex];
      if (target === undefined) {
        return rejectedOperation(
          operation,
          operation === 'undo'
            ? 'There is no earlier pulse snapshot to restore.'
            : 'There is no later pulse snapshot to restore.',
          DIAGNOSTIC_CODES.TASK_INVALID_TRANSITION,
          'task'
        );
      }
      try {
        const inspected = inspectPulse(target.content, {
          input: {
            displayName: sanitizeDisplayName(target.path.split(/[\\/]/).pop() ?? 'pulse.pulse'),
            bytes: target.content.byteLength
          }
        });
        const response = renameOperation(operation, toOperationDto(inspected));
        if (inspected.status !== 'success' || inspected.data === null) return response;
        if (inspected.data.sourceDigest !== target.digest) {
          return failedIpc(
            operation,
            DIAGNOSTIC_CODES.TASK_INVALID_TRANSITION,
            'task',
            'The pulse history snapshot is inconsistent.'
          );
        }
        selectHistorySnapshot(targetIndex);
        return response;
      } catch {
        return failedIpc(
          operation,
          DIAGNOSTIC_CODES.ADAPTER_READ,
          'adapter',
          operation === 'undo'
            ? 'The earlier pulse snapshot could not be restored.'
            : 'The later pulse snapshot could not be restored.'
        );
      }
    });
  };
  registerHistoryHandler('pulse:undo', 'undo', -1);
  registerHistoryHandler('pulse:redo', 'redo', 1);

  ipcMain.handle('pulse:diff', async (event, payload: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted IPC sender.');
    if (!plainObject(payload) || !onlyKeys(payload, ['sourceDigest']))
      return rejectedOperation(
        'diff',
        'Diff request contains unsupported fields.',
        DIAGNOSTIC_CODES.EDIT_VALUE,
        'semantic'
      );
    const digest = digestPayload(payload);
    if (digest === null)
      return rejectedOperation(
        'diff',
        'Diff request must identify the opened source.',
        DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE,
        'adapter'
      );
    const snapshot = currentSnapshot(digest);
    if (snapshot === null)
      return rejectedOperation(
        'diff',
        'The opened source is no longer available.',
        DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE,
        'adapter'
      );
    try {
      const selected = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Pulse files', extensions: ['pulse', 'txt'] }]
      });
      if (selected.canceled || selected.filePaths[0] === undefined) return cancelledIpc('diff');
      const read = await readInputFile(selected.filePaths[0]);
      if (read.status !== 'success' || read.data === null) return toOperationDto(read);
      return toOperationDto(diffPulses(snapshot.content, read.data.content));
    } catch {
      return failedIpc(
        'diff',
        DIAGNOSTIC_CODES.ADAPTER_READ,
        'adapter',
        'The comparison pulse could not be read.'
      );
    }
  });

  ipcMain.handle('pulse:batch-inspect', async (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted IPC sender.');
    try {
      const selected = await readSelectedBatchFiles();
      if ('cancelled' in selected) return cancelledIpc('batch');
      if ('error' in selected)
        return failedIpc(
          'batch',
          DIAGNOSTIC_CODES.ADAPTER_READ,
          'adapter',
          'Batch files could not be read.'
        );
      return toOperationDto(await inspectBatch(selected.inputs));
    } catch {
      return failedIpc(
        'batch',
        DIAGNOSTIC_CODES.ADAPTER_READ,
        'adapter',
        'Batch files could not be read.'
      );
    }
  });

  ipcMain.handle('pulse:batch-export', async (event, payload: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted IPC sender.');
    if (!plainObject(payload) || !onlyKeys(payload, ['mode', 'overwrite']))
      return rejectedOperation(
        'batch',
        'Batch export request contains unsupported fields.',
        DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_MODE,
        'export'
      );
    const value = payload;
    const mode = value.mode === undefined ? undefined : value.mode;
    if (mode !== undefined && mode !== 'source' && mode !== 'canonical')
      return rejectedOperation(
        'batch',
        'Batch export mode is invalid.',
        DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_MODE,
        'export'
      );
    if (value.overwrite !== undefined && typeof value.overwrite !== 'boolean') {
      return rejectedOperation(
        'batch',
        'Batch export overwrite flag must be boolean.',
        DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_MODE,
        'export'
      );
    }
    const overwrite = value.overwrite === true;
    try {
      const selected = await readSelectedBatchFiles();
      if ('cancelled' in selected) return cancelledIpc('batch');
      if ('error' in selected)
        return failedIpc(
          'batch',
          DIAGNOSTIC_CODES.ADAPTER_READ,
          'adapter',
          'Batch files could not be read.'
        );
      const exported = await exportBatch(selected.inputs as readonly BatchExportInput[], { mode });
      if (exported.data === null) return toOperationDto(exported);
      const directory = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      if (directory.canceled || directory.filePaths[0] === undefined)
        return cancelledIpc('batch', exported.diagnostics);
      const items = exported.data.items.map((item) => item);
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item === undefined || item.status !== 'success' || item.data === null) continue;
        const written = await writeAvailableOutput(
          join(directory.filePaths[0], item.data.displayName),
          item.data.bytes,
          overwrite
        );
        if (written.status !== 'success') {
          items[index] = Object.freeze({
            ...item,
            status: 'failed' as const,
            diagnostics: [...item.diagnostics, ...written.diagnostics],
            data: null
          });
        } else if (written.data !== null) {
          items[index] = Object.freeze({
            ...item,
            data: Object.freeze({ ...item.data, displayName: written.data.displayName })
          });
        }
      }
      const succeeded = items.filter((item) => item?.status === 'success').length;
      const rejected = items.filter((item) => item?.status === 'rejected').length;
      const failed = items.filter((item) => item?.status === 'failed').length;
      const batchStatus = succeeded > 0 ? 'success' : failed > 0 ? 'failed' : 'rejected';
      const combined = operationResult(
        'batch',
        batchStatus,
        batchStatus === 'success'
          ? {
              ...exported.data,
              succeeded,
              rejected,
              failed,
              items: Object.freeze(items)
            }
          : null,
        items.flatMap((item) => item?.diagnostics ?? [])
      );
      return toOperationDto(combined);
    } catch {
      return failedIpc(
        'batch',
        DIAGNOSTIC_CODES.ADAPTER_WRITE,
        'adapter',
        'Batch export could not be completed.'
      );
    }
  });

  ipcMain.handle('pulse:render-preview', async (event, payload: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted IPC sender.');
    if (!plainObject(payload) || !onlyKeys(payload, ['sourceDigest', 'displayName', 'format'])) {
      return rejectedOperation(
        'render',
        'Preview request contains unsupported fields.',
        DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_FORMAT,
        'export'
      );
    }
    const sourceDigest = payload.sourceDigest;
    if (typeof sourceDigest !== 'string' || !/^[0-9a-f]{16}$/i.test(sourceDigest)) {
      return rejectedOperation(
        'render',
        'Preview request must identify the opened source.',
        DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE,
        'adapter'
      );
    }
    const snapshot = currentSnapshot(sourceDigest);
    if (snapshot === null) {
      return rejectedOperation(
        'render',
        'The opened source is no longer available.',
        DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE,
        'adapter'
      );
    }
    const format = payload.format;
    if (format !== 'svg' && format !== 'png' && format !== 'jpg') {
      return rejectedOperation(
        'render',
        'Preview format is not supported.',
        DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_FORMAT,
        'export'
      );
    }
    if (payload.displayName !== undefined && typeof payload.displayName !== 'string') {
      return rejectedOperation(
        'render',
        'Preview display name must be text.',
        DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_FORMAT,
        'export'
      );
    }
    try {
      const inspected = inspectPulse(snapshot.content, {
        input: {
          displayName: sanitizeDisplayName(snapshot.path.split(/[\\/]/).pop() ?? 'pulse.pulse'),
          bytes: snapshot.content.byteLength
        }
      });
      if (
        inspected.status !== 'success' ||
        inspected.data?.stream === null ||
        inspected.data?.stream === undefined
      ) {
        return toOperationDto(
          operationResult(
            'render',
            inspected.status === 'success' ? 'rejected' : inspected.status,
            null,
            inspected.diagnostics
          )
        );
      }
      let image: ReturnType<typeof renderPreviewImage>;
      try {
        image = renderPreviewImage(inspected.data.stream, format);
      } catch {
        return failedIpc(
          'render',
          DIAGNOSTIC_CODES.EXPORT_BLOCKED,
          'export',
          'Preview could not be encoded.'
        );
      }
      const target = await dialog.showSaveDialog({
        defaultPath: previewDisplayName(
          typeof payload.displayName === 'string'
            ? payload.displayName
            : snapshot.path.split(/[\\/]/).pop(),
          format
        ),
        filters: [{ name: format.toUpperCase() + ' preview', extensions: [format] }],
        ...nativeOverwriteConfirmation()
      });
      if (target.canceled || target.filePath === undefined)
        return cancelledIpc('render', inspected.diagnostics);
      const written = await writeAvailableOutput(resolve(target.filePath), image.bytes, true);
      if (written.status !== 'success' || written.data === null) {
        return toOperationDto(
          operationResult('render', written.status, null, [
            ...inspected.diagnostics,
            ...written.diagnostics
          ])
        );
      }
      return toOperationDto(
        operationResult(
          'render',
          'success',
          {
            displayName: written.data.displayName,
            format: image.format,
            byteSize: image.bytes.byteLength,
            width: image.width,
            height: image.height,
            streamDigest: image.streamDigest,
            contentType: image.mimeType
          },
          inspected.diagnostics
        )
      );
    } catch {
      return failedIpc(
        'render',
        DIAGNOSTIC_CODES.ADAPTER_WRITE,
        'adapter',
        'Unable to save the preview image.'
      );
    }
  });

  ipcMain.handle('pulse:export', async (event, payload: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted IPC sender.');
    if (!plainObject(payload)) {
      return rejectedIpc('Export request must be an object.');
    }
    const value = payload as Record<string, unknown>;
    const allowedKeys = new Set(['sourceDigest', 'displayName', 'format', 'mode']);
    if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
      return rejectedIpc('Export request contains unsupported fields.');
    }
    const sourceDigest = value.sourceDigest;
    if (typeof sourceDigest !== 'string' || !/^[0-9a-f]{16}$/i.test(sourceDigest)) {
      return rejectedIpc(
        'Export request must identify the opened source.',
        DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE
      );
    }
    const snapshot = sourceSnapshot;
    if (snapshot === null || snapshot.digest !== sourceDigest) {
      return rejectedIpc(
        'The opened source is no longer available.',
        DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE
      );
    }
    const requestedFormat = value.format;
    if (
      requestedFormat !== undefined &&
      requestedFormat !== 'pulse-text' &&
      requestedFormat !== 'qr-envelope'
    ) {
      return rejectedIpc('Unsupported export format.', DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_FORMAT);
    }
    const requestedMode = value.mode;
    if (
      requestedMode !== undefined &&
      requestedMode !== 'canonical' &&
      requestedMode !== 'source'
    ) {
      return rejectedIpc('Unsupported export mode.', DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_MODE);
    }
    const format = requestedFormat === undefined ? 'pulse-text' : requestedFormat;
    const dirty = hasUnsavedChanges();
    if (format === 'pulse-text' && requestedMode === 'source' && dirty) {
      return rejectedIpc(
        'Source snapshot export is unavailable after edits; choose canonical mode.',
        DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE
      );
    }
    if (value.displayName !== undefined && typeof value.displayName !== 'string') {
      return rejectedIpc('Export display name must be text.');
    }
    try {
      const exported = exportPulse(snapshot.content, {
        format,
        mode:
          requestedMode === undefined
            ? format === 'pulse-text'
              ? dirty
                ? 'canonical'
                : 'source'
              : undefined
            : requestedMode,
        displayName:
          typeof value.displayName === 'string'
            ? sanitizeDisplayName(value.displayName)
            : 'pulse.pulse'
      });
      if (exported.status !== 'success' || exported.data === null) {
        return toOperationDto(exported);
      }
      const envelope = toOperationDto(exported);
      if (format === 'qr-envelope') {
        return {
          envelope,
          artifact: {
            bytes: exported.data.bytes,
            displayName: exported.data.displayName,
            contentType: exported.data.contentType ?? 'image/jpeg'
          }
        };
      }
      const target = await dialog.showSaveDialog({
        defaultPath: exported.data.displayName,
        filters: [{ name: 'Pulse files', extensions: ['pulse'] }],
        ...nativeOverwriteConfirmation()
      });
      if (target.canceled || target.filePath === undefined) {
        return cancelledIpc('export', exported.diagnostics);
      }
      const written = await writeAvailableOutput(
        resolve(target.filePath),
        exported.data.bytes,
        true
      );
      if (written.status !== 'success' || written.data === null) {
        return toOperationDto(
          operationResult('export', written.status, null, [
            ...exported.diagnostics,
            ...written.diagnostics
          ])
        );
      }
      return toOperationDto(
        operationResult(
          'export',
          'success',
          {
            ...exported.data,
            displayName: written.data.displayName
          },
          exported.diagnostics
        )
      );
    } catch {
      return failedIpc(
        'export',
        DIAGNOSTIC_CODES.ADAPTER_WRITE,
        'adapter',
        'Unable to export the selected pulse file.'
      );
    }
  });

  ipcMain.handle('pulse:save-artifact', async (event, payload: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted IPC sender.');
    if (
      !plainObject(payload) ||
      !onlyKeys(payload, ['artifact', 'suggestedName']) ||
      !plainObject(payload.artifact) ||
      !onlyKeys(payload.artifact, ['bytes', 'displayName', 'contentType'])
    ) {
      return rejectedIpc('Artifact save request contains unsupported fields.');
    }
    const artifact = payload.artifact;
    if (
      !(artifact.bytes instanceof Uint8Array) ||
      artifact.bytes.byteLength === 0 ||
      typeof artifact.displayName !== 'string' ||
      artifact.displayName.length === 0 ||
      typeof artifact.contentType !== 'string' ||
      artifact.contentType.length === 0 ||
      typeof payload.suggestedName !== 'string'
    ) {
      return rejectedIpc('Artifact save request is invalid.');
    }
    const suggestedName = sanitizeDisplayName(payload.suggestedName || artifact.displayName);
    try {
      const target = await dialog.showSaveDialog({
        defaultPath: suggestedName,
        filters:
          artifact.contentType === 'image/jpeg'
            ? [{ name: 'QR image', extensions: ['jpg'] }]
            : [{ name: 'Exported file', extensions: [parse(suggestedName).ext.slice(1) || 'bin'] }],
        ...nativeOverwriteConfirmation()
      });
      if (target.canceled || target.filePath === undefined) return cancelledIpc('write-file');
      const written = await writeAvailableOutput(resolve(target.filePath), artifact.bytes, true);
      if (written.status !== 'success' || written.data === null) {
        return toOperationDto(
          operationResult('write-file', written.status, null, written.diagnostics)
        );
      }
      return toOperationDto(operationResult('write-file', 'success', written.data, []));
    } catch {
      return failedIpc(
        'write-file',
        DIAGNOSTIC_CODES.ADAPTER_WRITE,
        'adapter',
        'Unable to save the exported artifact.'
      );
    }
  });

  ipcMain.handle('pulse:mark-dirty', async (event, payload: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted IPC sender.');
    if (!plainObject(payload) || typeof payload.dirty !== 'boolean') {
      return rejectedIpc(
        'Dirty state must be a boolean.',
        DIAGNOSTIC_CODES.TASK_INVALID_TRANSITION
      );
    }
    const derivedDirty =
      sourceSnapshot !== null &&
      originalSnapshot !== null &&
      sourceSnapshot.digest !== originalSnapshot.digest;
    documentDirty = payload.dirty || derivedDirty;
    return toOperationDto(operationResult('state', 'success', { dirty: documentDirty }, []));
  });
}

app.whenReady().then(() => {
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
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
