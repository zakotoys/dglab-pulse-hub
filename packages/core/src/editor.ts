import { DIAGNOSTIC_CODES, location, makeDiagnostic, sortDiagnostics } from './diagnostics.js';
import { encodeUtf8, normalizeDecimal, stableDigest } from './numbers.js';
import {
  previewQuadraticAssist,
  resolveControlPoints,
  type QuadraticAssistOptions
} from './interpolate.js';
import { validatePulse } from './validator.js';
import {
  DEFAULT_RULE_SET,
  type ChangeRecord,
  type ControlPoint,
  type Pulse,
  type PulseSection,
  type RuleSet
} from './types.js';

export interface EditResult {
  readonly pulse: Pulse | null;
  readonly changeRecords: readonly ChangeRecord[];
  readonly diagnostics: readonly ReturnType<typeof makeDiagnostic>[];
}

export interface ReviewedQuadraticAssistOptions extends QuadraticAssistOptions {
  readonly sectionIndex: number;
  /** The caller must explicitly acknowledge the proposed curve. */
  readonly reviewed: boolean;
}

function change(
  kind: ChangeRecord['kind'],
  path: string,
  description: string,
  before: ChangeRecord['before'],
  after: ChangeRecord['after'],
  affectedPointIndices?: readonly number[]
): ChangeRecord {
  const affected = affectedPointIndices === undefined ? [] : [...affectedPointIndices];
  const id =
    kind +
    '-' +
    stableDigest(
      encodeUtf8(
        JSON.stringify({
          kind,
          path,
          before,
          after,
          affected
        })
      )
    );
  const record: {
    id: string;
    kind: ChangeRecord['kind'];
    description: string;
    path: string;
    before: ChangeRecord['before'];
    after: ChangeRecord['after'];
    affectedPointIndices?: readonly number[];
  } = {
    id,
    kind,
    description,
    path,
    before,
    after
  };
  if (affectedPointIndices !== undefined) {
    record.affectedPointIndices = Object.freeze(affected);
  }
  return Object.freeze(record);
}

function editPulse(
  pulse: Pulse,
  sections: readonly PulseSection[],
  records: readonly ChangeRecord[]
): Pulse {
  return Object.freeze({
    ...pulse,
    sections: Object.freeze(sections),
    revision: pulse.revision + 1,
    changeRecords: Object.freeze([...pulse.changeRecords, ...records])
  });
}

function invalid(
  message: string,
  path: string,
  code: string = DIAGNOSTIC_CODES.EDIT_VALUE
): EditResult {
  return Object.freeze({
    pulse: null,
    changeRecords: Object.freeze([]),
    diagnostics: Object.freeze([makeDiagnostic(code, 'error', 'semantic', message, location(path))])
  });
}

function editablePulse(pulse: Pulse, rules: RuleSet): EditResult | null {
  const validation = validatePulse(pulse, rules);
  return validation.valid
    ? null
    : Object.freeze({
        pulse: null,
        changeRecords: Object.freeze([]),
        diagnostics: sortDiagnostics(validation.diagnostics)
      });
}

function validIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function normalizedRules(value: RuleSet): RuleSet {
  return typeof value === 'object' && value !== null ? value : DEFAULT_RULE_SET;
}

function validControlPoint(value: unknown): value is ControlPoint {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ControlPoint).strength === 'number' &&
    Number.isFinite((value as ControlPoint).strength) &&
    (value as ControlPoint).strength >= 0 &&
    (value as ControlPoint).strength <= 100 &&
    typeof (value as ControlPoint).strengthDecimal === 'string' &&
    normalizeDecimal((value as ControlPoint).strengthDecimal) ===
      (value as ControlPoint).strengthDecimal &&
    typeof (value as ControlPoint).strengthRaw === 'string' &&
    ((value as ControlPoint).anchor === 0 || (value as ControlPoint).anchor === 1)
  );
}

