import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  DIAGNOSTIC_CODES,
  encodeUtf8,
  location,
  makeDiagnostic,
  type Diagnostic
} from '@dglab-pulse-hub/core';
import {
  operationResult,
  sanitizeDisplayName,
  toOperationDto,
  type OperationResult
} from '@dglab-pulse-hub/application';

const JSON_CONTENT_TYPE = 'application/json';
const RAW_CONTENT_TYPES = new Set(['text/plain', 'application/octet-stream']);
const timedOutSignals = new WeakSet<AbortSignal>();
const signalDeadlines = new WeakMap<AbortSignal, number>();

export interface RequestInput {
  readonly content: Uint8Array;
  readonly displayName: string;
  readonly error?: OperationResult<never>;
}

export interface RequestSignal {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
}

export function requestResult<T>(
  result: OperationResult<T>,
  signal: AbortSignal
): OperationResult<T> {
  const deadline = signalDeadlines.get(signal);
  if (deadline !== undefined && Date.now() >= deadline) timedOutSignals.add(signal);
  if (timedOutSignals.has(signal)) {
    return operationResult(result.operation, 'failed', null, [timeoutDiagnostic()]);
  }
  if (signal.aborted && result.status !== 'cancelled') {
    return operationResult(result.operation, 'cancelled', null, [cancelDiagnostic()]);
  }
  return result;
}

export function requestAbortSignal(
  request: FastifyRequest,
  timeoutMs?: number,
  reply?: FastifyReply
): RequestSignal {
  const controller = new AbortController();
  const raw = request.raw;
  const responseRaw = reply?.raw;
  const responseSocket = responseRaw?.socket;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const abort = (): void => controller.abort();
  const timedOut = (): void => {
    timedOutSignals.add(controller.signal);
    controller.abort();
  };
  const close = (): void => {
    if (!raw.complete) controller.abort();
  };
  const responseClose = (): void => {
    // A request body can be complete while the client disconnects during
    // processing. The response stream is the reliable signal for that case.
    if (responseRaw !== undefined && !responseRaw.writableFinished) controller.abort();
  };
  if (raw.aborted) controller.abort();
  raw.once('aborted', abort);
  raw.once('close', close);
  responseRaw?.once('close', responseClose);
  responseSocket?.once('close', responseClose);
  if (timeoutMs !== undefined && timeoutMs > 0) {
    signalDeadlines.set(controller.signal, Date.now() + timeoutMs);
    timeout = setTimeout(timedOut, timeoutMs);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timeout !== null) clearTimeout(timeout);
      raw.removeListener('aborted', abort);
      raw.removeListener('close', close);
      responseRaw?.removeListener('close', responseClose);
      responseSocket?.removeListener('close', responseClose);
    }
  };
}

export async function readRequestInput(
  request: FastifyRequest,
  maxBytes: number,
  signal?: AbortSignal
): Promise<RequestInput> {
  if (signal?.aborted)
    return { content: new Uint8Array(), displayName: 'pulse', error: requestCancelled(signal) };
  const contentType = requestContentType(request);
  if (contentType === 'multipart/form-data') return readMultipartInput(request, maxBytes, signal);
  if (contentType === JSON_CONTENT_TYPE) {
    const body = jsonBody(request);
    const text = typeof body?.text === 'string' ? body.text : null;
    if (text === null)
      return {
        content: new Uint8Array(),
        displayName: 'pulse',
        error: rejectedInput('JSON body must contain a text string.')
      };
    const bytes = encodeUtf8(text);
    if (signal?.aborted)
      return { content: new Uint8Array(), displayName: 'pulse', error: requestCancelled(signal) };
    if (bytes.byteLength > maxBytes)
      return {
        content: new Uint8Array(),
        displayName: 'pulse',
        error: rejectedInput('Request exceeds the configured byte limit.')
      };
    return {
      content: bytes,
      displayName:
        typeof body?.displayName === 'string' ? sanitizeDisplayName(body.displayName) : 'pulse'
    };
  }
  if (contentType !== '' && !RAW_CONTENT_TYPES.has(contentType)) {
    return { content: new Uint8Array(), displayName: 'pulse', error: unsupportedContentType() };
  }
  const bytes = rawRequestBytes(request);
  if (signal?.aborted)
    return { content: new Uint8Array(), displayName: 'pulse', error: requestCancelled(signal) };
  if (bytes.byteLength > maxBytes)
    return {
      content: new Uint8Array(),
      displayName: 'pulse',
      error: rejectedInput('Request exceeds the configured byte limit.')
    };
  return { content: bytes, displayName: 'pulse' };
}

