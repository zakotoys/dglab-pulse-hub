import {
  DIAGNOSTIC_CODES,
  DEFAULT_RULE_SET,
  diffPulse,
  expandWaveform,
  hasBlockingErrors,
  makeDiagnostic,
  location,
  parsePulse,
  projectMetadata,
  semanticallyEqual,
  setControlPointAnchor,
  setControlPointStrength,
  setSectionDuration,
  setSectionFrequency,
  addControlPoint,
  applyReviewedQuadraticAssist,
  removeControlPoint,
  serializePulse,
  sortDiagnostics,
  validatePulse,
  type Diagnostic,
  type FormatKind,
  type ParseResult,
  type Pulse,
  type ControlPoint,
  type PulseMetadataBundle,
  type WaveformStream
} from '@dglab-pulse-hub/core';
import { decodeQr, encodeQr } from './qr.js';
import {
  operationResult,
  statusFromDiagnostics,
  type OperationResult
} from './result.js';

export interface InputDescriptor {
  readonly displayName?: string;
  readonly bytes?: number;
}

export interface InspectOptions {
  readonly input?: InputDescriptor;
  /** Maximum UTF-8 bytes accepted for the source document, including a QR
   * envelope's decoded pulse text. */
  readonly maxBytes?: number;
  readonly includeStream?: boolean;
  readonly maxExpandedPoints?: number;
  readonly maxExpandedDurationMs?: number;
  readonly signal?: AbortSignal;
}

export interface InspectData {
  readonly recognition: ParseResult['recognition'];
  readonly pulse: Pulse;
  readonly metadata: PulseMetadataBundle;
  readonly stream: WaveformStream | null;
  readonly sourceDigest: string;
}

export interface DiffOptions {
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

export interface DiffData {
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly diff: ReturnType<typeof diffPulse>;
}

function cancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function cancellationDiagnostic(): Diagnostic {
  return makeDiagnostic(
    'PULSE_TASK_CANCELLED',
    'info',
    'task',
    'Operation was cancelled before completion.',
    location('$')
  );
}

interface ParsedInput {
  readonly parse: ParseResult;
  readonly diagnostics: readonly Diagnostic[];
}

/** Resolve text/bytes through recognition, or defensively validate a model
 * supplied by an in-process caller. Object inputs must use the same source
 * snapshot and resource boundary as parsed inputs; otherwise diff/export/edit
 * could bypass the byte budget simply by handing over a Pulse object. */
function resolvePulseInput(
  input: Pulse | string | Uint8Array,
  maxBytes?: number
): { readonly pulse: Pulse | null; readonly diagnostics: readonly Diagnostic[] } {
  if (input !== null && typeof input === 'object' && !(input instanceof Uint8Array)) {
    const rules = maxBytes === undefined
      ? DEFAULT_RULE_SET
      : { ...DEFAULT_RULE_SET, maxBytes };
    const validation = validatePulse(input as Pulse, rules);
    return {
      pulse: validation.valid ? input as Pulse : null,
      diagnostics: validation.diagnostics
    };
  }
  const parsed = parseInput(input as string | Uint8Array, maxBytes);
  return { pulse: parsed.parse.pulse, diagnostics: parsed.diagnostics };
}

function qrLimitsFor(maxBytes: number | undefined): Parameters<typeof decodeQr>[1] {
  if (maxBytes === undefined) return {};
  // Apply the same byte budget to compressed and decoded QR payloads. The hex
  // budget is expressed in characters, so allow two characters per byte while
  // guarding arithmetic overflow for untrusted runtime options.
  const maxHexCharacters = Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, maxBytes > (Number.MAX_SAFE_INTEGER - 32) / 2
      ? Number.MAX_SAFE_INTEGER
      : maxBytes * 2 + 32)
    : maxBytes;
  // The gzip member contains Base64, whose representation is at most 4/3 the
  // decoded UTF-8 size (plus padding). Leave that framing headroom so the
  // nested pulse parser, rather than the intermediary encoding, enforces the
  // caller's actual source-text budget.
  const maxDecompressedBytes = Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(
        64 * 1024,
        maxBytes > (Number.MAX_SAFE_INTEGER - 8) * 3 / 4
          ? Number.MAX_SAFE_INTEGER
          : Math.ceil(maxBytes * 4 / 3) + 4
      ))
    : maxBytes;
  return {
    maxHexCharacters,
    maxCompressedBytes: maxBytes,
    maxDecompressedBytes,
    maxDecodedBytes: maxBytes
  };
}

