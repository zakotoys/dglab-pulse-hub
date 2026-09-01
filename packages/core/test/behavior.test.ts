import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULE_SET,
  DIAGNOSTIC_CODES,
  PreviewPlaybackController,
  PulseHistory,
  createPlotScene,
  diffPulse,
  expandWaveform,
  frequencyAt,
  interpolateQuadratic,
  applyReviewedQuadraticAssist,
  previewQuadraticAssist,
  normalizeDecimal,
  parseNumericLexeme,
  parsePulse,
  quadraticCurve,
  renderSvg,
  removeControlPoint,
  resolveControlPoints,
  serializePulse,
  setControlPointStrength,
  sourceSpan,
  validatePulse,
  validateSyntax
} from '../src/index.js';

const VALID = 'Dungeonlab+pulse:1,2,8=10,20,4,3,1/0.001-1,50.00-0,100-1';

describe('format and numeric matrix', () => {
  it('distinguishes legal zero, underflow, overflow, and malformed numbers', () => {
    expect(parseNumericLexeme('0')?.canonical).toBe('0');
    expect(parseNumericLexeme('0.00')?.canonical).toBe('0');
    expect(parseNumericLexeme('1e-1000')).toBeNull();
    expect(parseNumericLexeme('1e1000')).toBeNull();
    expect(parseNumericLexeme('NaN')).toBeNull();
    expect(parseNumericLexeme('Infinity')).toBeNull();
    expect(normalizeDecimal('001e+2')).toBe('100');
  });

  it('handles BOM/newline policy and rejects non-canonical separators', () => {
    const bom = parsePulse('\uFEFF' + VALID);
    expect(bom.accepted).toBe(true);
    expect(bom.diagnostics.some((item) => item.code === DIAGNOSTIC_CODES.RECOGNIZE_BOM)).toBe(true);
    expect(parsePulse('\uFEFF' + VALID, { allowBom: false }).accepted).toBe(false);
    expect(parsePulse(VALID + '\r\n').accepted).toBe(true);
    expect(parsePulse(VALID + '\r\n\r\n').accepted).toBe(false);
    const malformed = parsePulse(VALID + '+bad+0,0,0,1,1/0-1,1-1');
    expect(malformed.accepted).toBe(false);
    expect(
      malformed.diagnostics.some(
        (item) => item.code === DIAGNOSTIC_CODES.SYNTAX_INVALID_SECTION_SEPARATOR
      )
    ).toBe(true);
  });

  it('accepts the supported section ceiling while rejecting one beyond it', () => {
    const section = '0,0,0,1,1/0-1,100-1';
    const ten =
      'Dungeonlab+pulse:0,1,0=' + Array.from({ length: 10 }, () => section).join('+section+');
    const accepted = parsePulse(ten);
    expect(accepted.accepted).toBe(true);
    expect(accepted.pulse?.sections).toHaveLength(10);
    expect(
      accepted.diagnostics.some(
        (item) => item.code === DIAGNOSTIC_CODES.SEMANTIC_UNVERIFIED_SECTION_COUNT
      )
    ).toBe(true);
    const eleven = parsePulse(
      'Dungeonlab+pulse:0,1,0=' + Array.from({ length: 11 }, () => section).join('+section+')
    );
    expect(eleven.accepted).toBe(false);
    expect(
      eleven.diagnostics.some((item) => item.code === DIAGNOSTIC_CODES.RANGE_SECTION_COUNT)
    ).toBe(true);
  });
});