function updatePoint(
  pulse: Pulse,
  sectionIndex: number,
  pointIndex: number,
  updater: (point: ControlPoint) => ControlPoint,
  record: ChangeRecord,
  rules: RuleSet
): EditResult {
  const section = pulse.sections[sectionIndex];
  if (section === undefined)
    return invalid(
      'Section does not exist.',
      'sections[' + sectionIndex + ']',
      DIAGNOSTIC_CODES.EDIT_PATH
    );
  const point = section.pulseElement.points[pointIndex];
  if (point === undefined)
    return invalid(
      'Control point does not exist.',
      'sections[' + sectionIndex + '].points[' + pointIndex + ']',
      DIAGNOSTIC_CODES.EDIT_PATH
    );
  const points = section.pulseElement.points.map((item, index) =>
    index === pointIndex ? updater(item) : item
  );
  const nextSection: PulseSection = Object.freeze({
    ...section,
    pulseElement: Object.freeze({
      ...section.pulseElement,
      points: Object.freeze(points)
    })
  });
  const sections = pulse.sections.map((item, index) =>
    index === sectionIndex ? nextSection : item
  );
  const next = editPulse(pulse, sections, [record]);
  const validation = validatePulse(next, rules);
  return Object.freeze({
    pulse: validation.valid ? next : null,
    changeRecords: Object.freeze([record]),
    diagnostics: sortDiagnostics(validation.diagnostics)
  });
}

function recomputeAutomaticRange(
  points: readonly ControlPoint[],
  start: number,
  end: number,
  pathPrefix = 'points'
): { readonly points: readonly ControlPoint[]; readonly records: readonly ChangeRecord[] } {
  const resolved = resolveControlPoints(points).points;
  const records: ChangeRecord[] = [];
  const lower = Math.max(0, Math.min(start, end));
  const upper = Math.min(points.length - 1, Math.max(start, end));
  const next = points.map((point, index) => {
    const value = resolved[index];
    if (
      value === undefined ||
      point.anchor === 1 ||
      index < lower ||
      index > upper ||
      normalizeDecimal(point.strengthDecimal) === normalizeDecimal(value.decimal)
    ) {
      return point;
    }
    records.push(
      change(
        'interpolation',
        pathPrefix + '[' + index + '].strength',
        'Recomputed automatic point between edited anchors.',
        point.strengthDecimal,
        value.decimal,
        [index]
      )
    );
    return Object.freeze({
      ...point,
      // The decimal lexeme is the semantic authority. Keep the numeric
      // projection aligned with the rounded derived lexeme so domain
      // validation cannot observe two different values for one point.
      strength: Number(value.decimal),
      strengthDecimal: value.decimal,
      strengthRaw: value.decimal
    });
  });
  return { points: Object.freeze(next), records: Object.freeze(records) };
}

function recomputeAroundPoint(
  points: readonly ControlPoint[],
  pointIndex: number,
  pathPrefix: string
): { readonly points: readonly ControlPoint[]; readonly records: readonly ChangeRecord[] } {
  if (points.length === 0) return { points: Object.freeze([]), records: Object.freeze([]) };
  const pivot = Math.max(0, Math.min(points.length - 1, pointIndex));
  const anchors = points
    .map((point, index) => (point.anchor === 1 ? index : -1))
    .filter((index) => index >= 0);
  const left = [...anchors].reverse().find((index) => index < pivot) ?? 0;
  const right = anchors.find((index) => index > pivot) ?? points.length - 1;
  return recomputeAutomaticRange(points, left, right, pathPrefix);
}