function parseInput(
  input: string | Uint8Array,
  maxBytes?: number
): ParsedInput {
  const parseOptions = maxBytes === undefined ? {} : { maxBytes };
  const initial = parsePulse(input, parseOptions);
  if (initial.recognition.format !== 'qr-envelope') {
    return { parse: initial, diagnostics: initial.diagnostics };
  }
  const sourceText = initial.recognition.source?.text ?? '';
  const decoded = decodeQr(sourceText, qrLimitsFor(maxBytes));
  if (!decoded.accepted || decoded.pulseText === null) {
    return {
      parse: initial,
      diagnostics: sortDiagnostics([...initial.diagnostics, ...decoded.diagnostics])
    };
  }
  const nested = parsePulse(decoded.pulseText, parseOptions);
  return {
    parse: {
      ...nested,
      recognition: {
        ...nested.recognition,
        format: 'qr-envelope',
        evidence: Object.freeze(['community-inferred'])
      }
    },
    diagnostics: sortDiagnostics([...initial.diagnostics, ...decoded.diagnostics, ...nested.diagnostics])
  };
}

export function inspectPulse(
  input: string | Uint8Array,
  options: InspectOptions = {}
): OperationResult<InspectData> {
  if (options === null || typeof options !== 'object') options = {};
  if (cancelled(options.signal)) {
    return operationResult('inspect', 'cancelled', null, [cancellationDiagnostic()]);
  }
  let parsed: ParsedInput;
  try {
    parsed = parseInput(input, options.maxBytes);
  } catch {
    return operationResult('inspect', 'rejected', null, [
      makeDiagnostic(
        DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT,
        'error',
        'recognize',
        'Input could not be inspected.',
        location('$')
      )
    ]);
  }
  const diagnostics = [...parsed.diagnostics];
  if (parsed.parse.pulse === null) {
    return operationResult('inspect', 'rejected', null, sortDiagnostics(diagnostics));
  }
  if (cancelled(options.signal)) {
    return operationResult('inspect', 'cancelled', null, [cancellationDiagnostic()]);
  }
  const expansion = expandWaveform(parsed.parse.pulse, {
    maxPoints: options.maxExpandedPoints,
    maxDurationMs: options.maxExpandedDurationMs,
    signal: options.signal
  });
  diagnostics.push(...expansion.diagnostics);
  if (cancelled(options.signal)) {
    return operationResult('inspect', 'cancelled', null, sortDiagnostics(diagnostics));
  }
  const stream = expansion.stream;
  const status = statusFromDiagnostics(diagnostics, stream !== null);
  // A rejected expansion must not leak a partial metadata/Pulse payload. The
  // public envelope treats every non-success result as terminal with `null`
  // data, even though the low-level expansion result may contain projections
  // useful for diagnostics.
  if (status !== 'success') {
    return operationResult('inspect', status, null, sortDiagnostics(diagnostics));
  }
  const metadata = projectMetadata(parsed.parse.pulse, stream, {
    displayName: options.input?.displayName,
    byteSize: options.input?.bytes,
    diagnostics
  });
  const data: InspectData = {
    recognition: parsed.parse.recognition,
    pulse: parsed.parse.pulse,
    metadata,
    stream: options.includeStream === false ? null : stream,
    sourceDigest: parsed.parse.pulse.source.digest
  };
  return operationResult('inspect', status, data, sortDiagnostics(diagnostics));
}

/** Compare two independently supplied documents through the same semantic,
 * metadata and expanded-stream projections used by the editor. */
