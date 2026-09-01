import { z } from 'zod';

/**
 * Public contract versions are intentionally literals.  A caller using a
 * different major (or a different pulse rule set) must update explicitly;
 * there is no compatibility fallback at this boundary.
 */
export const SCHEMA_VERSION = 'pulse-contract-v1' as const;
export const RULE_VERSION = 'pulse-rules-v1' as const;

/** Alias retained as the descriptive name used by application callers. */
export const CONTRACT_VERSION = SCHEMA_VERSION;

export const schemaVersionSchema = z.literal(SCHEMA_VERSION);
export const ruleVersionSchema = z.literal(RULE_VERSION);

const finiteNumberSchema = z.number().finite();
const nonNegativeNumberSchema = finiteNumberSchema.nonnegative();
const safeIntegerSchema = z.number().int().refine(Number.isSafeInteger, 'Expected a safe integer.');
const nonNegativeIntegerSchema = safeIntegerSchema.nonnegative();
const positiveIntegerSchema = safeIntegerSchema.positive();
const nonEmptyStringSchema = z.string().min(1);
/** Digests emitted by the core stableDigest helper are canonical lowercase hex. */
export const digestSchema = z.string().regex(/^[0-9a-f]{16}$/);

/** Paths in a diagnostic are structural paths, never filesystem paths. */
const publicPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes('/') &&
      !value.includes('\\') &&
      !value.includes(':') &&
      !value.includes('..'),
    'Diagnostic paths must be structural paths.'
  );

const displayNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.includes('/') && !value.includes('\\') && !/[\u0000-\u001f\u007f]/.test(value),
    'Display names must not contain path separators or control characters.'
  );

export const sourceSpanSchema = z
  .object({
    start: nonNegativeIntegerSchema,
    end: nonNegativeIntegerSchema,
    line: positiveIntegerSchema,
    column: positiveIntegerSchema
  })
  .strict()
  .refine((value) => value.end >= value.start, {
    message: 'Source span end must not precede start.'
  });

export const diagnosticLocationSchema = z
  .object({
    path: publicPathSchema,
    span: sourceSpanSchema.optional(),
    sectionIndex: nonNegativeIntegerSchema.optional(),
    pointIndex: nonNegativeIntegerSchema.optional(),
    field: nonEmptyStringSchema.max(80).optional()
  })
  .strict();

export const diagnosticSeveritySchema = z.enum(['error', 'warning', 'info']);
export const diagnosticStageSchema = z.enum([
  'recognize',
  'syntax',
  'range',
  'semantic',
  'resource',
  'export',
  'qr',
  'adapter',
  'task'
]);

export const diagnosticSchema = z
  .object({
    code: z.string().regex(/^PULSE_[A-Z0-9_]+$/),
    severity: diagnosticSeveritySchema,
    stage: diagnosticStageSchema,
    message: nonEmptyStringSchema.max(2000),
    location: diagnosticLocationSchema,
    suggestion: z.string().min(1).max(2000).optional(),
    parameters: z
      .record(z.string(), z.union([z.string(), finiteNumberSchema, z.boolean()]))
      .optional()
  })
  .strict();

export const evidenceSchema = z.enum([
  'official-semantics',
  'corpus-observed',
  'community-inferred',
  'unverified'
]);

export const formatSchema = z.enum(['pulse-text', 'qr-envelope', 'unsupported']);
export const operationStatusSchema = z.enum(['success', 'rejected', 'failed', 'cancelled']);

export const pulseGlobalsSchema = z
  .object({
    sectionRestIndex: safeIntegerSchema,
    playbackSpeed: safeIntegerSchema,
    frequencyBalanceIndex: safeIntegerSchema,
    raw: z.tuple([z.string(), z.string(), z.string()])
  })
  .strict();

export const fileMetadataSchema = z
  .object({
    displayName: displayNameSchema,
    byteSize: nonNegativeIntegerSchema,
    format: formatSchema,
    formatProfile: z.union([z.literal('dungeonlab-pulse-text/corpus-v1'), z.literal('unknown')]),
    ruleVersion: ruleVersionSchema,
    evidence: z.array(evidenceSchema).min(1),
    status: z.enum(['accepted', 'rejected', 'failed'])
  })
  .strict();

