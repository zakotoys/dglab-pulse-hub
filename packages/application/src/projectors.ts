import {
  encodeUtf8,
  makeDiagnostic,
  stableDigest,
  PULSE_PREFIX,
  type Diagnostic
} from '@dglab-pulse-hub/core';
import type { EditData, ExportData, InspectData } from './single.js';
import type { OperationResult } from './result.js';
import {
  batchDataSchema,
  changeRecordSchema,
  editDataSchema,
  exportDataSchema,
  inspectDataSchema,
  operationEnvelopeSchema,
  qrDecodeDataSchema,
  qrEncodeDataSchema,
  renderDataSchema,
  diffDataSchema,
  type ExportResultDto,
  type InspectResultDto,
  type OperationEnvelopeDto
} from '@dglab-pulse-hub/contracts';
import { sanitizeDisplayName, type FileReadData, type FileWriteData } from './filesystem.js';

export function toInspectDto(data: InspectData): InspectResultDto {
  const metadata = {
    ...data.metadata,
    file: {
      ...data.metadata.file,
      displayName: sanitizeDisplayName(data.metadata.file.displayName)
    },
    pulse: {
      ...data.metadata.pulse,
      diagnostics: data.metadata.pulse.diagnostics.map(projectDiagnostic)
    },
    sections: data.metadata.sections.map((section) => ({
      ...section,
      diagnostics: section.diagnostics.map(projectDiagnostic)
    })),
    stream: {
      ...data.metadata.stream
    }
  };
  return inspectDataSchema.parse({
    recognition: {
      format: data.recognition.format,
      profile: data.recognition.profile,
      ruleVersion: data.recognition.ruleVersion,
      evidence: [...data.recognition.evidence],
      diagnostics: data.recognition.diagnostics.map(projectDiagnostic)
    },
    pulse: {
      kind: 'pulse',
      format: 'pulse-text',
      formatProfile: data.pulse.formatProfile,
      ruleVersion: data.pulse.ruleVersion,
      evidence: [...data.pulse.evidence],
      revision: data.pulse.revision,
      globals: {
        sectionRestIndex: data.pulse.globals.sectionRestIndex,
        playbackSpeed: data.pulse.globals.playbackSpeed,
        frequencyBalanceIndex: data.pulse.globals.frequencyBalanceIndex,
        raw: [...data.pulse.globals.raw] as [string, string, string]
      },
      sectionCount: data.pulse.sections.length,
      changeCount: data.pulse.changeRecords.length
    },
    metadata,
    stream:
      data.stream === null
        ? null
        : {
            ...data.stream,
            warnings: data.stream.warnings.map(projectDiagnostic)
          },
    sourceDigest: data.sourceDigest
  });
}

export function toExportDto(data: ExportData): ExportResultDto {
  if (!isRecord(data) || data.roundTripVerified !== true) {
    throw new Error('Export result is not verified.');
  }
  if (data.format !== 'pulse-text' && data.format !== 'qr-envelope') {
    throw new Error('Export result format is invalid.');
  }
  if (data.mode !== 'canonical' && data.mode !== 'source') {
    throw new Error('Export result mode is invalid.');
  }
  const value: Record<string, unknown> = {
    format: data.format,
    displayName: sanitizeDisplayName(data.displayName),
    byteSize: data.byteSize,
    mode: data.mode,
    sourceDigest: data.sourceDigest,
    roundTripVerified: data.roundTripVerified
  };
  if (typeof data.downloadId === 'string') value.downloadId = data.downloadId;
  if (typeof data.contentType === 'string') value.contentType = data.contentType;
  return exportDataSchema.parse(value);
}

