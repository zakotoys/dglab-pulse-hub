import { describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSION,
  RULE_VERSION,
  diagnosticSchema,
  batchDataSchema,
  diffDataSchema,
  inspectDataSchema,
  operationEnvelopeSchema,
  parseOperationEnvelope,
  projectOperationResult,
  safeParseOperationEnvelope,
  waveformStreamSchema
} from '../src/index.js';

const diagnostic = {
  code: 'PULSE_SYNTAX_INVALID_NUMBER',
  severity: 'error' as const,
  stage: 'syntax' as const,
  message: 'Invalid number.',
  location: { path: 'sections[0].points[1].strength' }
};

describe('versioned public contracts', () => {
  it('accepts a successful result envelope and rejects the old data key', () => {
    const valid = {
      schemaVersion: CONTRACT_VERSION,
      ruleVersion: RULE_VERSION,
      operation: 'inspect',
      status: 'success' as const,
      result: { sourceDigest: 'abc' },
      diagnostics: []
    };
    expect(operationEnvelopeSchema.safeParse(valid).success).toBe(true);
    expect(
      operationEnvelopeSchema.safeParse({ ...valid, data: valid.result, result: undefined }).success
    ).toBe(false);
  });

  it('rejects an unknown schema or rule version without fallback', () => {
    const value = {
      schemaVersion: 'pulse-contract-v9',
      ruleVersion: RULE_VERSION,
      operation: 'inspect',
      status: 'cancelled' as const,
      result: null,
      diagnostics: []
    };
    const safe = safeParseOperationEnvelope(value);
    expect(safe.ok).toBe(false);
    expect(() => parseOperationEnvelope(value)).toThrow(/schema version/i);

    const ruleMismatch = {
      ...value,
      schemaVersion: CONTRACT_VERSION,
      ruleVersion: 'pulse-rules-v9'
    };
    expect(() => parseOperationEnvelope(ruleMismatch)).toThrow(/rule version/i);
  });

  it('requires result data only for success and diagnostics for public errors', () => {
    const rejected = {
      schemaVersion: CONTRACT_VERSION,
      ruleVersion: RULE_VERSION,
      operation: 'inspect',
      status: 'rejected' as const,
      result: null,
      diagnostics: [diagnostic]
    };
    expect(operationEnvelopeSchema.safeParse(rejected).success).toBe(true);
    expect(operationEnvelopeSchema.safeParse({ ...rejected, result: {} }).success).toBe(false);
    expect(
      operationEnvelopeSchema.safeParse({
        ...rejected,
        diagnostics: [{ ...diagnostic, location: { path: '/tmp/input.pulse' } }]
      }).success
    ).toBe(false);
  });

  it('projects application data to result and drops data on non-success states', () => {
    const projected = projectOperationResult(
      {
        operation: 'inspect',
        status: 'success',
        data: { internal: true },
        diagnostics: [diagnostic]
      },
      (value) => ({ visible: value.internal })
    );
    expect(projected).toMatchObject({
      schemaVersion: CONTRACT_VERSION,
      ruleVersion: RULE_VERSION,
      status: 'success',
      result: { visible: true }
    });
    expect('data' in projected).toBe(false);

    const failed = projectOperationResult(
      {
        operation: 'inspect',
        status: 'failed',
        data: { internal: true },
        diagnostics: [diagnostic]
      },
      () => ({ shouldNotBeExposed: true })
    );
    expect(failed.result).toBeNull();
  });

  it('keeps diagnostic codes machine-stable while allowing message text', () => {
    expect(diagnosticSchema.parse({ ...diagnostic, message: '本地化消息' }).code).toBe(
      diagnostic.code
    );
    expect(diagnosticSchema.safeParse({ ...diagnostic, code: 'INVALID' }).success).toBe(false);
  });

  it('requires stable digest shapes in public projections', () => {
    const parsed = inspectDataSchema.shape.sourceDigest.safeParse('abc');
    expect(parsed.success).toBe(false);
    expect(inspectDataSchema.shape.sourceDigest.safeParse('0123456789abcdef').success).toBe(true);
  });

  it('rejects non-sequential stream point indexes and non-monotonic times', () => {
    const base = validInspectData();
    expect(inspectDataSchema.safeParse(base).success).toBe(true);
    const badIndex = structuredClone(base) as typeof base;
    badIndex.stream!.points[1]!.index = 3;
    expect(inspectDataSchema.safeParse(badIndex).success).toBe(false);
    const badTime = structuredClone(base) as typeof base;
    badTime.stream!.points[1]!.timeMs = 50;
    expect(inspectDataSchema.safeParse(badTime).success).toBe(false);

    const epsilonOverlap = structuredClone(base) as typeof base;
    epsilonOverlap.stream!.points[1]!.timeMs = 100 - 0.5e-6;
    expect(inspectDataSchema.safeParse(epsilonOverlap).success).toBe(true);
    const beyondEpsilon = structuredClone(base) as typeof base;
    beyondEpsilon.stream!.points[1]!.timeMs = 100 - 2e-6;
    expect(inspectDataSchema.safeParse(beyondEpsilon).success).toBe(false);
  });

  it('rejects segments that do not cover the stream point range and duration', () => {
    const base = validInspectData();
    const bad = structuredClone(base) as typeof base;
    bad.stream!.segments[0]!.pointCount = 99;
    expect(inspectDataSchema.safeParse(bad).success).toBe(false);
    const badEnd = structuredClone(base) as typeof base;
    badEnd.stream!.segments[0]!.durationMs = 1;
    expect(inspectDataSchema.safeParse(badEnd).success).toBe(false);

    const empty = structuredClone(base) as typeof base;
    empty.stream = {
      kind: 'waveform-stream',
      ruleVersion: RULE_VERSION,
      points: [],
      segments: [],
      totalDurationMs: 0,
      timeGranularityMs: 0,
      warnings: [],
      digest: '0123456789abcdef'
    };
    empty.metadata.stream.stats = {
      pointCount: 0,
      totalDurationMs: 0,
      minFrequencyIndex: null,
      maxFrequencyIndex: null,
      minIntensity: null,
      maxIntensity: null,
      meanIntensity: null
    };
    empty.metadata.stream.timeGranularityMs = 0;
    empty.metadata.pulse.effectiveDurationMs = 0;
    expect(inspectDataSchema.safeParse(empty).success).toBe(true);

    const withMultipleRests = structuredClone(base).stream!;
    withMultipleRests.segments = [
      withMultipleRests.segments[0]!,
      {
        kind: 'rest',
        startMs: 200,
        durationMs: 25,
        pointStart: 2,
        pointCount: 0
      },
      {
        kind: 'rest',
        startMs: 225,
        durationMs: 25,
        pointStart: 2,
        pointCount: 0
      }
    ];
    withMultipleRests.totalDurationMs = 250;
    expect(waveformStreamSchema.safeParse(withMultipleRests).success).toBe(true);
  });

  it('ties metadata section counts and rule versions together', () => {
    const base = validInspectData();
    const badCount = structuredClone(base) as typeof base;
    badCount.metadata.stream.sectionCount = 2;
    expect(inspectDataSchema.safeParse(badCount).success).toBe(false);
    const badRule = structuredClone(base) as typeof base;
    badRule.metadata.stream.ruleVersion = 'pulse-rules-v9' as never;
    expect(inspectDataSchema.safeParse(badRule).success).toBe(false);
  });

  it('rejects inconsistent stream statistics and effective duration', () => {
    const base = validInspectData();
    const badPoints = structuredClone(base) as typeof base;
    badPoints.metadata.stream.stats.pointCount = 1;
    expect(inspectDataSchema.safeParse(badPoints).success).toBe(false);

    const badGranularity = structuredClone(base) as typeof base;
    badGranularity.metadata.stream.timeGranularityMs = 25;
    expect(inspectDataSchema.safeParse(badGranularity).success).toBe(false);

    const badDuration = structuredClone(base) as typeof base;
    badDuration.metadata.pulse.effectiveDurationMs = 100;
    expect(inspectDataSchema.safeParse(badDuration).success).toBe(false);
  });

  it('requires diff equality and batch counts to match their item data', () => {
    const diff = {
      beforeDigest: '0123456789abcdef',
      afterDigest: '0123456789abcdef',
      diff: {
        equal: true,
        structural: [{ path: 'sections.length', before: 1, after: 2 }],
        metadata: [],
        stream: [],
        text: []
      }
    };
    expect(diffDataSchema.safeParse(diff).success).toBe(false);

    const batch = {
      total: 1,
      completed: 1,
      succeeded: 0,
      rejected: 0,
      failed: 0,
      warningFiles: 0,
      cancelled: false,
      items: [
        {
          id: 'one',
          index: 0,
          displayName: 'one.pulse',
          status: 'success' as const,
          diagnostics: [],
          result: { ok: true }
        }
      ]
    };
    expect(batchDataSchema.safeParse(batch).success).toBe(false);
  });
});

