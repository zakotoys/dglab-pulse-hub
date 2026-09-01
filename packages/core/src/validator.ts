import {
  DIAGNOSTIC_CODES,
  hasBlockingErrors,
  location,
  makeDiagnostic,
  sortDiagnostics
} from './diagnostics.js';
import {
  cloneBytes,
  decodeUtf8,
  isSafeIntegerNumber,
  normalizeDecimal,
  parseNumericLexeme,
  sourceSpan,
  stableDigest,
  trailingNewline
} from './numbers.js';
import {
  DEFAULT_RULE_SET,
  FORMAT_PROFILE,
  PULSE_PREFIX,
  RULE_VERSION,
  type ControlPoint,
  type Diagnostic,
  type NumericToken,
  type Pulse,
  type PulseSection,
  type RuleSet,
  type SourceSpan,
  type SyntacticPulse,
  type ValidationResult
} from './types.js';

type MadeDiagnostic = ReturnType<typeof makeDiagnostic>;

function integerDiagnostic(
  token: NumericToken,
  path: string,
  field: string,
  extra: { readonly sectionIndex?: number; readonly pointIndex?: number } = {}
): MadeDiagnostic | null {
  if (!isSafeIntegerNumber(token.value) || !/^-?\d+$/.test(token.canonical)) {
    return makeDiagnostic(
      DIAGNOSTIC_CODES.RANGE_INTEGER_REQUIRED,
      'error',
      'range',
      'Field must be a safe integer.',
      location(path, token.span, { field, ...extra }),
      { suggestion: 'Use a whole decimal number in the supported range.' }
    );
  }
  return null;
}

function rangeDiagnostic(
  token: NumericToken,
  path: string,
  code: string,
  min: number,
  max: number,
  field: string,
  extra: { readonly sectionIndex?: number; readonly pointIndex?: number } = {}
): MadeDiagnostic | null {
  if (!Number.isFinite(token.value) || token.value < min || token.value > max) {
    return makeDiagnostic(
      code,
      'error',
      'range',
      field + ' is outside the supported range.',
      location(path, token.span, { field, ...extra }),
      {
        suggestion: 'Choose a value between ' + min + ' and ' + max + '.',
        parameters: { min, max, actual: token.value }
      }
    );
  }
  return null;
}

function validateIntegerField(
  token: NumericToken,
  path: string,
  code: string,
  min: number,
  max: number,
  field: string,
  extra: { readonly sectionIndex?: number; readonly pointIndex?: number } = {},
  diagnostics: MadeDiagnostic[]
): void {
  const integer = integerDiagnostic(token, path, field, extra);
  if (integer !== null) {
    diagnostics.push(integer);
    return;
  }
  const range = rangeDiagnostic(token, path, code, min, max, field, extra);
  if (range !== null) diagnostics.push(range);
}

function validRuleLimit(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function validRuleDuration(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function ruleParameter(value: unknown): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  return String(value);
}

function validateRuleSet(value: unknown, diagnostics: MadeDiagnostic[]): RuleSet {
  if (!isRecord(value)) {
    diagnostics.push(
      modelDiagnostic(
        DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
        'Rule set must be an object.',
        'rules'
      )
    );
    return DEFAULT_RULE_SET;
  }
  let valid = true;
  if (value.id !== RULE_VERSION) {
    valid = false;
    diagnostics.push(
      modelDiagnostic(
        DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
        'Rule set id is not supported.',
        'rules.id'
      )
    );
  }
  const durationFields: readonly (keyof RuleSet)[] = [
    'pointDurationMs',
    'restUnitMs',
    'durationUnitMs',
    'maxExpandedDurationMs'
  ];
  durationFields.forEach((field) => {
    if (!validRuleDuration(value[field])) {
      valid = false;
      diagnostics.push(
        makeDiagnostic(
          DIAGNOSTIC_CODES.RESOURCE_DURATION_LIMIT,
          'error',
          'resource',
          'Rule field ' + field + ' must be a finite positive duration.',
          location('rules.' + field),
          { parameters: { value: ruleParameter(value[field]) } }
        )
      );
    }
  });
  if (typeof value.speedDivisor !== 'boolean') {
    valid = false;
    diagnostics.push(
      modelDiagnostic(
        DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
        'Rule field speedDivisor must be boolean.',
        'rules.speedDivisor'
      )
    );
  }
  if (!validRuleLimit(value.maxBytes)) {
    valid = false;
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.RESOURCE_BYTES_LIMIT,
        'error',
        'resource',
        'Rule field maxBytes must be a positive safe integer.',
        location('rules.maxBytes'),
        { parameters: { value: ruleParameter(value.maxBytes) } }
      )
    );
  }
  const pointLimits: readonly (keyof RuleSet)[] = [
    'maxSections',
    'maxPointsPerSection',
    'maxTotalControlPoints',
    'maxExpandedPoints'
  ];
  pointLimits.forEach((field) => {
    if (!validRuleLimit(value[field])) {
      valid = false;
      diagnostics.push(
        makeDiagnostic(
          DIAGNOSTIC_CODES.RESOURCE_POINTS_LIMIT,
          'error',
          'resource',
          'Rule field ' + field + ' must be a positive safe integer.',
          location('rules.' + field),
          { parameters: { value: ruleParameter(value[field]) } }
        )
      );
    }
  });
  return valid ? (value as unknown as RuleSet) : DEFAULT_RULE_SET;
}

