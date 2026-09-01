import { gzipSync, gunzipSync } from 'node:zlib';
import {
  DIAGNOSTIC_CODES,
  DEFAULT_RULE_SET,
  DGLAB_QR_MAX_SECTIONS,
  QR_PREFIX,
  QR_SHARE_URL,
  PULSE_PREFIX,
  encodeUtf8,
  makeDiagnostic,
  location,
  normalizeDecimal,
  parsePulse,
  serializePulse,
  sortDiagnostics,
  validatePulse,
  type Diagnostic,
  type Pulse
} from '@dglab-pulse-hub/core';

export interface QrLimits {
  readonly maxHexCharacters?: number;
  readonly maxCompressedBytes?: number;
  readonly maxDecompressedBytes?: number;
  /** Maximum UTF-8 bytes after Base64 decoding (the App internal QR text). */
  readonly maxDecodedBytes?: number;
}

export const DEFAULT_QR_LIMITS: Required<QrLimits> = Object.freeze({
  maxHexCharacters: 4_000_000,
  maxCompressedBytes: 2_000_000,
  maxDecompressedBytes: 2_000_000,
  maxDecodedBytes: 2_000_000
});

export interface QrDecodeResult {
  readonly accepted: boolean;
  readonly pulseText: string | null;
  readonly diagnostics: readonly Diagnostic[];
}

