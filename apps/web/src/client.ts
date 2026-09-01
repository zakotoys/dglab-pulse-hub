import {
  SCHEMA_VERSION,
  RULE_VERSION,
  batchDataSchema,
  diffDataSchema,
  editDataSchema,
  exportDataSchema,
  inspectDataSchema,
  renderDataSchema,
  safeParseOperationEnvelope,
  type OperationEnvelope
} from '@dglab-pulse-hub/contracts';
import {
  documentFromInspect,
  type EditPayload,
  type WorkspaceArtifact,
  type WorkspaceClient,
  type WorkspaceDocument,
  type WorkspaceFile,
  type WorkspaceOperation
} from '@dglab-pulse-hub/workspace-ui';

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
    diagnostics: [{
      code,
      severity: status === 'cancelled' ? 'info' : 'error',
      stage: status === 'cancelled' ? 'task' : 'adapter',
      message,
      location: { path: '$' }
    }]
  };
}

function parseJsonEnvelope(value: unknown, operation: string, responseOk = true): OperationEnvelope {
  const parsed = safeParseOperationEnvelope(value);
  if (!parsed.ok) return failureEnvelope(operation, 'The processing service returned an invalid response.', 'PULSE_TASK_INVALID_TRANSITION');
  if (!responseOk && parsed.value.status === 'success') {
    return failureEnvelope(operation, 'The processing service rejected the request.', 'PULSE_TASK_INVALID_TRANSITION');
  }
  return parsed.value;
}

async function jsonResponse(response: Response, operation: string): Promise<OperationEnvelope> {
  try {
    return parseJsonEnvelope(await response.json(), operation, response.ok);
  } catch {
    return failureEnvelope(operation, response.ok
      ? 'The processing service returned an empty response.'
      : 'The processing service returned an unreadable error.');
  }
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function displayNameFromDisposition(value: string | null, fallback: string): string {
  if (value !== null) {
    const encodedMatch = /(?:^|;)\s*filename\*=UTF-8''([^;]+)/i.exec(value);
    if (encodedMatch?.[1] !== undefined) {
      try {
        const decoded = decodeURIComponent(encodedMatch[1].trim());
        if (decoded.length > 0) return decoded.replace(/[\\/\0]/g, '_').slice(0, 180);
      } catch {
        // Try the ASCII filename parameter below.
      }
    }
    const plainMatch = /(?:^|;)\s*filename=(?:"([^"]*)"|([^;]*))/i.exec(value);
    const plainName = plainMatch?.[1] ?? plainMatch?.[2]?.trim();
    if (plainName !== undefined && plainName.length > 0) {
      return plainName.replace(/[\\/\0]/g, '_').slice(0, 180);
    }
  }
  return fallback;
}

async function artifactResponse(response: Response, fallbackName: string): Promise<WorkspaceArtifact | null> {
  if (!response.ok) return null;
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    displayName: displayNameFromDisposition(response.headers.get('content-disposition'), fallbackName),
    contentType: response.headers.get('content-type') ?? undefined
  };
}

function inspectOperation(envelope: OperationEnvelope, displayName: string, text?: string): WorkspaceOperation {
  if (envelope.status !== 'success') return { envelope };
  const parsed = inspectDataSchema.safeParse(envelope.result);
  if (!parsed.success) return { envelope: failureEnvelope('inspect', 'The inspection result was invalid.', 'PULSE_TASK_INVALID_TRANSITION') };
  const document = documentFromInspect(envelope, displayName, text);
  return document === null ? { envelope } : { envelope, document };
}

function withInspectionDiagnostics(
  inspection: WorkspaceOperation,
  preceding: OperationEnvelope
): WorkspaceOperation {
  if (preceding.diagnostics.length === 0) return inspection;
  return {
    ...inspection,
    envelope: { ...inspection.envelope, diagnostics: [...preceding.diagnostics, ...inspection.envelope.diagnostics] }
  };
}

function sourceText(document: WorkspaceDocument): string | null {
  return document.text === undefined ? null : document.text;
}

