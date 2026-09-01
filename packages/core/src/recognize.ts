import { DIAGNOSTIC_CODES, location, makeDiagnostic, sortDiagnostics } from './diagnostics.js';
import {
  FORMAT_PROFILE,
  PULSE_PREFIX,
  QR_PREFIX,
  QR_SHARE_URL,
  RULE_VERSION,
  type FormatKind,
  type RecognitionResult,
  type SourceDocument
} from './types.js';
import type { EvidenceLevel } from './types.js';
import { cloneBytes, decodeUtf8, encodeUtf8, stableDigest, trailingNewline } from './numbers.js';

export interface RecognitionOptions {
  readonly maxBytes?: number;
  readonly allowBom?: boolean;
}

function sourceFromInput(
  input: string | Uint8Array,
  maxBytes: number
): {
  readonly source: SourceDocument | null;
  readonly diagnostics: readonly ReturnType<typeof makeDiagnostic>[];
} {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) {
    return {
      source: null,
      diagnostics: [
        makeDiagnostic(
          DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT,
          'error',
          'recognize',
          'Input must be a UTF-8 string or byte array.',
          location('$')
        )
      ]
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = typeof input === 'string' ? encodeUtf8(input) : cloneBytes(input);
  } catch {
    return {
      source: null,
      diagnostics: [
        makeDiagnostic(
          DIAGNOSTIC_CODES.RECOGNIZE_INVALID_ENCODING,
          'error',
          'recognize',
          'Input bytes could not be read.',
          location('$')
        )
      ]
    };
  }
  if (bytes.byteLength > maxBytes) {
    return {
      source: null,
      diagnostics: [
        makeDiagnostic(
          DIAGNOSTIC_CODES.RECOGNIZE_SIZE_LIMIT,
          'error',
          'resource',
          'Input exceeds the configured byte limit.',
          location('$'),
          { parameters: { maxBytes, actualBytes: bytes.byteLength } }
        )
      ]
    };
  }
  const decoded = decodeUtf8(bytes);
  if (decoded.invalid || decoded.text === null) {
    return {
      source: null,
      diagnostics: [
        makeDiagnostic(
          DIAGNOSTIC_CODES.RECOGNIZE_INVALID_ENCODING,
          'error',
          'recognize',
          'Input is not valid UTF-8.',
          location('$')
        )
      ]
    };
  }
  const hadBom = decoded.text.charCodeAt(0) === 0xfeff;
  const text = hadBom ? decoded.text.slice(1) : decoded.text;
  const newline = trailingNewline(text);
  const source: SourceDocument = Object.freeze({
    text,
    bytes,
    byteLength: bytes.byteLength,
    digest: stableDigest(bytes),
    hadBom,
    trailingNewline: newline
  });
  return { source, diagnostics: [] };
}

/**
 * Recognition is intentionally content based. File extensions and names are
 * not consulted, so a renamed or uploaded file receives the same result.
 */
export function recognizeInput(
  input: string | Uint8Array,
  options: RecognitionOptions = {}
): RecognitionResult {
  const safeOptions = options !== null && typeof options === 'object' ? options : {};
  const requestedMaxBytes = safeOptions.maxBytes ?? 2_000_000;
  if (!Number.isSafeInteger(requestedMaxBytes) || requestedMaxBytes < 0) {
    return Object.freeze({
      format: 'unsupported',
      profile: 'unknown',
      ruleVersion: RULE_VERSION,
      evidence: ['unverified'] as readonly EvidenceLevel[],
      source: null,
      diagnostics: [
        makeDiagnostic(
          DIAGNOSTIC_CODES.RECOGNIZE_SIZE_LIMIT,
          'error',
          'resource',
          'Input byte limit must be a non-negative safe integer.',
          location('$')
        )
      ]
    });
  }
  if (safeOptions.allowBom !== undefined && typeof safeOptions.allowBom !== 'boolean') {
    return Object.freeze({
      format: 'unsupported',
      profile: 'unknown',
      ruleVersion: RULE_VERSION,
      evidence: ['unverified'] as readonly EvidenceLevel[],
      source: null,
      diagnostics: [
        makeDiagnostic(
          DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT,
          'error',
          'recognize',
          'allowBom must be a boolean when provided.',
          location('allowBom')
        )
      ]
    });
  }
  const maxBytes = requestedMaxBytes;
  const initial = sourceFromInput(input, maxBytes);
  if (initial.source === null) {
    return Object.freeze({
      format: 'unsupported',
      profile: 'unknown',
      ruleVersion: RULE_VERSION,
      evidence: ['unverified'] as readonly EvidenceLevel[],
      source: null,
      diagnostics: sortDiagnostics(initial.diagnostics)
    });
  }
  const source = initial.source;
  const diagnostics = [...initial.diagnostics];
  if (source.byteLength === 0) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.RECOGNIZE_EMPTY_INPUT,
        'error',
        'recognize',
        'Input is empty.',
        location('$')
      )
    );
  }
  if (source.hadBom) {
    const severity = safeOptions.allowBom === false ? 'error' : 'warning';
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.RECOGNIZE_BOM,
        severity,
        'recognize',
        'UTF-8 BOM is not part of the canonical pulse prefix.',
        location('$'),
        { suggestion: 'Export a canonical file without a BOM.' }
      )
    );
  }

  let format: FormatKind = 'unsupported';
  let profile: typeof FORMAT_PROFILE | 'unknown' = 'unknown';
  let evidence: readonly EvidenceLevel[] = ['unverified'];
  if (source.text.startsWith(PULSE_PREFIX)) {
    format = 'pulse-text';
    profile = FORMAT_PROFILE;
    evidence = ['official-semantics', 'corpus-observed', 'community-inferred'];
  } else if (source.text.startsWith(QR_SHARE_URL + QR_PREFIX)) {
    format = 'qr-envelope';
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.RECOGNIZE_UNKNOWN_PREFIX,
        'info',
        'recognize',
        'QR envelope detected; decode it before parsing pulse text.',
        location('$')
      )
    );
    evidence = ['community-inferred'];
  } else if (source.text.length > 0) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT,
        'error',
        'recognize',
        'Input is not a supported pulse text or QR envelope.',
        location('$'),
        { suggestion: 'Choose a Dungeonlab+pulse text file or a supported QR payload.' }
      )
    );
  }
  return Object.freeze({
    format,
    profile,
    ruleVersion: RULE_VERSION,
    evidence,
    source,
    diagnostics: sortDiagnostics(diagnostics)
  });
}
