import {
  SCHEMA_VERSION,
  RULE_VERSION,
  batchDataSchema,
  diffDataSchema,
  editDataSchema,
  inspectDataSchema,
  renderDataSchema,
  safeParseOperationEnvelope,
  type OperationEnvelope
} from '@dglab-pulse-hub/contracts';
import {
  documentFromInspect,
  type AssistPayload,
  type EditPayload,
  type WorkspaceArtifact,
  type WorkspaceClient,
  type WorkspaceDocument,
  type LocalPulseImportResult,
  type LocalPulseIndex,
  type WorkspaceFile,
  type WorkspaceOperation
} from '@dglab-pulse-hub/workspace-ui';
import type { Locale } from '@dglab-pulse-hub/workspace-ui';

interface DesktopApi {
  readonly setLocale: (locale: Locale) => Promise<void>;
  readonly listWorkspace: () => Promise<unknown>;
  readonly importLocalFiles: (multiple: boolean) => Promise<unknown>;
  readonly openWorkspaceFile: (relativePath: string) => Promise<unknown>;
  readonly importDroppedFile: (file: File) => Promise<unknown>;
  readonly inspectCurrent: () => Promise<unknown>;
  readonly decodeQr: (payload: { readonly text: string }) => Promise<unknown>;
  readonly edit: (payload: {
    readonly sourceDigest: string;
    readonly command: EditPayload;
  }) => Promise<unknown>;
  readonly assist: (payload: { readonly sourceDigest: string } & AssistPayload) => Promise<unknown>;
  readonly diff: (payload: {
    readonly sourceDigest: string;
    readonly relativePath: string;
  }) => Promise<unknown>;
  readonly undo: (payload: { readonly sourceDigest: string }) => Promise<unknown>;
  readonly redo: (payload: { readonly sourceDigest: string }) => Promise<unknown>;
  readonly onHistoryReset: (listener: (value: unknown) => void) => () => void;
  readonly batchInspect: (payload: {
    readonly relativePaths: readonly string[];
  }) => Promise<unknown>;
  readonly batchExport: (payload: {
    readonly relativePaths: readonly string[];
    readonly mode?: 'source' | 'canonical';
  }) => Promise<unknown>;
  readonly renderPreview: (payload: {
    readonly sourceDigest: string;
    readonly displayName?: string;
    readonly format: 'svg' | 'png' | 'jpg';
  }) => Promise<unknown>;
  readonly export: (payload: {
    readonly sourceDigest: string;
    readonly displayName?: string;
    readonly format?: 'pulse-text' | 'qr-envelope';
    readonly mode?: 'source' | 'canonical';
  }) => Promise<unknown>;
  readonly saveArtifact: (payload: {
    readonly artifact: WorkspaceArtifact;
    readonly suggestedName: string;
  }) => Promise<unknown>;
}

declare global {
  interface Window {
    readonly pulseDesktop?: DesktopApi;
  }
}

function failureEnvelope(
  operation: string,
  message: string,
  code = 'PULSE_ADAPTER_READ_FAILED',
  status: 'rejected' | 'failed' | 'cancelled' = 'failed'
): OperationEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    ruleVersion: RULE_VERSION,
    operation: /^[a-z][a-z0-9-]{0,79}$/.test(operation) ? operation : 'request',
    status,
    result: null,
    diagnostics: [
      {
        code,
        severity: status === 'cancelled' ? 'info' : 'error',
        stage: status === 'cancelled' ? 'task' : 'adapter',
        message,
        location: { path: '$' }
      }
    ]
  };
}

