import { dialog, ipcMain } from 'electron';
import { basename, join, parse, resolve } from 'node:path';
import {
  applyPulseAssist,
  applyPulseEdit,
  commandParseDiagnostic,
  decodeQr,
  diffPulses,
  exportBatch,
  exportPulse,
  inspectBatch,
  inspectPulse,
  operationResult,
  parseAssistCommand,
  parseEditCommand,
  readInputFile,
  renderPreviewImage,
  sanitizeDisplayName,
  toOperationDto
} from '@dglab-pulse-hub/application';
import { DIAGNOSTIC_CODES } from '@dglab-pulse-hub/core';
import type { OperationEnvelopeDto } from '@dglab-pulse-hub/contracts';
import {
  cancelledIpc,
  digestPayload,
  failedIpc,
  nativeOverwriteConfirmation,
  onlyKeys,
  plainObject,
  previewDisplayName,
  rejectedIpc,
  rejectedOperation,
  trustedSender,
  writeAvailableOutput
} from './ipc-support.js';
import { DocumentStore } from './document-store.js';
import { LocalPulseWorkspace } from './local-workspace.js';

export interface IpcContext {
  readonly currentDirectory: string;
  readonly documents: DocumentStore;
  readonly workspace: LocalPulseWorkspace;
  readonly confirmClose: () => boolean;
}