export async function readTextRequest(
  request: FastifyRequest,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ readonly text: string; readonly error?: OperationResult<never> }> {
  if (signal?.aborted) return { text: '', error: requestCancelled(signal) };
  const contentType = requestContentType(request);
  if (contentType === JSON_CONTENT_TYPE) {
    const body = jsonBody(request);
    const value = typeof body?.text === 'string' ? body.text : null;
    if (value === null)
      return { text: '', error: rejectedInput('JSON body must contain a text string.') };
    if (signal?.aborted) return { text: '', error: requestCancelled(signal) };
    if (encodeUtf8(value).byteLength > maxBytes)
      return { text: '', error: rejectedInput('Request exceeds the configured byte limit.') };
    return { text: value };
  }
  if (contentType !== '' && !RAW_CONTENT_TYPES.has(contentType)) {
    return { text: '', error: unsupportedContentType() };
  }
  const bytes = rawRequestBytes(request);
  if (signal?.aborted) return { text: '', error: requestCancelled(signal) };
  if (bytes.byteLength > maxBytes)
    return { text: '', error: rejectedInput('Request exceeds the configured byte limit.') };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return {
      text: '',
      error: operationResult('request', 'rejected', null, [
        makeDiagnostic(
          DIAGNOSTIC_CODES.RECOGNIZE_INVALID_ENCODING,
          'error',
          'recognize',
          'Input is not valid UTF-8.',
          location('$')
        )
      ])
    };
  }
}

export function jsonBody(request: FastifyRequest): Record<string, unknown> | null {
  const value = request.body;
  if (
    typeof value !== 'object' ||
    value === null ||
    Buffer.isBuffer(value) ||
    value instanceof Uint8Array ||
    Array.isArray(value)
  )
    return null;
  return value as Record<string, unknown>;
}

export function validateJsonKeys(
  body: Record<string, unknown> | null,
  allowed: readonly string[]
): OperationResult<never> | null {
  // Raw requests have no JSON object to validate. JSON routes still report a
  // missing text field from their input reader, while unsupported keys are
  // rejected here instead of being silently ignored.
  if (body === null) return null;
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(body).find((key) => !allowedKeys.has(key));
  if (unknown === undefined) return null;
  const field = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(unknown) ? unknown : 'request';
  return operationResult('request', 'rejected', null, [
    makeDiagnostic(
      DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT,
      'error',
      'recognize',
      'Request contains an unsupported field.',
      location('$', undefined, { field })
    )
  ]);
}

type JsonFieldType = 'string' | 'number';

export function validateJsonFieldTypes(
  body: Record<string, unknown> | null,
  fields: Readonly<Record<string, JsonFieldType>>
): OperationResult<never> | null {
  if (body === null) return null;
  for (const [field, expected] of Object.entries(fields)) {
    const value = body[field];
    if (value === undefined) continue;
    const valid =
      expected === 'string'
        ? typeof value === 'string'
        : typeof value === 'number' && Number.isFinite(value);
    if (valid) continue;
    return operationResult('request', 'rejected', null, [
      makeDiagnostic(
        DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT,
        'error',
        'recognize',
        'Request field has an invalid type.',
        location('$', undefined, { field })
      )
    ]);
  }
  return null;
}

export function editDiagnostic(
  message: string,
  path: string,
  code: string = DIAGNOSTIC_CODES.EDIT_VALUE
): Diagnostic {
  return makeDiagnostic(code, 'error', 'semantic', message, location(path));
}

export function adapterDiagnostic(code: string, message: string): Diagnostic {
  return makeDiagnostic(code, 'error', 'adapter', message, location('$'));
}

export function rejectedInput(message: string): OperationResult<never> {
  return operationResult('request', 'rejected', null, [
    makeDiagnostic(DIAGNOSTIC_CODES.TASK_INPUT_LIMIT, 'error', 'resource', message, location('$'))
  ]);
}

export function requestCancelled(signal?: AbortSignal): OperationResult<never> {
  if (signal !== undefined && timedOutSignals.has(signal)) {
    return operationResult('request', 'failed', null, [timeoutDiagnostic()]);
  }
  return operationResult('request', 'cancelled', null, [cancelDiagnostic()]);
}