function isCompleteRuleSet(value: unknown): value is RuleSet {
  return (
    isRecord(value) &&
    value.id === RULE_VERSION &&
    validRuleDuration(value.pointDurationMs) &&
    validRuleDuration(value.restUnitMs) &&
    validRuleDuration(value.durationUnitMs) &&
    typeof value.speedDivisor === 'boolean' &&
    validRuleLimit(value.maxBytes) &&
    validRuleLimit(value.maxSections) &&
    validRuleLimit(value.maxPointsPerSection) &&
    validRuleLimit(value.maxTotalControlPoints) &&
    validRuleLimit(value.maxExpandedPoints) &&
    validRuleDuration(value.maxExpandedDurationMs)
  );
}

function isNumericToken(value: unknown): value is NumericToken {
  if (
    !isRecord(value) ||
    typeof value.lexeme !== 'string' ||
    typeof value.value !== 'number' ||
    !Number.isFinite(value.value) ||
    typeof value.canonical !== 'string' ||
    !validSpan(value.span)
  )
    return false;
  const parsed = parseNumericLexeme(value.lexeme);
  return (
    parsed !== null &&
    parsed.value === value.value &&
    parsed.canonical === value.canonical &&
    value.span.end - value.span.start === value.lexeme.length
  );
}

function spanContainsText(value: unknown, text: string, expected: string): boolean {
  if (!validSpan(value) || value.end > text.length) return false;
  const expectedSpan = sourceSpan(text, value.start, value.end);
  return (
    value.line === expectedSpan.line &&
    value.column === expectedSpan.column &&
    text.slice(value.start, value.end) === expected
  );
}

function spanMatches(value: unknown, text: string, start: number, end: number): boolean {
  if (!validSpan(value) || start < 0 || end < start || end > text.length) return false;
  const expected = sourceSpan(text, start, end);
  return (
    value.start === expected.start &&
    value.end === expected.end &&
    value.line === expected.line &&
    value.column === expected.column
  );
}

function tokenSequenceMatches(
  tokens: readonly NumericToken[],
  text: string,
  start: number,
  separator: string
): boolean {
  let cursor = start;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      token === undefined ||
      !spanMatches(token.span, text, cursor, cursor + token.lexeme.length) ||
      text.slice(cursor, cursor + token.lexeme.length) !== token.lexeme
    ) {
      return false;
    }
    cursor += token.lexeme.length;
    if (index < tokens.length - 1) {
      if (text.slice(cursor, cursor + separator.length) !== separator) return false;
      cursor += separator.length;
    }
  }
  return true;
}

function pointSpanMatches(
  point: SyntacticPulse['sections'][number]['points'][number],
  text: string,
  start: number
): boolean {
  const strength = point.strength;
  const anchor = point.anchor;
  const strengthEnd = start + strength.lexeme.length;
  const anchorStart = strengthEnd + 1;
  const anchorEnd = anchorStart + anchor.lexeme.length;
  return (
    spanMatches(strength.span, text, start, strengthEnd) &&
    text.slice(strengthEnd, anchorStart) === '-' &&
    spanMatches(anchor.span, text, anchorStart, anchorEnd) &&
    spanMatches(point.span, text, start, anchorEnd) &&
    text.slice(start, anchorEnd) === strength.lexeme + '-' + anchor.lexeme
  );
}

function invalidSyntaxDiagnostic(path: string, message: string): MadeDiagnostic {
  return makeDiagnostic(
    DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
    'error',
    'semantic',
    message,
    location(path)
  );
}