export function setControlPointStrength(
  pulse: Pulse,
  sectionIndex: number,
  pointIndex: number,
  strength: number,
  rules: RuleSet = DEFAULT_RULE_SET
): EditResult {
  rules = normalizedRules(rules);
  const initial = editablePulse(pulse, rules);
  if (initial !== null) return initial;
  if (!validIndex(sectionIndex) || !validIndex(pointIndex)) {
    return invalid('Section and point indexes must be non-negative safe integers.', 'sections');
  }
  if (!Number.isFinite(strength) || strength < 0 || strength > 100) {
    return invalid(
      'Strength must be between 0 and 100.',
      'sections[' + sectionIndex + '].points[' + pointIndex + '].strength'
    );
  }
  const section = pulse.sections[sectionIndex];
  const point = section?.pulseElement.points[pointIndex];
  if (section === undefined || point === undefined) {
    return invalid(
      'Control point does not exist.',
      'sections[' + sectionIndex + '].points[' + pointIndex + ']',
      DIAGNOSTIC_CODES.EDIT_PATH
    );
  }
  const decimal = normalizeDecimal(strength.toFixed(6));
  const normalizedStrength = Number(decimal);
  const primary = change(
    'edit',
    'sections[' + sectionIndex + '].points[' + pointIndex + '].strength',
    'Set control point strength.',
    point.strengthDecimal,
    decimal,
    [pointIndex]
  );
  const promoted = point.anchor === 0;
  const updatedPoint = Object.freeze({
    ...point,
    ...(promoted ? { anchor: 1 as const } : {}),
    strength: normalizedStrength,
    strengthDecimal: decimal,
    strengthRaw: decimal
  });
  let points: readonly ControlPoint[] = section.pulseElement.points.map((item, index) =>
    index === pointIndex ? updatedPoint : item
  );
  const records: ChangeRecord[] = [primary];
  if (promoted) {
    records.push(
      change(
        'edit',
        'sections[' + sectionIndex + '].points[' + pointIndex + '].anchor',
        'Promoted an automatic point to an anchor because its strength was edited.',
        point.anchor,
        1,
        [pointIndex]
      )
    );
  }
  const recomputed = recomputeAroundPoint(
    points,
    pointIndex,
    'sections[' + sectionIndex + '].points'
  );
  points = recomputed.points;
  records.push(...recomputed.records);
  const nextSection: PulseSection = Object.freeze({
    ...section,
    pulseElement: Object.freeze({ ...section.pulseElement, points: Object.freeze(points) })
  });
  const next = editPulse(
    pulse,
    pulse.sections.map((item, index) => (index === sectionIndex ? nextSection : item)),
    records
  );
  const validation = validatePulse(next, rules);
  return Object.freeze({
    pulse: validation.valid ? next : null,
    changeRecords: Object.freeze(records),
    diagnostics: sortDiagnostics(validation.diagnostics)
  });
}

/** Apply the reviewed quadratic curve to one bounded point interval. The
 * operation is intentionally explicit: an unreviewed proposal is rejected so
 * adapters cannot silently rewrite a user's waveform. */
