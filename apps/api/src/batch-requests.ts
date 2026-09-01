import type { FastifyRequest } from 'fastify';
import { batchExportRequestSchema, batchRequestSchema } from '@dglab-pulse-hub/contracts';
import { DIAGNOSTIC_CODES, encodeUtf8, location, makeDiagnostic } from '@dglab-pulse-hub/core';
import {
  operationResult,
  sanitizeDisplayName,
  type BatchInput,
  type OperationResult
} from '@dglab-pulse-hub/application';
import {
  jsonBody,
  requestCancelled,
  requestContentType,
  validateJsonFieldTypes,
  validateJsonKeys
} from './http.js';

export interface BatchReadLimits {
  readonly maxBytes: number;
  readonly maxBatchFiles: number;
  readonly maxBatchTotalBytes: number;
  readonly batchConcurrency: number;
}

export type BatchApiInput = BatchInput & { readonly outputDisplayName?: string };

export interface BatchRequestData {
  readonly inputs: readonly BatchApiInput[];
  readonly concurrency: number;
  readonly maxTotalBytes: number;
  readonly mode?: 'canonical' | 'source';
}

export interface BatchRequestRead {
  readonly request: BatchRequestData | null;
  readonly error?: OperationResult<never>;
}

interface DiffDocument {
  readonly content: Uint8Array;
  readonly displayName: string;
}

export interface DiffRequestRead {
  readonly before: DiffDocument | null;
  readonly after: DiffDocument | null;
  readonly error?: OperationResult<never>;
}

export function batchRequestFailure(message: string): OperationResult<never> {
  return operationResult('batch', 'rejected', null, [
    makeDiagnostic(
      DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT,
      'error',
      'recognize',
      message,
      location('$')
    )
  ]);
}

export function batchLimitFailure(message: string): OperationResult<never> {
  return operationResult('batch', 'rejected', null, [
    makeDiagnostic(DIAGNOSTIC_CODES.TASK_INPUT_LIMIT, 'error', 'resource', message, location('$'))
  ]);
}

export function invalidSchemaFailure(path: string, message: string): OperationResult<never> {
  const safePath = /^[A-Za-z_$][A-Za-z0-9_$.[\]]*$/.test(path) && !path.includes('..') ? path : '$';
  return operationResult('request', 'rejected', null, [
    makeDiagnostic(
      DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT,
      'error',
      'recognize',
      message,
      location(safePath)
    )
  ]);
}

export async function readBatchRequest(
  request: FastifyRequest,
  limits: BatchReadLimits,
  signal: AbortSignal,
  operation: 'inspect' | 'export'
): Promise<BatchRequestRead> {
  if (signal.aborted) return { request: null, error: requestCancelled(signal) };
  const contentType = requestContentType(request);
  if (contentType === 'application/json') {
    const body = jsonBody(request);
    if (body === null)
      return { request: null, error: batchRequestFailure('Batch JSON body must be an object.') };
    const parsed = (
      operation === 'export' ? batchExportRequestSchema : batchRequestSchema
    ).safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path =
        issue === undefined
          ? '$'
          : issue.path
              .map((part) => (typeof part === 'number' ? '[' + part + ']' : String(part)))
              .join('.')
              .replace('.[', '[');
      return {
        request: null,
        error: invalidSchemaFailure(path, 'Batch request has an invalid shape.')
      };
    }
    const value = parsed.data as {
      readonly items: readonly {
        readonly id?: string;
        readonly displayName: string;
        readonly text: string;
        readonly outputDisplayName?: string;
      }[];
      readonly concurrency?: number;
      readonly maxTotalBytes?: number;
      readonly mode?: 'canonical' | 'source';
    };
    const concurrency = value.concurrency ?? limits.batchConcurrency;
    if (concurrency > limits.batchConcurrency) {
      return {
        request: null,
        error: batchLimitFailure('Requested batch concurrency exceeds the configured limit.')
      };
    }
    const maxTotalBytes = value.maxTotalBytes ?? limits.maxBatchTotalBytes;
    if (maxTotalBytes > limits.maxBatchTotalBytes) {
      return {
        request: null,
        error: batchLimitFailure('Requested batch byte limit exceeds the configured limit.')
      };
    }
    const inputs: BatchApiInput[] = [];
    let totalBytes = 0;
    for (let index = 0; index < value.items.length; index += 1) {
      const item = value.items[index];
      if (item === undefined) continue;
      const bytes = encodeUtf8(item.text);
      if (bytes.byteLength > limits.maxBytes) {
        return {
          request: null,
          error: batchLimitFailure('A batch item exceeds the configured byte limit.')
        };
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > maxTotalBytes) {
        return {
          request: null,
          error: batchLimitFailure('Batch byte count exceeds the configured limit.')
        };
      }
      inputs.push({
        ...(item.id === undefined ? {} : { id: item.id }),
        displayName: sanitizeDisplayName(item.displayName),
        content: bytes,
        ...(operation === 'export' && item.outputDisplayName !== undefined
          ? { outputDisplayName: sanitizeDisplayName(item.outputDisplayName) }
          : {})
      });
    }
    if (signal.aborted) return { request: null, error: requestCancelled(signal) };
    return {
      request: {
        inputs,
        concurrency,
        maxTotalBytes,
        ...(operation === 'export' && value.mode !== undefined ? { mode: value.mode } : {})
      }
    };
  }
  if (contentType === 'multipart/form-data') {
    return readMultipartBatchRequest(request, limits, signal, operation);
  }
  return {
    request: null,
    error: operationResult('request', 'rejected', null, [
      makeDiagnostic(
        DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT,
        'error',
        'recognize',
        'Batch requests require application/json or multipart/form-data.',
        location('$')
      )
    ])
  };
}