export function diffPulses(
  beforeInput: Pulse | string | Uint8Array,
  afterInput: Pulse | string | Uint8Array,
  options: DiffOptions = {}
): OperationResult<DiffData> {
  if (options === null || typeof options !== 'object') options = {};
  if (cancelled(options.signal)) {
    return operationResult('diff', 'cancelled', null, [cancellationDiagnostic()]);
  }
  let before: Pulse | null = null;
  let after: Pulse | null = null;
  const diagnostics: Diagnostic[] = [];
  try {
    const parsedBefore = resolvePulseInput(beforeInput, options.maxBytes);
    const parsedAfter = resolvePulseInput(afterInput, options.maxBytes);
    before = parsedBefore.pulse;
    after = parsedAfter.pulse;
    diagnostics.push(...parsedBefore.diagnostics, ...parsedAfter.diagnostics);
  } catch {
    return operationResult('diff', 'rejected', null, [
      makeDiagnostic(
        DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
        'error',
        'semantic',
        'Both documents must be valid pulse inputs.',
        location('$')
      )
    ]);
  }
  if (before === null || after === null) {
    return operationResult('diff', 'rejected', null, sortDiagnostics(diagnostics));
  }
  if (cancelled(options.signal)) {
    return operationResult('diff', 'cancelled', null, [cancellationDiagnostic()]);
  }
  try {
    const diff = diffPulse(before, after);
    const status = statusFromDiagnostics(diagnostics, true);
    const data = {
      beforeDigest: before.source.digest,
      afterDigest: after.source.digest,
      diff
    };
    return operationResult('diff', status, status === 'success' ? data : null, sortDiagnostics(diagnostics));
  } catch {
    return operationResult('diff', 'failed', null, [
      makeDiagnostic(
        DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
        'error',
        'semantic',
        'The documents could not be compared.',
        location('$')
      )
    ]);
  }
}

export interface ExportOptions {
  readonly maxBytes?: number;
  readonly displayName?: string;
  readonly format?: 'pulse-text' | 'qr-envelope';
  readonly mode?: 'canonical' | 'source';
  readonly signal?: AbortSignal;
}

export interface ExportData {
  readonly format: 'pulse-text' | 'qr-envelope';
  readonly displayName: string;
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly byteSize: number;
  readonly mode: 'canonical' | 'source';
  readonly sourceDigest: string;
  readonly roundTripVerified: boolean;
  /** Opaque handle used by HTTP/Electron adapters for a private download. */
  readonly downloadId?: string;
  readonly contentType?: string;
}

export type EditCommand =
  | {
      readonly kind: 'strength';
      readonly sectionIndex: number;
      readonly pointIndex: number;
      readonly value: number;
    }
  | {
      readonly kind: 'anchor';
      readonly sectionIndex: number;
      readonly pointIndex: number;
      readonly value: 0 | 1;
    }
  | {
      readonly kind: 'frequency';
      readonly sectionIndex: number;
      readonly startIndex: number;
      readonly endIndex: number;
    }
  | {
      readonly kind: 'duration';
      readonly sectionIndex: number;
      readonly value: number;
    }
  | {
      readonly kind: 'add-point';
      readonly sectionIndex: number;
      readonly point: ControlPoint;
      readonly atIndex?: number;
    }
  | {
      readonly kind: 'remove-point';
      readonly sectionIndex: number;
      readonly pointIndex: number;
    };

export interface EditOptions {
  readonly maxBytes?: number;
  readonly displayName?: string;
  readonly command: EditCommand;
  readonly signal?: AbortSignal;
}

export interface AssistOptions {
  readonly maxBytes?: number;
  readonly sectionIndex: number;
  readonly startPointIndex: number;
  readonly endPointIndex: number;
  readonly startStrength: number;
  readonly endStrength: number;
  readonly reviewed: boolean;
  readonly signal?: AbortSignal;
}

export interface EditData {
  readonly format: 'pulse-text';
  readonly mode: 'canonical';
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly byteSize: number;
  readonly sourceDigest: string;
  readonly roundTripVerified: boolean;
  readonly changeRecords: readonly import('@dglab-pulse-hub/core').ChangeRecord[];
  readonly downloadId?: string;
  readonly contentType?: string;
}

function rejectedExport(
  diagnostics: readonly Diagnostic[]
): OperationResult<ExportData> {
  const effective = diagnostics.length > 0
    ? diagnostics
    : [makeDiagnostic(
        DIAGNOSTIC_CODES.EXPORT_BLOCKED,
        'error',
        'export',
        'Pulse could not be exported.',
        location('$')
      )];
  return operationResult('export', 'rejected', null, sortDiagnostics(effective));
}

