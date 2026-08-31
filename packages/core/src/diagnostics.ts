import type {
  Diagnostic,
  DiagnosticLocation,
  DiagnosticSeverity,
  DiagnosticStage,
  SourceSpan
} from './types.js';

/**
 * Diagnostic codes are the public branching contract. Messages are deliberately
 * plain English and may be replaced by a client-localized presentation.
 */
export const DIAGNOSTIC_CODES = Object.freeze({
  RECOGNIZE_EMPTY_INPUT: 'PULSE_RECOGNIZE_EMPTY_INPUT',
  RECOGNIZE_INVALID_ENCODING: 'PULSE_RECOGNIZE_INVALID_ENCODING',
  RECOGNIZE_BOM: 'PULSE_RECOGNIZE_BOM',
  RECOGNIZE_UNSUPPORTED_INPUT: 'PULSE_RECOGNIZE_UNSUPPORTED_INPUT',
  RECOGNIZE_UNKNOWN_PREFIX: 'PULSE_RECOGNIZE_UNKNOWN_PREFIX',
  RECOGNIZE_SIZE_LIMIT: 'PULSE_RECOGNIZE_SIZE_LIMIT',

  SYNTAX_MISSING_EQUALS: 'PULSE_SYNTAX_MISSING_EQUALS',
  SYNTAX_DUPLICATE_EQUALS: 'PULSE_SYNTAX_DUPLICATE_EQUALS',
  SYNTAX_EMPTY_GLOBAL_FIELD: 'PULSE_SYNTAX_EMPTY_GLOBAL_FIELD',
  SYNTAX_GLOBAL_FIELD_COUNT: 'PULSE_SYNTAX_GLOBAL_FIELD_COUNT',
  SYNTAX_INVALID_NUMBER: 'PULSE_SYNTAX_INVALID_NUMBER',
  SYNTAX_NON_FINITE_NUMBER: 'PULSE_SYNTAX_NON_FINITE_NUMBER',
  SYNTAX_INVALID_SECTION_SEPARATOR: 'PULSE_SYNTAX_INVALID_SECTION_SEPARATOR',
  SYNTAX_EMPTY_SECTION: 'PULSE_SYNTAX_EMPTY_SECTION',
  SYNTAX_SECTION_HEADER_COUNT: 'PULSE_SYNTAX_SECTION_HEADER_COUNT',
  SYNTAX_MISSING_SLASH: 'PULSE_SYNTAX_MISSING_SLASH',
  SYNTAX_DUPLICATE_SLASH: 'PULSE_SYNTAX_DUPLICATE_SLASH',
  SYNTAX_EMPTY_POINT: 'PULSE_SYNTAX_EMPTY_POINT',
  SYNTAX_POINT_FIELD_COUNT: 'PULSE_SYNTAX_POINT_FIELD_COUNT',
  SYNTAX_MISSING_POINT_SEPARATOR: 'PULSE_SYNTAX_MISSING_POINT_SEPARATOR',
  SYNTAX_TRAILING_CONTENT: 'PULSE_SYNTAX_TRAILING_CONTENT',
  SYNTAX_UNEXPECTED_CHARACTER: 'PULSE_SYNTAX_UNEXPECTED_CHARACTER',

  RANGE_SECTION_COUNT: 'PULSE_RANGE_SECTION_COUNT',
  RANGE_GLOBAL_REST: 'PULSE_RANGE_GLOBAL_REST',
  RANGE_GLOBAL_SPEED: 'PULSE_RANGE_GLOBAL_SPEED',
  RANGE_GLOBAL_BALANCE: 'PULSE_RANGE_GLOBAL_BALANCE',
  RANGE_FREQUENCY_INDEX: 'PULSE_RANGE_FREQUENCY_INDEX',
  RANGE_DURATION_INDEX: 'PULSE_RANGE_DURATION_INDEX',
  RANGE_FREQUENCY_MODE: 'PULSE_RANGE_FREQUENCY_MODE',
  RANGE_ENABLED_FLAG: 'PULSE_RANGE_ENABLED_FLAG',
  RANGE_INTENSITY: 'PULSE_RANGE_INTENSITY',
  RANGE_ANCHOR_FLAG: 'PULSE_RANGE_ANCHOR_FLAG',
  RANGE_INTEGER_REQUIRED: 'PULSE_RANGE_INTEGER_REQUIRED',

  SEMANTIC_TOO_FEW_POINTS: 'PULSE_SEMANTIC_TOO_FEW_POINTS',
  SEMANTIC_INVALID_FREQUENCY_RANGE: 'PULSE_SEMANTIC_INVALID_FREQUENCY_RANGE',
  SEMANTIC_NO_ENABLED_SECTION: 'PULSE_SEMANTIC_NO_ENABLED_SECTION',
  SEMANTIC_EXPANSION_LIMIT: 'PULSE_SEMANTIC_EXPANSION_LIMIT',
  SEMANTIC_UNVERIFIED_SECTION_COUNT: 'PULSE_SEMANTIC_UNVERIFIED_SECTION_COUNT',
  SEMANTIC_INTERPOLATION_UNVERIFIED: 'PULSE_SEMANTIC_INTERPOLATION_UNVERIFIED',
  SEMANTIC_INVALID_MODEL: 'PULSE_SEMANTIC_INVALID_MODEL',
  SEMANTIC_DURATION_MISMATCH: 'PULSE_SEMANTIC_DURATION_MISMATCH',
  SEMANTIC_INVALID_SOURCE: 'PULSE_SEMANTIC_INVALID_SOURCE',
  SEMANTIC_INTERPOLATION_ROUNDED: 'PULSE_SEMANTIC_INTERPOLATION_ROUNDED',
  SEMANTIC_INTERPOLATION_CLIPPED: 'PULSE_SEMANTIC_INTERPOLATION_CLIPPED',

  RESOURCE_BYTES_LIMIT: 'PULSE_RESOURCE_BYTES_LIMIT',
  RESOURCE_POINTS_LIMIT: 'PULSE_RESOURCE_POINTS_LIMIT',
  RESOURCE_EXPANDED_POINTS_LIMIT: 'PULSE_RESOURCE_EXPANDED_POINTS_LIMIT',
  RESOURCE_DURATION_LIMIT: 'PULSE_RESOURCE_DURATION_LIMIT',

  EXPORT_BLOCKED: 'PULSE_EXPORT_BLOCKED',
  EXPORT_UNSUPPORTED_FORMAT: 'PULSE_EXPORT_UNSUPPORTED_FORMAT',
  EXPORT_UNSUPPORTED_MODE: 'PULSE_EXPORT_UNSUPPORTED_MODE',
  EXPORT_ROUNDTRIP_MISMATCH: 'PULSE_EXPORT_ROUNDTRIP_MISMATCH',
  EXPORT_SOURCE_UNAVAILABLE: 'PULSE_EXPORT_SOURCE_UNAVAILABLE',

  QR_PREFIX: 'PULSE_QR_INVALID_PREFIX',
  QR_URL_FRAGMENT: 'PULSE_QR_INVALID_FRAGMENT',
  QR_HEX: 'PULSE_QR_INVALID_HEX',
  QR_HEX_LIMIT: 'PULSE_QR_HEX_LIMIT',
  QR_GZIP: 'PULSE_QR_INVALID_GZIP',
  QR_GZIP_LIMIT: 'PULSE_QR_DECOMPRESSED_LIMIT',
  QR_BASE64: 'PULSE_QR_INVALID_BASE64',
  QR_TEXT: 'PULSE_QR_INVALID_TEXT',

  EDIT_PATH: 'PULSE_EDIT_INVALID_PATH',
  EDIT_VALUE: 'PULSE_EDIT_INVALID_VALUE',
  EDIT_EMPTY_POINTS: 'PULSE_EDIT_EMPTY_POINTS',
  EDIT_NOT_REVIEWED: 'PULSE_EDIT_NOT_REVIEWED',

  TASK_INVALID_TRANSITION: 'PULSE_TASK_INVALID_TRANSITION',
  TASK_CANCELLED: 'PULSE_TASK_CANCELLED',
  TASK_TIMEOUT: 'PULSE_TASK_TIMEOUT',
  TASK_INPUT_LIMIT: 'PULSE_TASK_INPUT_LIMIT',
  ADAPTER_READ: 'PULSE_ADAPTER_READ_FAILED',
  ADAPTER_WRITE: 'PULSE_ADAPTER_WRITE_FAILED',
  ADAPTER_CONFLICT: 'PULSE_ADAPTER_OUTPUT_CONFLICT'
} as const);