async function readMultipartBatchRequest(
  request: FastifyRequest,
  limits: BatchReadLimits,
  signal: AbortSignal,
  operation: 'inspect' | 'export'
): Promise<BatchRequestRead> {
  const files: Array<{ readonly displayName: string; readonly content: Uint8Array }> = [];
  let fileCount = 0;
  let totalBytes = 0;
  let exceeded = false;
  let invalidField = false;
  let concurrencyRaw: string | undefined;
  let maxTotalBytesRaw: string | undefined;
  let modeRaw: string | undefined;
  let manifestRaw: string | undefined;
  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        fileCount += 1;
        const accepted = part.fieldname === 'file' || part.fieldname === 'files';
        const chunks: Buffer[] = [];
        let itemBytes = 0;
        let itemExceeded = !accepted || fileCount > limits.maxBatchFiles;
        for await (const chunk of part.file) {
          if (signal.aborted) {
            part.file.destroy();
            return { request: null, error: requestCancelled(signal) };
          }
          if (itemExceeded || exceeded) continue;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const itemRemaining = limits.maxBytes - itemBytes;
          const batchRemaining = limits.maxBatchTotalBytes - totalBytes;
          if (buffer.byteLength > itemRemaining || buffer.byteLength > batchRemaining) {
            itemExceeded = true;
            exceeded = true;
            continue;
          }
          itemBytes += buffer.byteLength;
          totalBytes += buffer.byteLength;
          chunks.push(buffer);
        }
        if (part.file.truncated) {
          itemExceeded = true;
          exceeded = true;
        }
        if (!accepted) invalidField = true;
        else if (!itemExceeded) {
          files.push({
            displayName: sanitizeDisplayName(
              part.filename || 'item-' + String(fileCount).padStart(4, '0') + '.pulse'
            ),
            content: new Uint8Array(Buffer.concat(chunks))
          });
        }
        continue;
      }
      const field = part.fieldname;
      if (typeof part.value !== 'string') {
        invalidField = true;
        continue;
      }
      if (field === 'concurrency') {
        if (concurrencyRaw !== undefined) invalidField = true;
        else concurrencyRaw = part.value;
      } else if (field === 'maxTotalBytes') {
        if (maxTotalBytesRaw !== undefined) invalidField = true;
        else maxTotalBytesRaw = part.value;
      } else if (field === 'mode' && operation === 'export') {
        if (modeRaw !== undefined) invalidField = true;
        else modeRaw = part.value;
      } else if (field === 'manifest') {
        if (manifestRaw !== undefined) invalidField = true;
        else manifestRaw = part.value;
      } else invalidField = true;
    }
  } catch (error) {
    if (signal.aborted) return { request: null, error: requestCancelled(signal) };
    if (isMultipartLimitError(error)) {
      return {
        request: null,
        error: batchLimitFailure('Multipart batch upload exceeds a configured limit.')
      };
    }
    return { request: null, error: batchRequestFailure('Multipart batch upload is invalid.') };
  }
  if (signal.aborted) return { request: null, error: requestCancelled(signal) };
  if (invalidField)
    return {
      request: null,
      error: batchRequestFailure(
        'Multipart batch request contains unsupported or duplicate fields.'
      )
    };
  if (fileCount > limits.maxBatchFiles)
    return {
      request: null,
      error: batchLimitFailure('Batch file count exceeds the configured limit.')
    };
  if (exceeded)
    return {
      request: null,
      error: batchLimitFailure('Batch byte count exceeds the configured limit.')
    };
  if (fileCount === 0 || files.length === 0)
    return {
      request: null,
      error: batchRequestFailure('Multipart batch request must contain at least one file field.')
    };
  const concurrency = parseMultipartPositiveInteger(
    concurrencyRaw,
    limits.batchConcurrency,
    'concurrency'
  );
  if (concurrency.error !== undefined) return { request: null, error: concurrency.error };
  if (concurrency.value > limits.batchConcurrency)
    return {
      request: null,
      error: batchLimitFailure('Requested batch concurrency exceeds the configured limit.')
    };
  const maxTotalBytes = parseMultipartPositiveInteger(
    maxTotalBytesRaw,
    limits.maxBatchTotalBytes,
    'maxTotalBytes'
  );
  if (maxTotalBytes.error !== undefined) return { request: null, error: maxTotalBytes.error };
  if (maxTotalBytes.value > limits.maxBatchTotalBytes)
    return {
      request: null,
      error: batchLimitFailure('Requested batch byte limit exceeds the configured limit.')
    };
  if (
    modeRaw !== undefined &&
    operation === 'export' &&
    modeRaw !== 'canonical' &&
    modeRaw !== 'source'
  ) {
    return { request: null, error: invalidSchemaFailure('mode', 'Batch export mode is invalid.') };
  }
  const metadata = parseMultipartManifest(manifestRaw, files.length, operation);
  if (metadata.error !== undefined) return { request: null, error: metadata.error };
  const inputs: BatchApiInput[] = files.map((file, index) => ({
    ...(metadata.items[index]?.id === undefined ? {} : { id: metadata.items[index]?.id }),
    displayName: metadata.items[index]?.displayName ?? file.displayName,
    content: file.content,
    ...(operation === 'export' && metadata.items[index]?.outputDisplayName !== undefined
      ? { outputDisplayName: metadata.items[index]?.outputDisplayName }
      : {})
  }));
  if (totalBytes > maxTotalBytes.value)
    return {
      request: null,
      error: batchLimitFailure('Batch byte count exceeds the configured limit.')
    };
  return {
    request: {
      inputs,
      concurrency: concurrency.value,
      maxTotalBytes: maxTotalBytes.value,
      ...(operation === 'export' && modeRaw !== undefined
        ? { mode: modeRaw as 'canonical' | 'source' }
        : {})
    }
  };
}