const QR_GLOBAL_FIELD_COUNT = 20;
const QR_INTERNAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const QR_INTERNAL_POINT = /^(0|1)-((?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?)$/;

interface QrInternalPoint {
  readonly anchor: 0 | 1;
  readonly strength: number;
}

interface QrInternalSection {
  readonly frequencyStartIndex: number;
  readonly frequencyEndIndex: number;
  readonly durationIndex: number;
  readonly frequencyMode: 1 | 2 | 3 | 4;
  readonly enabled: boolean;
  readonly points: readonly QrInternalPoint[];
}

function invalidQrInternal(
  diagnostics: Diagnostic[],
  message: string,
  path = '$',
  parameters?: Readonly<Record<string, string | number | boolean>>
): null {
  diagnostics.push(
    makeDiagnostic(
      DIAGNOSTIC_CODES.QR_INTERNAL_FORMAT,
      'error',
      'qr',
      message,
      location(path),
      parameters === undefined ? {} : { parameters }
    )
  );
  return null;
}

function parseQrInternalInteger(
  raw: string | undefined,
  index: number,
  min: number,
  max: number,
  diagnostics: Diagnostic[]
): number | null {
  if (raw === undefined || !QR_INTERNAL_INTEGER.test(raw)) {
    return invalidQrInternal(
      diagnostics,
      'DGLAB QR internal field ' + String(index) + ' must be a non-negative decimal integer.',
      'internal[' + String(index) + ']'
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return invalidQrInternal(
      diagnostics,
      'DGLAB QR internal field ' + String(index) + ' is outside the supported range.',
      'internal[' + String(index) + ']',
      { min, max, actual: value }
    );
  }
  return value;
}

function pulseTextFromQrInternal(
  text: string,
  diagnostics: Diagnostic[]
): string | null {
  const chunks = text.split('+');
  if (chunks.length !== DGLAB_QR_MAX_SECTIONS + 1) {
    return invalidQrInternal(
      diagnostics,
      'DGLAB QR internal data must contain one 20-field header and exactly three section payloads.',
      '$',
      { expectedSections: DGLAB_QR_MAX_SECTIONS, actualChunks: Math.max(0, chunks.length - 1) }
    );
  }
  const rawFields = chunks[0]?.split(',') ?? [];
  if (rawFields.length !== QR_GLOBAL_FIELD_COUNT) {
    return invalidQrInternal(
      diagnostics,
      'DGLAB QR internal header must contain exactly 20 fields.',
      'internal',
      { expected: QR_GLOBAL_FIELD_COUNT, actual: rawFields.length }
    );
  }
  const fields: number[] = [];
  const ranges: readonly [number, number][] = [
    [0, 83], [0, 83], [0, 83], [0, 83], [0, 83], [0, 83],
    [2, 100_000], [2, 100_000], [2, 100_000],
    [0, 99], [0, 99], [0, 99],
    [1, 4], [1, 4], [1, 4],
    [0, 1], [0, 1], [0, 100], [0, 100], [1, 4]
  ];
  for (let index = 0; index < rawFields.length; index += 1) {
    const range = ranges[index] ?? [0, 0];
    const value = parseQrInternalInteger(rawFields[index], index, range[0], range[1], diagnostics);
    if (value === null) return null;
    fields.push(value);
  }

  const sections: QrInternalSection[] = [];
  for (let sectionIndex = 0; sectionIndex < DGLAB_QR_MAX_SECTIONS; sectionIndex += 1) {
    const rawPoints = (chunks[sectionIndex + 1] ?? '').split(',');
    const expectedPointCount = fields[sectionIndex + 6] ?? 0;
    if (rawPoints.length !== expectedPointCount) {
      return invalidQrInternal(
        diagnostics,
        'DGLAB QR section point count does not match its header.',
        'sections[' + String(sectionIndex) + '].points',
        { expected: expectedPointCount, actual: rawPoints.length }
      );
    }
    const points: QrInternalPoint[] = [];
    for (let pointIndex = 0; pointIndex < rawPoints.length; pointIndex += 1) {
      const rawPoint = rawPoints[pointIndex] ?? '';
      const match = QR_INTERNAL_POINT.exec(rawPoint);
      if (match === null) {
        return invalidQrInternal(
          diagnostics,
          'DGLAB QR section points must use the anchor-strength format with strength between 0 and 20.',
          'sections[' + String(sectionIndex) + '].points[' + String(pointIndex) + ']'
        );
      }
      const strength = Number(match[2]);
      if (!Number.isFinite(strength) || strength < 0 || strength > 20) {
        return invalidQrInternal(
          diagnostics,
          'DGLAB QR section point strength must be between 0 and 20.',
          'sections[' + String(sectionIndex) + '].points[' + String(pointIndex) + ']',
          { min: 0, max: 20, actual: strength }
        );
      }
      points.push(Object.freeze({
        anchor: Number(match[1]) as 0 | 1,
        strength
      }));
    }
    sections.push(Object.freeze({
      frequencyStartIndex: fields[sectionIndex] ?? 0,
      frequencyEndIndex: fields[sectionIndex + 3] ?? 0,
      durationIndex: fields[sectionIndex + 9] ?? 0,
      frequencyMode: (fields[sectionIndex + 12] ?? 1) as 1 | 2 | 3 | 4,
      enabled: sectionIndex === 0 || (fields[14 + sectionIndex] ?? 0) === 1,
      points: Object.freeze(points)
    }));
  }

  const pulseText = PULSE_PREFIX + [fields[17], fields[19], fields[18]].join(',') + '=' + sections.map((section) => {
    const header = [
      section.frequencyStartIndex,
      section.frequencyEndIndex,
      section.durationIndex,
      section.frequencyMode,
      section.enabled ? 1 : 0
    ].join(',');
    const points = section.points.map((point) =>
      normalizeDecimal(String(Number((point.strength * 5).toFixed(2)))) + '-' + String(point.anchor)
    ).join(',');
    return header + '/' + points;
  }).join('+section+');
  const parsed = parsePulse(pulseText);
  if (parsed.pulse === null) {
    return invalidQrInternal(diagnostics, 'DGLAB QR internal data could not be converted to a valid pulse document.');
  }
  return pulseText;
}

interface QrPulseSection {
  readonly frequencyStartIndex: number;
  readonly frequencyEndIndex: number;
  readonly durationIndex: number;
  readonly frequencyMode: 1 | 2 | 3 | 4;
  readonly enabled: boolean;
  readonly points: readonly { readonly anchor: 0 | 1; readonly strength: number }[];
}

const DEFAULT_QR_SECTION: QrPulseSection = Object.freeze({
  frequencyStartIndex: 0,
  frequencyEndIndex: 20,
  durationIndex: 20,
  frequencyMode: 1,
  enabled: false,
  points: Object.freeze([
    Object.freeze({ anchor: 1 as const, strength: 0 }),
    Object.freeze({ anchor: 1 as const, strength: 100 })
  ])
});

function qrPulseSections(
  pulse: Pulse,
  diagnostics: Diagnostic[]
): readonly QrPulseSection[] | null {
  if (pulse.sections.length > DGLAB_QR_MAX_SECTIONS) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_SECTION_LIMIT,
        'error',
        'qr',
        'DGLAB QR export supports at most three sections; the source contains more.',
        location('sections'),
        { parameters: { max: DGLAB_QR_MAX_SECTIONS, actual: pulse.sections.length } }
      )
    );
    return null;
  }
  const first = pulse.sections[0];
  if (first === undefined || !first.enabled) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_FIRST_SECTION_DISABLED,
        'error',
        'qr',
        'DGLAB QR export requires the first section to be enabled.',
        location('sections[0].enabled', undefined, { sectionIndex: 0 })
      )
    );
    return null;
  }
  const sections: QrPulseSection[] = [];
  for (let sectionIndex = 0; sectionIndex < DGLAB_QR_MAX_SECTIONS; sectionIndex += 1) {
    const source = pulse.sections[sectionIndex];
    if (source === undefined) {
      sections.push(DEFAULT_QR_SECTION);
      continue;
    }
    const points = source.pulseElement.points.map((point, pointIndex) => {
      const qrStrength = point.strength / 5;
      const rounded = Number(qrStrength.toFixed(2));
      if (Math.abs(rounded - qrStrength) > 1e-9) {
        diagnostics.push(
          makeDiagnostic(
            DIAGNOSTIC_CODES.QR_INTENSITY,
            'error',
            'qr',
            'Pulse strength cannot be represented exactly by the DGLAB QR 0.01 scale after conversion to 0..20.',
            location(
              'sections[' + String(sectionIndex) + '].points[' + String(pointIndex) + '].strength',
              undefined,
              { sectionIndex, pointIndex }
            ),
            {
              parameters: { strength: point.strength, qrStrength, rounded }
            }
          )
        );
        return null;
      }
      return Object.freeze({ anchor: point.anchor, strength: point.strength });
    });
    if (points.some((point) => point === null)) return null;
    sections.push(Object.freeze({
      frequencyStartIndex: source.frequencyStartIndex,
      frequencyEndIndex: source.frequencyEndIndex,
      durationIndex: source.durationIndex,
      frequencyMode: source.frequencyMode,
      enabled: source.enabled,
      points: Object.freeze(points as readonly { readonly anchor: 0 | 1; readonly strength: number }[])
    }));
  }
  return Object.freeze(sections);
}

