import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from 'fastify';
import multipart from '@fastify/multipart';
import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectBatch,
  exportBatch,
  applyPulseAssist,
  applyPulseEdit,
  diffPulses,
  decodeQr,
  encodeQr,
  exportPulse,
  inspectPulse,
  renderPreviewImage,
  sanitizeDisplayName,
  TempArtifactStore,
  toOperationDto,
  operationResult,
  type BatchInput,
  type BatchData,
  type ExportData,
  type EditCommand,
  type OperationResult
} from '@dglab-pulse-hub/application';
import {
  DIAGNOSTIC_CODES,
  encodeUtf8,
  location,
  makeDiagnostic,
  normalizeDecimal,
  parsePulse,
  sortDiagnostics,
  sourceSpan,
  type ControlPoint,
  type Diagnostic
} from '@dglab-pulse-hub/core';
import {
  batchExportRequestSchema,
  batchRequestSchema
} from '@dglab-pulse-hub/contracts';

export interface ApiOptions {
  readonly maxBytes?: number;
  readonly maxExpandedPoints?: number;
  readonly maxExpandedDurationMs?: number;
  readonly maxBatchFiles?: number;
  readonly maxBatchTotalBytes?: number;
  readonly batchConcurrency?: number;
  readonly processingTimeoutMs?: number;
  readonly artifactLifetimeMs?: number;
  readonly artifactCleanupIntervalMs?: number;
  readonly artifactStore?: TempArtifactStore;
  readonly logger?: boolean;
  /** Set an explicit origin when the API is served separately from the web UI. */
  readonly corsOrigin?: string;
}

const DEFAULT_API_LIMITS = Object.freeze({
  maxBytes: 2_000_000,
  maxExpandedPoints: 1_000_000,
  maxExpandedDurationMs: 86_400_000,
  maxBatchFiles: 100,
  maxBatchTotalBytes: 20_000_000,
  batchConcurrency: 4,
  processingTimeoutMs: 90_000,
  artifactLifetimeMs: 15 * 60 * 1000,
  artifactCleanupIntervalMs: 60 * 1000
});

const JSON_CONTENT_TYPES = ['application/json'];
const RAW_CONTENT_TYPES = ['text/plain', 'application/octet-stream'];
const timedOutSignals = new WeakSet<AbortSignal>();
const signalDeadlines = new WeakMap<AbortSignal, number>();

function validPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validIndex(value: unknown): value is number {
  return validNonNegativeSafeInteger(value);
}

function isOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' && parsed.password === '' &&
      parsed.pathname === '/' && parsed.search === '' && parsed.hash === '';
  } catch {
    return false;
  }
}

interface RequestInput {
  readonly content: Uint8Array;
  readonly displayName: string;
  readonly error?: OperationResult<never>;
}

interface RequestSignal {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
}

interface BatchRequestData {
  readonly inputs: readonly BatchApiInput[];
  readonly concurrency: number;
  readonly maxTotalBytes: number;
  readonly mode?: 'canonical' | 'source';
}

type BatchApiInput = BatchInput & { readonly outputDisplayName?: string };

interface BatchRequestRead {
  readonly request: BatchRequestData | null;
  readonly error?: OperationResult<never>;
}

type MultipartFilePart = Extract<Awaited<ReturnType<FastifyRequest['file']>>, { readonly type: 'file' }>;

