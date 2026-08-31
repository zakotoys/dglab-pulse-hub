import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULE_SET,
  DIAGNOSTIC_CODES,
  expandWaveform,
  normalizeDecimal,
  parsePulse,
  projectMetadata,
  serializePulse,
  sourceSpan
} from '../src/index.js';

const VALID = 'Dungeonlab+pulse:1,2,8=10,20,4,3,1/0.001-1,50.00-0,100-1';

describe('numeric semantics', () => {
  it('normalizes leading and trailing zeroes without moving the decimal', () => {
    expect(normalizeDecimal('000.00100')).toBe('0.001');
    expect(normalizeDecimal('00100e-2')).toBe('1');
    expect(normalizeDecimal('-0.00')).toBe('0');
  });

  it('computes source spans against the complete source text', () => {
    const result = parsePulse(VALID);
    expect(result.accepted).toBe(true);
    const point = result.pulse?.sections[0]?.pulseElement.points[0];
    const pointStart = VALID.indexOf('0.001-1');
    expect(point?.sourceSpan).toEqual(sourceSpan(VALID, pointStart, pointStart + 7));
    expect(point?.sourceSpan.start).toBeGreaterThan(VALID.indexOf('=') + 1);
  });
});

describe('syntax boundaries', () => {
  it('accepts one trailing newline but rejects additional trailing content', () => {
    expect(parsePulse(VALID + '\n').accepted).toBe(true);
    const rejected = parsePulse(VALID + '\n\n');
    expect(rejected.accepted).toBe(false);
    expect(rejected.diagnostics.some((item) => item.severity === 'error')).toBe(true);
  });

  it('does not treat an exponent plus sign as a section separator', () => {
    const result = parsePulse(
      'Dungeonlab+pulse:0,1,0=0,0,0,1,1/1e+1-1,2e+1-1'
    );
    expect(result.accepted).toBe(true);
  });
});

describe('derived stream and export', () => {
  it('keeps disabled sections in the Pulse and includes them only when requested', () => {
    const result = parsePulse(
      'Dungeonlab+pulse:1,1,0=0,0,0,1,0/0-1,100-1+section+1,2,0,1,1/0-1,100-1'
    );
    expect(result.accepted).toBe(true);
    const pulse = result.pulse;
    expect(pulse?.sections).toHaveLength(2);
    if (pulse === null) return;
    const enabledOnly = expandWaveform(pulse);
    const allSections = expandWaveform(pulse, { includeDisabled: true });
    expect(enabledOnly.stream?.segments.map((item) => item.sectionIndex)).toEqual([1]);
    expect(allSections.stream?.segments.map((item) => item.sectionIndex)).toEqual([0, undefined, 1]);
    expect(allSections.stream?.totalDurationMs).toBeGreaterThan(enabledOnly.stream?.totalDurationMs ?? 0);
    const metadata = projectMetadata(pulse, enabledOnly.stream);
    expect(metadata.sections[0]?.sourcePoints.map((point) => point.strengthDecimal)).toEqual(['0', '100']);
    expect(metadata.sections[1]?.sourcePoints.map((point) => point.strengthDecimal)).toEqual(['0', '100']);
  });

  it('round-trips source and canonical serialization', () => {
    const parsed = parsePulse(VALID);
    expect(parsed.pulse).not.toBeNull();
    if (parsed.pulse === null) return;
    const source = serializePulse(parsed.pulse, { mode: 'source' });
    expect(source.text).toBe(VALID);
    expect(source.bytes).toEqual(new TextEncoder().encode(VALID));
    expect(source.diagnostics).toEqual([]);
    const canonical = serializePulse(parsed.pulse, { mode: 'canonical' });
    expect(canonical.text).toContain('0.001-1');
    expect(canonical.diagnostics.some((item) => item.code === DIAGNOSTIC_CODES.EXPORT_ROUNDTRIP_MISMATCH)).toBe(false);
  });

  it('enforces expansion limits before allocating points', () => {
    const parsed = parsePulse(VALID);
    expect(parsed.pulse).not.toBeNull();
    if (parsed.pulse === null) return;
    const expanded = expandWaveform(parsed.pulse, {
      maxPoints: 1,
      maxDurationMs: DEFAULT_RULE_SET.maxExpandedDurationMs
    });
    expect(expanded.stream).toBeNull();
    expect(expanded.diagnostics.some((item) => item.code === DIAGNOSTIC_CODES.RESOURCE_EXPANDED_POINTS_LIMIT)).toBe(true);
  });
});