describe('stream rules and provenance', () => {
  it('maps all four frequency modes to deterministic endpoints', () => {
    for (const mode of [1, 2, 3, 4] as const) {
      const parsed = parsePulse(`Dungeonlab+pulse:0,1,0=10,20,0,${mode},1/0-1,50-1,100-1`);
      expect(parsed.pulse).not.toBeNull();
      if (parsed.pulse === null) continue;
      const section = parsed.pulse.sections[0]!;
      expect(frequencyAt(section, 0)).toBe(
        mode === 1 ? 10 : mode === 2 ? 20 : mode === 3 ? 10 : 20
      );
      expect(frequencyAt(section, 2)).toBe(
        mode === 1 ? 10 : mode === 2 ? 20 : mode === 3 ? 20 : 10
      );
    }
  });

  it('repeats complete pulse elements, inserts rest, and applies speed', () => {
    const parsed = parsePulse(
      'Dungeonlab+pulse:2,2,0=0,0,2,1,1/0-1,100-1+section+1,1,0,1,1/0-1,100-1'
    );
    expect(parsed.pulse).not.toBeNull();
    if (parsed.pulse === null) return;
    const expanded = expandWaveform(parsed.pulse);
    expect(expanded.stream).not.toBeNull();
    expect(expanded.sectionTiming[0]?.repetitionCount).toBe(2);
    expect(expanded.stream?.points).toHaveLength(6);
    expect(expanded.stream?.segments.map((segment) => segment.kind)).toEqual([
      'section',
      'rest',
      'section'
    ]);
    expect(expanded.stream?.totalDurationMs).toBe(400);
    const fast = expandWaveform(parsed.pulse, {}, { ...DEFAULT_RULE_SET, speedDivisor: true });
    expect(fast.stream?.timeGranularityMs).toBe(50);
  });

  it('keeps interpolation anchors and reports unverified boundaries', () => {
    const parsed = parsePulse('Dungeonlab+pulse:0,1,0=0,0,0,1,1/0-1,50-0,100-1');
    expect(parsed.pulse).not.toBeNull();
    if (parsed.pulse === null) return;
    const resolved = resolveControlPoints(parsed.pulse.sections[0]!.pulseElement.points);
    expect(resolved.points.map((point) => point.origin)).toEqual([
      'source-anchor',
      'quadratic-interpolation',
      'source-anchor'
    ]);
    expect(resolved.points[1]?.value).toBe(interpolateQuadratic(0, 100, 0.5));
    const noAnchors = parsePulse('Dungeonlab+pulse:0,1,0=0,0,0,1,1/0-0,50-0,100-0');
    expect(noAnchors.pulse).not.toBeNull();
    if (noAnchors.pulse !== null) {
      const result = resolveControlPoints(noAnchors.pulse.sections[0]!.pulseElement.points);
      expect(
        result.diagnostics.some(
          (item) => item.code === DIAGNOSTIC_CODES.SEMANTIC_INTERPOLATION_UNVERIFIED
        )
      ).toBe(true);
    }
  });
});

