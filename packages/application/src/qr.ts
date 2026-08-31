import { gzipSync, gunzipSync } from 'node:zlib';
import {
  DIAGNOSTIC_CODES,
  DEFAULT_RULE_SET,
  QR_PREFIX,
  PULSE_PREFIX,
  encodeUtf8,
  makeDiagnostic,
  location,
  parsePulse,
  serializePulse,
  semanticallyEqual,
  sortDiagnostics,
  validatePulse,
  type Diagnostic,
  type Pulse
} from '@dglab-pulse-hub/core';

export interface QrLimits {
  readonly maxHexCharacters?: number;
  readonly maxCompressedBytes?: number;
  readonly maxDecompressedBytes?: number;
  /** Maximum UTF-8 bytes after Base64 decoding (the pulse text itself). */
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

function payloadFromEnvelope(input: string): { readonly payload: string | null; readonly urlFragment: boolean } {
  const normalized = input.trim();
  if (normalized.startsWith(QR_PREFIX)) {
    return { payload: normalized.slice(QR_PREFIX.length), urlFragment: false };
  }
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
        'Decoded QR pulse text exceeds the configured byte limit.',
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
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_TEXT,
        'error',
        'qr',
        'Base64 payload is not valid UTF-8 pulse text.',
        location('$')
      )
    );
    return Object.freeze({ accepted: false, pulseText: null, diagnostics });
  }
  if (!text.startsWith(PULSE_PREFIX)) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.QR_TEXT,
        'error',
        'qr',
        'Decoded QR content is not Dungeonlab pulse text.',
        location('$')
      )
    );
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
  const textBytes = encodeUtf8(text);
  if (textBytes.byteLength > limits.maxDecodedBytes) {
    diagnostics.push(makeDiagnostic(
      DIAGNOSTIC_CODES.RECOGNIZE_SIZE_LIMIT,
      'error',
      'resource',
      'Encoded pulse text exceeds the configured decoded byte limit.',
      location('$'),
      { parameters: { maxDecodedBytes: limits.maxDecodedBytes, actualBytes: textBytes.byteLength } }
    ));
    return Object.freeze({ content: null, diagnostics: sortDiagnostics(diagnostics) });
  }
  const encodedText = Buffer.from(textBytes).toString('base64');
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
        'Pulse text could not be compressed for a QR envelope.',
        location('$')
      )
    );
    return Object.freeze({ content: null, diagnostics: sortDiagnostics(diagnostics) });
  }
  const hex = compressed.toString('hex');
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
  const content = QR_PREFIX + hex;
  const decoded = decodeQr(content, limits);
  if (!decoded.accepted || decoded.pulseText === null) {
    diagnostics.push(...decoded.diagnostics);
    return Object.freeze({ content: null, diagnostics: sortDiagnostics(diagnostics) });
  }
  const roundTrip = parsePulse(decoded.pulseText, { maxBytes: limits.maxDecodedBytes });
  if (roundTrip.pulse === null || !semanticallyEqual(sourcePulse, roundTrip.pulse)) {
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