function qrInternalTextFromPulse(pulse: Pulse, diagnostics: Diagnostic[]): string | null {
  const sections = qrPulseSections(pulse, diagnostics);
  if (sections === null) return null;
  const fields = [
    sections[0]!.frequencyStartIndex,
    sections[1]!.frequencyStartIndex,
    sections[2]!.frequencyStartIndex,
    sections[0]!.frequencyEndIndex,
    sections[1]!.frequencyEndIndex,
    sections[2]!.frequencyEndIndex,
    sections[0]!.points.length,
    sections[1]!.points.length,
    sections[2]!.points.length,
    sections[0]!.durationIndex,
    sections[1]!.durationIndex,
    sections[2]!.durationIndex,
    sections[0]!.frequencyMode,
    sections[1]!.frequencyMode,
    sections[2]!.frequencyMode,
    sections[1]!.enabled ? 1 : 0,
    sections[2]!.enabled ? 1 : 0,
    pulse.globals.sectionRestIndex,
    pulse.globals.frequencyBalanceIndex,
    pulse.globals.playbackSpeed
  ].join(',');
  const sectionTexts = sections.map((section) => section.points.map((point) =>
    String(point.anchor) + '-' + (point.strength / 5).toFixed(2)
  ).join(','));
  return fields + '+' + sectionTexts.join('+');
}