function unsupportedExportOption(field: 'format' | 'mode', value: unknown): Diagnostic {
  return makeDiagnostic(
    field === 'format'
      ? DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_FORMAT
      : DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_MODE,
    'error',
    'export',
    'Unsupported export ' + field + '.',
    location('$', undefined, { field }),
    { parameters: { value: typeof value === 'string' ? value : String(value) } }
  );
}

function exportFailure(_error: unknown): Diagnostic {
  return makeDiagnostic(
    DIAGNOSTIC_CODES.EXPORT_BLOCKED,
    'error',
    'export',
    'Pulse could not be exported.',
    location('$')
  );
}

export function exportPulse(
  input: Pulse | string | Uint8Array,
  options: ExportOptions = {}
): OperationResult<ExportData> {
  if (options === null || typeof options !== 'object') options = {};
  if (cancelled(options.signal)) {
    return operationResult('export', 'cancelled', null, [cancellationDiagnostic()]);
  }
  const requestedFormat: unknown = options.format;
  if (requestedFormat !== undefined && requestedFormat !== 'pulse-text' && requestedFormat !== 'qr-envelope') {
    return rejectedExport([unsupportedExportOption('format', requestedFormat)]);
  }
  const requestedMode: unknown = options.mode;
  if (requestedMode !== undefined && requestedMode !== 'canonical' && requestedMode !== 'source') {
    return rejectedExport([unsupportedExportOption('mode', requestedMode)]);
  }
  if (requestedFormat === 'qr-envelope' && requestedMode === 'source') {
    return rejectedExport([makeDiagnostic(
      DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_MODE,
      'error',
      'export',
      'Source mode is only supported for pulse-text export.',
      location('mode')
    )]);
  }
  let pulse: Pulse | null;
  let parseDiagnostics: readonly Diagnostic[] = [];
  try {
    const parsed = resolvePulseInput(input, options.maxBytes);
    pulse = parsed.pulse;
    parseDiagnostics = parsed.diagnostics;
  } catch (error) {
    return rejectedExport([exportFailure(error)]);
  }
  if (pulse === null) return rejectedExport(parseDiagnostics);
  if (cancelled(options.signal)) {
    return operationResult('export', 'cancelled', null, [cancellationDiagnostic()]);
  }
  const format = requestedFormat === undefined ? 'pulse-text' : requestedFormat;
  if (format === 'qr-envelope') {
    let encoded: ReturnType<typeof encodeQr>;
    try {
      encoded = encodeQr(pulse, qrLimitsFor(options.maxBytes));
    } catch (error) {
      return rejectedExport([...parseDiagnostics, exportFailure(error)]);
    }
    const diagnostics = sortDiagnostics([...parseDiagnostics, ...encoded.diagnostics]);
    if (encoded.content === null || hasBlockingErrors(diagnostics)) {
      return rejectedExport(diagnostics);
    }
    const bytes = new TextEncoder().encode(encoded.content);
    return operationResult('export', 'success', {
      format,
      displayName: options.displayName ?? 'pulse.qr.txt',
      text: encoded.content,
      bytes,
      byteSize: bytes.byteLength,
      mode: 'canonical',
      sourceDigest: pulse.source.digest,
      roundTripVerified: true
    }, diagnostics);
  }
  let serialized: ReturnType<typeof serializePulse>;
  try {
    serialized = serializePulse(pulse, {
      mode: requestedMode === undefined ? undefined : requestedMode
    });
  } catch (error) {
    return rejectedExport([...parseDiagnostics, exportFailure(error)]);
  }
  const diagnostics = [...parseDiagnostics, ...serialized.diagnostics];
  if (hasBlockingErrors(diagnostics)) return rejectedExport(diagnostics);
  let roundTrip: ParseResult;
  try {
    roundTrip = parsePulse(
      serialized.bytes,
      options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }
    );
  } catch (error) {
    diagnostics.push(exportFailure(error));
    return rejectedExport(diagnostics);
  }
  diagnostics.push(...roundTrip.diagnostics);
  const verified = roundTrip.pulse !== null && semanticallyEqual(pulse, roundTrip.pulse);
  if (!verified) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.EXPORT_ROUNDTRIP_MISMATCH,
        'error',
        'export',
        'Serialized output did not round-trip to equivalent pulse semantics.',
        location('$')
      )
    );
  }
  if (hasBlockingErrors(diagnostics)) return rejectedExport(diagnostics);
  return operationResult('export', 'success', {
    format,
    displayName: options.displayName ?? 'pulse.pulse',
    text: serialized.text,
    bytes: serialized.bytes,
    byteSize: serialized.bytes.byteLength,
    mode: serialized.mode,
    sourceDigest: pulse.source.digest,
    roundTripVerified: verified
  }, sortDiagnostics(diagnostics));
}

