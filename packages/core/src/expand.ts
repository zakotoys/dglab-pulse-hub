import {
  DIAGNOSTIC_CODES,
  hasBlockingErrors,
  location,
  makeDiagnostic,
  sortDiagnostics
} from './diagnostics.js';
import { encodeUtf8, stableDigest } from './numbers.js';
import { resolveControlPoints, type ResolvedControlPoint } from './interpolate.js';
import { validatePulse } from './validator.js';
import {
  DEFAULT_RULE_SET,
  type Diagnostic,
  type ExpansionOptions,
  type Pulse,
  type PulseSection,
  type RuleSet,
  type SectionMetadata,
  type SectionPointMetadata,
  type StreamSegment,
  type WaveformPoint,
  type WaveformStream
} from './types.js';

export interface SectionTiming {
  readonly targetDurationMs: number;
  readonly pulseElementDurationMs: number;
  readonly repetitionCount: number;
  readonly effectiveDurationMs: number;
  readonly overshootMs: number;
}

export interface ExpansionResult {
  readonly stream: WaveformStream | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly sectionTiming: readonly SectionTiming[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function targetDurationMs(section: PulseSection, rules: RuleSet = DEFAULT_RULE_SET): number {
  // The index-to-time mapping is intentionally explicit and index-only. The
  // project has no verified physical duration table, so the rule ID remains
  // visible in every derived stream.
  const candidateRules = isRecord(rules) ? (rules as RuleSet) : DEFAULT_RULE_SET;
  const candidateSection = isRecord(section) ? section : null;
  const unit =
    Number.isFinite(candidateRules.durationUnitMs) && candidateRules.durationUnitMs > 0
      ? candidateRules.durationUnitMs
      : DEFAULT_RULE_SET.durationUnitMs;
  const index =
    candidateSection !== null &&
    Number.isFinite(candidateSection.durationIndex) &&
    candidateSection.durationIndex >= 0
      ? candidateSection.durationIndex
      : 0;
  return Math.max(unit, (index + 1) * unit);
}

export function sectionTiming(
  section: PulseSection,
  rules: RuleSet = DEFAULT_RULE_SET
): SectionTiming {
  const candidateRules = isRecord(rules) ? (rules as RuleSet) : DEFAULT_RULE_SET;
  const candidateSection = isRecord(section) ? section : null;
  const pointDuration =
    Number.isFinite(candidateRules.pointDurationMs) && candidateRules.pointDurationMs > 0
      ? candidateRules.pointDurationMs
      : DEFAULT_RULE_SET.pointDurationMs;
  const points =
    candidateSection !== null &&
    isRecord(candidateSection.pulseElement) &&
    Array.isArray(candidateSection.pulseElement.points)
      ? candidateSection.pulseElement.points
      : [];
  const pointCount = Number.isSafeInteger(points.length) ? points.length : 0;
  const pulseElementDurationMs = pointCount * pointDuration;
  const target = targetDurationMs(section, candidateRules);
  const repetitionCount = Math.max(1, Math.ceil(target / Math.max(1, pulseElementDurationMs)));
  const effectiveDurationMs = repetitionCount * pulseElementDurationMs;
  return Object.freeze({
    targetDurationMs: target,
    pulseElementDurationMs,
    repetitionCount,
    effectiveDurationMs,
    overshootMs: effectiveDurationMs - target
  });
}

export function frequencyAt(section: PulseSection, pointIndex: number): number {
  if (
    !isRecord(section) ||
    !isRecord(section.pulseElement) ||
    !Array.isArray(section.pulseElement.points)
  )
    return 0;
  const count = section.pulseElement.points.length;
  const denominator = Math.max(1, count - 1);
  const x = Math.min(1, Math.max(0, pointIndex / denominator));
  switch (section.frequencyMode) {
    case 1:
      return section.frequencyStartIndex;
    case 2:
      return section.frequencyEndIndex;
    case 3:
      return (
        section.frequencyStartIndex + (section.frequencyEndIndex - section.frequencyStartIndex) * x
      );
    case 4:
      return (
        section.frequencyEndIndex + (section.frequencyStartIndex - section.frequencyEndIndex) * x
      );
    default:
      // Invalid modes are rejected by validatePulse. Keeping a deterministic
      // fallback here makes this low-level helper total for untrusted callers.
      return section.frequencyStartIndex;
  }
}

function stableNumber(value: number): number {
  return Number(value.toFixed(6));
}

function pointFromResolved(
  point: ResolvedControlPoint,
  section: PulseSection,
  sectionIndex: number,
  repetitionIndex: number,
  pointIndex: number,
  streamIndex: number,
  timeMs: number,
  durationMs: number
): WaveformPoint {
  return Object.freeze({
    index: streamIndex,
    timeMs: stableNumber(timeMs),
    durationMs: stableNumber(durationMs),
    frequencyIndex: stableNumber(frequencyAt(section, pointIndex)),
    intensity: stableNumber(point.value),
    intensityDecimal: point.decimal,
    anchor: point.origin === 'source-anchor' ? 1 : 0,
    source: Object.freeze({
      sectionIndex,
      pulseElementIndex: 0,
      repetitionIndex,
      controlPointIndex: pointIndex,
      origin: point.origin
    })
  });
}

function projectedExpansion(
  pulse: Pulse,
  rules: RuleSet,
  includeDisabled: boolean
): {
  readonly pointCount: number;
  readonly durationMs: number;
  readonly timings: readonly SectionTiming[];
} {
  const timings = pulse.sections.map((section) => sectionTiming(section, rules));
  let pointCount = 0;
  let durationMs = 0;
  let selectedSeen = false;
  const speed =
    rules.speedDivisor && pulse.globals.playbackSpeed > 0 ? pulse.globals.playbackSpeed : 1;
  pulse.sections.forEach((section, index) => {
    const timing = timings[index];
    if (timing === undefined || (!section.enabled && !includeDisabled)) return;
    if (selectedSeen) {
      durationMs += (pulse.globals.sectionRestIndex * rules.restUnitMs) / speed;
    }
    selectedSeen = true;
    const sectionPoints = section.pulseElement.points.length * timing.repetitionCount;
    pointCount = Math.min(Number.MAX_SAFE_INTEGER, pointCount + sectionPoints);
    durationMs += timing.effectiveDurationMs / speed;
  });
  return {
    pointCount,
    durationMs: stableNumber(durationMs),
    timings: Object.freeze(timings)
  };
}

export function expandWaveform(
  pulse: Pulse,
  options: ExpansionOptions = {},
  rules: RuleSet = DEFAULT_RULE_SET
): ExpansionResult {
  if (!isRecord(options)) options = {};
  if (!isRecord(rules)) rules = DEFAULT_RULE_SET;
  const diagnostics: Diagnostic[] = [];
  const validation = validatePulse(pulse, rules);
  diagnostics.push(...validation.diagnostics);
  const timingRulesValid =
    [
      rules.pointDurationMs,
      rules.restUnitMs,
      rules.durationUnitMs,
      rules.maxExpandedPoints,
      rules.maxExpandedDurationMs
    ].every((value) => Number.isFinite(value) && value > 0) &&
    Number.isSafeInteger(rules.maxExpandedPoints) &&
    typeof rules.speedDivisor === 'boolean';
  if (!timingRulesValid) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.RESOURCE_DURATION_LIMIT,
        'error',
        'resource',
        'Expansion timing and resource rules must be finite positive values.',
        location('rules')
      )
    );
  }
  const maxPoints = options.maxPoints ?? rules.maxExpandedPoints;
  const maxDuration = options.maxDurationMs ?? rules.maxExpandedDurationMs;
  const validMaxPoints = Number.isSafeInteger(maxPoints) && maxPoints >= 0;
  const validMaxDuration = Number.isFinite(maxDuration) && maxDuration >= 0;
  if (!validMaxPoints) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.RESOURCE_EXPANDED_POINTS_LIMIT,
        'error',
        'resource',
        'Maximum expanded point count must be a finite non-negative safe integer.',
        location('stream'),
        { parameters: { maxPoints } }
      )
    );
  }
  if (!validMaxDuration) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.RESOURCE_DURATION_LIMIT,
        'error',
        'resource',
        'Maximum expanded duration must be a finite non-negative number.',
        location('stream'),
        { parameters: { maxDurationMs: maxDuration } }
      )
    );
  }
  const hasSections =
    pulse !== null &&
    typeof pulse === 'object' &&
    Array.isArray((pulse as { readonly sections?: unknown }).sections);
  const canProject =
    hasSections &&
    !hasBlockingErrors(validation.diagnostics) &&
    timingRulesValid &&
    isRecord((pulse as { readonly globals?: unknown }).globals);
  const projected = canProject
    ? projectedExpansion(pulse, rules, options.includeDisabled === true)
    : { pointCount: 0, durationMs: 0, timings: Object.freeze([]) as readonly SectionTiming[] };
  if (validMaxPoints && projected.pointCount > maxPoints) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.RESOURCE_EXPANDED_POINTS_LIMIT,
        'error',
        'resource',
        'Expanded stream point count exceeds the configured limit.',
        location('stream'),
        {
          suggestion: 'Reduce section duration or control point count.',
          parameters: { maxPoints, actual: projected.pointCount }
        }
      )
    );
  }
  if (validMaxDuration && projected.durationMs > maxDuration) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.RESOURCE_DURATION_LIMIT,
        'error',
        'resource',
        'Expanded stream duration exceeds the configured limit.',
        location('stream'),
        {
          suggestion: 'Reduce duration, rest time or section count.',
          parameters: { maxDurationMs: maxDuration, actual: projected.durationMs }
        }
      )
    );
  }
  if (hasBlockingErrors(diagnostics)) {
    return Object.freeze({
      stream: null,
      diagnostics: sortDiagnostics(diagnostics),
      sectionTiming: projected.timings
    });
  }

  const points: WaveformPoint[] = [];
  const segments: StreamSegment[] = [];
  let timeMs = 0;
  let selectedSeen = false;
  const speed =
    rules.speedDivisor && pulse.globals.playbackSpeed > 0 ? pulse.globals.playbackSpeed : 1;
  for (let sectionIndex = 0; sectionIndex < pulse.sections.length; sectionIndex += 1) {
    if (options.signal?.aborted) {
      diagnostics.push(
        makeDiagnostic(
          DIAGNOSTIC_CODES.TASK_CANCELLED,
          'info',
          'task',
          'Waveform expansion was cancelled.',
          location('stream')
        )
      );
      return Object.freeze({
        stream: null,
        diagnostics: sortDiagnostics(diagnostics),
        sectionTiming: projected.timings
      });
    }
    const section = pulse.sections[sectionIndex];
    const timing = projected.timings[sectionIndex];
    if (section === undefined || timing === undefined) continue;
    if (!section.enabled && !options.includeDisabled) continue;
    if (selectedSeen) {
      const restDuration = (pulse.globals.sectionRestIndex * rules.restUnitMs) / speed;
      if (restDuration > 0) {
        segments.push(
          Object.freeze({
            kind: 'rest',
            startMs: stableNumber(timeMs),
            durationMs: stableNumber(restDuration),
            pointStart: points.length,
            pointCount: 0
          })
        );
        timeMs = stableNumber(timeMs + restDuration);
      }
    }
    selectedSeen = true;
    const resolved = resolveControlPoints(section.pulseElement.points);
    diagnostics.push(...resolved.diagnostics);
    const pointDuration = rules.pointDurationMs / speed;
    const pointStart = points.length;
    for (let repetitionIndex = 0; repetitionIndex < timing.repetitionCount; repetitionIndex += 1) {
      if (options.signal?.aborted) {
        diagnostics.push(
          makeDiagnostic(
            DIAGNOSTIC_CODES.TASK_CANCELLED,
            'info',
            'task',
            'Waveform expansion was cancelled.',
            location('stream', undefined, { sectionIndex })
          )
        );
        return Object.freeze({
          stream: null,
          diagnostics: sortDiagnostics(diagnostics),
          sectionTiming: projected.timings
        });
      }
      for (let pointIndex = 0; pointIndex < resolved.points.length; pointIndex += 1) {
        const resolvedPoint = resolved.points[pointIndex];
        if (resolvedPoint === undefined) continue;
        points.push(
          pointFromResolved(
            resolvedPoint,
            section,
            sectionIndex,
            repetitionIndex,
            pointIndex,
            points.length,
            timeMs,
            pointDuration
          )
        );
        timeMs = stableNumber(timeMs + pointDuration);
      }
    }
    segments.push(
      Object.freeze({
        kind: 'section',
        sectionIndex,
        startMs: stableNumber(timeMs - (points.length - pointStart) * pointDuration),
        durationMs: stableNumber((points.length - pointStart) * pointDuration),
        pointStart,
        pointCount: points.length - pointStart
      })
    );
  }
  const streamDigest = stableDigest(
    encodeUtf8(
      JSON.stringify({
        ruleVersion: rules.id,
        points,
        segments,
        totalDurationMs: stableNumber(timeMs),
        includeDisabled: options.includeDisabled === true,
        rules
      })
    )
  );
  const stream: WaveformStream = Object.freeze({
    kind: 'waveform-stream',
    ruleVersion: rules.id,
    points: Object.freeze(points),
    segments: Object.freeze(segments),
    totalDurationMs: stableNumber(timeMs),
    timeGranularityMs: stableNumber(rules.pointDurationMs / speed),
    warnings: Object.freeze(
      sortDiagnostics(diagnostics).filter((item) => item.severity !== 'error')
    ),
    digest: streamDigest
  });
  return Object.freeze({
    stream,
    diagnostics: sortDiagnostics(diagnostics),
    sectionTiming: projected.timings
  });
}