function payloadFromEnvelope(input: string): { readonly payload: string | null; readonly urlFragment: boolean } {
  const normalized = input.trim();
  try {
    const parsed = new URL(normalized);
    const fragment = parsed.hash;
    if (fragment.startsWith(QR_PREFIX)) {
      return { payload: fragment.slice(QR_PREFIX.length), urlFragment: true };
    }
    if (parsed.hash.length > 0) return { payload: null, urlFragment: true };
  } catch {
    // The caller receives a stable diagnostic below.
  }
  return { payload: null, urlFragment: false };
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizedLimits(options: QrLimits): Required<QrLimits> | null {
  if (options === null || typeof options !== 'object') return null;
  const limits = { ...DEFAULT_QR_LIMITS, ...options };
  return validLimit(limits.maxHexCharacters) &&
    validLimit(limits.maxCompressedBytes) &&
    validLimit(limits.maxDecompressedBytes) &&
    validLimit(limits.maxDecodedBytes)
    ? limits
    : null;
}

function gzipOutputLikelyExceedsLimit(compressed: Uint8Array, limit: number): boolean {
  // The gzip trailer stores the uncompressed size modulo 2^32. Only use it to
  // classify a truncated stream as a limit error when it proves the declared
  // output is larger than the configured budget.
  if (compressed.byteLength < 4) return false;
  const offset = compressed.byteLength - 4;
  const declared = (compressed[offset] ?? 0) |
    ((compressed[offset + 1] ?? 0) << 8) |
    ((compressed[offset + 2] ?? 0) << 16) |
    ((compressed[offset + 3] ?? 0) << 24);
  return (declared >>> 0) > limit;
}

export function decodeQr(
  input: unknown,
  options: QrLimits = {}
): QrDecodeResult {
  const limits = normalizedLimits(options);
  const diagnostics: Diagnostic[] = [];
  if (limits === null) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_HEX_LIMIT,
        'error',
        'resource',
        'QR limits must be positive safe integers.',
        location('$')
      )
    );
    return Object.freeze({ accepted: false, pulseText: null, diagnostics });
  }
  if (typeof input !== 'string') {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_PREFIX,
        'error',
        'qr',
        'QR content must be text.',
        location('$')
      )
    );
    return Object.freeze({ accepted: false, pulseText: null, diagnostics });
  }
  const envelope = payloadFromEnvelope(input);
  const payload = envelope.payload;
  if (payload === null) {
    diagnostics.push(
      makeDiagnostic(
        envelope.urlFragment ? DIAGNOSTIC_CODES.QR_URL_FRAGMENT : DIAGNOSTIC_CODES.QR_PREFIX,
        'error',
        'qr',
        envelope.urlFragment
          ? 'URL fragments must contain the exact #DGLAB-PULSE# envelope prefix.'
          : 'QR content must contain the exact #DGLAB-PULSE# envelope prefix.',
        location('$')
      )
    );
    return Object.freeze({ accepted: false, pulseText: null, diagnostics });
  }
  if (
    payload.length === 0 ||
    payload.length > limits.maxHexCharacters ||
    payload.length % 2 !== 0
  ) {
    diagnostics.push(
      makeDiagnostic(
        payload.length > limits.maxHexCharacters
          ? DIAGNOSTIC_CODES.QR_HEX_LIMIT
          : DIAGNOSTIC_CODES.QR_HEX,
        'error',
        payload.length > limits.maxHexCharacters ? 'resource' : 'qr',
        'QR payload must be an even-length hexadecimal string within the configured limit.',
        location('$'),
        { parameters: { maxHexCharacters: limits.maxHexCharacters } }
      )
    );
    return Object.freeze({ accepted: false, pulseText: null, diagnostics });
  }
  if (!/^[0-9a-fA-F]+$/.test(payload)) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_HEX,
        'error',
        'qr',
        'QR payload contains a non-hexadecimal character.',
        location('$')
      )
    );
    return Object.freeze({ accepted: false, pulseText: null, diagnostics });
  }
  const compressed = Buffer.from(payload, 'hex');
  if (compressed.byteLength > limits.maxCompressedBytes) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_HEX_LIMIT,
        'error',
        'resource',
        'Compressed QR payload exceeds the configured byte limit.',
        location('$'),
        { parameters: { maxCompressedBytes: limits.maxCompressedBytes } }
      )
    );
    return Object.freeze({ accepted: false, pulseText: null, diagnostics });
  }
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_GZIP,
        'error',
        'qr',
        'QR payload is not a gzip stream.',
        location('$')
      )
    );
    return Object.freeze({ accepted: false, pulseText: null, diagnostics });
  }
  let decompressed: Buffer;
  try {
    const result = gunzipSync(compressed, {
      info: true,
      maxOutputLength: limits.maxDecompressedBytes
    }) as unknown as {
      readonly buffer: Buffer;
      readonly engine: { readonly bytesWritten: number };
    };
    if (result.engine.bytesWritten !== compressed.byteLength) {
      throw new Error('QR gzip stream contains trailing bytes.');
    }
    decompressed = result.buffer;
  } catch (error) {
    const errorCode = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { readonly code?: unknown }).code)
      : '';
    const exceeded = errorCode === 'ERR_BUFFER_TOO_LARGE' ||
      (errorCode === 'ERR_ZLIB_BUF_ERROR' && gzipOutputLikelyExceedsLimit(compressed, limits.maxDecompressedBytes));
    diagnostics.push(
      makeDiagnostic(
        exceeded ? DIAGNOSTIC_CODES.QR_GZIP_LIMIT : DIAGNOSTIC_CODES.QR_GZIP,
        'error',
        exceeded ? 'resource' : 'qr',
        exceeded
          ? 'QR gzip data exceeds the decompressed size limit.'
          : 'QR payload is not a valid gzip stream.',
        location('$'),
        exceeded
          ? { parameters: { maxDecompressedBytes: limits.maxDecompressedBytes } }
          : {}
      )
    );
    return Object.freeze({ accepted: false, pulseText: null, diagnostics });
  }
  if (decompressed.byteLength > limits.maxDecompressedBytes) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_GZIP_LIMIT,
        'error',
        'resource',
        'QR decompressed data exceeds the configured byte limit.',
        location('$')
      )
    );
    return Object.freeze({ accepted: false, pulseText: null, diagnostics });
  }
  let base64: string;
  try {
    base64 = new TextDecoder('utf-8', { fatal: true }).decode(decompressed);
  } catch {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_BASE64,
        'error',
        'qr',
        'The gzip payload is not valid UTF-8 Base64 text.',
        location('$')
      )
    );
    return Object.freeze({ accepted: false, pulseText: null, diagnostics });
  }
  const strictBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (base64.length === 0 || !strictBase64.test(base64)) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_BASE64,
        'error',
        'qr',
        'QR payload contains invalid Base64.',
        location('$')
      )
    );
    return Object.freeze({ accepted: false, pulseText: null, diagnostics });
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const decodedByteLength = Math.floor(base64.length * 3 / 4) - padding;
  if (decodedByteLength > limits.maxDecodedBytes) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.RECOGNIZE_SIZE_LIMIT,
        'error',
        'resource',
        'Decoded DGLAB QR internal text exceeds the configured byte limit.',
        location('$'),
        { parameters: { maxDecodedBytes: limits.maxDecodedBytes, actualBytes: decodedByteLength } }
      )
    );
    return Object.freeze({ accepted: false, pulseText: null, diagnostics });
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(base64, 'base64');
    // Buffer's decoder is intentionally forgiving; the canonical re-encode
    // check rejects ignored characters and non-zero trailing bits.
    if (decoded.toString('base64') !== base64) throw new Error('non-canonical base64');
  } catch {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_BASE64,
        'error',
        'qr',
        'QR payload contains non-canonical Base64 padding or trailing bits.',
        location('$')
      )
    );
    return Object.freeze({ accepted: false, pulseText: null, diagnostics });
  }
  let internalText: string;
  try {
    internalText = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_TEXT,
        'error',
        'qr',
        'Base64 payload is not valid UTF-8 DGLAB QR internal text.',
        location('$')
      )
    );
    return Object.freeze({ accepted: false, pulseText: null, diagnostics });
  }
  const text = pulseTextFromQrInternal(internalText, diagnostics);
  if (text === null) {
    return Object.freeze({ accepted: false, pulseText: null, diagnostics });
  }
  return Object.freeze({
    accepted: true,
    pulseText: text,
    diagnostics: Object.freeze(diagnostics)
  });
}