export function toEditDto(data: EditData): import('@dglab-pulse-hub/contracts').EditDataDto {
  if (!isRecord(data) || data.roundTripVerified !== true) {
    throw new Error('Edit result is not verified.');
  }
  return editDataSchema.parse({
    format: data.format,
    mode: data.mode,
    byteSize: data.byteSize,
    sourceDigest: data.sourceDigest,
    roundTripVerified: data.roundTripVerified,
    changeRecords: data.changeRecords,
    ...(data.downloadId === undefined ? {} : { downloadId: data.downloadId }),
    ...(data.contentType === undefined ? {} : { contentType: data.contentType })
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function projectBatchPayload(value: unknown): unknown {
  if (!isRecord(value)) return null;
  if ('metadata' in value && 'pulse' in value && 'recognition' in value) {
    // Let the caller turn a malformed successful item into a failed envelope.
    // Returning `{}` here would make an invalid private payload look like a
    // successful public result because batch item results are intentionally
    // otherwise opaque.
    return toInspectDto(value as unknown as InspectData);
  }
  if ('format' in value && 'bytes' in value && 'roundTripVerified' in value) {
    return toExportDto(value as unknown as ExportData);
  }
  // Batch operations currently expose only inspect/export payloads. An
  // unknown adapter payload is never allowed to masquerade as success.
  return null;
}

function projectQrEncodePayload(value: unknown): unknown {
  if (!isRecord(value) || typeof value.content !== 'string') return null;
  const parsed = qrEncodeDataSchema.safeParse({ content: value.content });
  return parsed.success ? parsed.data : null;
}

function projectQrDecodePayload(value: unknown): unknown {
  // The decoded plaintext is deliberately reduced to a content descriptor.
  if (isRecord(value) && typeof value.pulseText === 'string') {
    if (!value.pulseText.startsWith(PULSE_PREFIX)) return null;
    if (
      'downloadId' in value &&
      (typeof value.downloadId !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/.test(value.downloadId))
    )
      return null;
    const bytes = encodeUtf8(value.pulseText);
    const downloadId = typeof value.downloadId === 'string' ? value.downloadId : undefined;
    const parsed = qrDecodeDataSchema.safeParse({
      format: 'pulse-text',
      formatProfile: 'dungeonlab-pulse-text/corpus-v1',
      ruleVersion: 'pulse-rules-v1',
      byteSize: bytes.byteLength,
      digest: stableDigest(bytes),
      contentType: 'text/plain',
      ...(downloadId === undefined ? {} : { downloadId })
    });
    return parsed.success ? parsed.data : null;
  }
  const parsed = qrDecodeDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function projectEditPayload(value: unknown): unknown {
  if (!isRecord(value)) return null;
  const text = typeof value.text === 'string' ? value.text : null;
  const bytes = value.bytes instanceof Uint8Array ? value.bytes : null;
  if (text === null && bytes === null) return null;
  if (text !== null && bytes !== null && encodeUtf8(text).byteLength !== bytes.byteLength)
    return null;
  if (value.roundTripVerified !== true) return null;
  if (
    'downloadId' in value &&
    (typeof value.downloadId !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/.test(value.downloadId))
  )
    return null;
  const sourceDigest = typeof value.sourceDigest === 'string' ? value.sourceDigest : '';
  const rawChangeRecords = Array.isArray(value.changeRecords) ? value.changeRecords : [];
  const changeRecords = rawChangeRecords.map(projectChangeRecord);
  if (changeRecords.some((record) => record === null)) return null;
  const candidate: Record<string, unknown> = {
    format: value.format === undefined ? 'pulse-text' : value.format,
    mode: value.mode === undefined ? 'canonical' : value.mode,
    byteSize: bytes?.byteLength ?? (text === null ? 0 : encodeUtf8(text).byteLength),
    sourceDigest,
    roundTripVerified: true,
    changeRecords: changeRecords as unknown[]
  };
  if (typeof value.downloadId === 'string') candidate.downloadId = value.downloadId;
  if (typeof value.contentType === 'string') candidate.contentType = value.contentType;
  const parsed = editDataSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function projectChangeRecord(value: unknown): Record<string, unknown> | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.id.length > 128 ||
    !/^[A-Za-z0-9._~-]+$/.test(value.id) ||
    (value.kind !== 'edit' &&
      value.kind !== 'interpolation' &&
      value.kind !== 'format-normalization' &&
      value.kind !== 'upgrade') ||
    typeof value.description !== 'string' ||
    typeof value.path !== 'string'
  )
    return null;
  if (!/^[A-Za-z_$][A-Za-z0-9_$.[\]]*$/.test(value.path) || value.path.includes('..')) return null;
  const before = projectChangeValue(value.before);
  const after = projectChangeValue(value.after);
  if (before === undefined || after === undefined) return null;
  const candidate: Record<string, unknown> = {
    id: value.id,
    kind: value.kind,
    description: sanitizePublicText(value.description.slice(0, 2000)),
    path: value.path,
    before,
    after
  };
  if (value.affectedPointIndices !== undefined) {
    if (!Array.isArray(value.affectedPointIndices)) return null;
    const indices = value.affectedPointIndices.map((index) =>
      typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 ? index : null
    );
    if (indices.some((index) => index === null)) return null;
    candidate.affectedPointIndices = indices;
  }
  const parsed = changeRecordSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function projectChangeValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
    return value;
  }
  if (typeof value !== 'string') return undefined;
  if (value.length > 256 || value.includes(PULSE_PREFIX)) return null;
  return sanitizePublicText(value);
}

function projectRenderPayload(value: unknown): unknown {
  if (!isRecord(value)) return null;
  const candidate: Record<string, unknown> = {
    displayName: value.displayName,
    format: value.format,
    byteSize: value.bytes instanceof Uint8Array ? value.bytes.byteLength : value.byteSize,
    width: value.width,
    height: value.height,
    streamDigest: value.streamDigest
  };
  if (
    'downloadId' in value &&
    (typeof value.downloadId !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/.test(value.downloadId))
  )
    return null;
  if (typeof value.downloadId === 'string') candidate.downloadId = value.downloadId;
  if (typeof value.contentType === 'string') candidate.contentType = value.contentType;
  const parsed = renderDataSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function projectDiagnostic(value: unknown): Diagnostic {
  if (isRecord(value)) {
    const rawLocation = isRecord(value.location) ? value.location : {};
    const rawPath = typeof rawLocation.path === 'string' ? rawLocation.path : '$';
    const path =
      /^[A-Za-z_$][A-Za-z0-9_$.[\]]*$/.test(rawPath) && !rawPath.includes('..') ? rawPath : '$';
    const stage =
      typeof value.stage === 'string' &&
      [
        'recognize',
        'syntax',
        'range',
        'semantic',
        'resource',
        'export',
        'qr',
        'adapter',
        'task'
      ].includes(value.stage)
        ? (value.stage as Diagnostic['stage'])
        : 'task';
    const severity =
      value.severity === 'warning' || value.severity === 'info' ? value.severity : 'error';
    const code =
      typeof value.code === 'string' && /^PULSE_[A-Z0-9_]+$/.test(value.code)
        ? value.code
        : 'PULSE_TASK_INVALID_TRANSITION';
    const rawMessage =
      typeof value.message === 'string' && value.message.length > 0
        ? value.message.slice(0, 2000)
        : 'The operation could not be completed.';
    const message = sanitizePublicText(rawMessage);
    const rawSpan = isRecord(rawLocation.span) ? rawLocation.span : null;
    const span =
      rawSpan !== null &&
      typeof rawSpan.start === 'number' &&
      typeof rawSpan.end === 'number' &&
      typeof rawSpan.line === 'number' &&
      typeof rawSpan.column === 'number' &&
      Number.isSafeInteger(rawSpan.start) &&
      Number.isSafeInteger(rawSpan.end) &&
      Number.isSafeInteger(rawSpan.line) &&
      Number.isSafeInteger(rawSpan.column) &&
      rawSpan.start >= 0 &&
      rawSpan.end >= rawSpan.start &&
      rawSpan.line >= 1 &&
      rawSpan.column >= 1
        ? {
            start: rawSpan.start,
            end: rawSpan.end,
            line: rawSpan.line,
            column: rawSpan.column
          }
        : undefined;
    const extra: {
      sectionIndex?: number;
      pointIndex?: number;
      field?: string;
      span?: typeof span;
    } = {};
    if (
      typeof rawLocation.sectionIndex === 'number' &&
      Number.isSafeInteger(rawLocation.sectionIndex) &&
      rawLocation.sectionIndex >= 0
    ) {
      extra.sectionIndex = rawLocation.sectionIndex;
    }
    if (
      typeof rawLocation.pointIndex === 'number' &&
      Number.isSafeInteger(rawLocation.pointIndex) &&
      rawLocation.pointIndex >= 0
    ) {
      extra.pointIndex = rawLocation.pointIndex;
    }
    if (
      typeof rawLocation.field === 'string' &&
      /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(rawLocation.field)
    )
      extra.field = rawLocation.field;
    if (span !== undefined) extra.span = span;
    const suggestion =
      typeof value.suggestion === 'string' && value.suggestion.length > 0
        ? sanitizePublicText(value.suggestion.slice(0, 2000))
        : undefined;
    const rawParameters = isRecord(value.parameters) ? value.parameters : null;
    const parameters: Record<string, string | number | boolean> = {};
    if (rawParameters !== null) {
      for (const [key, parameter] of Object.entries(rawParameters)) {
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(key)) continue;
        if (/(?:source|content|bytes|payload|text|path)/i.test(key)) continue;
        if (typeof parameter === 'string')
          parameters[key] = sanitizePublicText(parameter.slice(0, 200));
        else if (typeof parameter === 'boolean') parameters[key] = parameter;
        else if (typeof parameter === 'number' && Number.isFinite(parameter))
          parameters[key] = parameter;
      }
    }
    return makeDiagnostic(
      code,
      severity,
      stage,
      message,
      { path, ...extra },
      {
        ...(suggestion === undefined ? {} : { suggestion }),
        ...(Object.keys(parameters).length === 0 ? {} : { parameters })
      }
    );
  }
  return makeDiagnostic(
    'PULSE_TASK_INVALID_TRANSITION',
    'error',
    'task',
    'The operation could not be completed.',
    { path: '$' }
  );
}

function sanitizePublicText(value: string): string {
  if (value.includes(PULSE_PREFIX)) return 'The operation could not be completed.';
  // Diagnostics are allowed to describe structural fields, but never local
  // filesystem locations or source payloads.
  if (
    /(?:^|[\s([{"'])\/(?:[^\s/]+\/)+[^\s)]*/.test(value) ||
    /\b[A-Za-z]:[\\/][^\s)]+/.test(value) ||
    value.includes('\\\\')
  ) {
    return value.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s)]+/g, '$');
  }
  return value;
}

function toBatchDto(data: unknown): unknown {
  if (!isRecord(data) || !Array.isArray(data.items)) throw new Error('Invalid batch payload.');
  const items = data.items.map((item) => {
    if (!isRecord(item))
      return {
        id: 'item-invalid',
        index: 0,
        displayName: 'pulse',
        status: 'failed',
        diagnostics: [projectDiagnostic(null)],
        result: null
      };
    const status = item.status;
    const projected = status === 'success' ? projectBatchPayload(item.data) : null;
    if (status === 'success' && projected === null) {
      throw new Error('Invalid batch item payload.');
    }
    return {
      id: item.id,
      index: item.index,
      displayName:
        typeof item.displayName === 'string' ? sanitizeDisplayName(item.displayName) : 'pulse',
      status,
      diagnostics: Array.isArray(item.diagnostics)
        ? item.diagnostics.map(projectDiagnostic)
        : [projectDiagnostic(null)],
      result: projected
    };
  });
  return batchDataSchema.parse({
    total: data.total,
    completed: data.completed,
    succeeded: data.succeeded,
    rejected: data.rejected,
    failed: data.failed,
    warningFiles: data.warningFiles,
    cancelled: data.cancelled,
    items
  });
}

export function toOperationDto<T>(result: OperationResult<T>): OperationEnvelopeDto {
  try {
    return toOperationDtoUnsafe(result);
  } catch {
    // A private adapter payload must never turn into an exception carrying
    // source bytes or a local path. Return a contract-valid failure envelope.
    const operation =
      typeof result?.operation === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(result.operation)
        ? result.operation
        : 'task';
    return operationEnvelopeSchema.parse({
      schemaVersion: 'pulse-contract-v1',
      ruleVersion: 'pulse-rules-v1',
      operation,
      status: 'failed',
      result: null,
      diagnostics: [
        makeDiagnostic(
          'PULSE_TASK_INVALID_TRANSITION',
          'error',
          'task',
          'The operation result was invalid.',
          { path: '$' }
        )
      ]
    });
  }
}

function toOperationDtoUnsafe<T>(result: OperationResult<T>): OperationEnvelopeDto {
  let payload: unknown = null;
  if (result.status === 'success' && result.data !== null) {
    if (result.operation === 'inspect') {
      payload = toInspectDto(result.data as InspectData);
    } else if (result.operation === 'export') {
      payload = toExportDto(result.data as ExportData);
    } else if (result.operation === 'batch') {
      payload = toBatchDto(result.data);
    } else if (result.operation === 'read-file') {
      const data = result.data as FileReadData;
      if (
        !isRecord(data) ||
        typeof data.displayName !== 'string' ||
        !Number.isSafeInteger(data.byteSize) ||
        data.byteSize < 0 ||
        typeof data.digest !== 'string' ||
        data.digest.length === 0 ||
        !(data.content instanceof Uint8Array) ||
        data.content.byteLength !== data.byteSize
      ) {
        throw new Error('Invalid read-file payload.');
      }
      payload = {
        displayName: sanitizeDisplayName(data.displayName),
        byteSize: data.byteSize,
        digest: data.digest
      };
    } else if (result.operation === 'write-file') {
      const data = result.data as FileWriteData;
      if (
        !isRecord(data) ||
        typeof data.displayName !== 'string' ||
        !Number.isSafeInteger(data.byteSize) ||
        data.byteSize < 0
      ) {
        throw new Error('Invalid write-file payload.');
      }
      payload = {
        displayName: sanitizeDisplayName(data.displayName),
        byteSize: data.byteSize
      };
    } else if (result.operation === 'qr-encode') {
      payload = projectQrEncodePayload(result.data);
    } else if (result.operation === 'qr-decode') {
      payload = projectQrDecodePayload(result.data);
    } else if (result.operation === 'edit') {
      payload = projectEditPayload(result.data);
    } else if (result.operation === 'render') {
      payload = projectRenderPayload(result.data);
    } else if (result.operation === 'diff') {
      payload = projectDiffPayload(result.data);
    } else {
      // Unknown operation payloads are private by default. Primitive values
      // are safe summaries; objects may contain bytes, paths or source text.
      payload =
        typeof result.data === 'string'
          ? result.data.startsWith(PULSE_PREFIX)
            ? {}
            : result.data
          : typeof result.data === 'number' || typeof result.data === 'boolean'
            ? result.data
            : {};
    }
  }
  const envelope: {
    schemaVersion: 'pulse-contract-v1';
    ruleVersion: 'pulse-rules-v1';
    operation: string;
    status: OperationEnvelopeDto['status'];
    result: unknown;
    diagnostics: readonly Diagnostic[];
    timing?: OperationEnvelopeDto['timing'];
    operationId?: string;
  } = {
    schemaVersion: result.schemaVersion,
    ruleVersion: result.ruleVersion,
    operation: result.operation,
    status: result.status,
    result: payload,
    diagnostics: result.diagnostics.map(projectDiagnostic)
  };
  if (result.timing !== undefined) envelope.timing = result.timing;
  if (result.operationId !== undefined) envelope.operationId = result.operationId;
  return operationEnvelopeSchema.parse(envelope);
}

function projectDiffPayload(value: unknown): unknown {
  if (!isRecord(value)) return null;
  const beforeDigest = typeof value.beforeDigest === 'string' ? value.beforeDigest : '';
  const afterDigest = typeof value.afterDigest === 'string' ? value.afterDigest : '';
  const rawDiff = value.diff;
  if (!isRecord(rawDiff)) return null;
  const diff: Record<string, unknown> = {};
  for (const category of ['structural', 'metadata', 'stream', 'text'] as const) {
    const rawEntries = rawDiff[category];
    if (!Array.isArray(rawEntries)) return null;
    const entries = rawEntries.map(projectDiffEntry);
    if (entries.some((entry) => entry === null)) return null;
    diff[category] = entries;
  }
  if (typeof rawDiff.equal !== 'boolean') return null;
  diff.equal = rawDiff.equal;
  const candidate = {
    beforeDigest,
    afterDigest,
    diff
  };
  const parsed = diffDataSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function projectDiffEntry(value: unknown): Record<string, unknown> | null {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    !/^[A-Za-z_$][A-Za-z0-9_$.[\]]*$/.test(value.path) ||
    value.path.includes('..')
  )
    return null;
  const before = projectDiffValue(value.before);
  const after = projectDiffValue(value.after);
  if (before === undefined || after === undefined) return null;
  return { path: value.path, before, after };
}

function projectDiffValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return typeof value === 'number' && !Number.isFinite(value) ? undefined : value;
  }
  if (typeof value !== 'string') return undefined;
  // Text diffs are useful as stable fingerprints at the public boundary, but
  // the source document itself must remain behind the download adapter.
  if (value.includes(PULSE_PREFIX) || value.length > 256) {
    return 'digest:' + stableDigest(encodeUtf8(value));
  }
  return sanitizePublicText(value);
}
