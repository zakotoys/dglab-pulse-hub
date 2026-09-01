import { DIAGNOSTIC_CODES, location, makeDiagnostic } from './diagnostics.js';
import { normalizeDecimal } from './numbers.js';
import type { AnchorFlag, ControlPoint } from './types.js';

export const QUADRATIC_RULE = 'f(x)=1-(1-x)^2';

export function quadraticCurve(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  const clamped = Math.min(1, Math.max(0, x));
  return 1 - (1 - clamped) ** 2;
}

export function interpolateQuadratic(start: number, end: number, x: number): number {
  return Math.round(start + (end - start) * quadraticCurve(x));
}

function rawInterpolateQuadratic(start: number, end: number, x: number): number {
  return start + (end - start) * quadraticCurve(x);
}

/** The source values needed to preview a bounded assist interval. */
export interface QuadraticAssistPoint {
  readonly strength: number;
  readonly anchor: AnchorFlag;
}

/** Options shared by the pure assist preview and the reviewed editor command. */
export interface QuadraticAssistOptions {
  readonly startPointIndex: number;
  readonly endPointIndex: number;
  readonly startStrength: number;
  readonly endStrength: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validAssistPoint(value: unknown): value is QuadraticAssistPoint {
  return (
    isRecord(value) &&
    typeof value.strength === 'number' &&
    Number.isFinite(value.strength) &&
    value.strength >= 0 &&
    value.strength <= 100 &&
    (value.anchor === 0 || value.anchor === 1)
  );
}

function normalizedAssistStrength(value: number): number {
  return Number(normalizeDecimal(value.toFixed(6)));
}

/**
 * Calculate the values shown for a bounded quadratic assist. The selected
 * endpoints become constraints, while existing interior anchors remain
 * constraints and split the curve into independent interpolation runs.
 * `null` means the untrusted preview inputs cannot describe a valid range.
 */
export function previewQuadraticAssist(
  points: readonly QuadraticAssistPoint[],
  options: QuadraticAssistOptions
): readonly number[] | null {
  if (!Array.isArray(points) || points.length === 0 || !isRecord(options)) return null;
  if (
    !Number.isSafeInteger(options.startPointIndex) ||
    options.startPointIndex < 0 ||
    !Number.isSafeInteger(options.endPointIndex) ||
    options.endPointIndex <= options.startPointIndex ||
    options.endPointIndex >= points.length ||
    !Number.isFinite(options.startStrength) ||
    options.startStrength < 0 ||
    options.startStrength > 100 ||
    !Number.isFinite(options.endStrength) ||
    options.endStrength < 0 ||
    options.endStrength > 100
  )
    return null;
  for (let index = 0; index < points.length; index += 1) {
    if (!validAssistPoint(points[index])) return null;
  }

  const start = options.startPointIndex;
  const end = options.endPointIndex;
  const values = points.map((point) => point.strength);
  const anchors = points
    .map((point, index) =>
      index === start || index === end || (index > start && index < end && point.anchor === 1)
        ? index
        : -1
    )
    .filter((index) => index >= 0);
  values[start] = normalizedAssistStrength(options.startStrength);
  values[end] = normalizedAssistStrength(options.endStrength);

  for (let anchorCursor = 0; anchorCursor < anchors.length - 1; anchorCursor += 1) {
    const leftIndex = anchors[anchorCursor];
    const rightIndex = anchors[anchorCursor + 1];
    if (leftIndex === undefined || rightIndex === undefined || rightIndex <= leftIndex) continue;
    const leftValue = leftIndex === start ? values[start] : points[leftIndex]?.strength;
    const rightValue = rightIndex === end ? values[end] : points[rightIndex]?.strength;
    if (leftValue === undefined || rightValue === undefined) return null;
    for (let index = leftIndex + 1; index < rightIndex; index += 1) {
      const point = points[index];
      if (point === undefined || point.anchor === 1) continue;
      const x = (index - leftIndex) / (rightIndex - leftIndex);
      const rawValue = interpolateQuadratic(leftValue, rightValue, x);
      values[index] = normalizedAssistStrength(Math.min(100, Math.max(0, rawValue)));
    }
  }
  return Object.freeze(values.slice(start, end + 1));
}

function numberToDecimal(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return normalizeDecimal(value.toFixed(6));
}

export interface ResolvedControlPoint {
  readonly value: number;
  readonly decimal: string;
  readonly origin:
    'source-anchor' | 'source-point' | 'quadratic-interpolation' | 'boundary-interpolation';
}

/**
 * Resolve automatic control points without mutating the source Pulse. Explicit
 * anchors are never overwritten. Missing anchors at either boundary use the
 * boundary source value and are marked separately for the UI.
 */
export function resolveControlPoints(points: readonly ControlPoint[]): {
  readonly points: readonly ResolvedControlPoint[];
  readonly diagnostics: readonly ReturnType<typeof makeDiagnostic>[];
} {
  const diagnostics: ReturnType<typeof makeDiagnostic>[] = [];
  if (!Array.isArray(points)) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
        'error',
        'semantic',
        'Control points must be an array.',
        location('points')
      )
    );
    return { points: Object.freeze([]), diagnostics: Object.freeze(diagnostics) };
  }
  if (points.length === 0) return { points: Object.freeze([]), diagnostics };
  const anchors = points
    .map((point, index) => (isRecord(point) && point.anchor === 1 ? index : -1))
    .filter((index) => index >= 0);
  const resolved: ResolvedControlPoint[] = [];
  let clippedReported = false;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined) continue;
    if (
      !isRecord(point) ||
      typeof point.strength !== 'number' ||
      !Number.isFinite(point.strength) ||
      typeof point.strengthDecimal !== 'string' ||
      (point.anchor !== 0 && point.anchor !== 1)
    ) {
      diagnostics.push(
        makeDiagnostic(
          DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
          'error',
          'semantic',
          'Control point is malformed.',
          location('points[' + index + ']', undefined, { pointIndex: index })
        )
      );
      resolved.push({ value: 0, decimal: '0', origin: 'boundary-interpolation' });
      continue;
    }
    if (point.anchor === 1) {
      resolved.push({
        value: point.strength,
        decimal: point.strengthDecimal,
        origin: 'source-anchor'
      });
      continue;
    }
    // A two-point element has no interior automatic sample. Preserve those
    // supplied endpoints as source points so provenance does not claim an
    // interpolation that never occurred.
    if (points.length === 2 && (index === 0 || index === points.length - 1)) {
      resolved.push({
        value: point.strength,
        decimal: point.strengthDecimal,
        origin: 'source-point'
      });
      continue;
    }
    const leftAnchor = [...anchors].reverse().find((anchor) => anchor < index);
    const rightAnchor = anchors.find((anchor) => anchor > index);
    const leftIndex = leftAnchor ?? 0;
    const rightIndex = rightAnchor ?? points.length - 1;
    const leftPoint = points[leftIndex];
    const rightPoint = points[rightIndex];
    if (
      leftPoint === undefined ||
      rightPoint === undefined ||
      !isRecord(leftPoint) ||
      !isRecord(rightPoint) ||
      typeof leftPoint.strength !== 'number' ||
      typeof rightPoint.strength !== 'number' ||
      !Number.isFinite(leftPoint.strength) ||
      !Number.isFinite(rightPoint.strength) ||
      rightIndex <= leftIndex
    ) {
      resolved.push({
        value: point.strength,
        decimal: point.strengthDecimal,
        origin: 'boundary-interpolation'
      });
      continue;
    }
    const x = (index - leftIndex) / (rightIndex - leftIndex);
    const rawValue = rawInterpolateQuadratic(leftPoint.strength, rightPoint.strength, x);
    const roundedValue = Math.round(rawValue);
    const value = Math.min(100, Math.max(0, roundedValue));
    if (value !== roundedValue && !clippedReported) {
      diagnostics.push(
        makeDiagnostic(
          DIAGNOSTIC_CODES.SEMANTIC_INTERPOLATION_CLIPPED,
          'warning',
          'semantic',
          'An interpolated intensity was clipped to the supported range.',
          location('points[' + index + '].strength', undefined, { pointIndex: index }),
          { parameters: { value: rawValue, min: 0, max: 100 } }
        )
      );
      clippedReported = true;
    }
    const origin =
      leftAnchor === undefined || rightAnchor === undefined
        ? 'boundary-interpolation'
        : 'quadratic-interpolation';
    const decimal = numberToDecimal(value);
    resolved.push({
      value,
      decimal,
      origin
    });
  }
  if (anchors.length === 0 && points.length > 2) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.SEMANTIC_INTERPOLATION_UNVERIFIED,
        'warning',
        'semantic',
        'No explicit anchors were present; boundary values were used for automatic points.',
        location('points'),
        { suggestion: 'Add anchor points if exact intermediate values are required.' }
      )
    );
  }
  return {
    points: Object.freeze(resolved),
    diagnostics: Object.freeze(diagnostics)
  };
}

export function resolvedAnchorFlag(origin: ResolvedControlPoint['origin']): AnchorFlag {
  return origin === 'source-anchor' ? 1 : 0;
}