export function encodeQr(
  pulseOrText: Pulse | string,
  options: QrLimits = {}
): { readonly content: string | null; readonly diagnostics: readonly Diagnostic[] } {
  const limits = normalizedLimits(options);
  const diagnostics: Diagnostic[] = [];
  if (limits === null) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_HEX_LIMIT,
        'error',
        'resource',
        'QR limits must be positive safe integers.',
        location('$')
      )
    );
    return Object.freeze({ content: null, diagnostics });
  }
  let text: string;
  let sourcePulse: Pulse;
  if (typeof pulseOrText === 'string') {
    let sourceBytes: Uint8Array;
    try {
      sourceBytes = encodeUtf8(pulseOrText);
    } catch {
      diagnostics.push(makeDiagnostic(
        DIAGNOSTIC_CODES.QR_TEXT,
        'error',
        'qr',
        'Pulse text could not be read as UTF-8.',
        location('$')
      ));
      return Object.freeze({ content: null, diagnostics: sortDiagnostics(diagnostics) });
    }
    if (sourceBytes.byteLength > limits.maxDecodedBytes) {
      diagnostics.push(makeDiagnostic(
        DIAGNOSTIC_CODES.RECOGNIZE_SIZE_LIMIT,
        'error',
        'resource',
        'Pulse text exceeds the configured decoded byte limit.',
        location('$'),
        { parameters: { maxDecodedBytes: limits.maxDecodedBytes, actualBytes: sourceBytes.byteLength } }
      ));
      return Object.freeze({ content: null, diagnostics: sortDiagnostics(diagnostics) });
    }
    const parsed = parsePulse(pulseOrText, { maxBytes: limits.maxDecodedBytes });
    diagnostics.push(...parsed.diagnostics);
    if (parsed.pulse === null) {
      return Object.freeze({ content: null, diagnostics: sortDiagnostics(diagnostics) });
    }
    sourcePulse = parsed.pulse;
    const serialized = serializePulse(sourcePulse, { mode: 'canonical' });
    diagnostics.push(...serialized.diagnostics);
    if (serialized.diagnostics.some((item) => item.severity === 'error')) {
      return Object.freeze({ content: null, diagnostics: sortDiagnostics(diagnostics) });
    }
    text = serialized.text;
  } else if (pulseOrText !== null && typeof pulseOrText === 'object') {
    sourcePulse = pulseOrText;
    const validation = validatePulse(sourcePulse, {
      ...DEFAULT_RULE_SET,
      maxBytes: limits.maxDecodedBytes
    });
    diagnostics.push(...validation.diagnostics);
    if (!validation.valid) {
      return Object.freeze({ content: null, diagnostics: sortDiagnostics(diagnostics) });
    }
    try {
      const serialized = serializePulse(sourcePulse, { mode: 'canonical' });
      diagnostics.push(...serialized.diagnostics);
      if (serialized.diagnostics.some((item) => item.severity === 'error')) {
        return Object.freeze({ content: null, diagnostics: sortDiagnostics(diagnostics) });
      }
      text = serialized.text;
    } catch {
      diagnostics.push(
        makeDiagnostic(
          DIAGNOSTIC_CODES.QR_TEXT,
          'error',
          'qr',
          'Only a valid Pulse model can be encoded in a QR envelope.',
          location('$')
        )
      );
      return Object.freeze({ content: null, diagnostics: sortDiagnostics(diagnostics) });
    }
  } else {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_TEXT,
        'error',
        'qr',
        'QR input must be pulse text or a Pulse model.',
        location('$')
      )
    );
    return Object.freeze({ content: null, diagnostics: sortDiagnostics(diagnostics) });
  }
  if (!text.startsWith(PULSE_PREFIX)) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_TEXT,
        'error',
        'qr',
        'Only supported pulse text can be encoded in a QR envelope.',
        location('$')
      )
    );
    return Object.freeze({ content: null, diagnostics });
  }
  const internalText = qrInternalTextFromPulse(sourcePulse, diagnostics);
  if (internalText === null) {
    return Object.freeze({ content: null, diagnostics: sortDiagnostics(diagnostics) });
  }
  const internalTextBytes = encodeUtf8(internalText);
  if (internalTextBytes.byteLength > limits.maxDecodedBytes) {
    diagnostics.push(makeDiagnostic(
      DIAGNOSTIC_CODES.RECOGNIZE_SIZE_LIMIT,
      'error',
      'resource',
      'Encoded DGLAB QR internal text exceeds the configured decoded byte limit.',
      location('$'),
      { parameters: { maxDecodedBytes: limits.maxDecodedBytes, actualBytes: internalTextBytes.byteLength } }
    ));
    return Object.freeze({ content: null, diagnostics: sortDiagnostics(diagnostics) });
  }
  const encodedText = Buffer.from(internalTextBytes).toString('base64');
  // Node emits a deterministic zero mtime for gzip streams in the supported
  // runtime; keep options empty so the public Node types remain portable.
  let compressed: Buffer;
  try {
    compressed = gzipSync(Buffer.from(encodedText, 'utf8'));
  } catch {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_GZIP,
        'error',
        'qr',
        'DGLAB QR internal text could not be compressed for a QR envelope.',
        location('$')
      )
    );
    return Object.freeze({ content: null, diagnostics: sortDiagnostics(diagnostics) });
  }
  const hex = compressed.toString('hex').toUpperCase();
  if (compressed.byteLength > limits.maxCompressedBytes || hex.length > limits.maxHexCharacters) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_HEX_LIMIT,
        'error',
        'resource',
        'Encoded QR payload exceeds the configured limit.',
        location('$')
      )
    );
    return Object.freeze({ content: null, diagnostics });
  }
  const content = QR_SHARE_URL + QR_PREFIX + hex;
  const decoded = decodeQr(content, limits);
  if (!decoded.accepted || decoded.pulseText === null) {
    diagnostics.push(...decoded.diagnostics);
    return Object.freeze({ content: null, diagnostics: sortDiagnostics(diagnostics) });
  }
  const roundTrip = parsePulse(decoded.pulseText, { maxBytes: limits.maxDecodedBytes });
  const roundTripInternalText = roundTrip.pulse === null
    ? null
    : qrInternalTextFromPulse(roundTrip.pulse, []);
  if (roundTrip.pulse === null || roundTripInternalText !== internalText) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.EXPORT_ROUNDTRIP_MISMATCH,
        'error',
        'export',
        'Encoded QR content did not round-trip to equivalent pulse semantics.',
        location('$')
      )
    );
    return Object.freeze({ content: null, diagnostics: sortDiagnostics(diagnostics) });
  }
  return Object.freeze({
    content,
    diagnostics: Object.freeze(sortDiagnostics(diagnostics))
  });
}
