import {
  DIAGNOSTIC_CODES,
  makeDiagnostic,
  location,
  sortDiagnostics,
  type Diagnostic
} from '@dglab-pulse-hub/core';
import {
  inspectPulse,
  exportPulse,
  type ExportData,
  type InputDescriptor,
  type InspectData
} from './single.js';
import { operationResult, type OperationResult, type OperationStatus } from './result.js';
import { sanitizeDisplayName } from './filesystem.js';

export interface BatchInput {
  readonly id?: string;
  readonly displayName: string;
  readonly content: string | Uint8Array;
  /** Adapter failures can be carried into the per-item result without fake parsing. */
  readonly diagnostics?: readonly Diagnostic[];
}

export interface BatchProgress {
  readonly total: number;
  readonly completed: number;
  readonly succeeded: number;
  readonly rejected: number;
  readonly failed: number;
  readonly warningFiles: number;
  readonly cancelled: boolean;
}

export interface BatchItem<T> {
  readonly id: string;
  readonly index: number;
  readonly displayName: string;
  readonly status: OperationStatus;
  readonly diagnostics: readonly Diagnostic[];
  readonly data: T | null;
}

export interface BatchData<T> extends BatchProgress {
  readonly items: readonly BatchItem<T>[];
}

export interface BatchOptions {
  readonly concurrency?: number;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  /** Maximum bytes accepted by each nested single-file operation. */
  readonly maxBytes?: number;
  readonly maxExpandedPoints?: number;
  readonly maxExpandedDurationMs?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: BatchProgress) => void;
}

const DEFAULT_BATCH_LIMITS = Object.freeze({
  concurrency: 4,
  maxFiles: 100,
  maxTotalBytes: 20_000_000,
  maxBytes: 2_000_000
});

function batchLimitDiagnostic(message: string): Diagnostic {
  return makeDiagnostic(
    DIAGNOSTIC_CODES.TASK_INPUT_LIMIT,
    'error',
    'resource',
    message,
    location('$')
  );
}

function validPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validateBatchOptions(options: BatchOptions): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [name, value] of [
    ['concurrency', options.concurrency],
    ['maxFiles', options.maxFiles],
    ['maxTotalBytes', options.maxTotalBytes],
    ['maxBytes', options.maxBytes],
    ['maxExpandedPoints', options.maxExpandedPoints],
    ['maxExpandedDurationMs', options.maxExpandedDurationMs]
  ] as const) {
    if (value !== undefined && !validPositiveSafeInteger(value)) {
      diagnostics.push(batchLimitDiagnostic('Batch ' + name + ' must be a positive safe integer.'));
    }
  }
  return diagnostics;
}

function validateBatchInputs(inputs: unknown): readonly Diagnostic[] {
  if (!Array.isArray(inputs)) {
    return [batchLimitDiagnostic('Batch inputs must be an array.')];
  }
  const diagnostics: Diagnostic[] = [];
  const ids = new Set<string>();
  inputs.forEach((value, index) => {
    if (value === null || typeof value !== 'object') {
      diagnostics.push(batchLimitDiagnostic('Batch item ' + index + ' must be an object.'));
      return;
    }
    const item = value as Partial<BatchInput>;
    if (typeof item.displayName !== 'string' || item.displayName.length === 0) {
      diagnostics.push(batchLimitDiagnostic('Batch item ' + index + ' must have a displayName.'));
    }
    if (typeof item.content !== 'string' && !(item.content instanceof Uint8Array)) {
      diagnostics.push(
        batchLimitDiagnostic('Batch item ' + index + ' content must be text or bytes.')
      );
    }
    const id = item.id ?? 'item-' + String(index + 1).padStart(4, '0');
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      id.length > 128 ||
      !/^[A-Za-z0-9._~-]+$/.test(id) ||
      ids.has(id)
    ) {
      diagnostics.push(
        batchLimitDiagnostic('Batch item IDs must use safe characters and be unique.')
      );
    } else {
      ids.add(id);
    }
  });
  return diagnostics;
}

function itemId(item: BatchInput, index: number): string {
  return item.id ?? 'item-' + String(index + 1).padStart(4, '0');
}