export const sectionMetadataSchema = z
  .object({
    sectionIndex: nonNegativeIntegerSchema,
    enabled: z.boolean(),
    frequencyStartIndex: safeIntegerSchema,
    frequencyEndIndex: safeIntegerSchema,
    frequencyMode: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    durationIndex: safeIntegerSchema,
    targetDurationMs: nonNegativeNumberSchema,
    effectiveDurationMs: nonNegativeNumberSchema,
    repetitionCount: nonNegativeIntegerSchema,
    pulseElementDurationMs: nonNegativeNumberSchema,
    pointCount: nonNegativeIntegerSchema,
    sourcePoints: z
      .array(
        z
          .object({
            controlPointIndex: nonNegativeIntegerSchema,
            strength: z.number().finite().min(0).max(100),
            strengthDecimal: nonEmptyStringSchema,
            anchor: z.union([z.literal(0), z.literal(1)])
          })
          .strict()
      )
      .superRefine((points, context) => {
        points.forEach((point, index) => {
          if (point.controlPointIndex !== index) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'controlPointIndex'],
              message: 'Source point indexes must be sequential from zero.'
            });
          }
        });
      }),
    diagnostics: z.array(diagnosticSchema)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sourcePoints.length !== value.pointCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourcePoints'],
        message: 'Source point count must match pointCount.'
      });
    }
  });

export const pulseMetadataSchema = z
  .object({
    sectionCount: nonNegativeIntegerSchema,
    enabledSectionCount: nonNegativeIntegerSchema,
    disabledSectionCount: nonNegativeIntegerSchema,
    sourceDurationMs: nonNegativeNumberSchema,
    effectiveDurationMs: nonNegativeNumberSchema,
    globals: pulseGlobalsSchema,
    diagnostics: z.array(diagnosticSchema)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.enabledSectionCount + value.disabledSectionCount !== value.sectionCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sectionCount'],
        message: 'Enabled and disabled section counts must add up to sectionCount.'
      });
    }
  });

export const streamStatsSchema = z
  .object({
    pointCount: nonNegativeIntegerSchema,
    totalDurationMs: nonNegativeNumberSchema,
    minFrequencyIndex: finiteNumberSchema.nullable(),
    maxFrequencyIndex: finiteNumberSchema.nullable(),
    minIntensity: finiteNumberSchema.nullable(),
    maxIntensity: finiteNumberSchema.nullable(),
    meanIntensity: finiteNumberSchema.nullable()
  })
  .strict();

export const streamPointSourceSchema = z
  .object({
    sectionIndex: nonNegativeIntegerSchema,
    pulseElementIndex: nonNegativeIntegerSchema,
    repetitionIndex: nonNegativeIntegerSchema,
    controlPointIndex: nonNegativeIntegerSchema,
    origin: z.enum([
      'source-anchor',
      'source-point',
      'quadratic-interpolation',
      'boundary-interpolation'
    ])
  })
  .strict();

export const waveformPointSchema = z
  .object({
    index: nonNegativeIntegerSchema,
    timeMs: nonNegativeNumberSchema,
    durationMs: nonNegativeNumberSchema,
    frequencyIndex: finiteNumberSchema,
    intensity: finiteNumberSchema,
    intensityDecimal: nonEmptyStringSchema,
    anchor: z.union([z.literal(0), z.literal(1)]),
    source: streamPointSourceSchema
  })
  .strict();

export const streamSegmentSchema = z
  .object({
    kind: z.enum(['section', 'rest']),
    sectionIndex: nonNegativeIntegerSchema.optional(),
    startMs: nonNegativeNumberSchema,
    durationMs: nonNegativeNumberSchema,
    pointStart: nonNegativeIntegerSchema,
    pointCount: nonNegativeIntegerSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'section' && value.sectionIndex === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sectionIndex'],
        message: 'Section segments must identify their section.'
      });
    }
    if (value.kind === 'rest' && value.sectionIndex !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sectionIndex'],
        message: 'Rest segments must not identify a section.'
      });
    }
  });

