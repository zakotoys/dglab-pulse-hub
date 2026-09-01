import {
  DIAGNOSTIC_CODES,
  hasBlockingErrors,
  location,
  makeDiagnostic,
  sortDiagnostics
} from './diagnostics.js';
import { decodeUtf8, encodeUtf8, normalizeDecimal, stableDigest } from './numbers.js';
import { parsePulseText } from './parser.js';
import { validatePulse } from './validator.js';
import {
  DEFAULT_RULE_SET,
  PULSE_PREFIX,
  type ChangeRecord,
  type Pulse,
  type RuleSet,
  type SerializeOptions,
  type SerializedPulse
} from './types.js';

function isRecordPulse(value: unknown): value is Pulse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'source' in value &&
    'sections' in value &&
    'globals' in value
  );
}

export function canonicalPulseText(pulse: Pulse): string {
  const globals = [
    String(pulse.globals.sectionRestIndex),
    String(pulse.globals.playbackSpeed),
    String(pulse.globals.frequencyBalanceIndex)
  ].join(',');
  const sections = pulse.sections
    .map((section) => {
      const header = [
        String(section.frequencyStartIndex),
        String(section.frequencyEndIndex),
        String(section.durationIndex),
        String(section.frequencyMode),
        section.enabled ? '1' : '0'
      ].join(',');
      const points = section.pulseElement.points
        .map((point) => normalizeDecimal(point.strengthDecimal) + '-' + String(point.anchor))
        .join(',');
      return header + '/' + points;
    })
    .join('+section+');
  return PULSE_PREFIX + globals + '=' + sections;
}

export function serializePulse(
  pulse: Pulse,
  options: SerializeOptions = {},
  rules: RuleSet = DEFAULT_RULE_SET
): SerializedPulse {
  if (options === null || typeof options !== 'object') options = {};
  if (typeof rules !== 'object' || rules === null) rules = DEFAULT_RULE_SET;
  // Validation is always performed before writing. `validate: false` only
  // disables the optional parse/equivalence pass below; it never permits an
  // invalid domain object to reach an exporter.
  const diagnostics = [...validatePulse(pulse, rules).diagnostics];
  const requestedMode = options.mode as string | undefined;
  let mode: 'canonical' | 'source' =
    requestedMode === undefined
      ? isRecordPulse(pulse) && pulse.revision === 0 && pulse.changeRecords.length === 0
        ? 'source'
        : 'canonical'
      : requestedMode === 'source' || requestedMode === 'canonical'
        ? requestedMode
        : 'canonical';
  if (requestedMode !== undefined && requestedMode !== 'source' && requestedMode !== 'canonical') {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_MODE,
        'error',
        'export',
        'Export mode is not supported.',
        location('mode')
      )
    );
  }
  if (hasBlockingErrors(diagnostics) || !isRecordPulse(pulse)) {
    return Object.freeze({
      text: '',
      bytes: new Uint8Array(),
      mode,
      diagnostics: sortDiagnostics(diagnostics),
      changeRecords: Object.freeze([])
    });
  }
  const sourceDigestMatches = stableDigest(pulse.source.bytes) === pulse.source.digest;
  const sourceAvailable = pulse.source.bytes.byteLength > 0 && sourceDigestMatches;
  if (mode === 'source' && !sourceAvailable) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE,
        'error',
        'export',
        'The source snapshot bytes no longer match its recorded digest.',
        location('$'),
        { suggestion: 'Use canonical export from an unmodified Pulse snapshot.' }
      )
    );
  }
  const changes: ChangeRecord[] = [];
  if (mode === 'source' && (pulse.revision !== 0 || pulse.changeRecords.length > 0)) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.EXPORT_SOURCE_UNAVAILABLE,
        'error',
        'export',
        'The source snapshot is no longer the current editable document.',
        location('$'),
        { suggestion: 'Use canonical export for an edited document.' }
      )
    );
  }
  if (hasBlockingErrors(diagnostics)) {
    return Object.freeze({
      text: '',
      bytes: new Uint8Array(),
      mode,
      diagnostics: sortDiagnostics(diagnostics),
      changeRecords: Object.freeze([])
    });
  }
  let bytes: Uint8Array;
  let text: string;
  if (mode === 'source' && sourceAvailable) {
    bytes = new Uint8Array(pulse.source.bytes);
    const decoded = decodeUtf8(bytes);
    // Keep the text and byte projections truthful for BOM-bearing sources.
    // The parser strips the BOM for grammar purposes, but source export must
    // still expose the exact decoded byte content.
    text = decoded.text ?? pulse.source.text;
  } else {
    mode = 'canonical';
    text = canonicalPulseText(pulse);
    bytes = encodeUtf8(text);
    if (text !== pulse.source.text) {
      changes.push(
        Object.freeze({
          id:
            'format-normalization-' +
            stableDigest(
              encodeUtf8(
                JSON.stringify({
                  revision: pulse.revision,
                  before: pulse.source.text,
                  after: text
                })
              )
            ),
          kind: 'format-normalization',
          description: 'Canonical serialization normalized separators and numeric lexemes.',
          path: '$',
          before: pulse.source.text,
          after: text
        })
      );
    }
  }
  if (options.validate !== false) {
    const roundTrip = parsePulseText(bytes, { rules });
    const equivalent = roundTrip.pulse !== null && semanticallyEqual(pulse, roundTrip.pulse);
    if (!equivalent) {
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
  }
  if (hasBlockingErrors(diagnostics)) {
    return Object.freeze({
      text: '',
      bytes: new Uint8Array(),
      mode,
      diagnostics: sortDiagnostics(diagnostics),
      changeRecords: Object.freeze([])
    });
  }
  return Object.freeze({
    text,
    bytes: new Uint8Array(bytes),
    mode,
    diagnostics: sortDiagnostics(diagnostics),
    changeRecords: Object.freeze(changes)
  });
}

export function pulseSemanticKey(pulse: Pulse): string {
  return JSON.stringify({
    globals: [
      pulse.globals.sectionRestIndex,
      pulse.globals.playbackSpeed,
      pulse.globals.frequencyBalanceIndex
    ],
    sections: pulse.sections.map((section) => ({
      frequencyStartIndex: section.frequencyStartIndex,
      frequencyEndIndex: section.frequencyEndIndex,
      durationIndex: section.durationIndex,
      frequencyMode: section.frequencyMode,
      enabled: section.enabled,
      points: section.pulseElement.points.map((point) => [
        normalizeDecimal(point.strengthDecimal),
        point.anchor
      ])
    }))
  });
}

export function semanticallyEqual(left: Pulse, right: Pulse): boolean {
  return pulseSemanticKey(left) === pulseSemanticKey(right);
}