export function buildServer(options: ApiOptions = {}): FastifyInstance {
  if (options.maxBytes !== undefined && !validPositiveSafeInteger(options.maxBytes)) {
    throw new RangeError('API maxBytes must be a positive safe integer.');
  }
  if (options.maxExpandedPoints !== undefined && !validPositiveSafeInteger(options.maxExpandedPoints)) {
    throw new RangeError('API maxExpandedPoints must be a positive safe integer.');
  }
  if (options.maxExpandedDurationMs !== undefined && !validPositiveSafeInteger(options.maxExpandedDurationMs)) {
    throw new RangeError('API maxExpandedDurationMs must be a positive safe integer.');
  }
  if (options.maxBatchFiles !== undefined && !validPositiveSafeInteger(options.maxBatchFiles)) {
    throw new RangeError('API maxBatchFiles must be a positive safe integer.');
  }
  if (options.maxBatchTotalBytes !== undefined && !validPositiveSafeInteger(options.maxBatchTotalBytes)) {
    throw new RangeError('API maxBatchTotalBytes must be a positive safe integer.');
  }
  if (options.batchConcurrency !== undefined && !validPositiveSafeInteger(options.batchConcurrency)) {
    throw new RangeError('API batchConcurrency must be a positive safe integer.');
  }
  if (options.processingTimeoutMs !== undefined && !validPositiveSafeInteger(options.processingTimeoutMs)) {
    throw new RangeError('API processingTimeoutMs must be a positive safe integer.');
  }
  if (options.artifactLifetimeMs !== undefined && !validPositiveSafeInteger(options.artifactLifetimeMs)) {
    throw new RangeError('API artifactLifetimeMs must be a positive safe integer.');
  }
  if (options.artifactCleanupIntervalMs !== undefined && !validPositiveSafeInteger(options.artifactCleanupIntervalMs)) {
    throw new RangeError('API artifactCleanupIntervalMs must be a positive safe integer.');
  }
  if (options.corsOrigin !== undefined &&
      (typeof options.corsOrigin !== 'string' || options.corsOrigin.length === 0 ||
       (options.corsOrigin !== '*' && !isOrigin(options.corsOrigin)))) {
    throw new RangeError('API corsOrigin must be "*" or a valid origin.');
  }
  const limits = { ...DEFAULT_API_LIMITS, ...options };
  const artifactStore = options.artifactStore ?? new TempArtifactStore(
    limits.artifactLifetimeMs,
    limits.artifactCleanupIntervalMs
  );
  const ownsArtifactStore = options.artifactStore === undefined;
  const app = Fastify({
    logger: options.logger === true,
    // JSON envelopes add a small amount of framing; routes still enforce the
    // raw waveform byte limit before invoking application code.
    bodyLimit: Math.max(limits.maxBytes, limits.maxBatchTotalBytes) + 65_536
  });

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body)
  );
  void app.register(multipart, {
    // Let the adapter observe `truncated` and return the same contract
    // envelope as its own byte accounting.  Multipart's default exception
    // would otherwise bypass the operation mapper with a generic 413.
    throwFileSizeLimit: false,
    limits: {
      fileSize: limits.maxBytes,
      fieldSize: Math.min(limits.maxBytes, limits.maxBatchTotalBytes),
      files: limits.maxBatchFiles,
      fields: Math.max(8, limits.maxBatchFiles + 8),
      parts: limits.maxBatchFiles * 2 + 12
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('cross-origin-resource-policy', options.corsOrigin === undefined ? 'same-origin' : 'cross-origin');
    reply.header('cache-control', 'no-store');
    const requestOrigin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
    const corsAllowed = options.corsOrigin !== undefined &&
      (options.corsOrigin === '*' || requestOrigin === undefined || requestOrigin === options.corsOrigin);
    if (corsAllowed) {
      reply.header('access-control-allow-origin', options.corsOrigin);
      reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
      reply.header('access-control-allow-headers', 'content-type');
      reply.header('access-control-max-age', '600');
      reply.header('access-control-expose-headers', 'content-disposition,x-pulse-result,x-pulse-schema-version,x-pulse-rule-version,x-pulse-stream-digest');
      reply.header('vary', 'Origin');
    }
    return payload;
  });

  if (options.corsOrigin !== undefined) {
    app.options('*', async (request, reply) => {
      const requestOrigin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
      if (options.corsOrigin !== '*' && requestOrigin !== undefined && requestOrigin !== options.corsOrigin) {
        return reply.code(403).send();
      }
      return reply.code(204).send();
    });
  }

  app.addHook('onClose', async () => {
    if (ownsArtifactStore) await artifactStore.dispose();
    else await artifactStore.cleanupExpired();
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await artifactStore.init();
      return {
        status: 'ready',
        schemaVersion: 'pulse-contract-v1',
        ruleVersion: 'pulse-rules-v1'
      };
    } catch {
      return reply.code(503).send({ status: 'not-ready' });
    }
  });

  app.post('/api/v1/pulses/inspect', async (request, reply) => {
    const requestSignal = requestAbortSignal(request, limits.processingTimeoutMs, reply);
    try {
      const input = await readRequestInput(request, limits.maxBytes, requestSignal.signal);
      if (input.error !== undefined) return sendEnvelope(reply, input.error);
      const body = jsonBody(request);
      const bodyError = validateJsonKeys(body, ['text', 'displayName']);
      if (bodyError !== null) return sendEnvelope(reply, bodyError);
      const typeError = validateJsonFieldTypes(body, {
        text: 'string',
        displayName: 'string'
      });
      if (typeError !== null) return sendEnvelope(reply, typeError);
      const result = inspectPulse(input.content, {
        input: { displayName: input.displayName, bytes: input.content.byteLength },
        maxBytes: limits.maxBytes,
        maxExpandedPoints: limits.maxExpandedPoints,
        maxExpandedDurationMs: limits.maxExpandedDurationMs,
        signal: requestSignal.signal
      });
      return sendEnvelope(reply, requestResult(result, requestSignal.signal));
    } finally {
      requestSignal.dispose();
    }
  });

  app.post('/api/v1/pulses/batch/inspect', async (request, reply) => {
    const requestSignal = requestAbortSignal(request, limits.processingTimeoutMs, reply);
    try {
      const parsed = await readBatchRequest(request, limits, requestSignal.signal, 'inspect');
      if (parsed.error !== undefined) return sendEnvelope(reply, parsed.error);
      if (parsed.request === null) return sendEnvelope(reply, batchRequestFailure('Batch request could not be read.'));
      const result = await inspectBatch(parsed.request.inputs, {
        concurrency: parsed.request.concurrency,
        maxFiles: limits.maxBatchFiles,
        maxTotalBytes: parsed.request.maxTotalBytes,
        maxBytes: limits.maxBytes,
        maxExpandedPoints: limits.maxExpandedPoints,
        maxExpandedDurationMs: limits.maxExpandedDurationMs,
        signal: requestSignal.signal
      });
      return sendEnvelope(reply, requestResult(result, requestSignal.signal));
    } finally {
      requestSignal.dispose();
    }
  });

  app.post('/api/v1/pulses/batch/export', async (request, reply) => {
    const requestSignal = requestAbortSignal(request, limits.processingTimeoutMs, reply);
    try {
      const parsed = await readBatchRequest(request, limits, requestSignal.signal, 'export');
      if (parsed.error !== undefined) return sendEnvelope(reply, parsed.error);
      if (parsed.request === null) return sendEnvelope(reply, batchRequestFailure('Batch request could not be read.'));
      const result = await exportBatch(parsed.request.inputs as readonly (BatchInput & { readonly outputDisplayName?: string })[], {
        concurrency: parsed.request.concurrency,
        maxFiles: limits.maxBatchFiles,
        maxTotalBytes: parsed.request.maxTotalBytes,
        maxBytes: limits.maxBytes,
        mode: parsed.request.mode,
        signal: requestSignal.signal
      });
      const effective = requestResult(result, requestSignal.signal);
      if (effective.status !== 'success' || effective.data === null) {
        return sendEnvelope(reply, effective);
      }
      const staged = await stageBatchExports(effective.data, artifactStore, requestSignal.signal);
      return sendEnvelope(reply, requestResult(staged, requestSignal.signal));
    } finally {
      requestSignal.dispose();
    }
  });

  app.post('/api/v1/pulses/diff', async (request, reply) => {
    const requestSignal = requestAbortSignal(request, limits.processingTimeoutMs, reply);
    try {
      const parsed = await readDiffRequest(request, limits, requestSignal.signal);
      if (parsed.error !== undefined) return sendEnvelope(reply, parsed.error);
      if (parsed.before === null || parsed.after === null) {
        return sendEnvelope(reply, batchRequestFailure('Diff request must contain before and after documents.'));
      }
      const result = diffPulses(parsed.before.content, parsed.after.content, {
        maxBytes: limits.maxBytes,
        signal: requestSignal.signal
      });
      return sendEnvelope(reply, requestResult(result, requestSignal.signal));
    } finally {
      requestSignal.dispose();
    }
  });

  app.post('/api/v1/pulses/export', async (request, reply) => {
    const requestSignal = requestAbortSignal(request, limits.processingTimeoutMs, reply);
    try {
      const input = await readRequestInput(request, limits.maxBytes, requestSignal.signal);
      if (input.error !== undefined) return sendEnvelope(reply, input.error);
      const body = jsonBody(request);
      const bodyError = validateJsonKeys(body, ['text', 'displayName', 'format', 'mode']);
      if (bodyError !== null) return sendEnvelope(reply, bodyError);
      const typeError = validateJsonFieldTypes(body, {
        text: 'string',
        displayName: 'string',
        format: 'string',
        mode: 'string'
      });
      if (typeError !== null) return sendEnvelope(reply, typeError);
      const requestedFormat = body?.format;
      const format = requestedFormat === undefined
        ? undefined
        : requestedFormat as 'pulse-text' | 'qr-envelope';
      const mode = body?.mode as 'canonical' | 'source' | undefined;
      const result = exportPulse(input.content, {
        maxBytes: limits.maxBytes,
        displayName: typeof body?.displayName === 'string'
          ? sanitizeDisplayName(body.displayName)
          : 'pulse.pulse',
        format,
        mode,
        signal: requestSignal.signal
      });
      const effective = requestResult(result, requestSignal.signal);
      if (effective.status !== 'success' || effective.data === null) return sendEnvelope(reply, effective);
      const displayName = asciiDisplayName(effective.data.displayName);
      const dto = toOperationDto({
        ...effective,
        data: { ...effective.data, displayName }
      });
      return reply
        .code(200)
        .header('content-type', effective.data.contentType ?? 'text/plain; charset=utf-8')
        .header('content-disposition', contentDisposition(displayName))
        .header('x-pulse-schema-version', 'pulse-contract-v1')
        .header('x-pulse-rule-version', 'pulse-rules-v1')
        .header('x-pulse-result', JSON.stringify(dto.result))
        .send(Buffer.from(effective.data.bytes));
    } finally {
      requestSignal.dispose();
    }
  });

  app.post('/api/v1/pulses/qr/decode', async (request, reply) => {
    const requestSignal = requestAbortSignal(request, limits.processingTimeoutMs, reply);
    try {
      const input = await readTextRequest(request, limits.maxBytes, requestSignal.signal);
      if (input.error !== undefined) return sendEnvelope(reply, input.error);
      const bodyError = validateJsonKeys(jsonBody(request), ['text']);
      if (bodyError !== null) return sendEnvelope(reply, bodyError);
      const typeError = validateJsonFieldTypes(jsonBody(request), { text: 'string' });
      if (typeError !== null) return sendEnvelope(reply, typeError);
      const decoded = decodeQr(input.text, { maxDecodedBytes: limits.maxBytes });
      const diagnostics = [...decoded.diagnostics];
      if (!decoded.accepted || decoded.pulseText === null) {
        return sendEnvelope(reply, requestResult(operationResult('qr-decode', 'rejected', null, diagnostics), requestSignal.signal));
      }
      const parsed = parsePulse(decoded.pulseText, { maxBytes: limits.maxBytes });
      diagnostics.push(...parsed.diagnostics);
      if (parsed.pulse === null || diagnostics.some((item) => item.severity === 'error')) {
        return sendEnvelope(reply, requestResult(operationResult('qr-decode', 'rejected', null, diagnostics), requestSignal.signal));
      }
      let stagedArtifactId: string | null = null;
      try {
        const artifact = await putRequestArtifact(
          artifactStore,
          'decoded.pulse',
          encodeUtf8(decoded.pulseText),
          { contentType: 'text/plain' },
          requestSignal.signal
        );
        if (artifact === null) return requestSignal.signal.aborted
          ? sendEnvelope(reply, requestCancelled(requestSignal.signal))
          : sendEnvelope(reply, operationResult('qr-decode', 'failed', null, [
              adapterDiagnostic(DIAGNOSTIC_CODES.ADAPTER_WRITE, 'Decoded QR content could not be staged for download.')
            ]));
        stagedArtifactId = artifact.id;
        const effective = requestResult(operationResult('qr-decode', 'success', {
          pulseText: decoded.pulseText,
          downloadId: artifact.id
        }, diagnostics), requestSignal.signal);
        if (effective.status !== 'success') await artifactStore.remove(artifact.id);
        return sendEnvelope(reply, effective);
      } catch {
        if (stagedArtifactId !== null) await artifactStore.remove(stagedArtifactId);
        return sendEnvelope(reply, operationResult('qr-decode', 'failed', null, [
          adapterDiagnostic(DIAGNOSTIC_CODES.ADAPTER_WRITE, 'Decoded QR content could not be staged for download.')
        ]));
      }
    } finally {
      requestSignal.dispose();
    }
  });

  app.post('/api/v1/pulses/qr/encode', async (request, reply) => {
    const requestSignal = requestAbortSignal(request, limits.processingTimeoutMs, reply);
    try {
      const input = await readRequestInput(request, limits.maxBytes, requestSignal.signal);
      if (input.error !== undefined) return sendEnvelope(reply, input.error);
      const bodyError = validateJsonKeys(jsonBody(request), ['text']);
      if (bodyError !== null) return sendEnvelope(reply, bodyError);
      const typeError = validateJsonFieldTypes(jsonBody(request), { text: 'string' });
      if (typeError !== null) return sendEnvelope(reply, typeError);
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(input.content);
      } catch {
        return sendEnvelope(reply, operationResult('qr-encode', 'rejected', null, [
          makeDiagnostic(
            DIAGNOSTIC_CODES.RECOGNIZE_INVALID_ENCODING,
            'error',
            'recognize',
            'Input is not valid UTF-8.',
            location('$')
          )
        ]));
      }
      const encoded = encodeQr(text, { maxDecodedBytes: limits.maxBytes });
      return sendEnvelope(reply, requestResult(operationResult(
        'qr-encode',
        encoded.content === null ? 'rejected' : 'success',
        encoded.content === null ? null : { content: encoded.content },
        encoded.diagnostics
      ), requestSignal.signal));
    } finally {
      requestSignal.dispose();
    }
  });

  app.post('/api/v1/pulses/edit', async (request, reply) => {
    const requestSignal = requestAbortSignal(request, limits.processingTimeoutMs, reply);
    try {
      const body = jsonBody(request);
      const bodyError = validateJsonKeys(body, [
        'text', 'displayName', 'kind', 'sectionIndex', 'pointIndex', 'value',
        'startIndex', 'endIndex', 'atIndex', 'anchor'
      ]);
      if (bodyError !== null) return sendEnvelope(reply, bodyError);
      const typeError = validateJsonFieldTypes(body, {
        text: 'string',
        displayName: 'string',
        kind: 'string',
        sectionIndex: 'number',
        pointIndex: 'number',
        value: 'number',
        startIndex: 'number',
        endIndex: 'number',
        atIndex: 'number',
        anchor: 'number'
      });
      if (typeError !== null) return sendEnvelope(reply, typeError);
      const text = typeof body?.text === 'string' ? body.text : null;
      if (text === null) {
        return sendEnvelope(reply, operationResult('edit', 'rejected', null, [
          editDiagnostic('Input must contain a text string.', 'text')
        ]));
      }
      const commandResult = editCommandFromBody(body ?? {});
      if (commandResult.command === null) {
        return sendEnvelope(reply, operationResult('edit', 'rejected', null, commandResult.diagnostics));
      }
      if (encodeUtf8(text).byteLength > limits.maxBytes) {
        return sendEnvelope(reply, rejectedInput('Request exceeds the configured byte limit.'));
      }
      const edited = requestResult(
        applyPulseEdit(text, { command: commandResult.command, maxBytes: limits.maxBytes, signal: requestSignal.signal }),
        requestSignal.signal
      );
      if (edited.status !== 'success' || edited.data === null) return sendEnvelope(reply, edited);
      let stagedArtifactId: string | null = null;
      try {
        const artifact = await putRequestArtifact(
          artifactStore,
          sanitizeDisplayName(typeof body?.displayName === 'string' ? body.displayName : 'edited.pulse'),
          edited.data.bytes,
          { contentType: 'text/plain' },
          requestSignal.signal
        );
        if (artifact === null) return requestSignal.signal.aborted
          ? sendEnvelope(reply, requestCancelled(requestSignal.signal))
          : sendEnvelope(reply, operationResult('edit', 'failed', null, [
              adapterDiagnostic(DIAGNOSTIC_CODES.ADAPTER_WRITE, 'Edited content could not be staged for download.')
            ]));
        stagedArtifactId = artifact.id;
        const withArtifact = operationResult('edit', 'success', {
          ...edited.data,
          downloadId: artifact.id,
          contentType: 'text/plain'
        }, edited.diagnostics);
        return sendEnvelope(reply, withArtifact);
      } catch {
        if (stagedArtifactId !== null) await artifactStore.remove(stagedArtifactId);
        throw new Error('artifact-send-failed');
      }
    } catch {
      return sendEnvelope(reply, requestSignal.signal.aborted ? requestCancelled(requestSignal.signal) : operationResult('edit', 'failed', null, [
        adapterDiagnostic(DIAGNOSTIC_CODES.ADAPTER_WRITE, 'Edited content could not be staged for download.')
      ]));
    } finally {
      requestSignal.dispose();
    }
  });

  app.post('/api/v1/pulses/assist', async (request, reply) => {
    const requestSignal = requestAbortSignal(request, limits.processingTimeoutMs, reply);
    try {
      const body = jsonBody(request);
      const bodyError = validateJsonKeys(body, [
        'text', 'displayName', 'sectionIndex', 'startPointIndex', 'endPointIndex',
        'startStrength', 'endStrength', 'reviewed'
      ]);
      if (bodyError !== null) return sendEnvelope(reply, bodyError);
      if (body === null || typeof body.text !== 'string') {
        return sendEnvelope(reply, operationResult('edit', 'rejected', null, [
          editDiagnostic('Assist input must contain a text string.', 'text')
        ]));
      }
      if (body.displayName !== undefined && typeof body.displayName !== 'string') {
        return sendEnvelope(reply, operationResult('edit', 'rejected', null, [
          editDiagnostic('Assist displayName must be text.', 'displayName')
        ]));
      }
      const numericFields = ['sectionIndex', 'startPointIndex', 'endPointIndex', 'startStrength', 'endStrength'] as const;
      for (const field of numericFields) {
        const value = body[field];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return sendEnvelope(reply, operationResult('edit', 'rejected', null, [
            editDiagnostic('Assist field has an invalid numeric value.', field)
          ]));
        }
      }
      if (typeof body.reviewed !== 'boolean') {
        return sendEnvelope(reply, operationResult('edit', 'rejected', null, [
          editDiagnostic('Assist must include an explicit reviewed boolean.', 'reviewed')
        ]));
      }
      const sectionIndex = body.sectionIndex as number;
      const startPointIndex = body.startPointIndex as number;
      const endPointIndex = body.endPointIndex as number;
      const startStrength = body.startStrength as number;
      const endStrength = body.endStrength as number;
      if (![sectionIndex, startPointIndex, endPointIndex].every(validIndex)) {
        return sendEnvelope(reply, operationResult('edit', 'rejected', null, [
          editDiagnostic('Assist indexes must be non-negative safe integers.', 'command')
        ]));
      }
      if (![startStrength, endStrength].every((value) => value >= 0 && value <= 100)) {
        return sendEnvelope(reply, operationResult('edit', 'rejected', null, [
          editDiagnostic('Assist endpoint strengths must be between 0 and 100.', 'command')
        ]));
      }
      const inputBytes = encodeUtf8(body.text);
      if (inputBytes.byteLength > limits.maxBytes) return sendEnvelope(reply, rejectedInput('Request exceeds the configured byte limit.'));
      const edited = applyPulseAssist(body.text, {
        maxBytes: limits.maxBytes,
        sectionIndex,
        startPointIndex,
        endPointIndex,
        startStrength,
        endStrength,
        reviewed: body.reviewed,
        signal: requestSignal.signal
      });
      const effective = requestResult(edited, requestSignal.signal);
      if (effective.status !== 'success' || effective.data === null) return sendEnvelope(reply, effective);
      let artifactId: string | null = null;
      try {
        const artifact = await putRequestArtifact(
          artifactStore,
          sanitizeDisplayName(typeof body.displayName === 'string' ? body.displayName : 'assisted.pulse'),
          effective.data.bytes,
          { contentType: 'text/plain' },
          requestSignal.signal
        );
        if (artifact === null) return sendEnvelope(reply, requestCancelled(requestSignal.signal));
        artifactId = artifact.id;
        const staged = requestResult(operationResult('edit', 'success', {
          ...effective.data,
          downloadId: artifact.id,
          contentType: 'text/plain'
        }, effective.diagnostics), requestSignal.signal);
        if (staged.status !== 'success') await artifactStore.remove(artifact.id);
        return sendEnvelope(reply, staged);
      } catch {
        if (artifactId !== null) await artifactStore.remove(artifactId);
        return sendEnvelope(reply, operationResult('edit', 'failed', null, [
          adapterDiagnostic(DIAGNOSTIC_CODES.ADAPTER_WRITE, 'Assisted edit could not be staged for download.')
        ]));
      }
    } finally {
      requestSignal.dispose();
    }
  });

  app.post('/api/v1/pulses/preview', async (request, reply) => {
    const requestSignal = requestAbortSignal(request, limits.processingTimeoutMs, reply);
    try {
      const input = await readRequestInput(request, limits.maxBytes, requestSignal.signal);
      if (input.error !== undefined) return sendEnvelope(reply, input.error);
      const body = jsonBody(request);
      const bodyError = validateJsonKeys(body, ['text', 'displayName', 'format']);
      if (bodyError !== null) return sendEnvelope(reply, bodyError);
      const typeError = validateJsonFieldTypes(body, {
        text: 'string',
        displayName: 'string',
        format: 'string'
      });
      if (typeError !== null) return sendEnvelope(reply, typeError);
      const requestedFormat = body?.format;
      const format = requestedFormat === undefined
        ? 'svg'
        : requestedFormat;
      if (format !== 'svg' && format !== 'png' && format !== 'jpg') {
        return sendEnvelope(reply, operationResult('render', 'rejected', null, [
          makeDiagnostic(
            DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_FORMAT,
            'error',
            'export',
            'Preview format is not supported.',
            location('format')
          )
        ]));
      }
      const inspected = inspectPulse(input.content, {
        input: { displayName: input.displayName, bytes: input.content.byteLength },
        maxBytes: limits.maxBytes,
        maxExpandedPoints: limits.maxExpandedPoints,
        maxExpandedDurationMs: limits.maxExpandedDurationMs,
        signal: requestSignal.signal
      });
      const effective = requestResult(inspected, requestSignal.signal);
      if (effective.status !== 'success' || effective.data?.stream === null || effective.data?.stream === undefined) {
        return sendEnvelope(reply, effective);
      }
      try {
        const image = renderPreviewImage(effective.data.stream, format);
        const renderResult = {
          ...image,
          displayName: 'pulse-preview.' + image.format,
          contentType: image.mimeType
        };
        const afterRender = requestResult(
          operationResult('render', 'success', renderResult, effective.diagnostics),
          requestSignal.signal
        );
        if (afterRender.status !== 'success' || afterRender.data === null) return sendEnvelope(reply, afterRender);
        const dto = toOperationDto(afterRender);
        return reply
          .code(200)
          .header('content-type', image.mimeType)
          .header('content-disposition', contentDisposition('pulse-preview.' + image.format))
          .header('x-pulse-schema-version', 'pulse-contract-v1')
          .header('x-pulse-rule-version', 'pulse-rules-v1')
          .header('x-pulse-stream-digest', image.streamDigest)
          .header('x-pulse-result', JSON.stringify(dto.result))
          .send(Buffer.from(image.bytes));
      } catch {
        return sendEnvelope(reply, operationResult('render', 'rejected', null, [
          makeDiagnostic(
            DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_FORMAT,
            'error',
            'export',
            'Preview could not be encoded in the requested format.',
            location('format')
          )
        ]));
      }
    } finally {
      requestSignal.dispose();
    }
  });

  app.get<{ Params: { id: string } }>('/api/v1/artifacts/:id', async (request, reply) => {
    const id = request.params.id;
    const consumed = await artifactStore.consume(id);
    if (consumed === null) return sendEnvelope(reply, artifactMissing());
    const { descriptor, bytes } = consumed;
    return reply
      .code(200)
      .header('content-type', descriptor.contentType)
      .header('content-disposition', contentDisposition(descriptor.displayName))
      .send(Buffer.from(bytes));
  });

  app.setNotFoundHandler((_request, reply) => {
    const result = operationResult('request', 'rejected', null, [
      makeDiagnostic(
        DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT,
        'error',
        'recognize',
        'The requested API resource was not found.',
        location('$')
      )
    ]);
    return reply.code(404).type('application/json').send(toOperationDto(result));
  });

  app.setErrorHandler((error, _request, reply) => {
    if (reply.sent) return;
    const errorCode = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { readonly code?: unknown }).code)
      : '';
    const tooLarge = errorCode === 'FST_ERR_CTP_BODY_TOO_LARGE' || errorCode === 'FST_REQ_FILE_TOO_LARGE';
    const unsupported = errorCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE';
    const invalidJson = errorCode === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      errorCode === 'FST_ERR_CTP_EMPTY_JSON_BODY';
    const statusCode = tooLarge ? 413 : unsupported ? 415 : invalidJson ? 422 : 500;
    const diagnostic = tooLarge
      ? makeDiagnostic(DIAGNOSTIC_CODES.TASK_INPUT_LIMIT, 'error', 'resource', 'Request exceeds the configured byte limit.', location('$'))
      : unsupported
        ? makeDiagnostic(DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT, 'error', 'recognize', 'Request content type is not supported.', location('$'))
        : invalidJson
          ? makeDiagnostic(DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT, 'error', 'recognize', 'Request JSON body is invalid.', location('$'))
          : adapterDiagnostic(DIAGNOSTIC_CODES.ADAPTER_READ, 'Request could not be processed.');
    reply.code(statusCode).type('application/json').send(toOperationDto(
      operationResult('request', tooLarge || unsupported || invalidJson ? 'rejected' : 'failed', null, [diagnostic])
    ));
  });

  return app;
}