export function applyReviewedQuadraticAssist(
  pulse: Pulse,
  options: ReviewedQuadraticAssistOptions,
  rules: RuleSet = DEFAULT_RULE_SET
): EditResult {
  rules = normalizedRules(rules);
  if (options === null || typeof options !== 'object' || options.reviewed !== true) {
    return invalid(
      'The proposed quadratic curve must be reviewed before it can be applied.',
      'reviewed',
      DIAGNOSTIC_CODES.EDIT_NOT_REVIEWED
    );
  }
  const initial = editablePulse(pulse, rules);
  if (initial !== null) return initial;
  const { sectionIndex, startPointIndex, endPointIndex, startStrength, endStrength } = options;
  if (![sectionIndex, startPointIndex, endPointIndex].every(validIndex)) {
    return invalid('Section and point indexes must be non-negative safe integers.', 'command');
  }
  if (startPointIndex >= endPointIndex) {
    return invalid('The quadratic assist requires a start point before the end point.', 'command');
  }
  if (
    ![startStrength, endStrength].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 100
    )
  ) {
    return invalid(
      'Assist endpoint strengths must be finite numbers between 0 and 100.',
      'command'
    );
  }
  const section = pulse.sections[sectionIndex];
  if (section === undefined)
    return invalid(
      'Section does not exist.',
      'sections[' + sectionIndex + ']',
      DIAGNOSTIC_CODES.EDIT_PATH
    );
  const points = section.pulseElement.points;
  if (endPointIndex >= points.length) {
    return invalid(
      'Assist endpoint is outside the point list.',
      'sections[' + sectionIndex + '].points',
      DIAGNOSTIC_CODES.EDIT_PATH
    );
  }
  const nextPoints = points.map((point, index) => {
    if (index < startPointIndex || index > endPointIndex) return point;
    // The assist owns only its two explicit endpoints. Existing interior
    // anchors remain constraints and are never silently converted to auto
    // points by a proposal.
    const endpoint = index === startPointIndex || index === endPointIndex;
    if (!endpoint && point.anchor === 1) return point;
    const strength =
      index === startPointIndex
        ? startStrength
        : index === endPointIndex
          ? endStrength
          : point.strength;
    const decimal = normalizeDecimal(strength.toFixed(6));
    return Object.freeze({
      ...point,
      ...(endpoint ? { anchor: 1 as const } : {}),
      strength: endpoint ? Number(decimal) : point.strength,
      strengthDecimal: endpoint ? decimal : point.strengthDecimal,
      strengthRaw: endpoint ? decimal : point.strengthRaw
    });
  });
  const records: ChangeRecord[] = [];
  const start = points[startPointIndex];
  const end = points[endPointIndex];
  if (start !== undefined) {
    const next = nextPoints[startPointIndex];
    if (next !== undefined) {
      if (start.strengthDecimal !== next.strengthDecimal) {
        records.push(
          change(
            'edit',
            'sections[' + sectionIndex + '].points[' + startPointIndex + '].strength',
            'Set reviewed quadratic assist start strength.',
            start.strengthDecimal,
            next.strengthDecimal,
            [startPointIndex]
          )
        );
      }
      if (start.anchor !== next.anchor) {
        records.push(
          change(
            'edit',
            'sections[' + sectionIndex + '].points[' + startPointIndex + '].anchor',
            'Set reviewed quadratic assist start anchor.',
            start.anchor,
            next.anchor,
            [startPointIndex]
          )
        );
      }
    }
  }
  if (end !== undefined) {
    const next = nextPoints[endPointIndex];
    if (next !== undefined) {
      if (end.strengthDecimal !== next.strengthDecimal) {
        records.push(
          change(
            'edit',
            'sections[' + sectionIndex + '].points[' + endPointIndex + '].strength',
            'Set reviewed quadratic assist end strength.',
            end.strengthDecimal,
            next.strengthDecimal,
            [endPointIndex]
          )
        );
      }
      if (end.anchor !== next.anchor) {
        records.push(
          change(
            'edit',
            'sections[' + sectionIndex + '].points[' + endPointIndex + '].anchor',
            'Set reviewed quadratic assist end anchor.',
            end.anchor,
            next.anchor,
            [endPointIndex]
          )
        );
      }
    }
  }
  // Assist proposals are deliberately distinct from the regular automatic
  // point resolver. The shared preview computes the same piecewise values so
  // an interior anchor cannot be bypassed by a global curve.
  const preview = previewQuadraticAssist(nextPoints, {
    startPointIndex,
    endPointIndex,
    startStrength,
    endStrength
  });
  if (preview === null) return invalid('The quadratic assist proposal is invalid.', 'command');
  const interpolated = [...nextPoints];
  for (let index = startPointIndex + 1; index < endPointIndex; index += 1) {
    const point = nextPoints[index];
    const value = preview[index - startPointIndex];
    if (point === undefined || point.anchor === 1 || value === undefined) continue;
    const decimal = normalizeDecimal(value.toFixed(6));
    if (point.strengthDecimal === decimal) continue;
    records.push(
      change(
        'interpolation',
        'sections[' + sectionIndex + '].points[' + index + '].strength',
        'Applied reviewed quadratic interpolation.',
        point.strengthDecimal,
        decimal,
        [index]
      )
    );
    interpolated[index] = Object.freeze({
      ...point,
      strength: Number(decimal),
      strengthDecimal: decimal,
      strengthRaw: decimal
    });
  }
  const nextSection: PulseSection = Object.freeze({
    ...section,
    pulseElement: Object.freeze({ ...section.pulseElement, points: Object.freeze(interpolated) })
  });
  const next = editPulse(
    pulse,
    pulse.sections.map((item, index) => (index === sectionIndex ? nextSection : item)),
    records
  );
  const validation = validatePulse(next, rules);
  return Object.freeze({
    pulse: validation.valid ? next : null,
    changeRecords: Object.freeze(records),
    diagnostics: sortDiagnostics(validation.diagnostics)
  });
}