describe('editing, validation, and rendering', () => {
  it('edits immutably and supports history branching', () => {
    const parsed = parsePulse(VALID);
    expect(parsed.pulse).not.toBeNull();
    if (parsed.pulse === null) return;
    const history = new PulseHistory(parsed.pulse);
    const edited = setControlPointStrength(parsed.pulse, 0, 1, 40);
    expect(edited.pulse).not.toBeNull();
    history.apply(edited);
    expect(history.canUndo).toBe(true);
    expect(history.current.sections[0]!.pulseElement.points[1]!.strength).toBe(40);
    history.undo();
    expect(history.current.sections[0]!.pulseElement.points[1]!.strength).toBe(
      parsed.pulse.sections[0]!.pulseElement.points[1]!.strength
    );
    history.redo();
    expect(history.canRedo).toBe(false);
    expect(diffPulse(parsed.pulse, history.current).equal).toBe(false);
    const serialized = serializePulse(history.current, { mode: 'canonical' });
    expect(parsePulse(serialized.bytes).accepted).toBe(true);
  });

  it(
    'promotes an automatic point when its strength is edited ' +
      'so the stream keeps the user value',
    () => {
      const parsed = parsePulse('Dungeonlab+pulse:0,1,0=0,0,0,1,1/0-1,50-0,100-1');
      expect(parsed.pulse).not.toBeNull();
      if (parsed.pulse === null) return;
      const edited = setControlPointStrength(parsed.pulse, 0, 1, 40);
      expect(edited.pulse).not.toBeNull();
      if (edited.pulse === null) return;
      const point = edited.pulse.sections[0]!.pulseElement.points[1]!;
      expect(point.anchor).toBe(1);
      expect(point.strengthDecimal).toBe('40');
      const expanded = expandWaveform(edited.pulse);
      expect(expanded.stream?.points[1]?.intensityDecimal).toBe('40');
      expect(edited.changeRecords.some((record) => record.path.endsWith('.anchor'))).toBe(true);
    }
  );

  it('recomputes automatic points after removing an interior anchor', () => {
    const parsed = parsePulse('Dungeonlab+pulse:0,1,0=0,0,0,1,1/0-1,25-0,50-1,75-0,100-1');
    expect(parsed.pulse).not.toBeNull();
    if (parsed.pulse === null) return;
    const removed = removeControlPoint(parsed.pulse, 0, 2);
    expect(removed.pulse).not.toBeNull();
    if (removed.pulse === null) return;
    const points = removed.pulse.sections[0]!.pulseElement.points;
    expect(points.map((point) => point.strengthDecimal)).toEqual(['0', '56', '89', '100']);
    expect(removed.changeRecords.filter((record) => record.kind === 'interpolation')).toHaveLength(
      2
    );
    expect(
      expandWaveform(removed.pulse)
        .stream?.points.slice(0, 4)
        .map((point) => point.intensityDecimal)
    ).toEqual(['0', '56', '89', '100']);
  });

  it('projects derived pulse and section metadata in semantic diffs', () => {
    const before = parsePulse('Dungeonlab+pulse:0,1,0=0,0,0,1,1/0-1,100-1').pulse;
    const after = parsePulse('Dungeonlab+pulse:0,1,0=0,0,3,1,1/0-1,100-1').pulse;
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    if (before === null || after === null) return;
    const diff = diffPulse(before, after);
    expect(diff.metadata.some((entry) => entry.path === 'metadata.pulse.sourceDurationMs')).toBe(
      true
    );
    expect(
      diff.metadata.some((entry) => entry.path === 'metadata.sections[0].targetDurationMs')
    ).toBe(true);
    expect(diff.stream.some((entry) => entry.path === 'stream.points.length')).toBe(true);
  });

  it('requires review before applying a deterministic quadratic assist', () => {
    const parsed = parsePulse(VALID);
    expect(parsed.pulse).not.toBeNull();
    const unreviewed = applyReviewedQuadraticAssist(parsed.pulse!, {
      sectionIndex: 0,
      startPointIndex: 0,
      endPointIndex: 2,
      startStrength: 10,
      endStrength: 90,
      reviewed: false
    });
    expect(unreviewed.pulse).toBeNull();
    expect(unreviewed.diagnostics[0]?.code).toBe(DIAGNOSTIC_CODES.EDIT_NOT_REVIEWED);
    const reviewed = applyReviewedQuadraticAssist(parsed.pulse!, {
      sectionIndex: 0,
      startPointIndex: 0,
      endPointIndex: 2,
      startStrength: 10,
      endStrength: 90,
      reviewed: true
    });
    expect(reviewed.pulse).not.toBeNull();
    expect(reviewed.changeRecords.some((record) => record.kind === 'interpolation')).toBe(true);
    expect(reviewed.pulse!.sections[0]?.pulseElement.points[1]?.anchor).toBe(0);
    const unanchored = parsePulse('Dungeonlab+pulse:0,1,0=0,0,0,1,1/0-0,50-0,100-0');
    expect(unanchored.pulse).not.toBeNull();
    if (unanchored.pulse !== null) {
      const anchored = applyReviewedQuadraticAssist(unanchored.pulse, {
        sectionIndex: 0,
        startPointIndex: 0,
        endPointIndex: 2,
        startStrength: 10,
        endStrength: 90,
        reviewed: true
      });
      expect(
        anchored.changeRecords.filter((record) => record.path.endsWith('.anchor'))
      ).toHaveLength(2);
    }
  });

  it('keeps an existing interior anchor as an assist constraint', () => {
    const parsed = parsePulse('Dungeonlab+pulse:0,1,0=0,0,0,1,1/0-1,25-1,50-1,75-0,100-1');
    expect(parsed.pulse).not.toBeNull();
    if (parsed.pulse === null) return;
    const result = applyReviewedQuadraticAssist(parsed.pulse, {
      sectionIndex: 0,
      startPointIndex: 0,
      endPointIndex: 4,
      startStrength: 10,
      endStrength: 90,
      reviewed: true
    });
    expect(result.pulse).not.toBeNull();
    expect(result.pulse!.sections[0]!.pulseElement.points[2]!.anchor).toBe(1);
    expect(result.pulse!.sections[0]!.pulseElement.points[2]!.strengthDecimal).toBe('50');
  });

  it('uses interior assist anchors as piecewise interpolation constraints', () => {
    const parsed = parsePulse('Dungeonlab+pulse:0,1,0=0,0,0,1,1/0-1,20-0,40-1,80-0,100-1');
    expect(parsed.pulse).not.toBeNull();
    if (parsed.pulse === null) return;
    const result = applyReviewedQuadraticAssist(parsed.pulse, {
      sectionIndex: 0,
      startPointIndex: 0,
      endPointIndex: 4,
      startStrength: 10,
      endStrength: 90,
      reviewed: true
    });
    expect(result.pulse).not.toBeNull();
    if (result.pulse === null) return;
    const points = result.pulse.sections[0]!.pulseElement.points;
    expect(points.map((point) => point.strengthDecimal)).toEqual(['10', '33', '40', '78', '90']);
  });

  it('previews the same piecewise values that a reviewed assist applies', () => {
    const parsed = parsePulse('Dungeonlab+pulse:0,1,0=0,0,0,1,1/0-1,20-0,40-1,80-0,100-1');
    expect(parsed.pulse).not.toBeNull();
    if (parsed.pulse === null) return;
    const preview = previewQuadraticAssist(parsed.pulse.sections[0]!.pulseElement.points, {
      startPointIndex: 0,
      endPointIndex: 4,
      startStrength: 10,
      endStrength: 90
    });
    expect(preview).toEqual([10, 33, 40, 78, 90]);
    const applied = applyReviewedQuadraticAssist(parsed.pulse, {
      sectionIndex: 0,
      startPointIndex: 0,
      endPointIndex: 4,
      startStrength: 10,
      endStrength: 90,
      reviewed: true
    });
    expect(
      applied.pulse?.sections[0]?.pulseElement.points.slice(0, 5).map((point) => point.strength)
    ).toEqual(preview);
  });

  it('rejects malformed models without throwing', () => {
    const malformed = null as never;
    expect(validatePulse(malformed).valid).toBe(false);
    expect(expandWaveform(malformed).stream).toBeNull();
  });

  it('rejects malformed syntax trees without throwing', () => {
    const malformedValues = [
      null,
      {},
      { globals: null, sections: null },
      { globals: [], sections: [{}] },
      { globals: [{ value: 0 }], sections: [{ fields: [], points: null }] }
    ] as never[];
    for (const value of malformedValues) {
      expect(() => validateSyntax(value)).not.toThrow();
      const result = validateSyntax(value);
      expect(result.valid).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it('rejects inconsistent numeric tokens and invalid runtime rule timing', () => {
    const parsed = parsePulse(VALID);
    expect(parsed.syntax).not.toBeNull();
    expect(parsed.pulse).not.toBeNull();
    if (parsed.syntax === null || parsed.pulse === null) return;
    const globals = [...parsed.syntax.globals] as typeof parsed.syntax.globals;
    globals[0] = Object.freeze({
      ...globals[0],
      lexeme: '2'
    });
    const inconsistentSyntax = { ...parsed.syntax, globals } as never;
    expect(validateSyntax(inconsistentSyntax).valid).toBe(false);
    expect(
      validateSyntax(inconsistentSyntax).diagnostics.some(
        (item) => item.location.path === 'globals[0]'
      )
    ).toBe(true);

    const malformedRules = {
      ...DEFAULT_RULE_SET,
      pointDurationMs: 0,
      restUnitMs: Number.POSITIVE_INFINITY,
      speedDivisor: 'yes',
      maxExpandedPoints: Number.NaN
    } as never;
    expect(() => validateSyntax(parsed.syntax!, malformedRules)).not.toThrow();
    expect(validateSyntax(parsed.syntax!, malformedRules).valid).toBe(false);
    expect(() => validatePulse(parsed.pulse!, malformedRules)).not.toThrow();
    expect(validatePulse(parsed.pulse!, malformedRules).valid).toBe(false);
  });

  it('rejects syntactic spans that point at the wrong source layout', () => {
    const parsed = parsePulse(VALID);
    expect(parsed.syntax).not.toBeNull();
    if (parsed.syntax === null) return;
    const section = parsed.syntax.sections[0]!;
    const point = section.points[0]!;
    const shiftedSection = {
      ...parsed.syntax,
      sections: [
        {
          ...section,
          span: { ...section.span, start: section.span.start + 1, column: section.span.column + 1 }
        }
      ]
    } as never;
    expect(validateSyntax(shiftedSection).valid).toBe(false);
    const staleLocation = {
      ...parsed.syntax,
      globals: [
        {
          ...parsed.syntax.globals[0],
          span: { ...parsed.syntax.globals[0].span, line: 2, column: 1 }
        },
        parsed.syntax.globals[1],
        parsed.syntax.globals[2]
      ]
    } as never;
    expect(validateSyntax(staleLocation).valid).toBe(false);
    const shiftedPoint = {
      ...parsed.syntax,
      sections: [
        {
          ...section,
          points: [
            {
              ...point,
              span: { ...point.span, start: point.span.start + 1, column: point.span.column + 1 }
            },
            ...section.points.slice(1)
          ]
        }
      ]
    } as never;
    expect(validateSyntax(shiftedPoint).valid).toBe(false);
  });

  it('rejects missing nested model fields and mismatched raw point values', () => {
    const parsed = parsePulse(VALID);
    expect(parsed.pulse).not.toBeNull();
    if (parsed.pulse === null) return;
    const section = parsed.pulse.sections[0]!;
    const point = section.pulseElement.points[0]!;
    const malformed = {
      ...parsed.pulse,
      sections: [
        {
          ...section,
          raw: undefined,
          pulseElement: {
            ...section.pulseElement,
            points: [{ ...point, strengthRaw: '99' }]
          }
        }
      ]
    } as never;
    const result = validatePulse(malformed);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((item) => item.location.path.endsWith('.raw'))).toBe(true);
    expect(result.diagnostics.some((item) => item.location.path.endsWith('.strengthRaw'))).toBe(
      true
    );
  });

  it('enforces the source snapshot byte budget for built Pulse models', () => {
    const parsed = parsePulse(VALID);
    expect(parsed.pulse).not.toBeNull();
    if (parsed.pulse === null) return;
    const validation = validatePulse(parsed.pulse, { ...DEFAULT_RULE_SET, maxBytes: 8 });
    expect(validation.valid).toBe(false);
    expect(
      validation.diagnostics.some((item) => item.code === DIAGNOSTIC_CODES.RESOURCE_BYTES_LIMIT)
    ).toBe(true);
  });

  it('rejects a source snapshot with the wrong format identity', () => {
    const parsed = parsePulse(VALID);
    expect(parsed.pulse).not.toBeNull();
    if (parsed.pulse === null) return;
    const malformed = {
      ...parsed.pulse,
      source: { ...parsed.pulse.source, format: 'qr-envelope' }
    } as never;
    const result = validatePulse(malformed);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((item) => item.location.path === 'source')).toBe(true);
  });

  it('renders a bounded, non-empty scene and playback reaches ended', () => {
    const parsed = parsePulse(VALID);
    expect(parsed.pulse).not.toBeNull();
    if (parsed.pulse === null) return;
    const stream = expandWaveform(parsed.pulse).stream!;
    const scene = createPlotScene(stream, { width: 20_000, height: 20_000 });
    expect(scene.width * scene.height).toBeLessThanOrEqual(4_000_000);
    expect(renderSvg(stream)).toContain('<path class="intensity"');
    let now = 0;
    const scheduled: Array<() => void> = [];
    const controller = new PreviewPlaybackController(stream, {
      clock: { now: () => now },
      scheduler: {
        set: (callback) => {
          scheduled.push(callback);
          return callback;
        },
        clear: () => undefined
      }
    });
    controller.play();
    now = stream.totalDurationMs + 1;
    controller.tick();
    expect(controller.snapshot().state).toBe('ended');
    expect(scheduled.length).toBeGreaterThan(0);
    controller.dispose();
  });

  it('applies playback rate to elapsed clock time without changing stream duration', () => {
    const parsed = parsePulse(VALID);
    expect(parsed.pulse).not.toBeNull();
    if (parsed.pulse === null) return;
    const stream = expandWaveform(parsed.pulse).stream!;
    let now = 0;
    const controller = new PreviewPlaybackController(stream, {
      playbackRate: 0.2,
      clock: { now: () => now },
      scheduler: { set: (callback) => callback, clear: () => undefined }
    });
    controller.play();
    now = 500;
    controller.tick();
    expect(controller.snapshot().currentTimeMs).toBe(100);
    expect(controller.snapshot().totalDurationMs).toBe(stream.totalDurationMs);
    controller.dispose();
  });

  it('keeps playback update cadence independent from playback rate', () => {
    const parsed = parsePulse(VALID);
    expect(parsed.pulse).not.toBeNull();
    if (parsed.pulse === null) return;
    const stream = expandWaveform(parsed.pulse).stream!;
    let scheduledDelay = 0;
    const controller = new PreviewPlaybackController(stream, {
      playbackRate: 0.2,
      scheduler: {
        set: (_callback, delayMs) => {
          scheduledDelay = delayMs;
          return 0;
        },
        clear: () => undefined
      }
    });
    controller.play();
    expect(scheduledDelay).toBe(16);
    controller.dispose();
  });

  it('keeps repeated stream points mapped to one editable source point', () => {
    const parsed = parsePulse('Dungeonlab+pulse:2,1,0=0,0,5,1,1/0-1,50-0,100-1');
    expect(parsed.pulse).not.toBeNull();
    if (parsed.pulse === null) return;
    const edited = setControlPointStrength(parsed.pulse, 0, 1, 42);
    expect(edited.pulse).not.toBeNull();
    if (edited.pulse === null) return;
    expect(
      edited.pulse.sections[0]!.pulseElement.points.map((point) => point.strengthDecimal)
    ).toEqual(['0', '42', '100']);
    const repeated = expandWaveform(edited.pulse).stream!;
    expect(repeated.points.map((point) => point.source.repetitionIndex)).toEqual([
      0, 0, 0, 1, 1, 1
    ]);
    expect(
      repeated.points
        .filter((point) => point.source.controlPointIndex === 1)
        .map((point) => point.intensityDecimal)
    ).toEqual(['42', '42']);
  });

  it('renders an all-disabled pulse as a finite empty scene', () => {
    const parsed = parsePulse(
      'Dungeonlab+pulse:0,1,0=0,0,0,1,0/0-1,100-1+section+10,20,0,3,0/100-1,0-1'
    );
    expect(parsed.accepted).toBe(true);
    expect(parsed.pulse).not.toBeNull();
    if (parsed.pulse === null) return;
    const expanded = expandWaveform(parsed.pulse);
    expect(expanded.stream).not.toBeNull();
    if (expanded.stream === null) return;
    expect(expanded.stream.points).toHaveLength(0);
    expect(expanded.stream.totalDurationMs).toBe(0);
    const scene = createPlotScene(expanded.stream, { width: 160, height: 160 });
    expect(scene.points).toHaveLength(0);
    expect(
      scene.points.every((point) =>
        [point.x, point.intensityY, point.frequencyY].every(Number.isFinite)
      )
    ).toBe(true);
    const svg = renderSvg(expanded.stream, { width: 160, height: 160 });
    expect(svg).not.toMatch(/(?:NaN|Infinity)/);
    expect(svg).toContain('<path class="intensity" d=""');
  });

  it('keeps source spans stable for multiline diagnostics', () => {
    expect(sourceSpan('a\nb', 2, 3)).toEqual({ start: 2, end: 3, line: 2, column: 1 });
  });
});