interface BatchReadLimits {
  readonly maxBytes: number;
  readonly maxBatchFiles: number;
  readonly maxBatchTotalBytes: number;
  readonly batchConcurrency: number;
}

interface DiffDocument {
  readonly content: Uint8Array;
  readonly displayName: string;
}

interface DiffRequestRead {
  readonly before: DiffDocument | null;
  readonly after: DiffDocument | null;
  readonly error?: OperationResult<never>;
}

function batchRequestFailure(message: string): OperationResult<never> {
  return operationResult('batch', 'rejected', null, [
    makeDiagnostic(DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT, 'error', 'recognize', message, location('$'))
  ]);
}

function batchLimitFailure(message: string): OperationResult<never> {
  return operationResult('batch', 'rejected', null, [
    makeDiagnostic(DIAGNOSTIC_CODES.TASK_INPUT_LIMIT, 'error', 'resource', message, location('$'))
  ]);
}

function invalidSchemaFailure(path: string, message: string): OperationResult<never> {
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

async function readBatchRequest(
  request: FastifyRequest,
  limits: BatchReadLimits,
  signal: AbortSignal,
  operation: 'inspect' | 'export'
): Promise<BatchRequestRead> {
  if (signal.aborted) return { request: null, error: requestCancelled(signal) };
  const contentType = String(request.headers?.['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (contentType === 'application/json') {
    const body = jsonBody(request);
    if (body === null) return { request: null, error: batchRequestFailure('Batch JSON body must be an object.') };
    const parsed = (operation === 'export' ? batchExportRequestSchema : batchRequestSchema).safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue === undefined ? '$' : issue.path.map((part) => typeof part === 'number' ? '[' + part + ']' : String(part)).join('.').replace('.[', '[');
      return { request: null, error: invalidSchemaFailure(path, 'Batch request has an invalid shape.') };
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
      return { request: null, error: batchLimitFailure('Requested batch concurrency exceeds the configured limit.') };
    }
    const maxTotalBytes = value.maxTotalBytes ?? limits.maxBatchTotalBytes;
    if (maxTotalBytes > limits.maxBatchTotalBytes) {
      return { request: null, error: batchLimitFailure('Requested batch byte limit exceeds the configured limit.') };
    }
    const inputs: BatchApiInput[] = [];
    let totalBytes = 0;
    for (let index = 0; index < value.items.length; index += 1) {
      const item = value.items[index];
      if (item === undefined) continue;
      const bytes = encodeUtf8(item.text);
      if (bytes.byteLength > limits.maxBytes) {
        return { request: null, error: batchLimitFailure('A batch item exceeds the configured byte limit.') };
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > maxTotalBytes) {
        return { request: null, error: batchLimitFailure('Batch byte count exceeds the configured limit.') };
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
            displayName: sanitizeDisplayName(part.filename || 'item-' + String(fileCount).padStart(4, '0') + '.pulse'),
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
      return { request: null, error: batchLimitFailure('Multipart batch upload exceeds a configured limit.') };
    }
    return { request: null, error: batchRequestFailure('Multipart batch upload is invalid.') };
  }
  if (signal.aborted) return { request: null, error: requestCancelled(signal) };
  if (invalidField) return { request: null, error: batchRequestFailure('Multipart batch request contains unsupported or duplicate fields.') };
  if (fileCount > limits.maxBatchFiles) return { request: null, error: batchLimitFailure('Batch file count exceeds the configured limit.') };
  if (exceeded) return { request: null, error: batchLimitFailure('Batch byte count exceeds the configured limit.') };
  if (fileCount === 0 || files.length === 0) return { request: null, error: batchRequestFailure('Multipart batch request must contain at least one file field.') };
  const concurrency = parseMultipartPositiveInteger(concurrencyRaw, limits.batchConcurrency, 'concurrency');
  if (concurrency.error !== undefined) return { request: null, error: concurrency.error };
  if (concurrency.value > limits.batchConcurrency) return { request: null, error: batchLimitFailure('Requested batch concurrency exceeds the configured limit.') };
  const maxTotalBytes = parseMultipartPositiveInteger(maxTotalBytesRaw, limits.maxBatchTotalBytes, 'maxTotalBytes');
  if (maxTotalBytes.error !== undefined) return { request: null, error: maxTotalBytes.error };
  if (maxTotalBytes.value > limits.maxBatchTotalBytes) return { request: null, error: batchLimitFailure('Requested batch byte limit exceeds the configured limit.') };
  if (modeRaw !== undefined && operation === 'export' && modeRaw !== 'canonical' && modeRaw !== 'source') {
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
  if (totalBytes > maxTotalBytes.value) return { request: null, error: batchLimitFailure('Batch byte count exceeds the configured limit.') };
  return {
    request: {
      inputs,
      concurrency: concurrency.value,
      maxTotalBytes: maxTotalBytes.value,
      ...(operation === 'export' && modeRaw !== undefined ? { mode: modeRaw as 'canonical' | 'source' } : {})
    }
  };
}

function parseMultipartPositiveInteger(
  raw: string | undefined,
  fallback: number,
  field: string
): { readonly value: number; readonly error?: OperationResult<never> } {
  if (raw === undefined) return { value: fallback };
  if (!/^[0-9]+$/.test(raw)) return { value: fallback, error: invalidSchemaFailure(field, 'Multipart batch option must be a positive integer.') };
  const value = Number(raw);
  if (!validPositiveSafeInteger(value)) return { value: fallback, error: invalidSchemaFailure(field, 'Multipart batch option must be a positive integer.') };
  return { value };
}

function isMultipartLimitError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = String((error as { readonly code?: unknown }).code);
  return code === 'FST_REQ_FILE_TOO_LARGE' ||
    code === 'FST_FILES_LIMIT' ||
    code === 'FST_FIELDS_LIMIT' ||
    code === 'FST_PARTS_LIMIT';
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
    return { items: [], error: invalidSchemaFailure('manifest', 'Multipart manifest must be valid JSON.') };
  }
  if (!Array.isArray(value) || value.length !== count) {
    return { items: [], error: invalidSchemaFailure('manifest', 'Multipart manifest must describe every uploaded file.') };
  }
  const items: MultipartManifestItem[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { items: [], error: invalidSchemaFailure('manifest[' + index + ']', 'Multipart manifest item is invalid.') };
    }
    const candidate = item as Record<string, unknown>;
    const allowed = operation === 'export'
      ? ['id', 'displayName', 'outputDisplayName']
      : ['id', 'displayName'];
    if (Object.keys(candidate).some((key) => !allowed.includes(key))) {
      return { items: [], error: invalidSchemaFailure('manifest[' + index + ']', 'Multipart manifest item contains unsupported fields.') };
    }
    const id = candidate.id;
    const displayName = candidate.displayName;
    const outputDisplayName = candidate.outputDisplayName;
    if (id !== undefined && (typeof id !== 'string' || id.length === 0 || id.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(id) || ids.has(id))) {
      return { items: [], error: invalidSchemaFailure('manifest[' + index + '].id', 'Multipart item IDs must be unique safe strings.') };
    }
    if (typeof id === 'string') ids.add(id);
    if (displayName !== undefined && (typeof displayName !== 'string' || displayName.length === 0)) {
      return { items: [], error: invalidSchemaFailure('manifest[' + index + '].displayName', 'Multipart displayName is invalid.') };
    }
    if (outputDisplayName !== undefined && (typeof outputDisplayName !== 'string' || outputDisplayName.length === 0)) {
      return { items: [], error: invalidSchemaFailure('manifest[' + index + '].outputDisplayName', 'Multipart outputDisplayName is invalid.') };
    }
    items.push({
      ...(typeof id === 'string' ? { id } : {}),
      ...(typeof displayName === 'string' ? { displayName: sanitizeDisplayName(displayName) } : {}),
      ...(typeof outputDisplayName === 'string' ? { outputDisplayName: sanitizeDisplayName(outputDisplayName) } : {})
    });
  }
  return { items };
}