export function registerIpc({
  currentDirectory,
  documents,
  workspace,
  confirmClose
}: IpcContext): void {
  let openSequence = 0;

  const openPulsePath = async (
    selectedPath: string,
    requestSequence: number
  ): Promise<OperationEnvelopeDto> => {
    const read = await readInputFile(selectedPath);
    if (read.status !== 'success' || read.data === null) return toOperationDto(read);
    const validation = inspectPulse(read.data.content, {
      input: { displayName: read.data.displayName, bytes: read.data.byteSize }
    });
    if (validation.status !== 'success' || validation.data === null)
      return toOperationDto(validation);
    const documentPath = resolve(selectedPath);
    const displayName = sanitizeDisplayName(basename(documentPath));
    const inspected = inspectPulse(read.data.content, {
      input: { displayName, bytes: read.data.byteSize }
    });
    if (
      inspected.status === 'success' &&
      inspected.data !== null &&
      requestSequence === openSequence
    ) {
      documents.reset(
        Object.freeze({
          digest: inspected.data.sourceDigest,
          content: new Uint8Array(read.data.content),
          path: documentPath
        })
      );
    }
    return toOperationDto(inspected);
  };

  const renameOperation = (
    operation: 'undo' | 'redo',
    envelope: OperationEnvelopeDto
  ): OperationEnvelopeDto => Object.freeze({ ...envelope, operation });

  const importPaths = async (paths: readonly string[]) => {
    const archivedPaths: string[] = [];
    for (const path of paths) {
      const read = await readInputFile(path);
      if (read.status !== 'success' || read.data === null) continue;
      const validation = inspectPulse(read.data.content, {
        input: { displayName: read.data.displayName, bytes: read.data.byteSize }
      });
      if (validation.status !== 'success') continue;
      archivedPaths.push(await workspace.archive(path));
    }
    const index = await workspace.list();
    const archived = new Set(archivedPaths.map((path) => resolve(path)));
    const imported = [];
    for (const file of index.files) {
      if (archived.has(resolve(await workspace.resolveFile(file.relativePath))))
        imported.push(file);
    }
    return Object.freeze({ index, imported: Object.freeze(imported) });
  };

  ipcMain.handle('pulse:workspace-import', async (event, payload: unknown) => {
    if (!trustedSender(event, currentDirectory)) throw new Error('Untrusted IPC sender.');
    if (
      !plainObject(payload) ||
      !onlyKeys(payload, ['multiple']) ||
      typeof payload.multiple !== 'boolean'
    )
      throw new Error('A file-manager import mode is required.');
    const selected = await dialog.showOpenDialog({
      properties: payload.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'Pulse files', extensions: ['pulse'] }]
    });
    return importPaths(selected.canceled ? [] : selected.filePaths);
  });

  ipcMain.handle('pulse:workspace-list', async (event) => {
    if (!trustedSender(event, currentDirectory)) throw new Error('Untrusted IPC sender.');
    return workspace.list();
  });

  ipcMain.handle('pulse:workspace-open', async (event, payload: unknown) => {
    if (!trustedSender(event, currentDirectory)) throw new Error('Untrusted IPC sender.');
    if (
      !plainObject(payload) ||
      !onlyKeys(payload, ['relativePath']) ||
      typeof payload.relativePath !== 'string'
    )
      return rejectedOperation('inspect', 'A workspace-relative pulse path is required.');
    if (!confirmClose()) return cancelledIpc('inspect');
    const requestSequence = ++openSequence;
    try {
      const selectedPath = await workspace.resolveFile(payload.relativePath);
      return await openPulsePath(selectedPath, requestSequence);
    } catch {
      return failedIpc(
        'inspect',
        DIAGNOSTIC_CODES.ADAPTER_READ,
        'adapter',
        'Unable to open the workspace pulse file.'
      );
    }
  });

  ipcMain.handle('pulse:import-dropped', async (event, payload: unknown) => {
    if (!trustedSender(event, currentDirectory)) throw new Error('Untrusted IPC sender.');
    if (!plainObject(payload) || !onlyKeys(payload, ['path']) || typeof payload.path !== 'string')
      return rejectedOperation('inspect', 'A dropped pulse file path is required.');
    try {
      return await importPaths([payload.path]);
    } catch {
      return importPaths([]);
    }
  });

  ipcMain.handle('pulse:inspect-current', async (event) => {
    if (!trustedSender(event, currentDirectory)) throw new Error('Untrusted IPC sender.');
    const snapshot = documents.current;
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
    if (!trustedSender(event, currentDirectory)) throw new Error('Untrusted IPC sender.');
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
        documents.reset(
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
    if (!trustedSender(event, currentDirectory)) throw new Error('Untrusted IPC sender.');
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
    const snapshot = documents.currentFor(digest);
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
    const commandResult = parseEditCommand(payload.command);
    if (commandResult.value === null)
      return toOperationDto(
        operationResult('edit', 'rejected', null, [commandParseDiagnostic(commandResult.error)])
      );
    try {
      const edited = applyPulseEdit(snapshot.content, { command: commandResult.value });
      if (edited.status !== 'success' || edited.data === null) return toOperationDto(edited);
      const inspected = documents.update(edited.data.bytes, snapshot.path, true);
      if (inspected.status !== 'success' || inspected.data === null) {
        documents.restoreCurrent(snapshot, true);
        return failedIpc(
          'edit',
          DIAGNOSTIC_CODES.EXPORT_ROUNDTRIP_MISMATCH,
          'export',
          'The edited pulse could not be re-inspected.'
        );
      }
      documents.record();
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
    if (!trustedSender(event, currentDirectory)) throw new Error('Untrusted IPC sender.');
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
    const snapshot = documents.currentFor(digest);
    if (snapshot === null)
      return rejectedOperation(
        'edit',
        'The opened source is no longer available.',
        DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE,
        'adapter'
      );
    const optionsResult = parseAssistCommand({
      sectionIndex: payload.sectionIndex,
      startPointIndex: payload.startPointIndex,
      endPointIndex: payload.endPointIndex,
      startStrength: payload.startStrength,
      endStrength: payload.endStrength,
      reviewed: payload.reviewed
    });
    if (optionsResult.value === null)
      return toOperationDto(
        operationResult('edit', 'rejected', null, [commandParseDiagnostic(optionsResult.error)])
      );
    try {
      const edited = applyPulseAssist(snapshot.content, optionsResult.value);
      if (edited.status !== 'success' || edited.data === null) return toOperationDto(edited);
      const inspected = documents.update(edited.data.bytes, snapshot.path, true);
      if (inspected.status !== 'success' || inspected.data === null) {
        documents.restoreCurrent(snapshot, true);
        return failedIpc(
          'edit',
          DIAGNOSTIC_CODES.EXPORT_ROUNDTRIP_MISMATCH,
          'export',
          'The assisted pulse could not be re-inspected.'
        );
      }
      documents.record();
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
      if (!trustedSender(event, currentDirectory)) throw new Error('Untrusted IPC sender.');
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
      if (documents.current === null || documents.original === null || documents.cursor < 0) {
        return rejectedOperation(
          operation,
          'No pulse history is available.',
          DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE,
          'adapter'
        );
      }
      if (documents.current.digest !== digest) {
        return rejectedOperation(
          operation,
          'The opened source changed before the history operation completed.',
          DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE,
          'adapter'
        );
      }
      const targetIndex = documents.cursor + direction;
      const target = documents.history[targetIndex];
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
        documents.select(targetIndex);
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
    if (!trustedSender(event, currentDirectory)) throw new Error('Untrusted IPC sender.');
    if (!plainObject(payload) || !onlyKeys(payload, ['sourceDigest', 'relativePath']))
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
    const snapshot = documents.currentFor(digest);
    if (snapshot === null)
      return rejectedOperation(
        'diff',
        'The opened source is no longer available.',
        DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE,
        'adapter'
      );
    if (typeof payload.relativePath !== 'string')
      return rejectedOperation('diff', 'A managed comparison file is required.');
    try {
      const selectedPath = await workspace.resolveFile(payload.relativePath);
      const read = await readInputFile(selectedPath);
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

  const readManagedInputs = async (payload: unknown) => {
    if (
      !plainObject(payload) ||
      !onlyKeys(payload, ['relativePaths']) ||
      !Array.isArray(payload.relativePaths) ||
      payload.relativePaths.length === 0 ||
      payload.relativePaths.some((path) => typeof path !== 'string')
    )
      return null;
    return Promise.all(
      payload.relativePaths.map(async (relativePath) => {
        const path = await workspace.resolveFile(relativePath as string);
        const read = await readInputFile(path);
        return read.status === 'success' && read.data !== null
          ? { displayName: read.data.displayName, content: read.data.content }
          : {
              displayName: sanitizeDisplayName(basename(path)),
              content: new Uint8Array(),
              diagnostics: read.diagnostics
            };
      })
    );
  };

  ipcMain.handle('pulse:batch-inspect', async (event, payload: unknown) => {
    if (!trustedSender(event, currentDirectory)) throw new Error('Untrusted IPC sender.');
    try {
      const inputs = await readManagedInputs(payload);
      if (inputs === null) return rejectedOperation('batch', 'Managed batch files are required.');
      return toOperationDto(await inspectBatch(inputs));
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
    if (!trustedSender(event, currentDirectory)) throw new Error('Untrusted IPC sender.');
    if (!plainObject(payload) || !onlyKeys(payload, ['relativePaths', 'mode', 'overwrite']))
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
      const inputs = await readManagedInputs({ relativePaths: value.relativePaths });
      if (inputs === null) return rejectedOperation('batch', 'Managed batch files are required.');
      const exported = await exportBatch(inputs, { mode });
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
    if (!trustedSender(event, currentDirectory)) throw new Error('Untrusted IPC sender.');
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
    const snapshot = documents.currentFor(sourceDigest);
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
    if (!trustedSender(event, currentDirectory)) throw new Error('Untrusted IPC sender.');
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
    const snapshot = documents.current;
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
    const dirty = documents.hasUnsavedChanges();
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
    if (!trustedSender(event, currentDirectory)) throw new Error('Untrusted IPC sender.');
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
    if (!trustedSender(event, currentDirectory)) throw new Error('Untrusted IPC sender.');
    if (!plainObject(payload) || typeof payload.dirty !== 'boolean') {
      return rejectedIpc(
        'Dirty state must be a boolean.',
        DIAGNOSTIC_CODES.TASK_INVALID_TRANSITION
      );
    }
    const derivedDirty =
      documents.current !== null &&
      documents.original !== null &&
      documents.current.digest !== documents.original.digest;
    documents.setDirty(payload.dirty || derivedDirty);
    return toOperationDto(operationResult('state', 'success', { dirty: documents.dirty }, []));
  });
}