export const waveformStreamSchema = z
  .object({
    kind: z.literal('waveform-stream'),
    ruleVersion: ruleVersionSchema,
    points: z.array(waveformPointSchema),
    segments: z.array(streamSegmentSchema),
    totalDurationMs: nonNegativeNumberSchema,
    timeGranularityMs: nonNegativeNumberSchema,
    warnings: z.array(diagnosticSchema),
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    const epsilon = 1e-6;
    const close = (left: number, right: number): boolean => Math.abs(left - right) <= epsilon;

    let previousEnd = 0;
    value.points.forEach((point, index) => {
      if (point.index !== index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['points', index, 'index'],
          message: 'Waveform point indexes must be sequential from zero.'
        });
      }
      if (point.durationMs <= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['points', index, 'durationMs'],
          message: 'Waveform point duration must be positive.'
        });
      }
      if (index > 0 && point.timeMs < previousEnd - epsilon) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['points', index, 'timeMs'],
          message: 'Waveform point times must be monotonic and non-overlapping.'
        });
      }
      const pointEnd = point.timeMs + point.durationMs;
      if (pointEnd > value.totalDurationMs + epsilon) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['points', index],
          message: 'Waveform points must fit within totalDurationMs.'
        });
      }
      previousEnd = Math.max(previousEnd, pointEnd);
    });

    let expectedPointStart = 0;
    let expectedStartMs = 0;
    value.segments.forEach((segment, index) => {
      if (!close(segment.startMs, expectedStartMs)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments', index, 'startMs'],
          message: 'Stream segments must be contiguous in time.'
        });
      }
      if (segment.pointStart !== expectedPointStart) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments', index, 'pointStart'],
          message: 'Stream segments must cover points in order without gaps or overlaps.'
        });
      }
      if (segment.durationMs <= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments', index, 'durationMs'],
          message: 'Stream segment duration must be positive.'
        });
      }
      if (segment.pointStart + segment.pointCount > value.points.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments', index, 'pointCount'],
          message: 'Stream segment point range exceeds the point list.'
        });
      }
      if (segment.kind === 'rest' && segment.pointCount !== 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments', index, 'pointCount'],
          message: 'Rest segments must not contain waveform points.'
        });
      }
      if (segment.kind === 'section' && segment.pointCount === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments', index, 'pointCount'],
          message: 'Section segments must contain waveform points.'
        });
      }
      const segmentEnd = segment.startMs + segment.durationMs;
      if (segmentEnd > value.totalDurationMs + epsilon) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments', index],
          message: 'Stream segments must fit within totalDurationMs.'
        });
      }
      for (
        let pointIndex = segment.pointStart;
        pointIndex < segment.pointStart + segment.pointCount;
        pointIndex += 1
      ) {
        const point = value.points[pointIndex];
        if (point === undefined) continue;
        if (
          point.timeMs < segment.startMs - epsilon ||
          point.timeMs + point.durationMs > segmentEnd + epsilon
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['segments', index, 'pointCount'],
            message: 'Segment point times must fall within the segment range.'
          });
          break;
        }
      }
      expectedPointStart = Math.min(value.points.length, segment.pointStart + segment.pointCount);
      expectedStartMs = segmentEnd;
    });
    if (expectedPointStart !== value.points.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['segments'],
        message: 'Stream segments must cover every waveform point exactly once.'
      });
    }
    if (value.segments.length === 0) {
      if (value.points.length > 0 || value.totalDurationMs !== 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments'],
          message: 'A non-empty stream must contain covering segments.'
        });
      }
    } else if (!close(expectedStartMs, value.totalDurationMs)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalDurationMs'],
        message: 'Stream segment duration must equal totalDurationMs.'
      });
    }
  });

export const streamMetadataSchema = z
  .object({
    stats: streamStatsSchema,
    timeGranularityMs: nonNegativeNumberSchema,
    sectionCount: nonNegativeIntegerSchema,
    warningCount: nonNegativeIntegerSchema,
    ruleVersion: ruleVersionSchema
  })
  .strict();

export const pulseMetadataBundleSchema = z
  .object({
    file: fileMetadataSchema,
    pulse: pulseMetadataSchema,
    sections: z.array(sectionMetadataSchema),
    stream: streamMetadataSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sections.length !== value.pulse.sectionCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sections'],
        message: 'Section metadata count must equal pulse sectionCount.'
      });
    }
    if (
      value.pulse.enabledSectionCount + value.pulse.disabledSectionCount !==
      value.pulse.sectionCount
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pulse', 'sectionCount'],
        message: 'Enabled and disabled section counts must add up to sectionCount.'
      });
    }
    value.sections.forEach((section, index) => {
      if (section.sectionIndex !== index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sections', index, 'sectionIndex'],
          message: 'Section metadata indexes must be sequential from zero.'
        });
      }
    });
    const enabled = value.sections.filter((section) => section.enabled).length;
    if (enabled !== value.pulse.enabledSectionCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pulse', 'enabledSectionCount'],
        message: 'Enabled section count must match section metadata.'
      });
    }
    if (value.stream.sectionCount !== value.pulse.sectionCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stream', 'sectionCount'],
        message: 'Stream metadata section count must match pulse sectionCount.'
      });
    }
    if (value.file.ruleVersion !== value.stream.ruleVersion) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stream', 'ruleVersion'],
        message: 'File and stream metadata must use the same rule version.'
      });
    }
  });

/**
 * A pulse summary is intentionally smaller than the domain Pulse.  In
 * particular it has no source text/bytes and no source path.
 */
export const pulseSummarySchema = z
  .object({
    kind: z.literal('pulse'),
    format: z.literal('pulse-text'),
    formatProfile: z.literal('dungeonlab-pulse-text/corpus-v1'),
    ruleVersion: ruleVersionSchema,
    evidence: z.array(evidenceSchema).min(1),
    revision: nonNegativeIntegerSchema,
    globals: pulseGlobalsSchema,
    sectionCount: nonNegativeIntegerSchema,
    changeCount: nonNegativeIntegerSchema
  })
  .strict();