async function readDiffRequest(
  request: FastifyRequest,
  limits: BatchReadLimits,
  signal: AbortSignal
): Promise<DiffRequestRead> {
  if (signal.aborted) return { before: null, after: null, error: requestCancelled(signal) };
  const contentType = String(request.headers?.['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (contentType === 'application/json') {
    const body = jsonBody(request);
    if (body === null) return { before: null, after: null, error: invalidSchemaFailure('$', 'Diff JSON body must be an object.') };
    const keys = validateJsonKeys(body, ['before', 'after']);
    if (keys !== null) return { before: null, after: null, error: keys };
    const types = validateJsonFieldTypes(body, { before: 'string', after: 'string' });
    if (types !== null) return { before: null, after: null, error: types };
    if (typeof body.before !== 'string' || typeof body.after !== 'string') {
      return { before: null, after: null, error: invalidSchemaFailure('$', 'Diff request must contain before and after text.') };
    }
    const beforeBytes = encodeUtf8(body.before);
    const afterBytes = encodeUtf8(body.after);
    if (beforeBytes.byteLength > limits.maxBytes || afterBytes.byteLength > limits.maxBytes) {
      return { before: null, after: null, error: batchLimitFailure('A diff document exceeds the configured byte limit.') };
    }
    if (beforeBytes.byteLength + afterBytes.byteLength > limits.maxBatchTotalBytes) {
      return { before: null, after: null, error: batchLimitFailure('Diff byte count exceeds the configured limit.') };
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
        makeDiagnostic(DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT, 'error', 'recognize', 'Diff requests require application/json or multipart/form-data.', location('$'))
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
      const acceptedName = part.fieldname === 'before' || part.fieldname === 'after' || part.fieldname === 'file' || part.fieldname === 'files';
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
        if (buffer.byteLength > limits.maxBytes - size || buffer.byteLength > limits.maxBatchTotalBytes - totalBytes) {
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
      return { before: null, after: null, error: batchLimitFailure('Multipart diff upload exceeds a configured limit.') };
    }
    return { before: null, after: null, error: invalidSchemaFailure('$', 'Multipart diff upload is invalid.') };
  }
  const namedCount = Number(named.before !== undefined) + Number(named.after !== undefined);
  const fileCount = namedCount + unnamed.length;
  // A diff has exactly two documents.  Generic `file`/`files` parts are
  // positional; named `before`/`after` parts are explicit.  Mixing those
  // forms, or silently ignoring a third part, makes the comparison
  // ambiguous and must be rejected at the transport boundary.
  const ambiguous = fileCount !== 2 || (namedCount > 0 && unnamed.length > 0) ||
    (namedCount === 2 && (named.before === undefined || named.after === undefined));
  if (invalid || ambiguous || totalBytes > limits.maxBatchTotalBytes) {
    return {
      before: null,
      after: null,
      error: invalid || limitExceeded || totalBytes > limits.maxBatchTotalBytes
        ? batchLimitFailure('Multipart diff upload is invalid or exceeds a configured limit.')
        : invalidSchemaFailure('$', 'Diff multipart request must contain exactly before and after files.')
    };
  }
  if (unnamed.length === 2) {
    named.before = unnamed[0];
    named.after = unnamed[1];
  }
  if (named.before === undefined || named.after === undefined) {
    return { before: null, after: null, error: invalidSchemaFailure('$', 'Diff multipart request must contain before and after files.') };
  }
  return { before: named.before, after: named.after };
}

function requestResult<T>(result: OperationResult<T>, signal: AbortSignal): OperationResult<T> {
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

function cancelDiagnostic(): Diagnostic {
  return makeDiagnostic(DIAGNOSTIC_CODES.TASK_CANCELLED, 'info', 'task', 'Request was cancelled.', location('$'));
}

function timeoutDiagnostic(): Diagnostic {
  return makeDiagnostic(DIAGNOSTIC_CODES.TASK_TIMEOUT, 'error', 'task', 'Request processing exceeded the configured timeout.', location('$'));
}

async function readRequestInput(
  request: FastifyRequest,
  maxBytes: number,
  signal?: AbortSignal
): Promise<RequestInput> {
  if (signal?.aborted) return { content: new Uint8Array(), displayName: 'pulse', error: requestCancelled(signal) };
  const contentType = String(request.headers?.['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (contentType === 'multipart/form-data') {
    try {
      let fileBytes: Uint8Array | null = null;
      let fileName = '';
      let displayName: string | undefined;
      let fileCount = 0;
      let invalidField = false;
      let exceeded = false;
      // Consume every part so malformed or over-posted multipart requests do
      // not leave unread bytes on a keep-alive connection.  The public API has
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
              return { content: new Uint8Array(), displayName: 'pulse', error: requestCancelled(signal) };
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
        if (part.fieldname !== 'displayName' || displayName !== undefined || typeof part.value !== 'string') {
          invalidField = true;
          continue;
        }
        displayName = part.value;
      }
      if (invalidField) {
        return { content: new Uint8Array(), displayName: 'pulse', error: rejectedInput('Multipart request contains unsupported fields.') };
      }
      if (fileBytes === null || fileCount !== 1) {
        return { content: new Uint8Array(), displayName: 'pulse', error: rejectedInput('Multipart request must contain exactly one file field.') };
      }
      if (exceeded) return { content: new Uint8Array(), displayName: 'pulse', error: rejectedInput('Uploaded file exceeds the byte limit.') };
      if (signal?.aborted) return { content: new Uint8Array(), displayName: 'pulse', error: requestCancelled(signal) };
      return {
        content: fileBytes,
        displayName: sanitizeDisplayName(displayName ?? (fileName || 'pulse'))
      };
    } catch {
      return { content: new Uint8Array(), displayName: 'pulse', error: rejectedInput('Multipart upload is invalid or exceeds the byte limit.') };
    }
  }
  if (JSON_CONTENT_TYPES.includes(contentType)) {
    const body = jsonBody(request);
    const text = typeof body?.text === 'string' ? body.text : null;
    if (text === null) return { content: new Uint8Array(), displayName: 'pulse', error: rejectedInput('JSON body must contain a text string.') };
    const bytes = encodeUtf8(text);
    if (signal?.aborted) return { content: new Uint8Array(), displayName: 'pulse', error: requestCancelled(signal) };
    if (bytes.byteLength > maxBytes) return { content: new Uint8Array(), displayName: 'pulse', error: rejectedInput('Request exceeds the configured byte limit.') };
    return { content: bytes, displayName: typeof body?.displayName === 'string' ? sanitizeDisplayName(body.displayName) : 'pulse' };
  }
  if (contentType !== '' && !RAW_CONTENT_TYPES.includes(contentType)) {
    return {
      content: new Uint8Array(),
      displayName: 'pulse',
      error: operationResult('request', 'rejected', null, [
        makeDiagnostic(DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT, 'error', 'recognize', 'Request content type is not supported.', location('$'))
      ])
    };
  }
  const raw = request.body;
  const bytes = typeof raw === 'string'
    ? encodeUtf8(raw)
    : Buffer.isBuffer(raw) ? new Uint8Array(raw) : raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array();
  if (signal?.aborted) return { content: new Uint8Array(), displayName: 'pulse', error: requestCancelled(signal) };
  if (bytes.byteLength > maxBytes) return { content: new Uint8Array(), displayName: 'pulse', error: rejectedInput('Request exceeds the configured byte limit.') };
  return { content: bytes, displayName: 'pulse' };
}

async function readTextRequest(
  request: FastifyRequest,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ readonly text: string; readonly error?: OperationResult<never> }> {
  if (signal?.aborted) return { text: '', error: requestCancelled(signal) };
  const contentType = String(request.headers?.['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (contentType === 'application/json') {
    const body = jsonBody(request);
    const value = typeof body?.text === 'string' ? body.text : null;
    if (value === null) return { text: '', error: rejectedInput('JSON body must contain a text string.') };
    if (signal?.aborted) return { text: '', error: requestCancelled(signal) };
    if (encodeUtf8(value).byteLength > maxBytes) return { text: '', error: rejectedInput('Request exceeds the configured byte limit.') };
    return { text: value };
  }
  if (contentType !== '' && !RAW_CONTENT_TYPES.includes(contentType)) {
    return {
      text: '',
      error: operationResult('request', 'rejected', null, [
        makeDiagnostic(DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT, 'error', 'recognize', 'Request content type is not supported.', location('$'))
      ])
    };
  }
  const raw = request.body;
  const bytes = typeof raw === 'string' ? encodeUtf8(raw) : Buffer.isBuffer(raw) ? new Uint8Array(raw) : raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array();
  if (signal?.aborted) return { text: '', error: requestCancelled(signal) };
  if (bytes.byteLength > maxBytes) return { text: '', error: rejectedInput('Request exceeds the configured byte limit.') };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { text: '', error: operationResult('request', 'rejected', null, [makeDiagnostic(DIAGNOSTIC_CODES.RECOGNIZE_INVALID_ENCODING, 'error', 'recognize', 'Input is not valid UTF-8.', location('$'))]) };
  }
}

function jsonBody(request: FastifyRequest): Record<string, unknown> | null {
  const value = request.body;
  if (typeof value !== 'object' || value === null || Buffer.isBuffer(value) || value instanceof Uint8Array || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function validateJsonKeys(
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

function validateJsonFieldTypes(
  body: Record<string, unknown> | null,
  fields: Readonly<Record<string, JsonFieldType>>
): OperationResult<never> | null {
  if (body === null) return null;
  for (const [field, expected] of Object.entries(fields)) {
    const value = body[field];
    if (value === undefined) continue;
    const valid = expected === 'string'
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

function requestAbortSignal(request: FastifyRequest, timeoutMs?: number, reply?: FastifyReply): RequestSignal {
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

function editCommandFromBody(body: Record<string, unknown>): { readonly command: EditCommand | null; readonly diagnostics: readonly Diagnostic[] } {
  if (typeof body.kind !== 'string') {
    return { command: null, diagnostics: [editDiagnostic('Edit command kind is required.', 'kind')] };
  }
  const kind = body.kind;
  const commandFields: readonly string[] = kind === 'strength' || kind === 'anchor'
    ? ['pointIndex', 'value']
    : kind === 'frequency'
      ? ['startIndex', 'endIndex']
      : kind === 'duration'
        ? ['value']
        : kind === 'remove-point'
          ? ['pointIndex']
          : kind === 'add-point'
            ? ['atIndex', 'value', 'anchor']
            : [];
  const commandFieldSet = new Set(commandFields);
  for (const field of ['pointIndex', 'value', 'startIndex', 'endIndex', 'atIndex', 'anchor']) {
    if (body[field] !== undefined && !commandFieldSet.has(field)) {
      return { command: null, diagnostics: [editDiagnostic('Edit field is not valid for this command kind.', field)] };
    }
  }
  const sectionIndex = body.sectionIndex;
  if (!validIndex(sectionIndex)) return { command: null, diagnostics: [editDiagnostic('Section index must be a non-negative safe integer.', 'sectionIndex')] };
  const section = sectionIndex as number;
  if (kind === 'strength') {
    const pointIndex = body.pointIndex;
    const value = body.value;
    if (!validIndex(pointIndex)) return { command: null, diagnostics: [editDiagnostic('Point index must be a non-negative safe integer.', 'pointIndex')] };
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return { command: null, diagnostics: [editDiagnostic('Strength must be a finite number between 0 and 100.', 'value')] };
    return { command: { kind: 'strength', sectionIndex: section, pointIndex: pointIndex as number, value }, diagnostics: [] };
  }
  if (kind === 'anchor') {
    const pointIndex = body.pointIndex;
    const value = body.value;
    if (!validIndex(pointIndex) || (value !== 0 && value !== 1)) return { command: null, diagnostics: [editDiagnostic('Anchor edits require a valid point index and a value of 0 or 1.', 'value')] };
    return { command: { kind: 'anchor', sectionIndex: section, pointIndex: pointIndex as number, value }, diagnostics: [] };
  }
  if (kind === 'frequency') {
    const startIndex = body.startIndex;
    const endIndex = body.endIndex;
    if (!validIndex(startIndex) || !validIndex(endIndex) || startIndex > 83 || endIndex > 83) return { command: null, diagnostics: [editDiagnostic('Frequency indexes must be integers between 0 and 83.', 'frequency')] };
    return { command: { kind: 'frequency', sectionIndex: section, startIndex: startIndex as number, endIndex: endIndex as number }, diagnostics: [] };
  }
  if (kind === 'duration') {
    const value = body.value;
    if (!validIndex(value) || value > 99) return { command: null, diagnostics: [editDiagnostic('Duration index must be an integer between 0 and 99.', 'durationIndex')] };
    return { command: { kind: 'duration', sectionIndex: section, value: value as number }, diagnostics: [] };
  }
  if (kind === 'remove-point') {
    const pointIndex = body.pointIndex;
    if (!validIndex(pointIndex)) return { command: null, diagnostics: [editDiagnostic('Point index must be a non-negative safe integer.', 'pointIndex')] };
    return { command: { kind: 'remove-point', sectionIndex: section, pointIndex: pointIndex as number }, diagnostics: [] };
  }
  if (kind === 'add-point') {
    const value = body.value;
    const anchor = body.anchor;
    const atIndex = body.atIndex;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100 || (anchor !== 0 && anchor !== 1) || (atIndex !== undefined && !validIndex(atIndex))) return { command: null, diagnostics: [editDiagnostic('Added points require strength 0..100, anchor 0/1, and an optional valid insertion index.', 'point')] };
    const decimal = normalizeDecimal(value.toFixed(6));
    const point: ControlPoint = Object.freeze({ strength: Number(decimal), strengthDecimal: decimal, strengthRaw: decimal, anchor, sourceSpan: sourceSpan('', 0, 0) });
    return { command: { kind: 'add-point', sectionIndex: section, point, atIndex: atIndex as number | undefined }, diagnostics: [] };
  }
  return { command: null, diagnostics: [editDiagnostic('Unsupported edit command.', 'kind')] };
}

function editDiagnostic(message: string, path: string): Diagnostic {
  return makeDiagnostic(DIAGNOSTIC_CODES.EDIT_VALUE, 'error', 'semantic', message, location(path));
}

function adapterDiagnostic(code: string, message: string): Diagnostic {
  return makeDiagnostic(code, 'error', 'adapter', message, location('$'));
}

function rejectedInput(message: string): OperationResult<never> {
  return operationResult('request', 'rejected', null, [makeDiagnostic(DIAGNOSTIC_CODES.TASK_INPUT_LIMIT, 'error', 'resource', message, location('$'))]);
}

function requestCancelled(signal?: AbortSignal): OperationResult<never> {
  if (signal !== undefined && timedOutSignals.has(signal)) {
    return operationResult('request', 'failed', null, [timeoutDiagnostic()]);
  }
  return operationResult('request', 'cancelled', null, [
    cancelDiagnostic()
  ]);
}

function artifactMissing(): OperationResult<never> {
  return operationResult('artifact', 'rejected', null, [makeDiagnostic(DIAGNOSTIC_CODES.ADAPTER_READ, 'error', 'adapter', 'Artifact is missing or expired.', location('$'))]);
}

async function stageBatchExports(
  data: BatchData<ExportData>,
  store: TempArtifactStore,
  signal: AbortSignal
): Promise<OperationResult<BatchData<ExportData>>> {
  const stagedIds: string[] = [];
  const items: Array<BatchData<ExportData>['items'][number]> = [];
  let stageFailures = 0;
  const removeStaged = async (): Promise<void> => {
    if (stagedIds.length === 0) return;
    await Promise.all(stagedIds.splice(0).map((id) => store.remove(id)));
  };
  try {
    for (const item of data.items) {
      if (signal.aborted) {
        await removeStaged();
        return requestCancelled(signal) as OperationResult<BatchData<ExportData>>;
      }
      if (item.status !== 'success' || item.data === null) {
        items.push(item);
        continue;
      }
      try {
        const artifact = await putRequestArtifact(
          store,
          item.data.displayName,
          item.data.bytes,
          { contentType: 'text/plain' },
          signal
        );
        if (artifact === null) {
          await removeStaged();
          return requestCancelled(signal) as OperationResult<BatchData<ExportData>>;
        }
        stagedIds.push(artifact.id);
        items.push(Object.freeze({
          ...item,
          data: Object.freeze({
            ...item.data,
            downloadId: artifact.id,
            contentType: 'text/plain'
          })
        }));
      } catch {
        stageFailures += 1;
        items.push(Object.freeze({
          ...item,
          status: 'failed' as const,
          diagnostics: [
            ...item.diagnostics,
            adapterDiagnostic(DIAGNOSTIC_CODES.ADAPTER_WRITE, 'Batch export artifact could not be staged.')
          ],
          data: null
        }));
      }
    }
  } catch {
    await removeStaged();
    return operationResult('batch', 'failed', null, [
      adapterDiagnostic(DIAGNOSTIC_CODES.ADAPTER_WRITE, 'Batch export artifacts could not be staged.')
    ]);
  }
  // The request may disconnect immediately after the final put. Do not return
  // a success envelope with handles that are about to become unreachable.
  if (signal.aborted) {
    await removeStaged();
    return requestCancelled(signal) as OperationResult<BatchData<ExportData>>;
  }
  const succeeded = items.filter((item) => item.status === 'success').length;
  const rejected = items.filter((item) => item.status === 'rejected').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const cancelled = items.some((item) => item.status === 'cancelled');
  const warningFiles = items.filter((item) => item.diagnostics.some((diagnostic) => diagnostic.severity === 'warning')).length;
  const status = cancelled
    ? 'cancelled'
    : succeeded > 0
      ? 'success'
      : failed > 0 || stageFailures > 0
        ? 'failed'
        : 'rejected';
  // A failed batch cannot expose any artifact handle. This also protects the
  // lifecycle if a custom store reports a staged item that is later marked
  // failed by an adapter boundary.
  if (succeeded === 0) await removeStaged();
  const resultData = {
    ...data,
    completed: items.length,
    succeeded,
    rejected,
    failed,
    warningFiles,
    cancelled,
    items: Object.freeze(items)
  };
  return operationResult('batch', status, status === 'success' ? resultData : null, sortDiagnostics(items.flatMap((item) => item.diagnostics)));
}

async function putRequestArtifact(
  store: TempArtifactStore,
  displayName: string,
  content: Uint8Array,
  options: { readonly contentType?: string },
  signal: AbortSignal
): Promise<Awaited<ReturnType<TempArtifactStore['put']>> | null> {
  if (signal.aborted) return null;
  let resolveAborted: (() => void) | null = null;
  const aborted = new Promise<null>((resolve) => {
    resolveAborted = () => resolve(null);
  });
  const onAbort = (): void => resolveAborted?.();
  signal.addEventListener('abort', onAbort, { once: true });
  let pending: Promise<Awaited<ReturnType<TempArtifactStore['put']>>>;
  try {
    pending = store.put(displayName, content, options);
  } catch (error) {
    signal.removeEventListener('abort', onAbort);
    resolveAborted = null;
    throw error;
  }
  let artifact: Awaited<ReturnType<TempArtifactStore['put']>> | null;
  try {
    if (signal.aborted) onAbort();
    artifact = await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
    resolveAborted = null;
  }
  if (artifact === null) {
    // A store implementation may not support AbortSignal. Keep the request
    // responsive, then remove a late artifact when that operation completes.
    void pending
      .then((lateArtifact) => store.remove(lateArtifact.id))
      .catch(() => undefined);
    return null;
  }
  if (signal.aborted) {
    await store.remove(artifact.id);
    return null;
  }
  // A disconnect after staging must not leave the private artifact behind.
  // The one-shot download route removes it from the store first, so this
  // listener is harmless when a client successfully downloads the result.
  try {
    const removeOnAbort = (): void => {
      void store.remove(artifact.id);
    };
    signal.addEventListener('abort', removeOnAbort, { once: true });
    // Abort can race the check above. AbortSignal does not replay an event to a
    // listener added after it fired, so check again after registration.
    if (signal.aborted) {
      await store.remove(artifact.id);
      return null;
    }
  } catch {
    await store.remove(artifact.id);
    throw new Error('artifact-abort-hook-failed');
  }
  return artifact;
}

function sendEnvelope(reply: FastifyReply, result: OperationResult<unknown>): FastifyReply {
  const envelope = toOperationDto(result);
  const timedOut = result.diagnostics.some((diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.TASK_TIMEOUT);
  const code = timedOut ? 408 : result.status === 'success' ? 200 : result.status === 'rejected' ? 422 : result.status === 'cancelled' ? 499 : 500;
  return reply.code(code).type('application/json').send(envelope);
}

function asciiDisplayName(displayName: string): string {
  return sanitizeDisplayName(basename(displayName)).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180) || 'pulse-output';
}

function contentDisposition(displayName: string): string {
  return 'attachment; filename="' + asciiDisplayName(displayName) + '"';
}

export async function startServer(options: ApiOptions & { readonly port?: number; readonly host?: string } = {}): Promise<FastifyInstance> {
  const port = options.port ?? Number(process.env.PULSE_API_PORT ?? 8787);
  if (!validPositiveSafeInteger(port) || port > 65_535) throw new RangeError('API port must be between 1 and 65535.');
  const app = buildServer(options);
  try {
    await app.listen({ port, host: options.host ?? process.env.PULSE_API_HOST ?? '127.0.0.1' });
    return app;
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

const entryPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
const modulePath = resolve(fileURLToPath(import.meta.url));
const isMainModule = entryPath !== null && (() => {
  try {
    return realpathSync(entryPath) === realpathSync(modulePath);
  } catch {
    return entryPath === modulePath;
  }
})();
if (isMainModule) {
  const run = async (): Promise<void> => {
    const server = await startServer({ logger: true });
    let closing = false;
    const shutdown = async (): Promise<void> => {
      if (closing) return;
      closing = true;
      try {
        await server.close();
      } catch {
        process.stderr.write('Unable to stop API server cleanly.\n');
        process.exitCode = 1;
      }
    };
    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
  };
  run().catch(() => {
    process.stderr.write('Unable to start API server.\n');
    process.exitCode = 1;
  });
}