function parseMultipartPositiveInteger(
  raw: string | undefined,
  fallback: number,
  field: string
): { readonly value: number; readonly error?: OperationResult<never> } {
  if (raw === undefined) return { value: fallback };
  if (!/^[0-9]+$/.test(raw))
    return {
      value: fallback,
      error: invalidSchemaFailure(field, 'Multipart batch option must be a positive integer.')
    };
  const value = Number(raw);
  if (!validPositiveSafeInteger(value))
    return {
      value: fallback,
      error: invalidSchemaFailure(field, 'Multipart batch option must be a positive integer.')
    };
  return { value };
}

function isMultipartLimitError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = String((error as { readonly code?: unknown }).code);
  return (
    code === 'FST_REQ_FILE_TOO_LARGE' ||
    code === 'FST_FILES_LIMIT' ||
    code === 'FST_FIELDS_LIMIT' ||
    code === 'FST_PARTS_LIMIT'
  );
}

interface MultipartManifestItem {
  readonly id?: string;
  readonly displayName?: string;
  readonly outputDisplayName?: string;
}

function parseMultipartManifest(
  raw: string | undefined,
  count: number,
  operation: 'inspect' | 'export'
): { readonly items: readonly MultipartManifestItem[]; readonly error?: OperationResult<never> } {
  if (raw === undefined) return { items: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      items: [],
      error: invalidSchemaFailure('manifest', 'Multipart manifest must be valid JSON.')
    };
  }
  if (!Array.isArray(value) || value.length !== count) {
    return {
      items: [],
      error: invalidSchemaFailure(
        'manifest',
        'Multipart manifest must describe every uploaded file.'
      )
    };
  }
  const items: MultipartManifestItem[] = [];
  const ids = new Set<string>();
  const allowed =
    operation === 'export' ? ['id', 'displayName', 'outputDisplayName'] : ['id', 'displayName'];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return {
        items: [],
        error: invalidSchemaFailure(
          'manifest[' + index + ']',
          'Multipart manifest item is invalid.'
        )
      };
    }
    const candidate = item as Record<string, unknown>;
    if (Object.keys(candidate).some((key) => !allowed.includes(key))) {
      return {
        items: [],
        error: invalidSchemaFailure(
          'manifest[' + index + ']',
          'Multipart manifest item contains unsupported fields.'
        )
      };
    }
    const id = candidate.id;
    const displayName = candidate.displayName;
    const outputDisplayName = candidate.outputDisplayName;
    if (
      id !== undefined &&
      (typeof id !== 'string' ||
        id.length === 0 ||
        id.length > 128 ||
        !/^[A-Za-z0-9._~-]+$/.test(id) ||
        ids.has(id))
    ) {
      return {
        items: [],
        error: invalidSchemaFailure(
          'manifest[' + index + '].id',
          'Multipart item IDs must be unique safe strings.'
        )
      };
    }
    if (typeof id === 'string') ids.add(id);
    if (
      displayName !== undefined &&
      (typeof displayName !== 'string' || displayName.length === 0)
    ) {
      return {
        items: [],
        error: invalidSchemaFailure(
          'manifest[' + index + '].displayName',
          'Multipart displayName is invalid.'
        )
      };
    }
    if (
      outputDisplayName !== undefined &&
      (typeof outputDisplayName !== 'string' || outputDisplayName.length === 0)
    ) {
      return {
        items: [],
        error: invalidSchemaFailure(
          'manifest[' + index + '].outputDisplayName',
          'Multipart outputDisplayName is invalid.'
        )
      };
    }
    items.push({
      ...(typeof id === 'string' ? { id } : {}),
      ...(typeof displayName === 'string' ? { displayName: sanitizeDisplayName(displayName) } : {}),
      ...(typeof outputDisplayName === 'string'
        ? { outputDisplayName: sanitizeDisplayName(outputDisplayName) }
        : {})
    });
  }
  return { items };
}