function editFailure(diagnostics: readonly Diagnostic[]): OperationResult<EditData> {
  const effective = diagnostics.length > 0
    ? diagnostics
    : [makeDiagnostic(
        DIAGNOSTIC_CODES.EDIT_VALUE,
        'error',
        'semantic',
        'Pulse edit could not be applied.',
        location('$')
      )];
  return operationResult('edit', 'rejected', null, sortDiagnostics(effective));
}

function finalizeEdit(
  sourcePulse: Pulse,
  edited: {
    readonly pulse: Pulse | null;
    readonly changeRecords: readonly import('@dglab-pulse-hub/core').ChangeRecord[];
    readonly diagnostics: readonly Diagnostic[];
  },
  parseDiagnostics: readonly Diagnostic[],
  signal?: AbortSignal,
  maxBytes?: number
): OperationResult<EditData> {
  const diagnostics = [...parseDiagnostics, ...edited.diagnostics];
  if (edited.pulse === null || hasBlockingErrors(diagnostics)) return editFailure(diagnostics);
  if (cancelled(signal)) return operationResult('edit', 'cancelled', null, [cancellationDiagnostic()]);
  let serialized: ReturnType<typeof serializePulse>;
  try {
    serialized = serializePulse(edited.pulse, { mode: 'canonical' });
  } catch {
    return editFailure([...diagnostics, makeDiagnostic(
      DIAGNOSTIC_CODES.EXPORT_BLOCKED,
      'error',
      'export',
      'Edited Pulse could not be serialized.',
      location('$')
    )]);
  }
  diagnostics.push(...serialized.diagnostics);
  const roundTrip = parsePulse(
    serialized.bytes,
    maxBytes === undefined ? {} : { maxBytes }
  );
  diagnostics.push(...roundTrip.diagnostics);
  const verified = roundTrip.pulse !== null && semanticallyEqual(edited.pulse, roundTrip.pulse);
  if (!verified) {
    diagnostics.push(makeDiagnostic(
      DIAGNOSTIC_CODES.EXPORT_ROUNDTRIP_MISMATCH,
      'error',
      'export',
      'Edited output did not round-trip to equivalent pulse semantics.',
      location('$')
    ));
  }
  if (hasBlockingErrors(diagnostics)) return editFailure(diagnostics);
  const bytes = new Uint8Array(serialized.bytes);
  return operationResult('edit', 'success', {
    format: 'pulse-text',
    mode: 'canonical',
    text: serialized.text,
    bytes,
    byteSize: bytes.byteLength,
    sourceDigest: sourcePulse.source.digest,
    roundTripVerified: verified,
    changeRecords: Object.freeze([...edited.changeRecords]),
    contentType: 'text/plain'
  }, sortDiagnostics(diagnostics));
}

/** Apply one explicit domain edit and return a canonical, revalidated result.
 * The raw text/bytes stay in the application result for local adapters; public
 * projectors replace them with an opaque download descriptor. */
