import type { FastifyInstance } from 'fastify';
import {
  applyPulseAssist,
  applyPulseEdit,
  commandParseDiagnostic,
  decodeQr,
  diffPulses,
  encodeQr,
  exportBatch,
  exportPulse,
  inspectBatch,
  inspectPulse,
  operationResult,
  parseAssistCommand,
  parseEditCommand,
  renderPreviewImage,
  sanitizeDisplayName,
  toOperationDto,
  type TempArtifactStore
} from '@dglab-pulse-hub/application';
import {
  DIAGNOSTIC_CODES,
  encodeUtf8,
  location,
  makeDiagnostic,
  parsePulse
} from '@dglab-pulse-hub/core';
import {
  artifactMissing,
  asciiDisplayName,
  contentDisposition,
  stageArtifact,
  stageBatchExports
} from './artifacts.js';
import { batchRequestFailure, readBatchRequest, readDiffRequest } from './batch-requests.js';
import {
  adapterDiagnostic,
  editDiagnostic,
  jsonBody,
  readRequestInput,
  readTextRequest,
  requestAbortSignal,
  requestCancelled,
  requestResult,
  rejectedInput,
  sendEnvelope,
  validateJsonFieldTypes,
  validateJsonKeys
} from './http.js';

export interface ApiRouteLimits {
  readonly maxBytes: number;
  readonly maxExpandedPoints: number;
  readonly maxExpandedDurationMs: number;
  readonly maxBatchFiles: number;
  readonly maxBatchTotalBytes: number;
  readonly batchConcurrency: number;
  readonly processingTimeoutMs: number;
}

export interface ApiRouteContext {
  readonly limits: ApiRouteLimits;
  readonly artifactStore: TempArtifactStore;
}

