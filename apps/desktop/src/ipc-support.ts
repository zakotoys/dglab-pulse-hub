import {
  dialog,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type SaveDialogOptions
} from 'electron';
import { join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomicWriteFile,
  operationResult,
  sanitizeDisplayName,
  toOperationDto
} from '@dglab-pulse-hub/application';
import { DIAGNOSTIC_CODES, location, makeDiagnostic, type Diagnostic } from '@dglab-pulse-hub/core';
import type { OperationEnvelopeDto } from '@dglab-pulse-hub/contracts';

export function trustedSender(event: IpcMainInvokeEvent, currentDirectory: string): boolean {
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

export function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}

export function confirmClose(
  window: BrowserWindow | null,
  hasUnsavedChanges: () => boolean
): boolean {
  if (!hasUnsavedChanges() || window === null) return true;
  const confirm = (
    dialog as unknown as {
      showMessageBoxSync?: (window: BrowserWindow, options: Record<string, unknown>) => number;
    }
  ).showMessageBoxSync;
  if (typeof confirm !== 'function') return false;
  return (
    confirm(window, {
      type: 'warning',
      buttons: ['Cancel', 'Close without saving'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unsaved changes',
      message: 'Close without saving the current pulse?'
    }) === 1
  );
}

export function ipcDiagnostic(
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

export function rejectedIpc(
  message: string,
  code: string = DIAGNOSTIC_CODES.EXPORT_BLOCKED
): OperationEnvelopeDto {
  return toOperationDto(
    operationResult('export', 'rejected', null, [ipcDiagnostic(code, 'error', 'export', message)])
  );
}

export function cancelledIpc(
  operation:
    'inspect' | 'export' | 'write-file' | 'edit' | 'diff' | 'batch' | 'render' | 'undo' | 'redo',
  diagnostics: readonly Diagnostic[] = []
): OperationEnvelopeDto {
  return toOperationDto(
    operationResult(operation, 'cancelled', null, [
      ...diagnostics,
      ipcDiagnostic(DIAGNOSTIC_CODES.TASK_CANCELLED, 'info', 'task', cancellationMessage(operation))
    ])
  );
}

export function failedIpc(
  operation:
    'inspect' | 'export' | 'write-file' | 'edit' | 'diff' | 'batch' | 'render' | 'undo' | 'redo',
  code: string,
  stage: Diagnostic['stage'],
  message: string
): OperationEnvelopeDto {
  return toOperationDto(
    operationResult(operation, 'failed', null, [ipcDiagnostic(code, 'error', stage, message)])
  );
}

export function rejectedOperation(
  operation: string,
  message: string,
  code: string = DIAGNOSTIC_CODES.TASK_INVALID_TRANSITION,
  stage: Diagnostic['stage'] = 'task'
): OperationEnvelopeDto {
  return toOperationDto(
    operationResult(operation, 'rejected', null, [ipcDiagnostic(code, 'error', stage, message)])
  );
}

export function previewDisplayName(
  value: string | undefined,
  format: 'svg' | 'png' | 'jpg'
): string {
  const fallback = 'pulse-preview.' + format;
  if (value === undefined) return fallback;
  const sanitized = sanitizeDisplayName(value);
  const withoutKnownExtension = sanitized.replace(/\.(?:pulse|txt|svg|png|jpe?g)$/i, '');
  const stem = withoutKnownExtension.length > 0 ? withoutKnownExtension : 'pulse-preview';
  return stem + '.' + format;
}

export function nativeOverwriteConfirmation():
  Pick<SaveDialogOptions, 'properties'> | Record<string, never> {
  return process.platform === 'linux' ? { properties: ['showOverwriteConfirmation'] } : {};
}

export function indexedOutputPath(filePath: string, index: number): string {
  if (index === 0) return filePath;
  const target = parse(filePath);
  return join(target.dir, target.name + ' (' + index + ')' + target.ext);
}

export async function writeAvailableOutput(
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

export function digestPayload(payload: unknown): string | null {
  if (
    !plainObject(payload) ||
    typeof payload.sourceDigest !== 'string' ||
    !/^[0-9a-f]{16}$/i.test(payload.sourceDigest)
  )
    return null;
  return payload.sourceDigest;
}

function cancellationMessage(
  operation:
    'inspect' | 'export' | 'write-file' | 'edit' | 'diff' | 'batch' | 'render' | 'undo' | 'redo'
): string {
  switch (operation) {
    case 'inspect':
      return 'Open operation was cancelled.';
    case 'export':
      return 'Export operation was cancelled.';
    case 'write-file':
      return 'Artifact save was cancelled.';
    case 'diff':
      return 'Diff operation was cancelled.';
    case 'batch':
      return 'Batch operation was cancelled.';
    case 'render':
      return 'Preview rendering was cancelled.';
    case 'undo':
      return 'Undo operation was cancelled.';
    case 'redo':
      return 'Redo operation was cancelled.';
    case 'edit':
      return 'Edit operation was cancelled.';
  }
}