function parseEnvelope(value: unknown, operation: string): OperationEnvelope {
  const parsed = safeParseOperationEnvelope(value);
  return parsed.ok
    ? parsed.value
    : failureEnvelope(
        operation,
        'The desktop operation returned an invalid response.',
        'PULSE_TASK_INVALID_TRANSITION'
      );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseExportResponse(value: unknown): WorkspaceOperation {
  if (!isRecord(value) || !('envelope' in value))
    return { envelope: parseEnvelope(value, 'export') };
  const envelope = parseEnvelope(value.envelope, 'export');
  if (value.artifact === undefined) return { envelope };
  if (
    !isRecord(value.artifact) ||
    !(value.artifact.bytes instanceof Uint8Array) ||
    typeof value.artifact.displayName !== 'string' ||
    value.artifact.displayName.length === 0 ||
    typeof value.artifact.contentType !== 'string'
  ) {
    return {
      envelope: failureEnvelope(
        'export',
        'The desktop export artifact was invalid.',
        'PULSE_TASK_INVALID_TRANSITION'
      )
    };
  }
  return {
    envelope,
    artifact: {
      bytes: value.artifact.bytes,
      displayName: value.artifact.displayName,
      contentType: value.artifact.contentType
    }
  };
}

function cancelled(operation: string, label = operation): OperationEnvelope {
  return failureEnvelope(operation, label + ' was cancelled.', 'PULSE_TASK_CANCELLED', 'cancelled');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function inspectOperation(envelope: OperationEnvelope): WorkspaceOperation {
  if (envelope.status !== 'success') return { envelope };
  const parsed = inspectDataSchema.safeParse(envelope.result);
  if (!parsed.success)
    return {
      envelope: failureEnvelope(
        'inspect',
        'The desktop inspection result was invalid.',
        'PULSE_TASK_INVALID_TRANSITION'
      )
    };
  const document = documentFromInspect(envelope, parsed.data.metadata.file.displayName);
  return document === null ? { envelope } : { envelope, document };
}

function mergeDiagnostics(
  operation: WorkspaceOperation,
  preceding: OperationEnvelope
): WorkspaceOperation {
  if (preceding.diagnostics.length === 0) return operation;
  return {
    ...operation,
    envelope: {
      ...operation.envelope,
      diagnostics: [...preceding.diagnostics, ...operation.envelope.diagnostics]
    }
  };
}

function apiOrThrow(): DesktopApi {
  const api = window.pulseDesktop;
  if (api === undefined) throw new Error('Desktop preload API is unavailable.');
  return api;
}

function parseLocalPulseIndex(value: unknown): LocalPulseIndex {
  if (!isRecord(value) || typeof value.rootPath !== 'string' || !Array.isArray(value.files))
    throw new Error('The desktop workspace index was invalid.');
  const files = value.files.map((file) => {
    if (
      !isRecord(file) ||
      typeof file.name !== 'string' ||
      typeof file.relativePath !== 'string' ||
      typeof file.byteSize !== 'number' ||
      typeof file.modifiedAt !== 'string'
    )
      throw new Error('The desktop workspace file entry was invalid.');
    return Object.freeze({
      name: file.name,
      relativePath: file.relativePath,
      byteSize: file.byteSize,
      modifiedAt: file.modifiedAt
    });
  });
  return Object.freeze({ rootPath: value.rootPath, files: Object.freeze(files) });
}

function parseLocalPulseImport(value: unknown): LocalPulseImportResult {
  if (!isRecord(value) || !Array.isArray(value.imported))
    throw new Error('The desktop workspace import result was invalid.');
  const index = parseLocalPulseIndex(value.index);
  const importedPaths = new Set(
    value.imported.map((file) => {
      if (!isRecord(file) || typeof file.relativePath !== 'string')
        throw new Error('The desktop imported file entry was invalid.');
      return file.relativePath;
    })
  );
  return Object.freeze({
    index,
    imported: Object.freeze(index.files.filter((file) => importedPaths.has(file.relativePath)))
  });
}

function managedPaths(files: readonly WorkspaceFile[] | undefined): readonly string[] {
  if (files === undefined || files.some((file) => !('relativePath' in file)))
    throw new Error('Managed file references are required.');
  return files.map((file) => ('relativePath' in file ? file.relativePath : ''));
}

export function createElectronWorkspaceClient(): WorkspaceClient {
  const api = apiOrThrow();
  const client: WorkspaceClient = {
    fileMode: 'native',

    async open(signal) {
      throwIfAborted(signal);
      return { envelope: failureEnvelope('inspect', 'Choose a file from the file manager.') };
    },

    localFiles: {
      async list(signal) {
        throwIfAborted(signal);
        const index = parseLocalPulseIndex(await api.listWorkspace());
        throwIfAborted(signal);
        return index;
      },
      async import(multiple, signal) {
        throwIfAborted(signal);
        const result = parseLocalPulseImport(await api.importLocalFiles(multiple));
        throwIfAborted(signal);
        return result;
      },
      async importDropped(file, signal) {
        throwIfAborted(signal);
        const result = parseLocalPulseImport(await api.importDroppedFile(file));
        throwIfAborted(signal);
        return result;
      },
      async open(relativePath, signal) {
        try {
          throwIfAborted(signal);
          const operation = inspectOperation(
            parseEnvelope(await api.openWorkspaceFile(relativePath), 'inspect')
          );
          throwIfAborted(signal);
          return operation;
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError')
            return { envelope: cancelled('inspect', 'Open') };
          return {
            envelope: failureEnvelope('inspect', 'The workspace file could not be opened.')
          };
        }
      }
    },

    async importFile(file: WorkspaceFile, signal) {
      try {
        throwIfAborted(signal);
        if (!('relativePath' in file))
          return {
            envelope: failureEnvelope(
              'inspect',
              'The native adapter requires a managed file reference.',
              'PULSE_ADAPTER_READ_FAILED',
              'rejected'
            )
          };
        const operation = await client.localFiles?.open(file.relativePath, signal);
        throwIfAborted(signal);
        return (
          operation ?? { envelope: failureEnvelope('inspect', 'The file manager is unavailable.') }
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
          return { envelope: cancelled('inspect', 'Import') };
        return { envelope: failureEnvelope('inspect', 'The dropped file could not be imported.') };
      }
    },

    async inspect(_text, _displayName, signal) {
      throwIfAborted(signal);
      return {
        envelope: failureEnvelope(
          'inspect',
          'Native inspection does not accept renderer source text.',
          'PULSE_EXPORT_SOURCE_UNAVAILABLE',
          'rejected'
        )
      };
    },

    async decodeQr(text, signal) {
      try {
        throwIfAborted(signal);
        const operation = inspectOperation(parseEnvelope(await api.decodeQr({ text }), 'inspect'));
        throwIfAborted(signal);
        return operation;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
          return { envelope: cancelled('qr-decode', 'QR decoding') };
        return { envelope: failureEnvelope('qr-decode', 'QR content could not be decoded.') };
      }
    },

    async export(document, format, mode, signal) {
      try {
        throwIfAborted(signal);
        const operation = parseExportResponse(
          await api.export({
            sourceDigest: document.digest,
            displayName: document.displayName,
            format,
            ...(format === 'pulse-text' ? { mode } : {})
          })
        );
        throwIfAborted(signal);
        return { ...operation, document };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
          return { envelope: cancelled('export', 'Export') };
        return { envelope: failureEnvelope('export', 'The selected pulse could not be exported.') };
      }
    },

    async renderPreview(document, format, signal) {
      try {
        throwIfAborted(signal);
        const envelope = parseEnvelope(
          await api.renderPreview({
            sourceDigest: document.digest,
            displayName: document.displayName,
            format
          }),
          'render'
        );
        throwIfAborted(signal);
        return { envelope, document };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
          return { envelope: cancelled('render', 'Preview rendering') };
        return { envelope: failureEnvelope('render', 'The preview could not be saved.') };
      }
    },

    async edit(document, command, signal) {
      try {
        throwIfAborted(signal);
        const editEnvelope = parseEnvelope(
          await api.edit({ sourceDigest: document.digest, command }),
          'edit'
        );
        if (editEnvelope.status !== 'success') return { envelope: editEnvelope };
        const editParsed = editDataSchema.safeParse(editEnvelope.result);
        const inspected = inspectOperation(parseEnvelope(await api.inspectCurrent(), 'inspect'));
        if (inspected.envelope.status !== 'success' || inspected.document === undefined)
          return { envelope: inspected.envelope };
        throwIfAborted(signal);
        return {
          ...mergeDiagnostics(inspected, editEnvelope),
          ...(editParsed.success ? { editData: editParsed.data } : {})
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
          return { envelope: cancelled('edit', 'Edit') };
        return { envelope: failureEnvelope('edit', 'The pulse edit could not be completed.') };
      }
    },

    async assist(document, input, signal) {
      try {
        throwIfAborted(signal);
        const editEnvelope = parseEnvelope(
          await api.assist({ sourceDigest: document.digest, ...input }),
          'edit'
        );
        if (editEnvelope.status !== 'success') return { envelope: editEnvelope };
        const editParsed = editDataSchema.safeParse(editEnvelope.result);
        const inspected = inspectOperation(parseEnvelope(await api.inspectCurrent(), 'inspect'));
        if (inspected.envelope.status !== 'success' || inspected.document === undefined)
          return { envelope: inspected.envelope };
        throwIfAborted(signal);
        return {
          ...mergeDiagnostics(inspected, editEnvelope),
          ...(editParsed.success ? { editData: editParsed.data } : {})
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
          return { envelope: cancelled('edit', 'Curve application') };
        return { envelope: failureEnvelope('edit', 'The assisted edit could not be completed.') };
      }
    },

    async diff(document, comparison, signal) {
      try {
        throwIfAborted(signal);
        if (comparison === undefined || !('relativePath' in comparison))
          return { envelope: failureEnvelope('diff', 'A managed comparison file is required.') };
        const envelope = parseEnvelope(
          await api.diff({ sourceDigest: document.digest, relativePath: comparison.relativePath }),
          'diff'
        );
        if (envelope.status === 'success' && !diffDataSchema.safeParse(envelope.result).success)
          return {
            envelope: failureEnvelope(
              'diff',
              'The diff result was invalid.',
              'PULSE_TASK_INVALID_TRANSITION'
            )
          };
        throwIfAborted(signal);
        return { envelope };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
          return { envelope: cancelled('diff', 'Diff') };
        return { envelope: failureEnvelope('diff', 'The documents could not be compared.') };
      }
    },

    async batchInspect(files, signal) {
      try {
        throwIfAborted(signal);
        const relativePaths = managedPaths(files);
        const envelope = parseEnvelope(await api.batchInspect({ relativePaths }), 'batch');
        if (envelope.status === 'success' && !batchDataSchema.safeParse(envelope.result).success)
          return {
            envelope: failureEnvelope(
              'batch',
              'The batch result was invalid.',
              'PULSE_TASK_INVALID_TRANSITION'
            )
          };
        return { envelope };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
          return { envelope: cancelled('batch', 'Batch task') };
        return { envelope: failureEnvelope('batch', 'The batch task could not be completed.') };
      }
    },

    async batchExport(files, mode, signal) {
      try {
        throwIfAborted(signal);
        const envelope = parseEnvelope(
          await api.batchExport({
            relativePaths: managedPaths(files),
            ...(mode === undefined ? {} : { mode })
          }),
          'batch'
        );
        if (envelope.status === 'success' && !batchDataSchema.safeParse(envelope.result).success)
          return {
            envelope: failureEnvelope(
              'batch',
              'The batch result was invalid.',
              'PULSE_TASK_INVALID_TRANSITION'
            )
          };
        return { envelope };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
          return { envelope: cancelled('batch', 'Batch export') };
        return { envelope: failureEnvelope('batch', 'The batch export could not be completed.') };
      }
    },

    async undo(document, _target, signal) {
      try {
        throwIfAborted(signal);
        const operation = inspectOperation(
          parseEnvelope(await api.undo({ sourceDigest: document.digest }), 'undo')
        );
        throwIfAborted(signal);
        return operation;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
          return { envelope: cancelled('undo', 'Undo') };
        return {
          envelope: failureEnvelope('undo', 'The earlier pulse snapshot could not be restored.')
        };
      }
    },

    async redo(document, _target, signal) {
      try {
        throwIfAborted(signal);
        const operation = inspectOperation(
          parseEnvelope(await api.redo({ sourceDigest: document.digest }), 'redo')
        );
        throwIfAborted(signal);
        return operation;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
          return { envelope: cancelled('redo', 'Redo') };
        return {
          envelope: failureEnvelope('redo', 'The later pulse snapshot could not be restored.')
        };
      }
    },

    async downloadArtifact(_id, signal) {
      throwIfAborted(signal);
      return null;
    },

    async saveArtifact(artifact: WorkspaceArtifact, suggestedName: string, signal) {
      try {
        throwIfAborted(signal);
        const envelope = parseEnvelope(
          await api.saveArtifact({ artifact, suggestedName }),
          'export'
        );
        throwIfAborted(signal);
        return envelope;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
          return cancelled('export', 'Export');
        return failureEnvelope('export', 'The exported artifact could not be saved.');
      }
    },

    onHistoryReset(listener) {
      return api.onHistoryReset((value) => {
        const operation = inspectOperation(parseEnvelope(value, 'inspect'));
        listener(operation);
      });
    }
  };
  return client;
}