/** Validate the tokenized syntax tree without constructing an editable model. */
export function validateSyntax(
  syntax: SyntacticPulse,
  rules: RuleSet = DEFAULT_RULE_SET
): ValidationResult {
  const diagnostics: MadeDiagnostic[] = [];
  // Adapters can call this boundary with runtime values. Diagnose a malformed
  // rules object instead of dereferencing it before validation starts.
  const effectiveRules = validateRuleSet(rules, diagnostics);

  // This is a public boundary and can receive values produced by an adapter
  // at runtime, not only values produced by our parser. Validate the tree
  // shape before dereferencing nested tokens so malformed input is rejected
  // as a diagnostic rather than escaping as a TypeError.
  if (!isRecord(syntax)) {
    diagnostics.push(invalidSyntaxDiagnostic('$', 'Syntactic pulse must be an object.'));
    return Object.freeze({ valid: false, diagnostics: sortDiagnostics(diagnostics) });
  }

  if (syntax.kind !== 'syntactic-pulse') {
    diagnostics.push(invalidSyntaxDiagnostic('kind', 'Syntactic pulse kind is invalid.'));
  }
  const source = syntax.source;
  const sourceShapeValid =
    isRecord(source) &&
    typeof source.text === 'string' &&
    source.bytes instanceof Uint8Array &&
    Number.isSafeInteger(source.byteLength) &&
    source.byteLength >= 0 &&
    source.byteLength === source.bytes.byteLength &&
    typeof source.digest === 'string' &&
    source.digest.length > 0 &&
    typeof source.hadBom === 'boolean' &&
    (source.trailingNewline === '' ||
      source.trailingNewline === '\n' ||
      source.trailingNewline === '\r\n');
  if (!sourceShapeValid) {
    diagnostics.push(
      invalidSyntaxDiagnostic('source', 'Syntactic pulse source document is malformed.')
    );
  } else {
    const decoded = decodeUtf8(source.bytes);
    const decodedText = decoded.text;
    const normalizedText = decodedText?.startsWith('\uFEFF') ? decodedText.slice(1) : decodedText;
    const hasBom = decodedText?.startsWith('\uFEFF') === true;
    if (
      normalizedText === null ||
      normalizedText !== source.text ||
      stableDigest(source.bytes) !== source.digest ||
      source.hadBom !== hasBom ||
      source.trailingNewline !== trailingNewline(source.text)
    ) {
      diagnostics.push(
        invalidSyntaxDiagnostic('source', 'Syntactic pulse source document is inconsistent.')
      );
    }
  }
  const sourceText = sourceShapeValid ? source.text : null;
  const contentEnd =
    sourceText === null ? null : sourceText.length - trailingNewline(sourceText).length;
  if (
    !validSpan(syntax.span) ||
    (sourceText !== null && !spanMatches(syntax.span, sourceText, 0, contentEnd ?? 0))
  ) {
    diagnostics.push(invalidSyntaxDiagnostic('span', 'Syntactic pulse span is invalid.'));
  }

  const rawGlobals = syntax.globals;
  const globals = Array.isArray(rawGlobals) ? rawGlobals : [];
  if (!Array.isArray(rawGlobals) || rawGlobals.length !== 3) {
    diagnostics.push(
      invalidSyntaxDiagnostic(
        'globals',
        'Syntactic pulse must contain exactly three global fields.'
      )
    );
  }
  const globalChecks: readonly [string, string, number, number, string][] = [
    ['globals[0]', DIAGNOSTIC_CODES.RANGE_GLOBAL_REST, 0, 100, 'sectionRestIndex'],
    ['globals[1]', DIAGNOSTIC_CODES.RANGE_GLOBAL_SPEED, 1, 4, 'playbackSpeed'],
    ['globals[2]', DIAGNOSTIC_CODES.RANGE_GLOBAL_BALANCE, 0, 100, 'frequencyBalanceIndex']
  ];
  for (const [path, code, min, max, field] of globalChecks) {
    const value = globals[Number(path.slice(path.indexOf('[') + 1, -1))];
    if (
      !isNumericToken(value) ||
      (sourceText !== null && !spanContainsText(value.span, sourceText, value.lexeme))
    ) {
      diagnostics.push(invalidSyntaxDiagnostic(path, 'Global field token is malformed.'));
      continue;
    }
    validateIntegerField(value, path, code, min, max, field, {}, diagnostics);
  }

  // A token span is provenance, not merely a hint.  Require the global tokens
  // to occupy the exact prefix/global/equals layout emitted by the parser so a
  // caller cannot move a valid token to an unrelated occurrence in the source.
  let nextSectionStart: number | null = null;
  if (sourceText !== null && globals.length === 3 && globals.every(isNumericToken)) {
    const globalTokens = globals as readonly NumericToken[];
    const globalLayoutValid =
      sourceText.startsWith(PULSE_PREFIX) &&
      tokenSequenceMatches(globalTokens, sourceText, PULSE_PREFIX.length, ',') &&
      sourceText.slice(globalTokens[2]!.span.end, globalTokens[2]!.span.end + 1) === '=';
    if (!globalLayoutValid) {
      diagnostics.push(
        invalidSyntaxDiagnostic('globals', 'Global token spans do not match the source layout.')
      );
    } else {
      nextSectionStart = globalTokens[2]!.span.end + 1;
    }
  }

  const maxSections = validRuleLimit(effectiveRules.maxSections)
    ? effectiveRules.maxSections
    : DEFAULT_RULE_SET.maxSections;
  const rawSections = syntax.sections;
  const sections = Array.isArray(rawSections) ? rawSections : [];
  if (!Array.isArray(rawSections)) {
    diagnostics.push(
      invalidSyntaxDiagnostic('sections', 'Syntactic pulse sections must be an array.')
    );
  }
  if (sections.length < 1 || sections.length > maxSections) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.RANGE_SECTION_COUNT,
        'error',
        'range',
        'Pulse must contain between 1 and ' + maxSections + ' sections.',
        location('sections'),
        {
          suggestion: 'Remove extra sections or split the input into separate files.',
          parameters: { min: 1, max: maxSections, actual: sections.length }
        }
      )
    );
  } else if (sections.length > 3) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.SEMANTIC_UNVERIFIED_SECTION_COUNT,
        'warning',
        'semantic',
        'More than three sections are parse-supported but App interoperability is not verified.',
        location('sections'),
        { suggestion: 'Verify this file in the target App before sharing it.' }
      )
    );
  }

  const maxPointsPerSection = validRuleLimit(effectiveRules.maxPointsPerSection)
    ? effectiveRules.maxPointsPerSection
    : DEFAULT_RULE_SET.maxPointsPerSection;
  const maxTotalPoints = validRuleLimit(effectiveRules.maxTotalControlPoints)
    ? effectiveRules.maxTotalControlPoints
    : DEFAULT_RULE_SET.maxTotalControlPoints;
  let totalPoints = 0;
  sections.forEach((rawSection, sectionIndex) => {
    const sectionPath = 'sections[' + sectionIndex + ']';
    if (!isRecord(rawSection)) {
      diagnostics.push(
        invalidSyntaxDiagnostic(sectionPath, 'Syntactic section must be an object.')
      );
      return;
    }
    const rawFields = rawSection.fields;
    const fields = Array.isArray(rawFields) ? rawFields : [];
    if (
      !Array.isArray(rawFields) ||
      fields.length !== 5 ||
      !fields.every(
        (field) =>
          isNumericToken(field) &&
          (sourceText === null || spanContainsText(field.span, sourceText, field.lexeme))
      )
    ) {
      diagnostics.push(
        invalidSyntaxDiagnostic(
          sectionPath + '.fields',
          'Syntactic section must contain five valid field tokens.'
        )
      );
      return;
    }
    const fieldTokens = fields as unknown as readonly [
      NumericToken,
      NumericToken,
      NumericToken,
      NumericToken,
      NumericToken
    ];
    const rawPoints = rawSection.points;
    if (!Array.isArray(rawPoints)) {
      diagnostics.push(
        invalidSyntaxDiagnostic(
          sectionPath + '.points',
          'Syntactic section points must be an array.'
        )
      );
      return;
    }
    const points = rawPoints;
    let sectionLayoutValid = true;
    const sectionStart = fieldTokens[0]!.span.start;
    if (sourceText !== null) {
      sectionLayoutValid = tokenSequenceMatches(fieldTokens, sourceText, sectionStart, ',');
      const slashStart = fieldTokens[4]!.span.end;
      if (sourceText.slice(slashStart, slashStart + 1) !== '/') sectionLayoutValid = false;
      let pointCursor = slashStart + 1;
      for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
        const rawPoint = points[pointIndex];
        if (
          !isRecord(rawPoint) ||
          !isNumericToken(rawPoint.strength) ||
          !isNumericToken(rawPoint.anchor) ||
          !pointSpanMatches(
            rawPoint as unknown as SyntacticPulse['sections'][number]['points'][number],
            sourceText,
            pointCursor
          )
        ) {
          sectionLayoutValid = false;
          continue;
        }
        const typedPoint =
          rawPoint as unknown as SyntacticPulse['sections'][number]['points'][number];
        pointCursor = typedPoint.span.end;
        if (pointIndex < points.length - 1) {
          if (sourceText.slice(pointCursor, pointCursor + 1) !== ',') sectionLayoutValid = false;
          pointCursor += 1;
        }
      }
      const lastPoint = points[points.length - 1];
      const sectionEnd =
        points.length > 0 && isRecord(lastPoint) && validSpan(lastPoint.span)
          ? (lastPoint.span as SourceSpan).end
          : slashStart + 1;
      if (!spanMatches(rawSection.span, sourceText, sectionStart, sectionEnd))
        sectionLayoutValid = false;
      if (nextSectionStart !== null && sectionStart !== nextSectionStart)
        sectionLayoutValid = false;
      if (sectionIndex === sections.length - 1) {
        if (contentEnd !== null && sectionEnd !== contentEnd) sectionLayoutValid = false;
      } else {
        if (sourceText.slice(sectionEnd, sectionEnd + '+section+'.length) !== '+section+')
          sectionLayoutValid = false;
        nextSectionStart = sectionEnd + '+section+'.length;
      }
    } else if (!validSpan(rawSection.span)) {
      sectionLayoutValid = false;
    }
    if (!sectionLayoutValid) {
      diagnostics.push(
        invalidSyntaxDiagnostic(
          sectionPath + '.span',
          'Syntactic section span or token layout is invalid.'
        )
      );
    }
    const fieldChecks: readonly [NumericToken, string, string, number, number, string][] = [
      [
        fieldTokens[0],
        sectionPath + '.frequencyStartIndex',
        DIAGNOSTIC_CODES.RANGE_FREQUENCY_INDEX,
        0,
        83,
        'frequencyStartIndex'
      ],
      [
        fieldTokens[1],
        sectionPath + '.frequencyEndIndex',
        DIAGNOSTIC_CODES.RANGE_FREQUENCY_INDEX,
        0,
        83,
        'frequencyEndIndex'
      ],
      [
        fieldTokens[2],
        sectionPath + '.durationIndex',
        DIAGNOSTIC_CODES.RANGE_DURATION_INDEX,
        0,
        99,
        'durationIndex'
      ],
      [
        fieldTokens[3],
        sectionPath + '.frequencyMode',
        DIAGNOSTIC_CODES.RANGE_FREQUENCY_MODE,
        1,
        4,
        'frequencyMode'
      ],
      [
        fieldTokens[4],
        sectionPath + '.enabled',
        DIAGNOSTIC_CODES.RANGE_ENABLED_FLAG,
        0,
        1,
        'enabled'
      ]
    ];
    for (const [value, path, code, min, max, field] of fieldChecks) {
      validateIntegerField(value, path, code, min, max, field, { sectionIndex }, diagnostics);
    }
    if (points.length < 2) {
      diagnostics.push(
        makeDiagnostic(
          DIAGNOSTIC_CODES.SEMANTIC_TOO_FEW_POINTS,
          'error',
          'semantic',
          'Each pulse element must contain at least two control points.',
          location(
            sectionPath + '.points',
            validSpan(rawSection.span) ? rawSection.span : undefined,
            { sectionIndex }
          )
        )
      );
    }
    if (points.length > maxPointsPerSection) {
      diagnostics.push(
        makeDiagnostic(
          DIAGNOSTIC_CODES.RESOURCE_POINTS_LIMIT,
          'error',
          'resource',
          'Section control point count exceeds the configured limit.',
          location(
            sectionPath + '.points',
            validSpan(rawSection.span) ? rawSection.span : undefined,
            { sectionIndex }
          ),
          { parameters: { maxPointsPerSection, actual: points.length } }
        )
      );
    }
    totalPoints += points.length;
    points.forEach((rawPoint, pointIndex) => {
      const pointPath = sectionPath + '.points[' + pointIndex + ']';
      if (
        !isRecord(rawPoint) ||
        !isNumericToken(rawPoint.strength) ||
        !isNumericToken(rawPoint.anchor) ||
        (sourceText !== null &&
          (!spanContainsText(rawPoint.strength.span, sourceText, rawPoint.strength.lexeme) ||
            !spanContainsText(rawPoint.anchor.span, sourceText, rawPoint.anchor.lexeme)))
      ) {
        diagnostics.push(
          invalidSyntaxDiagnostic(pointPath, 'Syntactic control point tokens are malformed.')
        );
        return;
      }
      const pointSpan = rawPoint.span;
      if (
        !validSpan(pointSpan) ||
        (sourceText !== null &&
          !spanContainsText(
            pointSpan,
            sourceText,
            rawPoint.strength.lexeme + '-' + rawPoint.anchor.lexeme
          ))
      ) {
        diagnostics.push(
          invalidSyntaxDiagnostic(pointPath + '.span', 'Syntactic control point span is invalid.')
        );
      }
      const point = rawPoint as {
        readonly strength: NumericToken;
        readonly anchor: NumericToken;
      };
      const strength = rangeDiagnostic(
        point.strength,
        pointPath + '.strength',
        DIAGNOSTIC_CODES.RANGE_INTENSITY,
        0,
        100,
        'strength',
        { sectionIndex, pointIndex }
      );
      if (strength !== null) diagnostics.push(strength);
      validateIntegerField(
        point.anchor,
        pointPath + '.anchor',
        DIAGNOSTIC_CODES.RANGE_ANCHOR_FLAG,
        0,
        1,
        'anchor',
        { sectionIndex, pointIndex },
        diagnostics
      );
    });
  });
  if (totalPoints > maxTotalPoints) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.RESOURCE_POINTS_LIMIT,
        'error',
        'resource',
        'Total control point count exceeds the configured limit.',
        location('sections'),
        { parameters: { maxTotalControlPoints: maxTotalPoints, actual: totalPoints } }
      )
    );
  }
  if (
    sections.length > 0 &&
    sections.every(
      (section) =>
        isRecord(section) && Array.isArray(section.fields) && isNumericToken(section.fields[4])
    ) &&
    !sections.some((section) => section.fields[4].value === 1)
  ) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.SEMANTIC_NO_ENABLED_SECTION,
        'warning',
        'semantic',
        'No section is enabled for playback preview.',
        location('sections'),
        { suggestion: 'Enable at least one section before previewing or sharing.' }
      )
    );
  }
  return Object.freeze({
    valid: !hasBlockingErrors(diagnostics),
    diagnostics: sortDiagnostics(diagnostics)
  });
}