async function runBatch<T>(
  inputs: readonly BatchInput[],
  operation: (input: BatchInput, signal: AbortSignal | undefined) => OperationResult<T>,
  options: BatchOptions = {}
): Promise<OperationResult<BatchData<T>>> {
  const safeOptions: BatchOptions = options !== null && typeof options === 'object' ? options : {};
  const optionDiagnostics = validateBatchOptions(safeOptions);
  const inputDiagnostics = validateBatchInputs(inputs);
  if (optionDiagnostics.length > 0 || inputDiagnostics.length > 0) {
    return operationResult('batch', 'rejected', null, [...optionDiagnostics, ...inputDiagnostics]);
  }
  const limits = { ...DEFAULT_BATCH_LIMITS, ...safeOptions };
  let totalBytes = 0;
  try {
    for (const item of inputs) {
      const itemBytes =
        typeof item.content === 'string'
          ? new TextEncoder().encode(item.content).byteLength
          : item.content.byteLength;
      if (itemBytes > limits.maxBytes) {
        return operationResult('batch', 'rejected', null, [
          batchLimitDiagnostic('A batch item exceeds the configured byte limit.')
        ]);
      }
      totalBytes =
        totalBytes > Number.MAX_SAFE_INTEGER - itemBytes
          ? Number.MAX_SAFE_INTEGER
          : totalBytes + itemBytes;
    }
  } catch {
    return operationResult('batch', 'rejected', null, [
      batchLimitDiagnostic('Batch content could not be read.')
    ]);
  }
  if (inputs.length === 0) {
    return operationResult('batch', 'rejected', null, [
      batchLimitDiagnostic('At least one batch input is required.')
    ]);
  }
  if (inputs.length > limits.maxFiles) {
    const diagnostic = batchLimitDiagnostic('Batch file count exceeds the configured limit.');
    return operationResult('batch', 'rejected', null, [diagnostic]);
  }
  if (totalBytes > limits.maxTotalBytes) {
    const diagnostic = batchLimitDiagnostic('Batch byte count exceeds the configured limit.');
    return operationResult('batch', 'rejected', null, [diagnostic]);
  }
  const workerCount = Math.max(1, Math.min(limits.concurrency, Math.max(1, inputs.length)));
  const items: Array<BatchItem<T> | undefined> = new Array(inputs.length);
  let nextIndex = 0;
  let completed = 0;
  let succeeded = 0;
  let rejected = 0;
  let failed = 0;
  let warningFiles = 0;
  let cancelled = false;
  const report = (): void => {
    try {
      safeOptions.onProgress?.({
        total: inputs.length,
        completed,
        succeeded,
        rejected,
        failed,
        warningFiles,
        cancelled
      });
    } catch {
      // Progress observers are side effects and must not corrupt the batch.
    }
  };
  const worker = async (): Promise<void> => {
    while (true) {
      if (safeOptions.signal?.aborted) {
        cancelled = true;
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= inputs.length) return;
      const input = inputs[index];
      if (input === undefined) continue;
      let result: OperationResult<T>;
      try {
        result =
          input.diagnostics !== undefined && input.diagnostics.length > 0
            ? operationResult('batch-item', 'failed', null, input.diagnostics)
            : operation(input, safeOptions.signal);
        if (result.status !== 'success' && result.diagnostics.length === 0) {
          result = operationResult('batch-item', result.status, null, [
            makeDiagnostic(
              result.status === 'cancelled'
                ? DIAGNOSTIC_CODES.TASK_CANCELLED
                : DIAGNOSTIC_CODES.ADAPTER_READ,
              result.status === 'cancelled' ? 'info' : 'error',
              result.status === 'cancelled' ? 'task' : 'adapter',
              result.status === 'cancelled'
                ? 'Batch item was cancelled.'
                : 'Batch item returned no diagnostics.',
              location('items[' + index + ']')
            )
          ]);
        }
        if (!['success', 'rejected', 'failed', 'cancelled'].includes(result.status)) {
          result = operationResult('batch-item', 'failed', null, [
            makeDiagnostic(
              DIAGNOSTIC_CODES.ADAPTER_READ,
              'error',
              'adapter',
              'Batch operation returned an invalid status.',
              location('items[' + index + ']')
            )
          ]);
        } else if (result.status === 'success' && result.data === null) {
          result = operationResult('batch-item', 'failed', null, [
            makeDiagnostic(
              DIAGNOSTIC_CODES.ADAPTER_READ,
              'error',
              'adapter',
              'Successful batch operation returned no result data.',
              location('items[' + index + ']')
            )
          ]);
        } else if (result.status !== 'success' && result.data !== null) {
          result = operationResult('batch-item', result.status, null, [
            ...result.diagnostics,
            makeDiagnostic(
              DIAGNOSTIC_CODES.ADAPTER_READ,
              'error',
              'adapter',
              'Non-successful batch operation returned result data.',
              location('items[' + index + ']')
            )
          ]);
        }
      } catch {
        result = operationResult('batch-item', 'failed', null, [
          makeDiagnostic(
            'PULSE_ADAPTER_READ_FAILED',
            'error',
            'adapter',
            'Batch item could not be processed.',
            location('items[' + index + ']')
          )
        ]);
      }
      const itemDiagnostics = sortDiagnostics(result.diagnostics);
      const item: BatchItem<T> = {
        id: itemId(input, index),
        index,
        displayName: sanitizeDisplayName(input.displayName),
        status: result.status,
        diagnostics: itemDiagnostics,
        data: result.data
      };
      items[index] = Object.freeze(item);
      completed += 1;
      if (result.status === 'success') succeeded += 1;
      else if (result.status === 'rejected') rejected += 1;
      else if (result.status === 'failed') failed += 1;
      else if (result.status === 'cancelled') cancelled = true;
      if (itemDiagnostics.some((diagnostic) => diagnostic.severity === 'warning')) {
        warningFiles += 1;
      }
      report();
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (safeOptions.signal?.aborted) cancelled = true;
  const finalizedItems = inputs.map((input, index) => {
    const existing = items[index];
    if (existing !== undefined) return existing;
    const diagnostics = [
      makeDiagnostic(
        DIAGNOSTIC_CODES.TASK_CANCELLED,
        'info',
        'task',
        'Batch item was cancelled before processing.',
        location('items[' + index + ']')
      )
    ];
    completed += 1;
    cancelled = true;
    return Object.freeze({
      id: itemId(input, index),
      index,
      displayName: sanitizeDisplayName(input.displayName),
      status: 'cancelled' as const,
      diagnostics,
      data: null
    });
  });
  const progress: BatchProgress = {
    total: inputs.length,
    completed,
    succeeded,
    rejected,
    failed,
    warningFiles,
    cancelled
  };
  report();
  // The public envelope carries the detailed item table only for a successful
  // batch. Every terminal non-success state is represented by a null payload.
  const status: OperationStatus = cancelled
    ? 'cancelled'
    : succeeded > 0
      ? 'success'
      : failed > 0
        ? 'failed'
        : 'rejected';
  const diagnostics = sortDiagnostics(finalizedItems.flatMap((item) => item.diagnostics));
  const data: BatchData<T> = Object.freeze({
    ...progress,
    items: Object.freeze(finalizedItems)
  });
  return operationResult('batch', status, status === 'success' ? data : null, diagnostics);
}

export function inspectBatch(
  inputs: readonly BatchInput[],
  options: BatchOptions = {}
): Promise<OperationResult<BatchData<InspectData>>> {
  const safeOptions: BatchOptions = options !== null && typeof options === 'object' ? options : {};
  return runBatch(
    inputs,
    (input, signal) =>
      inspectPulse(input.content, {
        input: { displayName: input.displayName },
        maxExpandedPoints: safeOptions.maxExpandedPoints,
        maxExpandedDurationMs: safeOptions.maxExpandedDurationMs,
        maxBytes: safeOptions.maxBytes,
        signal
      }),
    safeOptions
  );
}

export interface BatchExportInput extends BatchInput {
  readonly outputDisplayName?: string;
}

export interface BatchExportOptions extends BatchOptions {
  readonly mode?: 'canonical' | 'source';
}

export function exportBatch(
  inputs: readonly BatchExportInput[],
  options: BatchExportOptions = {}
): Promise<OperationResult<BatchData<ExportData>>> {
  if (!Array.isArray(inputs)) {
    return Promise.resolve(
      operationResult('batch', 'rejected', null, [
        batchLimitDiagnostic('Batch inputs must be an array.')
      ])
    );
  }
  const seen = new Set<string>();
  const duplicateDiagnostics: Diagnostic[] = [];
  inputs.forEach((input, index) => {
    if (input === null || typeof input !== 'object' || typeof input.displayName !== 'string')
      return;
    const requestedOutput =
      input.outputDisplayName ?? input.displayName.replace(/\.[^.]+$/, '') + '.pulse';
    const output = sanitizeDisplayName(requestedOutput);
    if (seen.has(output)) {
      duplicateDiagnostics.push(
        makeDiagnostic(
          DIAGNOSTIC_CODES.ADAPTER_CONFLICT,
          'error',
          'adapter',
          'Batch output names must be unique.',
          location('items[' + index + '].output')
        )
      );
    }
    seen.add(output);
  });
  if (duplicateDiagnostics.length > 0) {
    return Promise.resolve(operationResult('batch', 'rejected', null, duplicateDiagnostics));
  }
  const safeOptions: BatchExportOptions =
    options !== null && typeof options === 'object' ? options : {};
  return runBatch(
    inputs,
    (input, signal) =>
      exportPulse(input.content, {
        displayName: sanitizeDisplayName(
          (input as BatchExportInput).outputDisplayName ??
            input.displayName.replace(/\.[^.]+$/, '') + '.pulse'
        ),
        mode: safeOptions.mode,
        maxBytes: safeOptions.maxBytes,
        signal
      }),
    safeOptions
  );
}