export function setControlPointAnchor(
  pulse: Pulse,
  sectionIndex: number,
  pointIndex: number,
  anchor: 0 | 1,
  rules: RuleSet = DEFAULT_RULE_SET
): EditResult {
  rules = normalizedRules(rules);
  const initial = editablePulse(pulse, rules);
  if (initial !== null) return initial;
  if (!validIndex(sectionIndex) || !validIndex(pointIndex)) {
    return invalid('Section and point indexes must be non-negative safe integers.', 'sections');
  }
  if (anchor !== 0 && anchor !== 1) {
    return invalid(
      'Anchor must be 0 or 1.',
      'sections[' + sectionIndex + '].points[' + pointIndex + '].anchor',
      DIAGNOSTIC_CODES.EDIT_VALUE
    );
  }
  const section = pulse.sections[sectionIndex];
  const point = section?.pulseElement.points[pointIndex];
  if (section === undefined || point === undefined) {
    return invalid(
      'Control point does not exist.',
      'sections[' + sectionIndex + '].points[' + pointIndex + ']',
      DIAGNOSTIC_CODES.EDIT_PATH
    );
  }
  const record = change(
    'edit',
    'sections[' + sectionIndex + '].points[' + pointIndex + '].anchor',
    'Set control point anchor state.',
    point.anchor,
    anchor,
    [pointIndex]
  );
  const updatedPoint = Object.freeze({ ...point, anchor });
  let points: readonly ControlPoint[] = section.pulseElement.points.map((item, index) =>
    index === pointIndex ? updatedPoint : item
  );
  const records: ChangeRecord[] = [record];
  // Recompute the entire interval bounded by the nearest remaining anchors.
  // This keeps every automatic point deterministic when an anchor is added or
  // removed, including edits far from the changed point.
  const anchorIndexes = points
    .map((item, index) => (item.anchor === 1 ? index : -1))
    .filter((index) => index >= 0);
  const left = [...anchorIndexes].reverse().find((index) => index < pointIndex) ?? 0;
  const right = anchorIndexes.find((index) => index > pointIndex) ?? points.length - 1;
  const recomputed = recomputeAutomaticRange(
    points,
    left,
    right,
    'sections[' + sectionIndex + '].points'
  );
  points = recomputed.points;
  records.push(...recomputed.records);
  const nextSection: PulseSection = Object.freeze({
    ...section,
    pulseElement: Object.freeze({ ...section.pulseElement, points: Object.freeze(points) })
  });
  const next = editPulse(
    pulse,
    pulse.sections.map((item, index) => (index === sectionIndex ? nextSection : item)),
    records
  );
  const validation = validatePulse(next, rules);
  return Object.freeze({
    pulse: validation.valid ? next : null,
    changeRecords: Object.freeze(records),
    diagnostics: sortDiagnostics(validation.diagnostics)
  });
}