function triggerDownload(bytes: Uint8Array, displayName: string, contentType = 'application/octet-stream'): void {
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = displayName.replace(/[\\/\0]/g, '_').slice(0, 180) || 'pulse-output';
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function requestBinary(
  url: string,
  init: RequestInit,
  operation: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } },
  fallbackName: string,
  signal?: AbortSignal
): Promise<WorkspaceOperation> {
  try {
    const response = await fetch(url, { ...init, signal });
    if (!response.ok) return { envelope: await jsonResponse(response, operation) };
    let result: unknown;
    try {
      result = JSON.parse(response.headers.get('x-pulse-result') ?? 'null');
    } catch {
      return { envelope: failureEnvelope(operation, 'The processing service returned an invalid binary result.', 'PULSE_TASK_INVALID_TRANSITION') };
    }
    const checked = schema.safeParse(result);
    if (!checked.success) return { envelope: failureEnvelope(operation, 'The processing service returned an invalid binary result.', 'PULSE_TASK_INVALID_TRANSITION') };
    const artifact = await artifactResponse(response, fallbackName);
    if (artifact === null) return { envelope: failureEnvelope(operation, 'The generated file could not be read.') };
    const envelope: OperationEnvelope = {
      schemaVersion: SCHEMA_VERSION,
      ruleVersion: RULE_VERSION,
      operation,
      status: 'success',
      result: checked.data as Record<string, unknown>,
      diagnostics: []
    };
    return { envelope, artifact };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return { envelope: failureEnvelope(operation, 'The processing service could not be reached.') };
  }
}

async function inspectText(text: string, displayName: string, signal?: AbortSignal): Promise<WorkspaceOperation> {
  try {
    const response = await fetch('/api/v1/pulses/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, displayName }),
      signal
    });
    return inspectOperation(await jsonResponse(response, 'inspect'), displayName, text);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return { envelope: failureEnvelope('inspect', 'Unable to reach the processing service.') };
  }
}

async function decodeQrText(text: string, signal?: AbortSignal): Promise<WorkspaceOperation> {
  try {
    const response = await fetch('/api/v1/pulses/qr/decode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: text.trim() }),
      signal
    });
    const qrEnvelope = await jsonResponse(response, 'qr-decode');
    if (qrEnvelope.status !== 'success' || typeof qrEnvelope.result !== 'object' || qrEnvelope.result === null) return { envelope: qrEnvelope };
    const downloadId = (qrEnvelope.result as { readonly downloadId?: unknown }).downloadId;
    if (typeof downloadId !== 'string') return { envelope: failureEnvelope('qr-decode', 'Decoded QR content was not staged for download.', 'PULSE_TASK_INVALID_TRANSITION') };
    const artifact = await artifactResponse(
      await fetch('/api/v1/artifacts/' + encodeURIComponent(downloadId), { signal }),
      'decoded.pulse'
    );
    if (artifact === null) return { envelope: failureEnvelope('qr-decode', 'Decoded QR content could not be downloaded.') };
    const decoded = decodeUtf8(artifact.bytes);
    if (decoded === null) return { envelope: failureEnvelope('qr-decode', 'Decoded QR content is not valid UTF-8.') };
    const inspection = await inspectText(decoded, 'decoded.pulse', signal);
    return { ...withInspectionDiagnostics(inspection, qrEnvelope), decodedText: decoded };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return { envelope: failureEnvelope('qr-decode', 'QR content could not be decoded.') };
  }
}

async function readFile(file: WorkspaceFile): Promise<string | null> {
  return decodeUtf8(file.bytes);
}