export function sendEnvelope(reply: FastifyReply, result: OperationResult<unknown>): FastifyReply {
  const envelope = toOperationDto(result);
  const timedOut = result.diagnostics.some(
    (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.TASK_TIMEOUT
  );
  const code = timedOut
    ? 408
    : result.status === 'success'
      ? 200
      : result.status === 'rejected'
        ? 422
        : result.status === 'cancelled'
          ? 499
          : 500;
  return reply.code(code).type('application/json').send(envelope);
}

export function requestContentType(request: FastifyRequest): string {
  return (
    String(request.headers?.['content-type'] ?? '')
      .split(';', 1)[0]
      ?.trim()
      .toLowerCase() ?? ''
  );
}

function rawRequestBytes(request: FastifyRequest): Uint8Array {
  const raw = request.body;
  if (typeof raw === 'string') return encodeUtf8(raw);
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw);
  if (raw instanceof Uint8Array) return new Uint8Array(raw);
  return new Uint8Array();
}

async function readMultipartInput(
  request: FastifyRequest,
  maxBytes: number,
  signal?: AbortSignal
): Promise<RequestInput> {
  try {
    let fileBytes: Uint8Array | null = null;
    let fileName = '';
    let displayName: string | undefined;
    let fileCount = 0;
    let invalidField = false;
    let exceeded = false;
    // Consume every part so malformed or over-posted multipart requests do
    // not leave unread bytes on a keep-alive connection. The public API has
    // one deliberately small shape: a `file` part and an optional
    // `displayName` field.
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        fileCount += 1;
        const acceptedPart = part.fieldname === 'file' && fileBytes === null;
        const chunks: Buffer[] = [];
        let total = 0;
        let partExceeded = false;
        for await (const chunk of part.file) {
          if (signal?.aborted) {
            part.file.destroy();
            return {
              content: new Uint8Array(),
              displayName: 'pulse',
              error: requestCancelled(signal)
            };
          }
          if (!acceptedPart || partExceeded) continue;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (buffer.byteLength > maxBytes - total) {
            partExceeded = true;
            continue;
          }
          total += buffer.byteLength;
          chunks.push(buffer);
        }
        if (partExceeded || part.file.truncated) exceeded = true;
        if (acceptedPart && !partExceeded && !part.file.truncated) {
          fileBytes = new Uint8Array(Buffer.concat(chunks));
          fileName = part.filename;
        }
        continue;
      }
      if (
        part.fieldname !== 'displayName' ||
        displayName !== undefined ||
        typeof part.value !== 'string'
      ) {
        invalidField = true;
        continue;
      }
      displayName = part.value;
    }
    if (invalidField) {
      return {
        content: new Uint8Array(),
        displayName: 'pulse',
        error: rejectedInput('Multipart request contains unsupported fields.')
      };
    }
    if (fileBytes === null || fileCount !== 1) {
      return {
        content: new Uint8Array(),
        displayName: 'pulse',
        error: rejectedInput('Multipart request must contain exactly one file field.')
      };
    }
    if (exceeded) {
      return {
        content: new Uint8Array(),
        displayName: 'pulse',
        error: rejectedInput('Uploaded file exceeds the byte limit.')
      };
    }
    if (signal?.aborted)
      return { content: new Uint8Array(), displayName: 'pulse', error: requestCancelled(signal) };
    return {
      content: fileBytes,
      displayName: sanitizeDisplayName(displayName ?? (fileName || 'pulse'))
    };
  } catch {
    return {
      content: new Uint8Array(),
      displayName: 'pulse',
      error: rejectedInput('Multipart upload is invalid or exceeds the byte limit.')
    };
  }
}

function unsupportedContentType(): OperationResult<never> {
  return operationResult('request', 'rejected', null, [
    makeDiagnostic(
      DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT,
      'error',
      'recognize',
      'Request content type is not supported.',
      location('$')
    )
  ]);
}

function cancelDiagnostic(): Diagnostic {
  return makeDiagnostic(
    DIAGNOSTIC_CODES.TASK_CANCELLED,
    'info',
    'task',
    'Request was cancelled.',
    location('$')
  );
}

function timeoutDiagnostic(): Diagnostic {
  return makeDiagnostic(
    DIAGNOSTIC_CODES.TASK_TIMEOUT,
    'error',
    'task',
    'Request processing exceeded the configured timeout.',
    location('$')
  );
}