function controlPointFromSyntax(
  point: SyntacticPulse['sections'][number]['points'][number]
): ControlPoint {
  const anchorValue = point.anchor.value;
  return Object.freeze({
    strength: point.strength.value,
    strengthDecimal: point.strength.canonical,
    strengthRaw: point.strength.lexeme,
    anchor: (anchorValue === 1 ? 1 : 0) as 0 | 1,
    sourceSpan: point.span
  });
}

/** Convert a valid syntax tree to an immutable Pulse value object. */
export function pulseFromSyntax(
  syntax: SyntacticPulse,
  diagnostics: readonly Diagnostic[] = [],
  rules: RuleSet = DEFAULT_RULE_SET
): Pulse | null {
  const validation = validateSyntax(syntax, rules);
  const allDiagnostics = sortDiagnostics([...diagnostics, ...validation.diagnostics]);
  if (hasBlockingErrors(allDiagnostics)) return null;
  const effectiveRules = isCompleteRuleSet(rules) ? rules : DEFAULT_RULE_SET;
  const sections: PulseSection[] = syntax.sections.map((section) => {
    const points = section.points.map(controlPointFromSyntax);
    const fields = section.fields;
    return Object.freeze({
      frequencyStartIndex: fields[0].value,
      frequencyEndIndex: fields[1].value,
      durationIndex: fields[2].value,
      frequencyMode: fields[3].value as 1 | 2 | 3 | 4,
      enabled: fields[4].value === 1,
      pulseElement: Object.freeze({
        points: Object.freeze(points),
        durationMs: points.length * effectiveRules.pointDurationMs
      }),
      raw: Object.freeze([
        fields[0].lexeme,
        fields[1].lexeme,
        fields[2].lexeme,
        fields[3].lexeme,
        fields[4].lexeme
      ] as [string, string, string, string, string]),
      sourceSpan: section.span
    });
  });
  const globals = syntax.globals;
  return Object.freeze({
    kind: 'pulse',
    format: 'pulse-text',
    formatProfile: FORMAT_PROFILE,
    ruleVersion: effectiveRules.id,
    evidence: Object.freeze([
      'official-semantics',
      'corpus-observed',
      'community-inferred'
    ] as const),
    source: Object.freeze({
      text: syntax.source.text,
      bytes: cloneBytes(syntax.source.bytes),
      digest: syntax.source.digest,
      format: 'pulse-text'
    }),
    globals: Object.freeze({
      sectionRestIndex: globals[0].value,
      playbackSpeed: globals[1].value,
      frequencyBalanceIndex: globals[2].value,
      raw: Object.freeze([globals[0].lexeme, globals[1].lexeme, globals[2].lexeme] as [
        string,
        string,
        string
      ])
    }),
    sections: Object.freeze(sections),
    revision: 0,
    changeRecords: Object.freeze([])
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validSpan(value: unknown): value is SourceSpan {
  if (!isRecord(value)) return false;
  const start = value.start;
  const end = value.end;
  const line = value.line;
  const column = value.column;
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    (start as number) >= 0 &&
    (end as number) >= (start as number) &&
    Number.isSafeInteger(line) &&
    (line as number) >= 1 &&
    Number.isSafeInteger(column) &&
    (column as number) >= 1
  );
}

function rawNumberMatches(value: unknown, expected: unknown): boolean {
  if (typeof value !== 'string' || typeof expected !== 'number' || !Number.isFinite(expected))
    return false;
  const parsed = parseNumericLexeme(value);
  return parsed !== null && parsed.value === expected;
}

function modelDiagnostic(
  code: string,
  message: string,
  path: string,
  stage: 'semantic' | 'range' = 'semantic'
): MadeDiagnostic {
  return makeDiagnostic(code, 'error', stage, message, location(path));
}

/** Validate an already-built Pulse defensively; this function never throws for malformed input. */
export function validatePulse(pulse: Pulse, rules: RuleSet = DEFAULT_RULE_SET): ValidationResult {
  const diagnostics: MadeDiagnostic[] = [];
  const effectiveRules = validateRuleSet(rules, diagnostics);
  if (!isRecord(pulse)) {
    diagnostics.push(
      modelDiagnostic(
        DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
        'Pulse value must be an object.',
        '$'
      )
    );
    return Object.freeze({ valid: false, diagnostics: sortDiagnostics(diagnostics) });
  }
  if (
    pulse.kind !== 'pulse' ||
    pulse.format !== 'pulse-text' ||
    pulse.formatProfile !== FORMAT_PROFILE
  ) {
    diagnostics.push(
      modelDiagnostic(
        DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
        'Pulse identity does not match the supported profile.',
        '$'
      )
    );
  }
  if (pulse.ruleVersion !== effectiveRules.id && pulse.ruleVersion !== RULE_VERSION) {
    diagnostics.push(
      modelDiagnostic(
        DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
        'Pulse rule version is not supported.',
        'ruleVersion'
      )
    );
  }
  if (!Number.isSafeInteger(pulse.revision) || pulse.revision < 0) {
    diagnostics.push(
      modelDiagnostic(
        DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
        'Pulse revision must be a non-negative safe integer.',
        'revision',
        'range'
      )
    );
  }
  if (!Array.isArray(pulse.changeRecords)) {
    diagnostics.push(
      modelDiagnostic(
        DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
        'Pulse change records must be an array.',
        'changeRecords'
      )
    );
  } else {
    pulse.changeRecords.forEach((record, index) => {
      if (
        !isRecord(record) ||
        typeof record.id !== 'string' ||
        record.id.length === 0 ||
        typeof record.kind !== 'string' ||
        typeof record.description !== 'string' ||
        typeof record.path !== 'string'
      ) {
        diagnostics.push(
          modelDiagnostic(
            DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
            'Change record is malformed.',
            'changeRecords[' + index + ']'
          )
        );
      }
    });
  }

  const source = pulse.source;
  const sourceValid =
    isRecord(source) &&
    typeof source.text === 'string' &&
    source.bytes instanceof Uint8Array &&
    typeof source.digest === 'string' &&
    source.digest.length > 0 &&
    source.format === 'pulse-text';
  if (!sourceValid) {
    diagnostics.push(
      modelDiagnostic(
        DIAGNOSTIC_CODES.SEMANTIC_INVALID_SOURCE,
        'Pulse source snapshot is invalid.',
        'source'
      )
    );
  } else {
    if (source.bytes.byteLength > effectiveRules.maxBytes) {
      diagnostics.push(
        makeDiagnostic(
          DIAGNOSTIC_CODES.RESOURCE_BYTES_LIMIT,
          'error',
          'resource',
          'Pulse source snapshot exceeds the configured byte limit.',
          location('source.bytes'),
          {
            parameters: {
              maxBytes: effectiveRules.maxBytes,
              actualBytes: source.bytes.byteLength
            }
          }
        )
      );
    }
    if (stableDigest(source.bytes) !== source.digest) {
      diagnostics.push(
        modelDiagnostic(
          DIAGNOSTIC_CODES.SEMANTIC_INVALID_SOURCE,
          'Pulse source digest does not match its bytes.',
          'source.digest'
        )
      );
    }
    const decoded = decodeUtf8(source.bytes);
    const normalizedText = decoded.text?.startsWith('\uFEFF')
      ? decoded.text.slice(1)
      : decoded.text;
    if (normalizedText === null || normalizedText !== source.text) {
      diagnostics.push(
        modelDiagnostic(
          DIAGNOSTIC_CODES.SEMANTIC_INVALID_SOURCE,
          'Pulse source text does not match its bytes.',
          'source.text'
        )
      );
    }
  }

  const globals = pulse.globals;
  if (!isRecord(globals)) {
    diagnostics.push(
      modelDiagnostic(
        DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
        'Pulse global settings must be an object.',
        'globals'
      )
    );
  } else {
    const values: readonly [unknown, unknown, unknown] = [
      globals.sectionRestIndex,
      globals.playbackSpeed,
      globals.frequencyBalanceIndex
    ];
    const ranges: readonly [number, number][] = [
      [0, 100],
      [1, 4],
      [0, 100]
    ];
    const codes = [
      DIAGNOSTIC_CODES.RANGE_GLOBAL_REST,
      DIAGNOSTIC_CODES.RANGE_GLOBAL_SPEED,
      DIAGNOSTIC_CODES.RANGE_GLOBAL_BALANCE
    ];
    values.forEach((value, index) => {
      const range = ranges[index] ?? [0, 0];
      if (!Number.isSafeInteger(value)) {
        diagnostics.push(
          modelDiagnostic(
            DIAGNOSTIC_CODES.RANGE_INTEGER_REQUIRED,
            'Global setting must be a safe integer.',
            'globals[' + index + ']',
            'range'
          )
        );
      } else if ((value as number) < range[0] || (value as number) > range[1]) {
        diagnostics.push(
          modelDiagnostic(
            codes[index] ?? DIAGNOSTIC_CODES.RANGE_GLOBAL_BALANCE,
            'Global setting is outside the supported range.',
            'globals[' + index + ']',
            'range'
          )
        );
      }
    });
    if (
      !Array.isArray(globals.raw) ||
      globals.raw.length !== 3 ||
      globals.raw.some((item, index) => !rawNumberMatches(item, values[index]))
    ) {
      diagnostics.push(
        modelDiagnostic(
          DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
          'Global raw values must contain three strings.',
          'globals.raw'
        )
      );
    }
  }

  const sections = pulse.sections;
  if (!Array.isArray(sections)) {
    diagnostics.push(
      modelDiagnostic(
        DIAGNOSTIC_CODES.RANGE_SECTION_COUNT,
        'Pulse sections must be an array.',
        'sections',
        'range'
      )
    );
    return Object.freeze({ valid: false, diagnostics: sortDiagnostics(diagnostics) });
  }
  const maxSections = validRuleLimit(effectiveRules.maxSections)
    ? effectiveRules.maxSections
    : DEFAULT_RULE_SET.maxSections;
  if (sections.length < 1 || sections.length > maxSections) {
    diagnostics.push(
      modelDiagnostic(
        DIAGNOSTIC_CODES.RANGE_SECTION_COUNT,
        'Pulse section count is outside the supported range.',
        'sections',
        'range'
      )
    );
  } else if (sections.length > 3) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.SEMANTIC_UNVERIFIED_SECTION_COUNT,
        'warning',
        'semantic',
        'More than three sections are parse-supported but App interoperability is not verified.',
        location('sections')
      )
    );
  }
  const maxPoints = validRuleLimit(effectiveRules.maxPointsPerSection)
    ? effectiveRules.maxPointsPerSection
    : DEFAULT_RULE_SET.maxPointsPerSection;
  const maxTotal = validRuleLimit(effectiveRules.maxTotalControlPoints)
    ? effectiveRules.maxTotalControlPoints
    : DEFAULT_RULE_SET.maxTotalControlPoints;
  let totalPoints = 0;
  sections.forEach((section, sectionIndex) => {
    const sectionPath = 'sections[' + sectionIndex + ']';
    if (!isRecord(section)) {
      diagnostics.push(
        modelDiagnostic(
          DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
          'Section value must be an object.',
          sectionPath
        )
      );
      return;
    }
    const numberFields: readonly [unknown, string, string, number, number][] = [
      [
        section.frequencyStartIndex,
        'frequencyStartIndex',
        DIAGNOSTIC_CODES.RANGE_FREQUENCY_INDEX,
        0,
        83
      ],
      [
        section.frequencyEndIndex,
        'frequencyEndIndex',
        DIAGNOSTIC_CODES.RANGE_FREQUENCY_INDEX,
        0,
        83
      ],
      [section.durationIndex, 'durationIndex', DIAGNOSTIC_CODES.RANGE_DURATION_INDEX, 0, 99],
      [section.frequencyMode, 'frequencyMode', DIAGNOSTIC_CODES.RANGE_FREQUENCY_MODE, 1, 4],
      [
        section.enabled === true ? 1 : section.enabled === false ? 0 : Number.NaN,
        'enabled',
        DIAGNOSTIC_CODES.RANGE_ENABLED_FLAG,
        0,
        1
      ]
    ];
    numberFields.forEach(([value, field, code, min, max]) => {
      if (!Number.isSafeInteger(value))
        diagnostics.push(
          modelDiagnostic(
            DIAGNOSTIC_CODES.RANGE_INTEGER_REQUIRED,
            field + ' must be a safe integer.',
            sectionPath + '.' + field,
            'range'
          )
        );
      else if ((value as number) < min || (value as number) > max)
        diagnostics.push(
          modelDiagnostic(
            code,
            field + ' is outside the supported range.',
            sectionPath + '.' + field,
            'range'
          )
        );
    });
    if (typeof section.enabled !== 'boolean')
      diagnostics.push(
        modelDiagnostic(
          DIAGNOSTIC_CODES.RANGE_ENABLED_FLAG,
          'Enabled flag must be boolean.',
          sectionPath + '.enabled',
          'range'
        )
      );
    if (
      !Array.isArray(section.raw) ||
      section.raw.length !== 5 ||
      section.raw.some((item) => typeof item !== 'string')
    ) {
      diagnostics.push(
        modelDiagnostic(
          DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
          'Section raw values must contain five strings.',
          sectionPath + '.raw'
        )
      );
    }
    if (!validSpan(section.sourceSpan))
      diagnostics.push(
        modelDiagnostic(
          DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
          'Section source span is invalid.',
          sectionPath + '.sourceSpan'
        )
      );
    const element = section.pulseElement;
    if (!isRecord(element) || !Array.isArray(element.points)) {
      diagnostics.push(
        modelDiagnostic(
          DIAGNOSTIC_CODES.SEMANTIC_TOO_FEW_POINTS,
          'Section must contain a pulse element with control points.',
          sectionPath + '.pulseElement'
        )
      );
      return;
    }
    const expectedDuration = element.points.length * effectiveRules.pointDurationMs;
    const elementDuration = element.durationMs;
    if (!Number.isFinite(elementDuration) || (elementDuration as number) < 0) {
      diagnostics.push(
        modelDiagnostic(
          DIAGNOSTIC_CODES.SEMANTIC_DURATION_MISMATCH,
          'Pulse element duration must be a finite non-negative number.',
          sectionPath + '.pulseElement.durationMs',
          'range'
        )
      );
    } else if (
      Number.isFinite(effectiveRules.pointDurationMs) &&
      Math.abs((elementDuration as number) - expectedDuration) > 1e-9
    ) {
      diagnostics.push(
        modelDiagnostic(
          DIAGNOSTIC_CODES.SEMANTIC_DURATION_MISMATCH,
          'Pulse element duration does not match its control point count.',
          sectionPath + '.pulseElement.durationMs'
        )
      );
    }
    if (element.points.length < 2)
      diagnostics.push(
        modelDiagnostic(
          DIAGNOSTIC_CODES.SEMANTIC_TOO_FEW_POINTS,
          'Each pulse element must contain at least two control points.',
          sectionPath + '.pulseElement.points'
        )
      );
    if (element.points.length > maxPoints)
      diagnostics.push(
        modelDiagnostic(
          DIAGNOSTIC_CODES.RESOURCE_POINTS_LIMIT,
          'Section control point count exceeds the configured limit.',
          sectionPath + '.pulseElement.points',
          'range'
        )
      );
    totalPoints += element.points.length;
    element.points.forEach((point, pointIndex) => {
      const pointPath = sectionPath + '.pulseElement.points[' + pointIndex + ']';
      if (!isRecord(point)) {
        diagnostics.push(
          modelDiagnostic(
            DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
            'Control point value must be an object.',
            pointPath
          )
        );
        return;
      }
      if (
        !Number.isFinite(point.strength) ||
        (point.strength as number) < 0 ||
        (point.strength as number) > 100
      )
        diagnostics.push(
          modelDiagnostic(
            DIAGNOSTIC_CODES.RANGE_INTENSITY,
            'Strength is outside the supported range.',
            pointPath + '.strength',
            'range'
          )
        );
      if (typeof point.strengthDecimal !== 'string') {
        diagnostics.push(
          modelDiagnostic(
            DIAGNOSTIC_CODES.RANGE_INTENSITY,
            'Strength decimal representation must be a string.',
            pointPath + '.strengthDecimal',
            'range'
          )
        );
      } else {
        const parsed = parseNumericLexeme(point.strengthDecimal);
        if (
          parsed === null ||
          parsed.value !== point.strength ||
          normalizeDecimal(point.strengthDecimal) !== point.strengthDecimal
        )
          diagnostics.push(
            modelDiagnostic(
              DIAGNOSTIC_CODES.RANGE_INTENSITY,
              'Strength decimal representation must match the normalized numeric value.',
              pointPath + '.strengthDecimal',
              'range'
            )
          );
      }
      if (!rawNumberMatches(point.strengthRaw, point.strength))
        diagnostics.push(
          modelDiagnostic(
            DIAGNOSTIC_CODES.RANGE_INTENSITY,
            'Strength raw representation must match the numeric value.',
            pointPath + '.strengthRaw',
            'range'
          )
        );
      if (point.anchor !== 0 && point.anchor !== 1)
        diagnostics.push(
          modelDiagnostic(
            DIAGNOSTIC_CODES.RANGE_ANCHOR_FLAG,
            'Anchor must be 0 or 1.',
            pointPath + '.anchor',
            'range'
          )
        );
      if (!validSpan(point.sourceSpan))
        diagnostics.push(
          modelDiagnostic(
            DIAGNOSTIC_CODES.SEMANTIC_INVALID_MODEL,
            'Control point source span is invalid.',
            pointPath + '.sourceSpan'
          )
        );
    });
  });
  if (totalPoints > maxTotal)
    diagnostics.push(
      modelDiagnostic(
        DIAGNOSTIC_CODES.RESOURCE_POINTS_LIMIT,
        'Total control point count exceeds the configured limit.',
        'sections',
        'range'
      )
    );
  if (
    sections.length > 0 &&
    !sections.some((section) => isRecord(section) && section.enabled === true)
  )
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.SEMANTIC_NO_ENABLED_SECTION,
        'warning',
        'semantic',
        'No section is enabled for playback preview.',
        location('sections')
      )
    );
  return Object.freeze({
    valid: !hasBlockingErrors(diagnostics),
    diagnostics: sortDiagnostics(diagnostics)
  });
}

export function decimalSemanticEqual(left: string, right: string): boolean {
  return normalizeDecimal(left) === normalizeDecimal(right);
}