export function createWebWorkspaceClient(): WorkspaceClient {
  const client: WorkspaceClient = {
    fileMode: 'browser',

    async open(signal) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return { envelope: failureEnvelope('inspect', 'Choose a file from the browser file picker.', 'PULSE_ADAPTER_READ_FAILED', 'rejected') };
    },

    async importFile(file, signal) {
      const decoded = await readFile(file);
      if (decoded === null) {
        try {
          const body = new FormData();
          body.append('file', new Blob([file.bytes.buffer as ArrayBuffer], { type: file.type ?? 'application/octet-stream' }), file.name);
          const response = await fetch('/api/v1/pulses/inspect', { method: 'POST', body, signal });
          return { envelope: await jsonResponse(response, 'inspect') };
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          return { envelope: failureEnvelope('inspect', 'The selected file could not be imported.') };
        }
      }
      const candidate = /^https?:\/\/[^\s]+#DGLAB-PULSE#/i.test(decoded.trim())
        ? await decodeQrText(decoded, signal)
        : await inspectText(decoded, file.name, signal);
      if (candidate.document === undefined || candidate.decodedText === undefined) return candidate;
      return {
        ...candidate,
        document: { ...candidate.document, displayName: file.name, text: candidate.decodedText }
      };
    },

    inspect(text, displayName, signal) {
      return inspectText(text, displayName, signal);
    },

    decodeQr(text, signal) {
      return decodeQrText(text, signal);
    },

    async export(document, format, mode, signal) {
      const text = sourceText(document);
      if (text === null) return { envelope: failureEnvelope('export', 'The browser source text is unavailable.', 'PULSE_EXPORT_SOURCE_UNAVAILABLE', 'rejected') };
      return requestBinary(
        '/api/v1/pulses/export',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, displayName: document.displayName, format, ...(format === 'pulse-text' ? { mode } : {}) })
        },
        'export',
        exportDataSchema,
        format === 'qr-envelope' ? 'pulse.qr.jpg' : document.displayName,
        signal
      );
    },

    async renderPreview(document, format, signal) {
      const text = sourceText(document);
      if (text === null) return { envelope: failureEnvelope('render', 'The browser source text is unavailable.', 'PULSE_EXPORT_SOURCE_UNAVAILABLE', 'rejected') };
      return requestBinary(
        '/api/v1/pulses/preview',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, format, displayName: document.displayName })
        },
        'render',
        renderDataSchema,
        'pulse-preview.' + format,
        signal
      );
    },

    async edit(document, command: EditPayload, signal) {
      const text = sourceText(document);
      if (text === null) return { envelope: failureEnvelope('edit', 'The browser source text is unavailable.', 'PULSE_EXPORT_SOURCE_UNAVAILABLE', 'rejected') };
      try {
        const response = await fetch('/api/v1/pulses/edit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, displayName: document.displayName, ...command }),
          signal
        });
        const envelope = await jsonResponse(response, 'edit');
        if (envelope.status !== 'success') return { envelope };
        const parsed = editDataSchema.safeParse(envelope.result);
        if (!parsed.success || parsed.data.downloadId === undefined) return { envelope: failureEnvelope('edit', 'The edit result did not include a download handle.', 'PULSE_TASK_INVALID_TRANSITION') };
        const artifact = await artifactResponse(await fetch('/api/v1/artifacts/' + encodeURIComponent(parsed.data.downloadId), { signal }), document.displayName);
        if (artifact === null) return { envelope: failureEnvelope('edit', 'The edited document could not be downloaded.') };
        const candidate = decodeUtf8(artifact.bytes);
        if (candidate === null) return { envelope: failureEnvelope('edit', 'The edited document is not valid UTF-8.') };
        const inspection = await inspectText(candidate, document.displayName, signal);
        return { ...withInspectionDiagnostics(inspection, envelope), editData: parsed.data };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        return { envelope: failureEnvelope('edit', 'The pulse edit could not be completed.') };
      }
    },

    async assist(document, input, signal) {
      const text = sourceText(document);
      if (text === null) return { envelope: failureEnvelope('edit', 'The browser source text is unavailable.', 'PULSE_EXPORT_SOURCE_UNAVAILABLE', 'rejected') };
      try {
        const response = await fetch('/api/v1/pulses/assist', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, displayName: document.displayName, ...input }),
          signal
        });
        const envelope = await jsonResponse(response, 'edit');
        if (envelope.status !== 'success') return { envelope };
        const parsed = editDataSchema.safeParse(envelope.result);
        if (!parsed.success || parsed.data.downloadId === undefined) return { envelope: failureEnvelope('edit', 'The assisted edit did not include a download handle.', 'PULSE_TASK_INVALID_TRANSITION') };
        const artifact = await artifactResponse(await fetch('/api/v1/artifacts/' + encodeURIComponent(parsed.data.downloadId), { signal }), document.displayName);
        if (artifact === null) return { envelope: failureEnvelope('edit', 'The assisted document could not be downloaded.') };
        const candidate = decodeUtf8(artifact.bytes);
        if (candidate === null) return { envelope: failureEnvelope('edit', 'The assisted document is not valid UTF-8.') };
        const inspection = await inspectText(candidate, document.displayName, signal);
        return { ...withInspectionDiagnostics(inspection, envelope), editData: parsed.data };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        return { envelope: failureEnvelope('edit', 'The assisted edit could not be completed.') };
      }
    },

    async diff(document, comparison, signal) {
      const before = sourceText(document);
      const after = comparison === undefined ? null : await readFile(comparison);
      if (before === null || after === null) return { envelope: failureEnvelope('diff', 'Both documents must be available as UTF-8 text.', 'PULSE_RECOGNIZE_INVALID_ENCODING', 'rejected') };
      try {
        const response = await fetch('/api/v1/pulses/diff', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ before, after }),
          signal
        });
        const envelope = await jsonResponse(response, 'diff');
        if (envelope.status === 'success' && !diffDataSchema.safeParse(envelope.result).success) return { envelope: failureEnvelope('diff', 'The diff result was invalid.', 'PULSE_TASK_INVALID_TRANSITION') };
        return { envelope };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        return { envelope: failureEnvelope('diff', 'The documents could not be compared.') };
      }
    },

    async batchInspect(files, signal) {
      return batchRequest(files, 'inspect', undefined, signal);
    },

    async batchExport(files, mode, signal) {
      return batchRequest(files, 'export', mode, signal);
    },

    async undo(document, target, signal) {
      if (target === undefined || target.text === undefined) return { envelope: failureEnvelope('undo', 'No earlier browser snapshot is available.', 'PULSE_EXPORT_SOURCE_UNAVAILABLE', 'rejected') };
      return inspectText(target.text, target.displayName, signal);
    },

    async redo(document, target, signal) {
      if (target === undefined || target.text === undefined) return { envelope: failureEnvelope('redo', 'No later browser snapshot is available.', 'PULSE_EXPORT_SOURCE_UNAVAILABLE', 'rejected') };
      return inspectText(target.text, target.displayName, signal);
    },

    async downloadArtifact(id, signal) {
      if (!/^[A-Za-z0-9._~-]{1,128}$/.test(id)) return null;
      try {
        return artifactResponse(await fetch('/api/v1/artifacts/' + encodeURIComponent(id), { signal }), 'pulse-output');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        return null;
      }
    },

    async saveArtifact(artifact, suggestedName, signal) {
      if (signal?.aborted) return failureEnvelope('export', 'Download was cancelled.', 'PULSE_TASK_CANCELLED', 'cancelled');
      triggerDownload(artifact.bytes, suggestedName || artifact.displayName, artifact.contentType);
      return {
        schemaVersion: SCHEMA_VERSION,
        ruleVersion: RULE_VERSION,
        operation: 'export',
        status: 'success',
        result: { displayName: suggestedName || artifact.displayName, byteSize: artifact.bytes.byteLength },
        diagnostics: []
      };
    }
  };
  return client;
}