function validInspectData(): Record<string, any> {
  const point = (index: number, timeMs: number, intensity: number) => ({
    index,
    timeMs,
    durationMs: 100,
    frequencyIndex: 10,
    intensity,
    intensityDecimal: String(intensity),
    anchor: 1,
    source: {
      sectionIndex: 0,
      pulseElementIndex: 0,
      repetitionIndex: 0,
      controlPointIndex: index,
      origin: 'source-anchor'
    }
  });
  const stream = {
    kind: 'waveform-stream',
    ruleVersion: RULE_VERSION,
    points: [point(0, 0, 0), point(1, 100, 100)],
    segments: [
      {
        kind: 'section',
        sectionIndex: 0,
        startMs: 0,
        durationMs: 200,
        pointStart: 0,
        pointCount: 2
      }
    ],
    totalDurationMs: 200,
    timeGranularityMs: 100,
    warnings: [],
    digest: '0123456789abcdef'
  };
  const section = {
    sectionIndex: 0,
    enabled: true,
    frequencyStartIndex: 10,
    frequencyEndIndex: 10,
    frequencyMode: 1,
    durationIndex: 0,
    targetDurationMs: 100,
    effectiveDurationMs: 200,
    repetitionCount: 1,
    pulseElementDurationMs: 200,
    pointCount: 2,
    sourcePoints: [
      { controlPointIndex: 0, strength: 0, strengthDecimal: '0', anchor: 1 },
      { controlPointIndex: 1, strength: 100, strengthDecimal: '100', anchor: 1 }
    ],
    diagnostics: []
  };
  const pulse = {
    sectionCount: 1,
    enabledSectionCount: 1,
    disabledSectionCount: 0,
    sourceDurationMs: 100,
    effectiveDurationMs: 200,
    globals: {
      sectionRestIndex: 0,
      playbackSpeed: 1,
      frequencyBalanceIndex: 0,
      raw: ['0', '1', '0']
    },
    diagnostics: []
  };
  return {
    recognition: {
      format: 'pulse-text',
      profile: 'dungeonlab-pulse-text/corpus-v1',
      ruleVersion: RULE_VERSION,
      evidence: ['official-semantics'],
      diagnostics: []
    },
    pulse: {
      kind: 'pulse',
      format: 'pulse-text',
      formatProfile: 'dungeonlab-pulse-text/corpus-v1',
      ruleVersion: RULE_VERSION,
      evidence: ['official-semantics'],
      revision: 0,
      globals: pulse.globals,
      sectionCount: 1,
      changeCount: 0
    },
    metadata: {
      file: {
        displayName: 'sample.pulse',
        byteSize: 10,
        format: 'pulse-text',
        formatProfile: 'dungeonlab-pulse-text/corpus-v1',
        ruleVersion: RULE_VERSION,
        evidence: ['official-semantics'],
        status: 'accepted'
      },
      pulse,
      sections: [section],
      stream: {
        stats: {
          pointCount: 2,
          totalDurationMs: 200,
          minFrequencyIndex: 10,
          maxFrequencyIndex: 10,
          minIntensity: 0,
          maxIntensity: 100,
          meanIntensity: 50
        },
        timeGranularityMs: 100,
        sectionCount: 1,
        warningCount: 0,
        ruleVersion: RULE_VERSION
      }
    },
    stream,
    sourceDigest: '0123456789abcdef'
  };
}