export const recognitionSchema = z
  .object({
    format: formatSchema,
    profile: z.union([z.literal('dungeonlab-pulse-text/corpus-v1'), z.literal('unknown')]),
    ruleVersion: ruleVersionSchema,
    evidence: z.array(evidenceSchema).min(1),
    diagnostics: z.array(diagnosticSchema)
  })
  .strict();

export const inspectDataSchema = z
  .object({
    recognition: recognitionSchema,
    pulse: pulseSummarySchema,
    metadata: pulseMetadataBundleSchema,
    stream: waveformStreamSchema.nullable(),
    sourceDigest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    const epsilon = 1e-6;
    if (
      value.pulse.sectionCount !== value.metadata.pulse.sectionCount ||
      value.pulse.sectionCount !== value.metadata.sections.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pulse', 'sectionCount'],
        message: 'Pulse summary and metadata section counts must agree.'
      });
    }
    if (
      value.recognition.ruleVersion !== value.pulse.ruleVersion ||
      value.metadata.file.ruleVersion !== value.pulse.ruleVersion
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ruleVersion'],
        message: 'Recognition, pulse and metadata rule versions must agree.'
      });
    }
    if (value.stream !== null) {
      if (
        value.stream.digest.length !== 16 ||
        value.metadata.stream.stats.pointCount !== value.stream.points.length ||
        Math.abs(value.metadata.stream.stats.totalDurationMs - value.stream.totalDurationMs) >
          1e-6 ||
        value.metadata.stream.warningCount !== value.stream.warnings.length ||
        Math.abs(value.metadata.stream.timeGranularityMs - value.stream.timeGranularityMs) >
          epsilon ||
        Math.abs(value.metadata.pulse.effectiveDurationMs - value.stream.totalDurationMs) > epsilon
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['metadata', 'stream'],
          message: 'Stream metadata statistics must match the waveform stream.'
        });
      }
      const stats = value.metadata.stream.stats;
      if (value.stream.points.length === 0) {
        if (
          stats.minFrequencyIndex !== null ||
          stats.maxFrequencyIndex !== null ||
          stats.minIntensity !== null ||
          stats.maxIntensity !== null ||
          stats.meanIntensity !== null
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['metadata', 'stream', 'stats'],
            message: 'Empty streams must use null extrema and mean statistics.'
          });
        }
      } else {
        const frequencies = value.stream.points.map((point) => point.frequencyIndex);
        const intensities = value.stream.points.map((point) => point.intensity);
        const minFrequency = Math.min(...frequencies);
        const maxFrequency = Math.max(...frequencies);
        const minIntensity = Math.min(...intensities);
        const maxIntensity = Math.max(...intensities);
        const meanIntensity = intensities.reduce((sum, item) => sum + item, 0) / intensities.length;
        if (
          stats.minFrequencyIndex === null ||
          stats.maxFrequencyIndex === null ||
          stats.minIntensity === null ||
          stats.maxIntensity === null ||
          stats.meanIntensity === null ||
          Math.abs(stats.minFrequencyIndex - minFrequency) > epsilon ||
          Math.abs(stats.maxFrequencyIndex - maxFrequency) > epsilon ||
          Math.abs(stats.minIntensity - minIntensity) > epsilon ||
          Math.abs(stats.maxIntensity - maxIntensity) > epsilon ||
          Math.abs(stats.meanIntensity - meanIntensity) > epsilon
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['metadata', 'stream', 'stats'],
            message: 'Stream statistics must match waveform point values.'
          });
        }
      }
    }
  });

