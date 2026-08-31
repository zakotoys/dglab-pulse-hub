/**
 * Public domain types for the supported Dungeonlab pulse text profile.
 *
 * The model deliberately keeps the source lexeme next to every numeric value.
 * A JavaScript number is useful for calculations, while the canonical decimal
 * string remains authoritative for semantic comparison and serialization.
 */

export const FORMAT_PROFILE = 'dungeonlab-pulse-text/corpus-v1' as const;
export const RULE_VERSION = 'pulse-rules-v1' as const;
export const QR_PREFIX = '#DGLAB-PULSE#' as const;
export const PULSE_PREFIX = 'Dungeonlab+pulse:' as const;

export type FormatProfile = typeof FORMAT_PROFILE;
export type RuleVersion = typeof RULE_VERSION;
export type FormatKind = 'pulse-text' | 'qr-envelope' | 'unsupported';
export type EvidenceLevel =
  | 'official-semantics'
  | 'corpus-observed'
  | 'community-inferred'
  | 'unverified';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';
export type DiagnosticStage =
  | 'recognize'
  | 'syntax'
  | 'range'
  | 'semantic'
  | 'resource'
  | 'export'
  | 'qr'
  | 'adapter'
  | 'task';

export interface SourceSpan {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export interface DiagnosticLocation {
  readonly path: string;
  readonly span?: SourceSpan;
  readonly sectionIndex?: number;
  readonly pointIndex?: number;
  readonly field?: string;
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly stage: DiagnosticStage;
  readonly message: string;
  readonly location: DiagnosticLocation;
  readonly suggestion?: string;
  readonly parameters?: Readonly<Record<string, string | number | boolean>>;
}

export interface NumericToken {
  readonly lexeme: string;
  readonly value: number;
  readonly canonical: string;
  readonly span: SourceSpan;
}

export interface SourceDocument {
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly digest: string;
  readonly hadBom: boolean;
  readonly trailingNewline: '' | '\n' | '\r\n';
}

export interface SourceSnapshot {
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly format: FormatKind;
}

export interface SyntacticControlPoint {
  readonly strength: NumericToken;
  readonly anchor: NumericToken;
  readonly span: SourceSpan;
}

export interface SyntacticSection {
  readonly fields: readonly [
    NumericToken,
    NumericToken,
    NumericToken,
    NumericToken,
    NumericToken
  ];
  readonly points: readonly SyntacticControlPoint[];
  readonly span: SourceSpan;
}

export interface SyntacticPulse {
  readonly kind: 'syntactic-pulse';
  readonly source: SourceDocument;
  readonly globals: readonly [NumericToken, NumericToken, NumericToken];
  readonly sections: readonly SyntacticSection[];
  readonly span: SourceSpan;
}

export interface PulseGlobals {
  /** Index/value on the left side of the equals sign. */
  readonly sectionRestIndex: number;
  readonly playbackSpeed: number;
  /** Kept as an index; no physical unit is implied. */
  readonly frequencyBalanceIndex: number;
  readonly raw: readonly [string, string, string];
}

export type AnchorFlag = 0 | 1;
export type FrequencyMode = 1 | 2 | 3 | 4;

export interface ControlPoint {
  readonly strength: number;
  /** Exact, normalized decimal representation used for semantic equality. */
  readonly strengthDecimal: string;
  /** Original source lexeme, retained for diagnostics and provenance. */
  readonly strengthRaw: string;
  readonly anchor: AnchorFlag;
  readonly sourceSpan: SourceSpan;
}

export interface PulseElement {
  readonly points: readonly ControlPoint[];
  readonly durationMs: number;
}

export interface PulseSection {
  readonly frequencyStartIndex: number;
  readonly frequencyEndIndex: number;
  readonly durationIndex: number;
  readonly frequencyMode: FrequencyMode;
  readonly enabled: boolean;
  readonly pulseElement: PulseElement;
  readonly raw: readonly [string, string, string, string, string];
  readonly sourceSpan: SourceSpan;
}

export interface Pulse {
  readonly kind: 'pulse';
  readonly format: 'pulse-text';
  readonly formatProfile: FormatProfile;
  readonly ruleVersion: RuleVersion;
  readonly evidence: readonly EvidenceLevel[];
  readonly source: SourceSnapshot;
  readonly globals: PulseGlobals;
  readonly sections: readonly PulseSection[];
  readonly revision: number;
  readonly changeRecords: readonly ChangeRecord[];
}

export type StreamPointOrigin =
  | 'source-anchor'
  | 'source-point'
  | 'quadratic-interpolation'
  | 'boundary-interpolation';

export interface StreamPointSource {
  readonly sectionIndex: number;
  readonly pulseElementIndex: number;
  readonly repetitionIndex: number;
  readonly controlPointIndex: number;
  readonly origin: StreamPointOrigin;
}

export interface WaveformPoint {
  readonly index: number;
  readonly timeMs: number;
  readonly durationMs: number;
  /** Index-domain value. It is intentionally not labelled Hz. */
  readonly frequencyIndex: number;
  readonly intensity: number;
  readonly intensityDecimal: string;
  readonly anchor: AnchorFlag;
  readonly source: StreamPointSource;
}

export interface StreamSegment {
  readonly kind: 'section' | 'rest';
  readonly sectionIndex?: number;
  readonly startMs: number;
  readonly durationMs: number;
  readonly pointStart: number;
  readonly pointCount: number;
}

export interface WaveformStream {
  readonly kind: 'waveform-stream';
  readonly ruleVersion: RuleVersion;
  readonly points: readonly WaveformPoint[];
  readonly segments: readonly StreamSegment[];
  readonly totalDurationMs: number;
  readonly timeGranularityMs: number;
  readonly warnings: readonly Diagnostic[];
  readonly digest: string;
}

export interface StreamStats {
  readonly pointCount: number;
  readonly totalDurationMs: number;
  readonly minFrequencyIndex: number | null;
  readonly maxFrequencyIndex: number | null;
  readonly minIntensity: number | null;
  readonly maxIntensity: number | null;
  readonly meanIntensity: number | null;
}

export interface FileMetadata {
  readonly displayName: string;
  readonly byteSize: number;
  readonly format: FormatKind;
  readonly formatProfile: FormatProfile | 'unknown';
  readonly ruleVersion: RuleVersion;
  readonly evidence: readonly EvidenceLevel[];
  readonly status: 'accepted' | 'rejected' | 'failed';
}

export interface SectionMetadata {
  readonly sectionIndex: number;
  readonly enabled: boolean;
  readonly frequencyStartIndex: number;
  readonly frequencyEndIndex: number;
  readonly frequencyMode: FrequencyMode;
  readonly durationIndex: number;
  readonly targetDurationMs: number;
  readonly effectiveDurationMs: number;
  readonly repetitionCount: number;
  readonly pulseElementDurationMs: number;
  readonly pointCount: number;
  /** Source control points, including points from disabled sections. */
  readonly sourcePoints: readonly SectionPointMetadata[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface SectionPointMetadata {
  readonly controlPointIndex: number;
  readonly strength: number;
  readonly strengthDecimal: string;
  readonly anchor: AnchorFlag;
}

export interface PulseMetadata {
  readonly sectionCount: number;
  readonly enabledSectionCount: number;
  readonly disabledSectionCount: number;
  readonly sourceDurationMs: number;
  readonly effectiveDurationMs: number;
  readonly globals: PulseGlobals;
  readonly diagnostics: readonly Diagnostic[];
}

export interface StreamMetadata {
  readonly stats: StreamStats;
  readonly timeGranularityMs: number;
  readonly sectionCount: number;
  readonly warningCount: number;
  readonly ruleVersion: RuleVersion;
}

export interface PointMetadata {
  readonly point: WaveformPoint;
  readonly section: SectionMetadata;
}

export interface PulseMetadataBundle {
  readonly file: FileMetadata;
  readonly pulse: PulseMetadata;
  readonly sections: readonly SectionMetadata[];
  readonly stream: StreamMetadata;
}

export type ChangeKind =
  | 'edit'
  | 'interpolation'
  | 'format-normalization'
  | 'upgrade';

export interface ChangeRecord {
  readonly id: string;
  readonly kind: ChangeKind;
  readonly description: string;
  readonly path: string;
  readonly before: string | number | boolean | null;
  readonly after: string | number | boolean | null;
  readonly affectedPointIndices?: readonly number[];
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ParseResult {
  readonly accepted: boolean;
  readonly recognition: RecognitionResult;
  readonly syntax: SyntacticPulse | null;
  readonly pulse: Pulse | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface RecognitionResult {
  readonly format: FormatKind;
  readonly profile: FormatProfile | 'unknown';
  readonly ruleVersion: RuleVersion;
  readonly evidence: readonly EvidenceLevel[];
  readonly source: SourceDocument | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ExpansionOptions {
  readonly maxPoints?: number;
  readonly maxDurationMs?: number;
  readonly includeDisabled?: boolean;
  readonly signal?: AbortSignal;
}

export interface RuleSet {
  readonly id: RuleVersion;
  readonly pointDurationMs: number;
  readonly restUnitMs: number;
  readonly speedDivisor: boolean;
  readonly durationUnitMs: number;
  readonly maxBytes: number;
  readonly maxSections: number;
  readonly maxPointsPerSection: number;
  readonly maxTotalControlPoints: number;
  readonly maxExpandedPoints: number;
  readonly maxExpandedDurationMs: number;
}

export const DEFAULT_RULE_SET: RuleSet = Object.freeze({
  id: RULE_VERSION,
  pointDurationMs: 100,
  restUnitMs: 100,
  speedDivisor: true,
  durationUnitMs: 100,
  maxBytes: 2_000_000,
  maxSections: 10,
  maxPointsPerSection: 10_000,
  maxTotalControlPoints: 100_000,
  maxExpandedPoints: 1_000_000,
  maxExpandedDurationMs: 86_400_000
});

export interface SerializeOptions {
  readonly mode?: 'canonical' | 'source';
  readonly validate?: boolean;
}

export interface SerializedPulse {
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly mode: 'canonical' | 'source';
  readonly diagnostics: readonly Diagnostic[];
  readonly changeRecords: readonly ChangeRecord[];
}