export function setSectionFrequency(
  pulse: Pulse,
  sectionIndex: number,
  startIndex: number,
  endIndex: number,
  rules: RuleSet = DEFAULT_RULE_SET
): EditResult {
  rules = normalizedRules(rules);
  const initial = editablePulse(pulse, rules);
  if (initial !== null) return initial;
  if (!validIndex(sectionIndex))
    return invalid('Section index must be a non-negative safe integer.', 'sections');
  const section = pulse.sections[sectionIndex];
  if (section === undefined)
    return invalid(
      'Section does not exist.',
      'sections[' + sectionIndex + ']',
      DIAGNOSTIC_CODES.EDIT_PATH
    );
  if (
    ![startIndex, endIndex].every(
      (value) => Number.isSafeInteger(value) && value >= 0 && value <= 83
    )
  ) {
    return invalid(
      'Frequency indexes must be integers between 0 and 83.',
      'sections[' + sectionIndex + '].frequency'
    );
  }
  const records = [
    change(
      'edit',
      'sections[' + sectionIndex + '].frequencyStartIndex',
      'Set frequency start index.',
      section.frequencyStartIndex,
      startIndex
    ),
    change(
      'edit',
      'sections[' + sectionIndex + '].frequencyEndIndex',
      'Set frequency end index.',
      section.frequencyEndIndex,
      endIndex
    )
  ];
  const nextSection: PulseSection = Object.freeze({
    ...section,
    frequencyStartIndex: startIndex,
    frequencyEndIndex: endIndex
  });
  const next = editPulse(
    pulse,
    pulse.sections.map((item, index) => (index === sectionIndex ? nextSection : item)),
    records
  );
  const validation = validatePulse(next, rules);
  return Object.freeze({
    pulse: validation.valid ? next : null,
    changeRecords: Object.freeze(records),
    diagnostics: validation.diagnostics
  });
}

export function setSectionDuration(
  pulse: Pulse,
  sectionIndex: number,
  durationIndex: number,
  rules: RuleSet = DEFAULT_RULE_SET
): EditResult {
  rules = normalizedRules(rules);
  const initial = editablePulse(pulse, rules);
  if (initial !== null) return initial;
  if (!validIndex(sectionIndex))
    return invalid('Section index must be a non-negative safe integer.', 'sections');
  const section = pulse.sections[sectionIndex];
  if (section === undefined)
    return invalid(
      'Section does not exist.',
      'sections[' + sectionIndex + ']',
      DIAGNOSTIC_CODES.EDIT_PATH
    );
  if (!Number.isSafeInteger(durationIndex) || durationIndex < 0 || durationIndex > 99) {
    return invalid(
      'Duration index must be an integer between 0 and 99.',
      'sections[' + sectionIndex + '].durationIndex'
    );
  }
  const record = change(
    'edit',
    'sections[' + sectionIndex + '].durationIndex',
    'Set section duration index.',
    section.durationIndex,
    durationIndex
  );
  const nextSection: PulseSection = Object.freeze({ ...section, durationIndex });
  const next = editPulse(
    pulse,
    pulse.sections.map((item, index) => (index === sectionIndex ? nextSection : item)),
    [record]
  );
  const validation = validatePulse(next, rules);
  return Object.freeze({
    pulse: validation.valid ? next : null,
    changeRecords: Object.freeze([record]),
    diagnostics: validation.diagnostics
  });
}

export function addControlPoint(
  pulse: Pulse,
  sectionIndex: number,
  point: ControlPoint,
  atIndex?: number,
  rules: RuleSet = DEFAULT_RULE_SET
): EditResult {
  rules = normalizedRules(rules);
  const initial = editablePulse(pulse, rules);
  if (initial !== null) return initial;
  if (!validIndex(sectionIndex))
    return invalid('Section index must be a non-negative safe integer.', 'sections');
  if (!validControlPoint(point)) return invalid('Control point is malformed.', 'point');
  const section = pulse.sections[sectionIndex];
  if (section === undefined)
    return invalid(
      'Section does not exist.',
      'sections[' + sectionIndex + ']',
      DIAGNOSTIC_CODES.EDIT_PATH
    );
  const index = atIndex ?? section.pulseElement.points.length;
  if (!Number.isSafeInteger(index) || index < 0 || index > section.pulseElement.points.length) {
    return invalid(
      'Insertion index is outside the point list.',
      'sections[' + sectionIndex + '].points'
    );
  }
  const points = [...section.pulseElement.points];
  points.splice(index, 0, Object.freeze({ ...point }));
  const record = change(
    'edit',
    'sections[' + sectionIndex + '].points',
    'Insert control point.',
    null,
    point.strengthDecimal,
    [index]
  );
  const recomputed = recomputeAroundPoint(points, index, 'sections[' + sectionIndex + '].points');
  const records: ChangeRecord[] = [record, ...recomputed.records];
  const nextSection: PulseSection = Object.freeze({
    ...section,
    pulseElement: Object.freeze({
      points: recomputed.points,
      durationMs: points.length * rules.pointDurationMs
    })
  });
  const next = editPulse(
    pulse,
    pulse.sections.map((item, i) => (i === sectionIndex ? nextSection : item)),
    records
  );
  const validation = validatePulse(next, rules);
  return Object.freeze({
    pulse: validation.valid ? next : null,
    changeRecords: Object.freeze(records),
    diagnostics: validation.diagnostics
  });
}