export const exportDataSchema = z
  .object({
    format: z.enum(['pulse-text', 'qr-envelope']),
    displayName: displayNameSchema,
    byteSize: nonNegativeIntegerSchema,
    mode: z.enum(['canonical', 'source']),
    sourceDigest: digestSchema,
    roundTripVerified: z.boolean(),
    /** Opaque adapter handle; it is never a path or inline source content. */
    downloadId: z
      .string()
      .regex(/^[A-Za-z0-9._~-]+$/)
      .optional(),
    contentType: z
      .string()
      .regex(/^[A-Za-z0-9!#$%&*+.^_`|~-]+\/[A-Za-z0-9!#$%&*+.^_`|~-]+$/)
      .optional()
  })
  .strict();

/** A QR envelope is already an encoded representation; decoded plaintext is
 * intentionally represented by a digest/metadata descriptor instead. */
export const qrEncodeDataSchema = z
  .object({
    content: z
      .string()
      .regex(/^https:\/\/www\.dungeon-lab\.com\/app-download\.php#DGLAB-PULSE#[0-9a-fA-F]+$/)
      .max(8_000_000)
      .refine(
        (value) =>
          (value.length - 'https://www.dungeon-lab.com/app-download.php#DGLAB-PULSE#'.length) %
            2 ===
          0,
        'QR payload must contain complete hexadecimal bytes.'
      )
  })
  .strict();

export const qrDecodeDataSchema = z
  .object({
    format: z.literal('pulse-text'),
    formatProfile: z.literal('dungeonlab-pulse-text/corpus-v1'),
    ruleVersion: ruleVersionSchema,
    byteSize: nonNegativeIntegerSchema,
    digest: digestSchema,
    contentType: z.literal('text/plain'),
    downloadId: z
      .string()
      .regex(/^[A-Za-z0-9._~-]+$/)
      .optional()
  })
  .strict();

export const changeRecordSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/),
    kind: z.enum(['edit', 'interpolation', 'format-normalization', 'upgrade']),
    description: nonEmptyStringSchema.max(2000),
    path: publicPathSchema,
    before: z.union([z.string(), finiteNumberSchema, z.boolean()]).nullable(),
    after: z.union([z.string(), finiteNumberSchema, z.boolean()]).nullable(),
    affectedPointIndices: z.array(nonNegativeIntegerSchema).optional()
  })
  .strict();

/** Public edit result: change records and an opaque download handle, never
 * inline source text or bytes. */
export const editDataSchema = z
  .object({
    format: z.literal('pulse-text'),
    mode: z.literal('canonical'),
    byteSize: nonNegativeIntegerSchema,
    sourceDigest: digestSchema,
    roundTripVerified: z.boolean(),
    changeRecords: z.array(changeRecordSchema),
    downloadId: z
      .string()
      .regex(/^[A-Za-z0-9._~-]+$/)
      .optional(),
    contentType: z.literal('text/plain').optional()
  })
  .strict();

export const renderDataSchema = z
  .object({
    displayName: displayNameSchema,
    format: z.enum(['svg', 'png', 'jpg']),
    byteSize: nonNegativeIntegerSchema,
    width: positiveIntegerSchema,
    height: positiveIntegerSchema,
    streamDigest: digestSchema,
    downloadId: z
      .string()
      .regex(/^[A-Za-z0-9._~-]+$/)
      .optional(),
    contentType: z
      .string()
      .regex(/^[A-Za-z0-9!#$%&*+.^_`|~-]+\/[A-Za-z0-9!#$%&*+.^_`|~-]+$/)
      .optional()
  })
  .strict();

export const batchProgressSchema = z
  .object({
    total: nonNegativeIntegerSchema,
    completed: nonNegativeIntegerSchema,
    succeeded: nonNegativeIntegerSchema,
    rejected: nonNegativeIntegerSchema,
    failed: nonNegativeIntegerSchema,
    warningFiles: nonNegativeIntegerSchema,
    cancelled: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.completed > value.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completed'],
        message: 'Completed count must not exceed total.'
      });
    }
    if (value.succeeded + value.rejected + value.failed > value.completed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completed'],
        message: 'Outcome counts must not exceed completed count.'
      });
    }
  });

export const batchItemSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/),
    index: nonNegativeIntegerSchema,
    displayName: displayNameSchema,
    status: operationStatusSchema,
    diagnostics: z.array(diagnosticSchema),
    result: z.unknown().nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'success' && value.result === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result'],
        message: 'Successful batch items must include result data.'
      });
    }
    if (value.status !== 'success' && value.result !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result'],
        message: 'Non-successful batch items must not include result data.'
      });
    }
    if (value.status !== 'success' && value.diagnostics.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['diagnostics'],
        message: 'Non-successful batch items must include diagnostics.'
      });
    }
  });