export type DiagnosticCode =
  (typeof DIAGNOSTIC_CODES)[keyof typeof DIAGNOSTIC_CODES];

export const DIAGNOSTIC_CATALOG: Readonly<Record<DiagnosticCode, {
  readonly stage: DiagnosticStage;
  readonly defaultSeverity: DiagnosticSeverity;
}>> = Object.freeze({
  [DIAGNOSTIC_CODES.RECOGNIZE_EMPTY_INPUT]: { stage: 'recognize', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.RECOGNIZE_INVALID_ENCODING]: { stage: 'recognize', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.RECOGNIZE_BOM]: { stage: 'recognize', defaultSeverity: 'warning' },
  [DIAGNOSTIC_CODES.RECOGNIZE_UNSUPPORTED_INPUT]: { stage: 'recognize', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.RECOGNIZE_UNKNOWN_PREFIX]: { stage: 'recognize', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.RECOGNIZE_SIZE_LIMIT]: { stage: 'resource', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SYNTAX_MISSING_EQUALS]: { stage: 'syntax', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SYNTAX_DUPLICATE_EQUALS]: { stage: 'syntax', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SYNTAX_EMPTY_GLOBAL_FIELD]: { stage: 'syntax', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SYNTAX_GLOBAL_FIELD_COUNT]: { stage: 'syntax', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SYNTAX_INVALID_NUMBER]: { stage: 'syntax', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SYNTAX_NON_FINITE_NUMBER]: { stage: 'syntax', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SYNTAX_INVALID_SECTION_SEPARATOR]: { stage: 'syntax', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SYNTAX_EMPTY_SECTION]: { stage: 'syntax', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SYNTAX_SECTION_HEADER_COUNT]: { stage: 'syntax', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SYNTAX_MISSING_SLASH]: { stage: 'syntax', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SYNTAX_DUPLICATE_SLASH]: { stage: 'syntax', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SYNTAX_EMPTY_POINT]: { stage: 'syntax', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SYNTAX_POINT_FIELD_COUNT]: { stage: 'syntax', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SYNTAX_MISSING_POINT_SEPARATOR]: { stage: 'syntax', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SYNTAX_TRAILING_CONTENT]: { stage: 'syntax', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SYNTAX_UNEXPECTED_CHARACTER]: { stage: 'syntax', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.RANGE_SECTION_COUNT]: { stage: 'range', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.RANGE_GLOBAL_REST]: { stage: 'range', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.RANGE_GLOBAL_SPEED]: { stage: 'range', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.RANGE_GLOBAL_BALANCE]: { stage: 'range', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.RANGE_FREQUENCY_INDEX]: { stage: 'range', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.RANGE_DURATION_INDEX]: { stage: 'range', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.RANGE_FREQUENCY_MODE]: { stage: 'range', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.RANGE_ENABLED_FLAG]: { stage: 'range', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.RANGE_INTENSITY]: { stage: 'range', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.RANGE_ANCHOR_FLAG]: { stage: 'range', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.RANGE_INTEGER_REQUIRED]: { stage: 'range', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SEMANTIC_TOO_FEW_POINTS]: { stage: 'semantic', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SEMANTIC_INVALID_FREQUENCY_RANGE]: { stage: 'semantic', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SEMANTIC_NO_ENABLED_SECTION]: { stage: 'semantic', defaultSeverity: 'warning' },
  [DIAGNOSTIC_CODES.SEMANTIC_EXPANSION_LIMIT]: { stage: 'semantic', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SEMANTIC_UNVERIFIED_SECTION_COUNT]: { stage: 'semantic', defaultSeverity: 'warning' },
  [DIAGNOSTIC_CODES.SEMANTIC_INTERPOLATION_UNVERIFIED]: { stage: 'semantic', defaultSeverity: 'warning' },
  [DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL]: { stage: 'semantic', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SEMANTIC_DURATION_MISMATCH]: { stage: 'semantic', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SEMANTIC_INVALID_SOURCE]: { stage: 'semantic', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.SEMANTIC_INTERPOLATION_ROUNDED]: { stage: 'semantic', defaultSeverity: 'warning' },
  [DIAGNOSTIC_CODES.SEMANTIC_INTERPOLATION_CLIPPED]: { stage: 'semantic', defaultSeverity: 'warning' },
  [DIAGNOSTIC_CODES.RESOURCE_BYTES_LIMIT]: { stage: 'resource', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.RESOURCE_POINTS_LIMIT]: { stage: 'resource', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.RESOURCE_EXPANDED_POINTS_LIMIT]: { stage: 'resource', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.RESOURCE_DURATION_LIMIT]: { stage: 'resource', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.EXPORT_BLOCKED]: { stage: 'export', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_FORMAT]: { stage: 'export', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_MODE]: { stage: 'export', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.EXPORT_ROUNDTRIP_MISMATCH]: { stage: 'export', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE]: { stage: 'export', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.QR_PREFIX]: { stage: 'qr', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.QR_URL_FRAGMENT]: { stage: 'qr', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.QR_HEX]: { stage: 'qr', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.QR_HEX_LIMIT]: { stage: 'resource', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.QR_GZIP]: { stage: 'qr', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.QR_GZIP_LIMIT]: { stage: 'resource', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.QR_BASE64]: { stage: 'qr', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.QR_TEXT]: { stage: 'qr', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.EDIT_PATH]: { stage: 'semantic', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.EDIT_VALUE]: { stage: 'range', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.EDIT_EMPTY_POINTS]: { stage: 'semantic', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.EDIT_NOT_REVIEWED]: { stage: 'semantic', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.TASK_INVALID_TRANSITION]: { stage: 'task', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.TASK_CANCELLED]: { stage: 'task', defaultSeverity: 'info' },
  [DIAGNOSTIC_CODES.TASK_TIMEOUT]: { stage: 'task', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.TASK_INPUT_LIMIT]: { stage: 'resource', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.ADAPTER_READ]: { stage: 'adapter', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.ADAPTER_WRITE]: { stage: 'adapter', defaultSeverity: 'error' },
  [DIAGNOSTIC_CODES.ADAPTER_CONFLICT]: { stage: 'adapter', defaultSeverity: 'error' }
});