export function removeControlPoint(
  pulse: Pulse,
  sectionIndex: number,
  pointIndex: number,
  rules: RuleSet = DEFAULT_RULE_SET
): EditResult {
  rules = normalizedRules(rules);
  const initial = editablePulse(pulse, rules);
  if (initial !== null) return initial;
  if (!validIndex(sectionIndex) || !validIndex(pointIndex)) {
    return invalid('Section and point indexes must be non-negative safe integers.', 'sections');
  }
  const section = pulse.sections[sectionIndex];
  if (section === undefined)
    return invalid(
      'Section does not exist.',
      'sections[' + sectionIndex + ']',
      DIAGNOSTIC_CODES.EDIT_PATH
    );
  if (pointIndex < 0 || pointIndex >= section.pulseElement.points.length) {
    return invalid(
      'Control point does not exist.',
      'sections[' + sectionIndex + '].points[' + pointIndex + ']',
      DIAGNOSTIC_CODES.EDIT_PATH
    );
  }
  if (section.pulseElement.points.length <= 2) {
    return invalid(
      'A pulse element must retain at least two control points.',
      'sections[' + sectionIndex + '].points',
      DIAGNOSTIC_CODES.EDIT_EMPTY_POINTS
    );
  }
  const removed = section.pulseElement.points[pointIndex];
  const points = section.pulseElement.points.filter((_, index) => index !== pointIndex);
  const record = change(
    'edit',
    'sections[' + sectionIndex + '].points[' + pointIndex + ']',
    'Remove control point.',
    removed?.strengthDecimal ?? null,
    null,
    [pointIndex]
  );
  const recomputed = recomputeAroundPoint(
    points,
    Math.min(pointIndex, points.length - 1),
    'sections[' + sectionIndex + '].points'
  );
  const records: ChangeRecord[] = [record, ...recomputed.records];
  const nextSection: PulseSection = Object.freeze({
    ...section,
    pulseElement: Object.freeze({
      points: recomputed.points,
      durationMs: points.length * rules.pointDurationMs
    })
  });
  const next = editPulse(
    pulse,
    pulse.sections.map((item, i) => (i === sectionIndex ? nextSection : item)),
    records
  );
  const validation = validatePulse(next, rules);
  return Object.freeze({
    pulse: validation.valid ? next : null,
    changeRecords: Object.freeze(records),
    diagnostics: validation.diagnostics
  });
}

export class PulseHistory {
  private readonly snapshots: Pulse[] = [];
  private cursor = -1;

  public constructor(initial: Pulse) {
    this.snapshots.push(initial);
    this.cursor = 0;
  }

  public get current(): Pulse {
    return this.snapshots[this.cursor] ?? this.snapshots[0]!;
  }

  public get canUndo(): boolean {
    return this.cursor > 0;
  }

  public get canRedo(): boolean {
    return this.cursor < this.snapshots.length - 1;
  }

  public apply(result: EditResult): Pulse {
    if (result.pulse === null) return this.current;
    this.snapshots.splice(this.cursor + 1);
    this.snapshots.push(result.pulse);
    this.cursor += 1;
    return result.pulse;
  }

  public undo(): Pulse {
    if (this.canUndo) this.cursor -= 1;
    return this.current;
  }

  public redo(): Pulse {
    if (this.canRedo) this.cursor += 1;
    return this.current;
  }

  public reset(): Pulse {
    this.cursor = 0;
    return this.current;
  }
}