export const batchDataSchema = z
  .object({
    total: nonNegativeIntegerSchema,
    completed: nonNegativeIntegerSchema,
    succeeded: nonNegativeIntegerSchema,
    rejected: nonNegativeIntegerSchema,
    failed: nonNegativeIntegerSchema,
    warningFiles: nonNegativeIntegerSchema,
    cancelled: z.boolean(),
    items: z.array(batchItemSchema)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.items.length !== value.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'Batch item count must equal total.'
      });
    }
    if (value.completed > value.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completed'],
        message: 'Completed count must not exceed total.'
      });
    }
    if (value.succeeded + value.rejected + value.failed > value.completed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completed'],
        message: 'Outcome counts must not exceed completed count.'
      });
    }
    const indices = new Set(value.items.map((item) => item.index));
    if (indices.size !== value.items.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'Batch item indices must be unique.'
      });
    }
    const ids = new Set(value.items.map((item) => item.id));
    if (ids.size !== value.items.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'Batch item IDs must be unique.'
      });
    }
    const succeeded = value.items.filter((item) => item.status === 'success').length;
    const rejected = value.items.filter((item) => item.status === 'rejected').length;
    const failed = value.items.filter((item) => item.status === 'failed').length;
    const cancelled = value.items.filter((item) => item.status === 'cancelled').length;
    const warningFiles = value.items.filter((item) =>
      item.diagnostics.some((diagnostic) => diagnostic.severity === 'warning')
    ).length;
    if (
      value.succeeded !== succeeded ||
      value.rejected !== rejected ||
      value.failed !== failed ||
      value.warningFiles !== warningFiles ||
      value.cancelled !== cancelled > 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'Batch outcome counts must match item statuses and diagnostics.'
      });
    }
    if (
      value.completed !== value.items.length ||
      value.completed !== value.succeeded + value.rejected + value.failed + cancelled
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completed'],
        message: 'Completed count must match the terminal batch item count.'
      });
    }
  });

/** JSON request shape shared by the batch HTTP adapter and browser clients.
 * Binary/multipart adapters normalize into this same logical shape before
 * invoking the application layer. */
export const batchInputSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/)
      .optional(),
    displayName: displayNameSchema,
    text: z.string().max(2_000_000)
  })
  .strict();

export const batchRequestSchema = z
  .object({
    items: z.array(batchInputSchema).min(1).max(100),
    concurrency: positiveIntegerSchema.max(32).optional(),
    maxTotalBytes: positiveIntegerSchema.max(20_000_000).optional()
  })
  .strict();

export const batchExportRequestSchema = batchRequestSchema
  .extend({
    items: z
      .array(
        batchInputSchema.extend({
          outputDisplayName: displayNameSchema.optional()
        })
      )
      .min(1)
      .max(100),
    mode: z.enum(['canonical', 'source']).optional()
  })
  .strict();

/** Semantic diff is deliberately a public, path-oriented projection. */
export const diffEntrySchema = z
  .object({
    path: publicPathSchema,
    before: z.union([z.string(), finiteNumberSchema, z.boolean()]).nullable(),
    after: z.union([z.string(), finiteNumberSchema, z.boolean()]).nullable()
  })
  .strict();

export const pulseDiffSchema = z
  .object({
    equal: z.boolean(),
    structural: z.array(diffEntrySchema),
    metadata: z.array(diffEntrySchema),
    stream: z.array(diffEntrySchema),
    text: z.array(diffEntrySchema)
  })
  .strict()
  .superRefine((value, context) => {
    const hasChanges =
      value.structural.length > 0 ||
      value.metadata.length > 0 ||
      value.stream.length > 0 ||
      value.text.length > 0;
    if (value.equal === hasChanges) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['equal'],
        message: 'Diff equality must be the inverse of whether any change entries exist.'
      });
    }
  });

export const diffDataSchema = z
  .object({
    beforeDigest: digestSchema,
    afterDigest: digestSchema,
    diff: pulseDiffSchema
  })
  .strict();

const operationNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9-]*$/);
const timingSchema = z
  .object({
    startedAt: finiteNumberSchema.optional(),
    durationMs: nonNegativeNumberSchema.optional()
  })
  .strict();

const envelopeCommon = {
  schemaVersion: schemaVersionSchema,
  ruleVersion: ruleVersionSchema,
  operation: operationNameSchema,
  diagnostics: z.array(diagnosticSchema),
  timing: timingSchema.optional(),
  operationId: z
    .string()
    .regex(/^[A-Za-z0-9._~-]+$/)
    .optional()
} as const;

const successfulEnvelopeSchema = z
  .object({
    ...envelopeCommon,
    status: z.literal('success'),
    result: z
      .unknown()
      .refine(
        (value) => value !== null && value !== undefined,
        'Successful results must include result data.'
      )
  })
  .strict();

const emptyEnvelopeSchema = z
  .object({
    ...envelopeCommon,
    status: z.enum(['rejected', 'failed', 'cancelled']),
    result: z.null(),
    diagnostics: z.array(diagnosticSchema).min(1)
  })
  .strict();

/** Canonical cross-transport result envelope. */
export const operationEnvelopeSchema = z.union([successfulEnvelopeSchema, emptyEnvelopeSchema]);