export function sectionMetadata(
  pulse: Pulse,
  sectionIndex: number,
  diagnostics: readonly Diagnostic[] = [],
  rules: RuleSet = DEFAULT_RULE_SET
): SectionMetadata | null {
  const section = pulse.sections[sectionIndex];
  if (section === undefined) return null;
  const timing = sectionTiming(section, rules);
  const sourcePoints: SectionPointMetadata[] = section.pulseElement.points.map((point, index) =>
    Object.freeze({
      controlPointIndex: index,
      strength: point.strength,
      strengthDecimal: point.strengthDecimal,
      anchor: point.anchor
    })
  );
  return Object.freeze({
    sectionIndex,
    enabled: section.enabled,
    frequencyStartIndex: section.frequencyStartIndex,
    frequencyEndIndex: section.frequencyEndIndex,
    frequencyMode: section.frequencyMode,
    durationIndex: section.durationIndex,
    targetDurationMs: timing.targetDurationMs,
    effectiveDurationMs: timing.effectiveDurationMs,
    repetitionCount: timing.repetitionCount,
    pulseElementDurationMs: timing.pulseElementDurationMs,
    pointCount: section.pulseElement.points.length,
    sourcePoints: Object.freeze(sourcePoints),
    diagnostics: Object.freeze(diagnostics)
  });
}