export function applyPulseEdit(
  input: Pulse | string | Uint8Array,
  options: EditOptions
): OperationResult<EditData> {
  if (options === null || typeof options !== 'object' ||
      !('command' in options) || options.command === null || typeof options.command !== 'object') {
    return editFailure([makeDiagnostic(
      DIAGNOSTIC_CODES.EDIT_VALUE,
      'error',
      'semantic',
      'An edit command is required.',
      location('command')
    )]);
  }
  if (cancelled(options.signal)) {
    return operationResult('edit', 'cancelled', null, [cancellationDiagnostic()]);
  }
  let pulse: Pulse | null;
  let parseDiagnostics: readonly Diagnostic[] = [];
  try {
    const parsed = resolvePulseInput(input, options.maxBytes);
    pulse = parsed.pulse;
    parseDiagnostics = parsed.diagnostics;
  } catch {
    return editFailure([makeDiagnostic(
      DIAGNOSTIC_CODES.EDIT_VALUE,
      'error',
      'semantic',
      'Pulse input could not be parsed.',
      location('$')
    )]);
  }
  if (pulse === null) return editFailure(parseDiagnostics);
  if (cancelled(options.signal)) return operationResult('edit', 'cancelled', null, [cancellationDiagnostic()]);

  let edited: ReturnType<typeof setControlPointStrength>;
  try {
    switch (options.command.kind) {
      case 'strength':
        edited = setControlPointStrength(
          pulse,
          options.command.sectionIndex,
          options.command.pointIndex,
          options.command.value
        );
        break;
      case 'anchor':
        edited = setControlPointAnchor(
          pulse,
          options.command.sectionIndex,
          options.command.pointIndex,
          options.command.value
        );
        break;
      case 'frequency':
        edited = setSectionFrequency(
          pulse,
          options.command.sectionIndex,
          options.command.startIndex,
          options.command.endIndex
        );
        break;
      case 'duration':
        edited = setSectionDuration(
          pulse,
          options.command.sectionIndex,
          options.command.value
        );
        break;
      case 'add-point':
        edited = addControlPoint(
          pulse,
          options.command.sectionIndex,
          options.command.point,
          options.command.atIndex
        );
        break;
      case 'remove-point':
        edited = removeControlPoint(
          pulse,
          options.command.sectionIndex,
          options.command.pointIndex
        );
        break;
      default:
        return editFailure([makeDiagnostic(
          DIAGNOSTIC_CODES.EDIT_VALUE,
          'error',
          'semantic',
          'Unsupported edit command.',
          location('command')
        )]);
    }
  } catch {
    return editFailure([makeDiagnostic(
      DIAGNOSTIC_CODES.EDIT_VALUE,
      'error',
      'semantic',
      'Pulse edit could not be applied.',
      location('command')
    )]);
  }
  return finalizeEdit(pulse, edited, parseDiagnostics, options.signal, options.maxBytes);
}

/** Apply a reviewed quadratic assist through the same parse, validation and
 * round-trip pipeline as ordinary edits. */
export function applyPulseAssist(
  input: Pulse | string | Uint8Array,
  options: AssistOptions
): OperationResult<EditData> {
  if (options === null || typeof options !== 'object') {
    return editFailure([makeDiagnostic(
      DIAGNOSTIC_CODES.EDIT_NOT_REVIEWED,
      'error',
      'semantic',
      'A reviewed quadratic assist command is required.',
      location('command')
    )]);
  }
  if (cancelled(options.signal)) return operationResult('edit', 'cancelled', null, [cancellationDiagnostic()]);
  let pulse: Pulse | null;
  let parseDiagnostics: readonly Diagnostic[] = [];
  try {
    const parsed = resolvePulseInput(input, options.maxBytes);
    pulse = parsed.pulse;
    parseDiagnostics = parsed.diagnostics;
  } catch {
    return editFailure([makeDiagnostic(
      DIAGNOSTIC_CODES.EDIT_VALUE,
      'error',
      'semantic',
      'Pulse input could not be parsed.',
      location('$')
    )]);
  }
  if (pulse === null) return editFailure(parseDiagnostics);
  const edited = applyReviewedQuadraticAssist(pulse, {
    sectionIndex: options.sectionIndex,
    startPointIndex: options.startPointIndex,
    endPointIndex: options.endPointIndex,
    startStrength: options.startStrength,
    endStrength: options.endStrength,
    reviewed: options.reviewed
  });
  return finalizeEdit(pulse, edited, parseDiagnostics, options.signal, options.maxBytes);
}