export type SchemaVersion = typeof SCHEMA_VERSION;
export type RuleVersion = typeof RULE_VERSION;
export type DiagnosticLocation = z.infer<typeof diagnosticLocationSchema>;
export type DiagnosticDto = z.infer<typeof diagnosticSchema>;
export type FileMetadataDto = z.infer<typeof fileMetadataSchema>;
export type SectionMetadataDto = z.infer<typeof sectionMetadataSchema>;
export type PulseMetadataDto = z.infer<typeof pulseMetadataSchema>;
export type StreamMetadataDto = z.infer<typeof streamMetadataSchema>;
export type WaveformPointDto = z.infer<typeof waveformPointSchema>;
export type WaveformStreamDto = z.infer<typeof waveformStreamSchema>;
export type PulseMetadataBundleDto = z.infer<typeof pulseMetadataBundleSchema>;
export type PulseSummaryDto = z.infer<typeof pulseSummarySchema>;
export type RecognitionDto = z.infer<typeof recognitionSchema>;
export type InspectDataDto = z.infer<typeof inspectDataSchema>;
export type ExportDataDto = z.infer<typeof exportDataSchema>;
export type QrEncodeDataDto = z.infer<typeof qrEncodeDataSchema>;
export type QrDecodeDataDto = z.infer<typeof qrDecodeDataSchema>;
export type ChangeRecordDto = z.infer<typeof changeRecordSchema>;
export type EditDataDto = z.infer<typeof editDataSchema>;
export type RenderDataDto = z.infer<typeof renderDataSchema>;
/** Descriptive aliases used by application adapters. */
export type InspectResultDto = InspectDataDto;
export type ExportResultDto = ExportDataDto;
export type BatchProgressDto = z.infer<typeof batchProgressSchema>;
export type BatchItemDto = z.infer<typeof batchItemSchema>;
export type BatchDataDto = z.infer<typeof batchDataSchema>;
export type BatchInputDto = z.infer<typeof batchInputSchema>;
export type BatchRequestDto = z.infer<typeof batchRequestSchema>;
export type BatchExportRequestDto = z.infer<typeof batchExportRequestSchema>;
export type DiffEntryDto = z.infer<typeof diffEntrySchema>;
export type PulseDiffDto = z.infer<typeof pulseDiffSchema>;
export type DiffDataDto = z.infer<typeof diffDataSchema>;
export type OperationEnvelope = z.infer<typeof operationEnvelopeSchema>;
export type OperationEnvelopeDto = OperationEnvelope;
export type OperationStatus = z.infer<typeof operationStatusSchema>;

export type ContractParseFailure = {
  readonly ok: false;
  readonly issues: readonly z.core.$ZodIssue[];
};

export type ContractParseSuccess<T> = {
  readonly ok: true;
  readonly value: T;
};

export type ContractParseResult<T> = ContractParseSuccess<T> | ContractParseFailure;

export class ContractVersionError extends Error {
  public readonly kind: 'schema' | 'rule';
  public readonly expected: string;
  public readonly received: unknown;

  public constructor(kind: 'schema' | 'rule', expected: string, received: unknown) {
    super(
      kind === 'schema'
        ? `Unsupported contract schema version; expected ${expected}.`
        : `Unsupported pulse rule version; expected ${expected}.`
    );
    this.name = 'ContractVersionError';
    this.kind = kind;
    this.expected = expected;
    this.received = received;
  }
}

function versionOf(value: unknown, key: 'schemaVersion' | 'ruleVersion'): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** Throws before schema parsing when a caller sends an unknown version. */
export function assertSupportedVersions(value: unknown): void {
  const schemaVersion = versionOf(value, 'schemaVersion');
  if (schemaVersion !== SCHEMA_VERSION) {
    throw new ContractVersionError('schema', SCHEMA_VERSION, schemaVersion);
  }
  const ruleVersion = versionOf(value, 'ruleVersion');
  if (ruleVersion !== RULE_VERSION) {
    throw new ContractVersionError('rule', RULE_VERSION, ruleVersion);
  }
}

/** Strict parser used by HTTP, CLI and Electron adapters. */
export function parseOperationEnvelope(value: unknown): OperationEnvelope {
  assertSupportedVersions(value);
  return operationEnvelopeSchema.parse(value);
}

/** Non-throwing parser for request validation and contract tests. */
export function safeParseOperationEnvelope(value: unknown): ContractParseResult<OperationEnvelope> {
  try {
    assertSupportedVersions(value);
  } catch (error) {
    if (error instanceof ContractVersionError) {
      return {
        ok: false,
        issues: Object.freeze([
          {
            code: 'custom',
            path: [error.kind === 'schema' ? 'schemaVersion' : 'ruleVersion'],
            message: error.message
          } as z.core.$ZodIssue
        ])
      };
    }
    throw error;
  }
  const parsed = operationEnvelopeSchema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issues: Object.freeze(parsed.error.issues) };
}

/**
 * Project an application result into the public envelope.  `data` is the
 * current application-layer property; it is deliberately renamed to
 * `result` at this boundary.  A caller supplies a projector for the payload,
 * so domain objects never get JSON-stringified accidentally.
 */