async function batchRequest(
  files: readonly WorkspaceFile[] | undefined,
  operation: 'inspect' | 'export',
  mode: 'source' | 'canonical' | undefined,
  signal?: AbortSignal
): Promise<WorkspaceOperation> {
  if (files === undefined || files.length === 0) return { envelope: failureEnvelope('batch', 'Choose at least one file for the batch task.', 'PULSE_TASK_INPUT_LIMIT', 'rejected') };
  const items: Array<{ id: string; displayName: string; text: string }> = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (file === undefined) continue;
    const text = decodeUtf8(file.bytes);
    if (text === null) return { envelope: failureEnvelope('batch', 'Batch files must be valid UTF-8 text.', 'PULSE_RECOGNIZE_INVALID_ENCODING', 'rejected') };
    items.push({ id: 'web-' + String(index + 1), displayName: file.name, text });
  }
  try {
    const response = await fetch('/api/v1/pulses/batch/' + operation, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items, ...(operation === 'export' && mode !== undefined ? { mode } : {}) }),
      signal
    });
    const envelope = await jsonResponse(response, 'batch');
    if (envelope.status === 'success' && !batchDataSchema.safeParse(envelope.result).success) return { envelope: failureEnvelope('batch', 'The batch result was invalid.', 'PULSE_TASK_INVALID_TRANSITION') };
    return { envelope };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return { envelope: failureEnvelope('batch', 'The batch task could not be completed.') };
  }
}