export async function readDiffRequest(
  request: FastifyRequest,
  limits: BatchReadLimits,
  signal: AbortSignal
): Promise<DiffRequestRead> {
  if (signal.aborted) return { before: null, after: null, error: requestCancelled(signal) };
  const contentType = requestContentType(request);
  if (contentType === 'application/json') {
    const body = jsonBody(request);
    if (body === null)
      return {
        before: null,
        after: null,
        error: invalidSchemaFailure('$', 'Diff JSON body must be an object.')
      };
    const keys = validateJsonKeys(body, ['before', 'after']);
    if (keys !== null) return { before: null, after: null, error: keys };
    const types = validateJsonFieldTypes(body, { before: 'string', after: 'string' });
    if (types !== null) return { before: null, after: null, error: types };
    if (typeof body.before !== 'string' || typeof body.after !== 'string') {
      return {
        before: null,
        after: null,
        error: invalidSchemaFailure('$', 'Diff request must contain before and after text.')
      };
    }
    const beforeBytes = encodeUtf8(body.before);
    const afterBytes = encodeUtf8(body.after);
    if (beforeBytes.byteLength > limits.maxBytes || afterBytes.byteLength > limits.maxBytes) {
      return {
        before: null,
        after: null,
        error: batchLimitFailure('A diff document exceeds the configured byte limit.')
      };
    }
    if (beforeBytes.byteLength + afterBytes.byteLength > limits.maxBatchTotalBytes) {
      return {
        before: null,
        after: null,
        error: batchLimitFailure('Diff byte count exceeds the configured limit.')
      };
    }
    return {
      before: { content: beforeBytes, displayName: 'before.pulse' },
      after: { content: afterBytes, displayName: 'after.pulse' }
    };
  }
  if (contentType !== 'multipart/form-data') {
    return {
      before: null,
      after: null,
      error: operationResult('request', 'rejected', null, [
        makeDiagnostic(
          DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT,
          'error',
          'recognize',
          'Diff requests require application/json or multipart/form-data.',
          location('$')
        )
      ])
    };
  }
  const named: { before?: DiffDocument; after?: DiffDocument } = {};
  const unnamed: DiffDocument[] = [];
  let totalBytes = 0;
  let invalid = false;
  let limitExceeded = false;
  try {
    for await (const part of request.parts()) {
      if (part.type !== 'file') {
        invalid = true;
        continue;
      }
      const acceptedName =
        part.fieldname === 'before' ||
        part.fieldname === 'after' ||
        part.fieldname === 'file' ||
        part.fieldname === 'files';
      const chunks: Buffer[] = [];
      let size = 0;
      let exceeded = !acceptedName;
      for await (const chunk of part.file) {
        if (signal.aborted) {
          part.file.destroy();
          return { before: null, after: null, error: requestCancelled(signal) };
        }
        if (exceeded) continue;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (
          buffer.byteLength > limits.maxBytes - size ||
          buffer.byteLength > limits.maxBatchTotalBytes - totalBytes
        ) {
          exceeded = true;
          limitExceeded = true;
          continue;
        }
        size += buffer.byteLength;
        totalBytes += buffer.byteLength;
        chunks.push(buffer);
      }
      if (part.file.truncated) {
        exceeded = true;
        limitExceeded = true;
      }
      if (exceeded) {
        invalid = true;
        continue;
      }
      const document: DiffDocument = {
        content: new Uint8Array(Buffer.concat(chunks)),
        displayName: sanitizeDisplayName(part.filename || 'pulse.pulse')
      };
      if (part.fieldname === 'before' || part.fieldname === 'after') {
        if (named[part.fieldname] !== undefined) invalid = true;
        else named[part.fieldname] = document;
      } else unnamed.push(document);
    }
  } catch (error) {
    if (signal.aborted) return { before: null, after: null, error: requestCancelled(signal) };
    if (isMultipartLimitError(error)) {
      return {
        before: null,
        after: null,
        error: batchLimitFailure('Multipart diff upload exceeds a configured limit.')
      };
    }
    return {
      before: null,
      after: null,
      error: invalidSchemaFailure('$', 'Multipart diff upload is invalid.')
    };
  }
  const namedCount = Number(named.before !== undefined) + Number(named.after !== undefined);
  const fileCount = namedCount + unnamed.length;
  // A diff has exactly two documents. Generic `file`/`files` parts are
  // positional; named `before`/`after` parts are explicit. Mixing those
  // forms, or silently ignoring a third part, makes the comparison
  // ambiguous and must be rejected at the transport boundary.
  const ambiguous =
    fileCount !== 2 ||
    (namedCount > 0 && unnamed.length > 0) ||
    (namedCount === 2 && (named.before === undefined || named.after === undefined));
  if (invalid || ambiguous || totalBytes > limits.maxBatchTotalBytes) {
    return {
      before: null,
      after: null,
      error:
        invalid || limitExceeded || totalBytes > limits.maxBatchTotalBytes
          ? batchLimitFailure('Multipart diff upload is invalid or exceeds a configured limit.')
          : invalidSchemaFailure(
              '$',
              'Diff multipart request must contain exactly before and after files.'
            )
    };
  }
  if (unnamed.length === 2) {
    named.before = unnamed[0];
    named.after = unnamed[1];
  }
  if (named.before === undefined || named.after === undefined) {
    return {
      before: null,
      after: null,
      error: invalidSchemaFailure(
        '$',
        'Diff multipart request must contain before and after files.'
      )
    };
  }
  return { before: named.before, after: named.after };
}

function validPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