const DEFAULT_LOCATION: DiagnosticLocation = Object.freeze({ path: '$' });

export function makeDiagnostic(
  code: string,
  severity: DiagnosticSeverity,
  stage: DiagnosticStage,
  message: string,
  location: DiagnosticLocation = DEFAULT_LOCATION,
  options: {
    readonly suggestion?: string;
    readonly parameters?: Readonly<Record<string, string | number | boolean>>;
  } = {}
): Diagnostic {
  const optional: {
    suggestion?: string;
    parameters?: Readonly<Record<string, string | number | boolean>>;
  } = {};
  if (options.suggestion !== undefined) optional.suggestion = options.suggestion;
  if (options.parameters !== undefined) optional.parameters = options.parameters;
  const diagnostic: Diagnostic = {
    code,
    severity,
    stage,
    message,
    location,
    ...optional
  };
  return Object.freeze(diagnostic);
}

export function location(
  path: string,
  span?: SourceSpan,
  extra: Omit<DiagnosticLocation, 'path' | 'span'> = {}
): DiagnosticLocation {
  return span === undefined
    ? { path, ...extra }
    : { path, span, ...extra };
}

export function hasBlockingErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((item) => item.severity === 'error');
}

function severityRank(severity: DiagnosticSeverity): number {
  return severity === 'error' ? 0 : severity === 'warning' ? 1 : 2;
}

export function sortDiagnostics(
  diagnostics: readonly Diagnostic[]
): readonly Diagnostic[] {
  return [...diagnostics].sort((a, b) => {
    const aStart = a.location.span?.start ?? Number.MAX_SAFE_INTEGER;
    const bStart = b.location.span?.start ?? Number.MAX_SAFE_INTEGER;
    if (aStart !== bStart) return aStart - bStart;
    const severity = severityRank(a.severity) - severityRank(b.severity);
    if (severity !== 0) return severity;
    if (a.stage !== b.stage) return a.stage.localeCompare(b.stage);
    return a.code.localeCompare(b.code);
  });
}

export function catalogSeverity(code: string): DiagnosticSeverity {
  const entry = (DIAGNOSTIC_CATALOG as Record<string, {
    readonly stage: DiagnosticStage;
    readonly defaultSeverity: DiagnosticSeverity;
  }>)[code];
  return entry?.defaultSeverity ?? 'error';
}
