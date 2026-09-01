import { DIAGNOSTIC_CODES, sortDiagnostics } from './diagnostics.js';
import { expandWaveform, sectionMetadata, sectionTiming } from './expand.js';
import {
  DEFAULT_RULE_SET,
  FORMAT_PROFILE,
  type Diagnostic,
  type FileMetadata,
  type Pulse,
  type PulseMetadata,
  type PulseMetadataBundle,
  type RuleSet,
  type SectionMetadata,
  type StreamMetadata,
  type StreamStats,
  type WaveformPoint,
  type WaveformStream
} from './types.js';

export interface MetadataOptions {
  readonly displayName?: string;
  readonly byteSize?: number;
  readonly status?: FileMetadata['status'];
  readonly diagnostics?: readonly Diagnostic[];
  readonly rules?: RuleSet;
}

export function streamStats(stream: WaveformStream): StreamStats {
  const points = stream.points;
  if (points.length === 0) {
    return Object.freeze({
      pointCount: 0,
      totalDurationMs: stream.totalDurationMs,
      minFrequencyIndex: null,
      maxFrequencyIndex: null,
      minIntensity: null,
      maxIntensity: null,
      meanIntensity: null
    });
  }
  let minFrequency = Number.POSITIVE_INFINITY;
  let maxFrequency = Number.NEGATIVE_INFINITY;
  let minIntensity = Number.POSITIVE_INFINITY;
  let maxIntensity = Number.NEGATIVE_INFINITY;
  let sum = 0;
  points.forEach((point) => {
    minFrequency = Math.min(minFrequency, point.frequencyIndex);
    maxFrequency = Math.max(maxFrequency, point.frequencyIndex);
    minIntensity = Math.min(minIntensity, point.intensity);
    maxIntensity = Math.max(maxIntensity, point.intensity);
    sum += point.intensity;
  });
  return Object.freeze({
    pointCount: points.length,
    totalDurationMs: stream.totalDurationMs,
    minFrequencyIndex: minFrequency,
    maxFrequencyIndex: maxFrequency,
    minIntensity,
    maxIntensity,
    meanIntensity: sum / points.length
  });
}

export function projectMetadata(
  pulse: Pulse,
  stream: WaveformStream | null = null,
  options: MetadataOptions = {}
): PulseMetadataBundle {
  const rules = options.rules ?? DEFAULT_RULE_SET;
  let unverifiedSectionCountReported = false;
  const diagnostics = sortDiagnostics(options.diagnostics ?? []).filter((item) => {
    if (item.code === DIAGNOSTIC_CODES.SEMANTIC_INTERPOLATION_ROUNDED) return false;
    if (item.code !== DIAGNOSTIC_CODES.SEMANTIC_UNVERIFIED_SECTION_COUNT) return true;
    if (item.location.sectionIndex !== undefined) return false;
    if (unverifiedSectionCountReported) return false;
    unverifiedSectionCountReported = true;
    return true;
  });
  const sections: SectionMetadata[] = pulse.sections
    .map((_, index) => {
      const sectionDiagnostics = diagnostics.filter((item) => item.location.sectionIndex === index);
      return sectionMetadata(pulse, index, sectionDiagnostics, rules);
    })
    .filter((item): item is SectionMetadata => item !== null);
  const effectiveStream = stream ?? expandWaveform(pulse, {}, rules).stream;
  const stats =
    effectiveStream === null
      ? Object.freeze({
          pointCount: 0,
          totalDurationMs: 0,
          minFrequencyIndex: null,
          maxFrequencyIndex: null,
          minIntensity: null,
          maxIntensity: null,
          meanIntensity: null
        })
      : streamStats(effectiveStream);
  const targetDuration = sections.reduce((sum, item) => sum + item.targetDurationMs, 0);
  const effectiveDuration =
    effectiveStream?.totalDurationMs ??
    sections.reduce((sum, item) => sum + item.effectiveDurationMs, 0);
  const pulseMetadata: PulseMetadata = Object.freeze({
    sectionCount: pulse.sections.length,
    enabledSectionCount: pulse.sections.filter((section) => section.enabled).length,
    disabledSectionCount: pulse.sections.filter((section) => !section.enabled).length,
    sourceDurationMs: targetDuration,
    effectiveDurationMs: effectiveDuration,
    globals: pulse.globals,
    diagnostics
  });
  const streamMetadata: StreamMetadata = Object.freeze({
    stats,
    timeGranularityMs: effectiveStream?.timeGranularityMs ?? rules.pointDurationMs,
    sectionCount: sections.length,
    warningCount: effectiveStream?.warnings.length ?? 0,
    ruleVersion: rules.id
  });
  const file: FileMetadata = Object.freeze({
    displayName: options.displayName ?? 'pulse',
    byteSize: options.byteSize ?? pulse.source.bytes.byteLength,
    format: 'pulse-text',
    formatProfile: FORMAT_PROFILE,
    ruleVersion: rules.id,
    evidence: pulse.evidence,
    status:
      options.status ??
      (diagnostics.some((item) => item.severity === 'error') ? 'rejected' : 'accepted')
  });
  return Object.freeze({
    file,
    pulse: pulseMetadata,
    sections: Object.freeze(sections),
    stream: streamMetadata
  });
}

export function pointMetadata(
  pulse: Pulse,
  stream: WaveformStream,
  pointIndex: number,
  options: MetadataOptions = {}
): { readonly point: WaveformPoint; readonly section: SectionMetadata } | null {
  const point = stream.points[pointIndex];
  if (point === undefined) return null;
  const section = sectionMetadata(
    pulse,
    point.source.sectionIndex,
    options.diagnostics ?? [],
    options.rules ?? DEFAULT_RULE_SET
  );
  if (section === null) return null;
  return Object.freeze({ point, section });
}