export function projectOperationResult<T, U>(
  input: {
    readonly operation: string;
    readonly status: OperationStatus;
    readonly data: T | null;
    readonly diagnostics: readonly unknown[];
    readonly timing?: { readonly startedAt?: number; readonly durationMs?: number };
    readonly operationId?: string;
  },
  project: (value: T) => U
): OperationEnvelope {
  const diagnostics = (Array.isArray(input.diagnostics) ? input.diagnostics : [])
    .map((item) => diagnosticSchema.safeParse(item))
    .map((parsed) =>
      parsed.success
        ? parsed.data
        : {
            code: 'PULSE_TASK_INVALID_TRANSITION',
            severity: 'error' as const,
            stage: 'task' as const,
            message: 'The operation result was invalid.',
            location: { path: '$' }
          }
    );
  const safeDiagnostics =
    diagnostics.length > 0
      ? diagnostics
      : input.status === 'success'
        ? diagnostics
        : [
            {
              code: 'PULSE_TASK_INVALID_TRANSITION',
              severity: 'error' as const,
              stage: 'task' as const,
              message: 'The operation result was invalid.',
              location: { path: '$' }
            }
          ];
  const operation =
    typeof input.operation === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(input.operation)
      ? input.operation
      : 'task';
  const common = {
    schemaVersion: SCHEMA_VERSION,
    ruleVersion: RULE_VERSION,
    operation,
    diagnostics: safeDiagnostics,
    ...(input.timing === undefined ? {} : { timing: input.timing }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId })
  };
  try {
    const result =
      input.status === 'success' && input.data !== null
        ? { ...common, status: 'success' as const, result: project(input.data as T) }
        : input.status === 'rejected' || input.status === 'failed' || input.status === 'cancelled'
          ? { ...common, status: input.status, result: null }
          : {
              ...common,
              status: 'failed' as const,
              result: null,
              diagnostics: [
                {
                  code: 'PULSE_TASK_INVALID_TRANSITION',
                  severity: 'error' as const,
                  stage: 'task' as const,
                  message: 'The operation result was invalid.',
                  location: { path: '$' }
                }
              ]
            };
    return operationEnvelopeSchema.parse(result);
  } catch {
    return operationEnvelopeSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      ruleVersion: RULE_VERSION,
      operation,
      status: 'failed',
      result: null,
      diagnostics: [
        {
          code: 'PULSE_TASK_INVALID_TRANSITION',
          severity: 'error',
          stage: 'task',
          message: 'The operation result was invalid.',
          location: { path: '$' }
        }
      ]
    });
  }
}

/**
 * Convert an application batch item from `data` to the public `result` field.
 * The payload projector is intentionally explicit for the same reason as the
 * single-result projector above.
 */
export function projectBatchItem<T, U>(
  input: {
    readonly id: string;
    readonly index: number;
    readonly displayName: string;
    readonly status: OperationStatus;
    readonly diagnostics: readonly unknown[];
    readonly data: T | null;
  },
  project: (value: T) => U
): BatchItemDto {
  const diagnostics = (Array.isArray(input.diagnostics) ? input.diagnostics : [])
    .map((item) => diagnosticSchema.safeParse(item))
    .map((parsed) =>
      parsed.success
        ? parsed.data
        : {
            code: 'PULSE_TASK_INVALID_TRANSITION' as const,
            severity: 'error' as const,
            stage: 'task' as const,
            message: 'The batch item result was invalid.',
            location: { path: '$' }
          }
    );
  const safeStatus =
    input.status === 'success' ||
    input.status === 'rejected' ||
    input.status === 'failed' ||
    input.status === 'cancelled'
      ? input.status
      : 'failed';
  const safeDiagnostics =
    diagnostics.length > 0
      ? diagnostics
      : safeStatus === 'success'
        ? diagnostics
        : [
            {
              code: 'PULSE_TASK_INVALID_TRANSITION' as const,
              severity: 'error' as const,
              stage: 'task' as const,
              message: 'The batch item result was invalid.',
              location: { path: '$' }
            }
          ];
  try {
    return batchItemSchema.parse({
      id: input.id,
      index: input.index,
      displayName: input.displayName,
      status: safeStatus,
      diagnostics: safeDiagnostics,
      result: safeStatus === 'success' && input.data !== null ? project(input.data) : null
    });
  } catch {
    return batchItemSchema.parse({
      id: 'item-invalid',
      index: 0,
      displayName: 'pulse',
      status: 'failed',
      diagnostics: [
        {
          code: 'PULSE_TASK_INVALID_TRANSITION',
          severity: 'error',
          stage: 'task',
          message: 'The batch item result was invalid.',
          location: { path: '$' }
        }
      ],
      result: null
    });
  }
}