export function registerApiRoutes(
  app: FastifyInstance,
  { limits, artifactStore }: ApiRouteContext
): void {
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
      if (parsed.request === null)
        return sendEnvelope(reply, batchRequestFailure('Batch request could not be read.'));
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
      if (parsed.request === null)
        return sendEnvelope(reply, batchRequestFailure('Batch request could not be read.'));
      const result = await exportBatch(parsed.request.inputs, {
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
        return sendEnvelope(
          reply,
          batchRequestFailure('Diff request must contain before and after documents.')
        );
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
      const format =
        requestedFormat === undefined
          ? undefined
          : (requestedFormat as 'pulse-text' | 'qr-envelope');
      const mode = body?.mode as 'canonical' | 'source' | undefined;
      const result = exportPulse(input.content, {
        maxBytes: limits.maxBytes,
        displayName:
          typeof body?.displayName === 'string'
            ? sanitizeDisplayName(body.displayName)
            : 'pulse.pulse',
        format,
        mode,
        signal: requestSignal.signal
      });
      const effective = requestResult(result, requestSignal.signal);
      if (effective.status !== 'success' || effective.data === null)
        return sendEnvelope(reply, effective);
      const displayName = sanitizeDisplayName(effective.data.displayName);
      const headerSafeDisplayName = asciiDisplayName(displayName);
      const dto = toOperationDto({
        ...effective,
        data: { ...effective.data, displayName: headerSafeDisplayName }
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
        return sendEnvelope(
          reply,
          requestResult(
            operationResult('qr-decode', 'rejected', null, diagnostics),
            requestSignal.signal
          )
        );
      }
      const parsed = parsePulse(decoded.pulseText, { maxBytes: limits.maxBytes });
      diagnostics.push(...parsed.diagnostics);
      if (parsed.pulse === null || diagnostics.some((item) => item.severity === 'error')) {
        return sendEnvelope(
          reply,
          requestResult(
            operationResult('qr-decode', 'rejected', null, diagnostics),
            requestSignal.signal
          )
        );
      }
      const staged = await stageArtifact(
        artifactStore,
        'qr-decode',
        'decoded.pulse',
        encodeUtf8(decoded.pulseText),
        { pulseText: decoded.pulseText },
        diagnostics,
        requestSignal.signal,
        'Decoded QR content could not be staged for download.'
      );
      return sendEnvelope(reply, staged);
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
        return sendEnvelope(
          reply,
          operationResult('qr-encode', 'rejected', null, [
            makeDiagnostic(
              DIAGNOSTIC_CODES.RECOGNIZE_INVALID_ENCODING,
              'error',
              'recognize',
              'Input is not valid UTF-8.',
              location('$')
            )
          ])
        );
      }
      const encoded = encodeQr(text, { maxDecodedBytes: limits.maxBytes });
      return sendEnvelope(
        reply,
        requestResult(
          operationResult(
            'qr-encode',
            encoded.content === null ? 'rejected' : 'success',
            encoded.content === null ? null : { content: encoded.content },
            encoded.diagnostics
          ),
          requestSignal.signal
        )
      );
    } finally {
      requestSignal.dispose();
    }
  });

  app.post('/api/v1/pulses/edit', async (request, reply) => {
    const requestSignal = requestAbortSignal(request, limits.processingTimeoutMs, reply);
    try {
      const body = jsonBody(request);
      const bodyError = validateJsonKeys(body, [
        'text',
        'displayName',
        'kind',
        'sectionIndex',
        'pointIndex',
        'value',
        'startIndex',
        'endIndex',
        'atIndex',
        'anchor'
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
      if (body === null || typeof body.text !== 'string') {
        return sendEnvelope(
          reply,
          operationResult('edit', 'rejected', null, [
            editDiagnostic('Input must contain a text string.', 'text')
          ])
        );
      }
      const { text, displayName, ...commandPayload } = body;
      const commandResult = parseEditCommand(commandPayload);
      if (commandResult.value === null) {
        return sendEnvelope(
          reply,
          operationResult('edit', 'rejected', null, [commandParseDiagnostic(commandResult.error)])
        );
      }
      if (encodeUtf8(text).byteLength > limits.maxBytes) {
        return sendEnvelope(reply, rejectedInput('Request exceeds the configured byte limit.'));
      }
      const edited = requestResult(
        applyPulseEdit(text, {
          command: commandResult.value,
          maxBytes: limits.maxBytes,
          signal: requestSignal.signal
        }),
        requestSignal.signal
      );
      if (edited.status !== 'success' || edited.data === null) return sendEnvelope(reply, edited);
      const staged = await stageArtifact(
        artifactStore,
        'edit',
        sanitizeDisplayName(typeof displayName === 'string' ? displayName : 'edited.pulse'),
        edited.data.bytes,
        edited.data,
        edited.diagnostics,
        requestSignal.signal,
        'Edited content could not be staged for download.'
      );
      return sendEnvelope(reply, staged);
    } catch {
      return sendEnvelope(
        reply,
        requestSignal.signal.aborted
          ? requestCancelled(requestSignal.signal)
          : operationResult('edit', 'failed', null, [
              adapterDiagnostic(
                DIAGNOSTIC_CODES.ADAPTER_WRITE,
                'Edited content could not be staged for download.'
              )
            ])
      );
    } finally {
      requestSignal.dispose();
    }
  });

  app.post('/api/v1/pulses/assist', async (request, reply) => {
    const requestSignal = requestAbortSignal(request, limits.processingTimeoutMs, reply);
    try {
      const body = jsonBody(request);
      const bodyError = validateJsonKeys(body, [
        'text',
        'displayName',
        'sectionIndex',
        'startPointIndex',
        'endPointIndex',
        'startStrength',
        'endStrength',
        'reviewed'
      ]);
      if (bodyError !== null) return sendEnvelope(reply, bodyError);
      if (body === null || typeof body.text !== 'string') {
        return sendEnvelope(
          reply,
          operationResult('edit', 'rejected', null, [
            editDiagnostic('Assist input must contain a text string.', 'text')
          ])
        );
      }
      if (body.displayName !== undefined && typeof body.displayName !== 'string') {
        return sendEnvelope(
          reply,
          operationResult('edit', 'rejected', null, [
            editDiagnostic('Assist displayName must be text.', 'displayName')
          ])
        );
      }
      const assistCommand = parseAssistCommand({
        sectionIndex: body.sectionIndex,
        startPointIndex: body.startPointIndex,
        endPointIndex: body.endPointIndex,
        startStrength: body.startStrength,
        endStrength: body.endStrength,
        reviewed: body.reviewed
      });
      if (assistCommand.value === null) {
        return sendEnvelope(
          reply,
          operationResult('edit', 'rejected', null, [commandParseDiagnostic(assistCommand.error)])
        );
      }
      const inputBytes = encodeUtf8(body.text);
      if (inputBytes.byteLength > limits.maxBytes)
        return sendEnvelope(reply, rejectedInput('Request exceeds the configured byte limit.'));
      const edited = applyPulseAssist(body.text, {
        maxBytes: limits.maxBytes,
        ...assistCommand.value,
        signal: requestSignal.signal
      });
      const effective = requestResult(edited, requestSignal.signal);
      if (effective.status !== 'success' || effective.data === null)
        return sendEnvelope(reply, effective);
      const staged = await stageArtifact(
        artifactStore,
        'edit',
        sanitizeDisplayName(
          typeof body.displayName === 'string' ? body.displayName : 'assisted.pulse'
        ),
        effective.data.bytes,
        effective.data,
        effective.diagnostics,
        requestSignal.signal,
        'Assisted edit could not be staged for download.'
      );
      return sendEnvelope(reply, staged);
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
      const format = requestedFormat === undefined ? 'svg' : requestedFormat;
      if (format !== 'svg' && format !== 'png' && format !== 'jpg') {
        return sendEnvelope(
          reply,
          operationResult('render', 'rejected', null, [
            makeDiagnostic(
              DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_FORMAT,
              'error',
              'export',
              'Preview format is not supported.',
              location('format')
            )
          ])
        );
      }
      const inspected = inspectPulse(input.content, {
        input: { displayName: input.displayName, bytes: input.content.byteLength },
        maxBytes: limits.maxBytes,
        maxExpandedPoints: limits.maxExpandedPoints,
        maxExpandedDurationMs: limits.maxExpandedDurationMs,
        signal: requestSignal.signal
      });
      const effective = requestResult(inspected, requestSignal.signal);
      if (
        effective.status !== 'success' ||
        effective.data?.stream === null ||
        effective.data?.stream === undefined
      ) {
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
        if (afterRender.status !== 'success' || afterRender.data === null)
          return sendEnvelope(reply, afterRender);
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
        return sendEnvelope(
          reply,
          operationResult('render', 'rejected', null, [
            makeDiagnostic(
              DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_FORMAT,
              'error',
              'export',
              'Preview could not be encoded in the requested format.',
              location('format')
            )
          ])
        );
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
    const errorCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { readonly code?: unknown }).code)
        : '';
    const tooLarge =
      errorCode === 'FST_ERR_CTP_BODY_TOO_LARGE' || errorCode === 'FST_REQ_FILE_TOO_LARGE';
    const unsupported = errorCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE';
    const invalidJson =
      errorCode === 'FST_ERR_CTP_INVALID_JSON_BODY' || errorCode === 'FST_ERR_CTP_EMPTY_JSON_BODY';
    const statusCode = tooLarge ? 413 : unsupported ? 415 : invalidJson ? 422 : 500;
    const diagnostic = tooLarge
      ? makeDiagnostic(
          DIAGNOSTIC_CODES.TASK_INPUT_LIMIT,
          'error',
          'resource',
          'Request exceeds the configured byte limit.',
          location('$')
        )
      : unsupported
        ? makeDiagnostic(
            DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT,
            'error',
            'recognize',
            'Request content type is not supported.',
            location('$')
          )
        : invalidJson
          ? makeDiagnostic(
              DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT,
              'error',
              'recognize',
              'Request JSON body is invalid.',
              location('$')
            )
          : adapterDiagnostic(DIAGNOSTIC_CODES.ADAPTER_READ, 'Request could not be processed.');
    reply
      .code(statusCode)
      .type('application/json')
      .send(
        toOperationDto(
          operationResult(
            'request',
            tooLarge || unsupported || invalidJson ? 'rejected' : 'failed',
            null,
            [diagnostic]
          )
        )
      );
  });
}
