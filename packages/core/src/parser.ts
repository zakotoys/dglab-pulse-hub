import { DIAGNOSTIC_CODES, location, makeDiagnostic, sortDiagnostics } from './diagnostics.js';
import { parseNumericLexeme, sourceSpan } from './numbers.js';
import {
  PULSE_PREFIX,
  type NumericToken,
  type ParseResult,
  type RecognitionResult,
  type RuleSet,
  type SourceDocument,
  type SourceSpan,
  type SyntacticControlPoint,
  type SyntacticSection,
  type SyntacticPulse
} from './types.js';
import { recognizeInput } from './recognize.js';
import { pulseFromSyntax, validateSyntax } from './validator.js';

const SECTION_SEPARATOR = '+section+';

export interface ParseOptions {
  readonly maxBytes?: number;
  readonly allowBom?: boolean;
  readonly rules?: RuleSet;
}

function token(
  lexeme: string,
  start: number,
  fullText: string,
  path: string,
  diagnostics: ReturnType<typeof makeDiagnostic>[]
): NumericToken | null {
  const span = sourceSpan(fullText, start, start + lexeme.length);
  if (lexeme.length === 0) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.SYNTAX_EMPTY_GLOBAL_FIELD,
        'error',
        'syntax',
        'A numeric field is empty.',
        location(path, span)
      )
    );
    return null;
  }
  const parsed = parseNumericLexeme(lexeme);
  if (parsed === null) {
    const nonFinite = /^(?:[+-]?(?:NaN|Infinity))$/i.test(lexeme);
    diagnostics.push(
      makeDiagnostic(
        nonFinite
          ? DIAGNOSTIC_CODES.SYNTAX_NON_FINITE_NUMBER
          : DIAGNOSTIC_CODES.SYNTAX_INVALID_NUMBER,
        'error',
        'syntax',
        nonFinite
          ? 'Numeric value must be finite.'
          : 'Numeric field is not valid ASCII decimal syntax.',
        location(path, span),
        { suggestion: 'Use an ASCII decimal number without whitespace.' }
      )
    );
    return null;
  }
  return Object.freeze({
    lexeme,
    value: parsed.value,
    canonical: parsed.canonical,
    span
  });
}

function parseSection(
  sectionText: string,
  absoluteStart: number,
  fullText: string,
  sectionIndex: number,
  diagnostics: ReturnType<typeof makeDiagnostic>[]
): SyntacticSection | null {
  const sectionSpan = sourceSpan(fullText, absoluteStart, absoluteStart + sectionText.length);
  if (sectionText.length === 0) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.SYNTAX_EMPTY_SECTION,
        'error',
        'syntax',
        'Section is empty.',
        location('sections[' + sectionIndex + ']', sectionSpan, {
          sectionIndex
        })
      )
    );
    return null;
  }
  const slashCount = [...sectionText].filter((char) => char === '/').length;
  if (slashCount === 0) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.SYNTAX_MISSING_SLASH,
        'error',
        'syntax',
        'Section header and control points must be separated by "/".',
        location('sections[' + sectionIndex + ']', sectionSpan, {
          sectionIndex
        })
      )
    );
    return null;
  }
  if (slashCount !== 1) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.SYNTAX_DUPLICATE_SLASH,
        'error',
        'syntax',
        'Section must contain exactly one "/".',
        location('sections[' + sectionIndex + ']', sectionSpan, {
          sectionIndex
        })
      )
    );
    return null;
  }
  const slash = sectionText.indexOf('/');
  const headerText = sectionText.slice(0, slash);
  const pointsText = sectionText.slice(slash + 1);
  const headerFields = headerText.split(',');
  const basePath = 'sections[' + sectionIndex + ']';
  if (headerFields.length !== 5) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.SYNTAX_SECTION_HEADER_COUNT,
        'error',
        'syntax',
        'Section header must contain exactly five fields.',
        location(
          basePath + '.header',
          sourceSpan(fullText, absoluteStart, absoluteStart + headerText.length),
          { sectionIndex }
        ),
        {
          parameters: { expected: 5, actual: headerFields.length }
        }
      )
    );
  }
  const parsedHeader: NumericToken[] = [];
  let fieldOffset = absoluteStart;
  for (let index = 0; index < headerFields.length; index += 1) {
    const fieldText = headerFields[index] ?? '';
    const parsed = token(
      fieldText,
      fieldOffset,
      fullText,
      basePath + '.header[' + index + ']',
      diagnostics
    );
    if (parsed !== null) parsedHeader.push(parsed);
    fieldOffset += fieldText.length + 1;
  }

  const pointParts = pointsText.split(',');
  const points: SyntacticControlPoint[] = [];
  let pointOffset = absoluteStart + slash + 1;
  for (let pointIndex = 0; pointIndex < pointParts.length; pointIndex += 1) {
    const pointText = pointParts[pointIndex] ?? '';
    const pointSpan = sourceSpan(fullText, pointOffset, pointOffset + pointText.length);
    if (pointText.length === 0) {
      diagnostics.push(
        makeDiagnostic(
          DIAGNOSTIC_CODES.SYNTAX_EMPTY_POINT,
          'error',
          'syntax',
          'Control point is empty.',
          location(basePath + '.points[' + pointIndex + ']', pointSpan, {
            sectionIndex,
            pointIndex
          })
        )
      );
      pointOffset += pointText.length + 1;
      continue;
    }
    // The strength/anchor values may themselves be signed or use a negative
    // exponent. Find the hyphen that leaves two numeric lexemes; this keeps a
    // malformed anchor such as `1-1e-2` diagnosable as a range/number error
    // instead of mis-parsing the exponent sign as the field separator.
    let dash = -1;
    for (let candidate = 1; candidate < pointText.length - 1; candidate += 1) {
      if (pointText[candidate] !== '-') continue;
      if (
        parseNumericLexeme(pointText.slice(0, candidate)) !== null &&
        parseNumericLexeme(pointText.slice(candidate + 1)) !== null
      ) {
        dash = candidate;
        break;
      }
    }
    if (dash < 0) dash = pointText.lastIndexOf('-');
    if (dash <= 0 || dash === pointText.length - 1) {
      diagnostics.push(
        makeDiagnostic(
          DIAGNOSTIC_CODES.SYNTAX_POINT_FIELD_COUNT,
          'error',
          'syntax',
          'Control point must contain strength-anchor.',
          location(basePath + '.points[' + pointIndex + ']', pointSpan, {
            sectionIndex,
            pointIndex
          })
        )
      );
      pointOffset += pointText.length + 1;
      continue;
    }
    const strengthText = pointText.slice(0, dash);
    const anchorText = pointText.slice(dash + 1);
    const strength = token(
      strengthText,
      pointOffset,
      fullText,
      basePath + '.points[' + pointIndex + '].strength',
      diagnostics
    );
    const anchor = token(
      anchorText,
      pointOffset + dash + 1,
      fullText,
      basePath + '.points[' + pointIndex + '].anchor',
      diagnostics
    );
    if (strength !== null && anchor !== null) {
      points.push(
        Object.freeze({
          strength,
          anchor,
          span: pointSpan
        })
      );
    }
    pointOffset += pointText.length + 1;
  }

  if (parsedHeader.length !== 5 || points.length !== pointParts.length) {
    return null;
  }
  const fields = parsedHeader as [
    NumericToken,
    NumericToken,
    NumericToken,
    NumericToken,
    NumericToken
  ];
  return Object.freeze({
    fields: Object.freeze(fields),
    points: Object.freeze(points),
    span: sectionSpan
  });
}

export function parseSyntax(source: SourceDocument): {
  readonly syntax: SyntacticPulse | null;
  readonly diagnostics: readonly ReturnType<typeof makeDiagnostic>[];
} {
  const diagnostics: ReturnType<typeof makeDiagnostic>[] = [];
  let text = source.text;
  if (source.trailingNewline !== '') {
    text = text.slice(0, -source.trailingNewline.length);
  }
  // Exactly one final LF/CRLF is tolerated by the file format.  Anything
  // beyond that is trailing content, rather than part of the last numeric
  // token (which would produce a misleading "invalid number" diagnostic).
  if (text.endsWith('\n') || text.endsWith('\r')) {
    const start = Math.max(0, text.length - 1);
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.SYNTAX_TRAILING_CONTENT,
        'error',
        'syntax',
        'Only one trailing newline is allowed after pulse content.',
        location('document', sourceSpan(text, start, text.length))
      )
    );
    return { syntax: null, diagnostics: sortDiagnostics(diagnostics) };
  }
  // The grammar is ASCII-only apart from the optional final newline.  Reject
  // control characters up front so they cannot be swallowed by a token.
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      diagnostics.push(
        makeDiagnostic(
          DIAGNOSTIC_CODES.SYNTAX_UNEXPECTED_CHARACTER,
          'error',
          'syntax',
          'Pulse content contains an unexpected control character.',
          location('document', sourceSpan(text, index, index + 1))
        )
      );
      return { syntax: null, diagnostics: sortDiagnostics(diagnostics) };
    }
  }
  if (!text.startsWith(PULSE_PREFIX)) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.RECOGNIZE_UNKNOWN_PREFIX,
        'error',
        'recognize',
        'Input does not start with the supported pulse prefix.',
        location('$')
      )
    );
    return { syntax: null, diagnostics: sortDiagnostics(diagnostics) };
  }
  const body = text.slice(PULSE_PREFIX.length);
  const equalsPositions: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '=') equalsPositions.push(index);
  }
  if (equalsPositions.length === 0) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.SYNTAX_MISSING_EQUALS,
        'error',
        'syntax',
        'Pulse text must contain one "=" separator.',
        location('document', sourceSpan(text, text.length, text.length))
      )
    );
    return { syntax: null, diagnostics: sortDiagnostics(diagnostics) };
  }
  if (equalsPositions.length > 1) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.SYNTAX_DUPLICATE_EQUALS,
        'error',
        'syntax',
        'Pulse text must contain exactly one "=" separator.',
        location(
          'document',
          sourceSpan(
            text,
            PULSE_PREFIX.length + (equalsPositions[1] ?? 0),
            PULSE_PREFIX.length + (equalsPositions[1] ?? 0) + 1
          )
        )
      )
    );
    return { syntax: null, diagnostics: sortDiagnostics(diagnostics) };
  }
  const equals = equalsPositions[0] ?? 0;
  const globalText = body.slice(0, equals);
  const rightText = body.slice(equals + 1);
  const globalFields = globalText.split(',');
  if (globalFields.length !== 3) {
    diagnostics.push(
      makeDiagnostic(
        DIAGNOSTIC_CODES.SYNTAX_GLOBAL_FIELD_COUNT,
        'error',
        'syntax',
        'Global settings must contain exactly three fields.',
        location(
          'globals',
          sourceSpan(text, PULSE_PREFIX.length, PULSE_PREFIX.length + globalText.length)
        ),
        { parameters: { expected: 3, actual: globalFields.length } }
      )
    );
  }
  const globals: NumericToken[] = [];
  let globalOffset = PULSE_PREFIX.length;
  for (let index = 0; index < globalFields.length; index += 1) {
    const value = globalFields[index] ?? '';
    const parsed = token(value, globalOffset, text, 'globals[' + index + ']', diagnostics);
    if (parsed !== null) globals.push(parsed);
    globalOffset += value.length + 1;
  }

  const separatorPositions: number[] = [];
  for (let index = 0; index < rightText.length; index += 1) {
    if (rightText[index] !== '+') continue;
    if (rightText.startsWith(SECTION_SEPARATOR, index)) {
      index += SECTION_SEPARATOR.length - 1;
      continue;
    }
    // A plus sign can be a numeric sign (`+1`, `1e+2`, `1-+1`). Anything
    // else is outside the section grammar and should be reported as a bad
    // separator rather than silently becoming part of a token.
    const previous = rightText[index - 1] ?? '';
    if (
      index === 0 ||
      previous === ',' ||
      previous === '/' ||
      previous === '-' ||
      previous === 'e' ||
      previous === 'E'
    ) {
      continue;
    }
    separatorPositions.push(index);
  }
  for (const position of separatorPositions) {
    if (!rightText.startsWith(SECTION_SEPARATOR, position)) {
      diagnostics.push(
        makeDiagnostic(
          DIAGNOSTIC_CODES.SYNTAX_INVALID_SECTION_SEPARATOR,
          'error',
          'syntax',
          'Sections must be separated by the exact +section+ marker.',
          location(
            'sections',
            sourceSpan(
              text,
              PULSE_PREFIX.length + equals + 1 + position,
              PULSE_PREFIX.length + equals + 1 + position + 1
            )
          )
        )
      );
    }
  }
  if (diagnostics.some((item) => item.code === DIAGNOSTIC_CODES.SYNTAX_INVALID_SECTION_SEPARATOR)) {
    return { syntax: null, diagnostics: sortDiagnostics(diagnostics) };
  }
  const sectionTexts = rightText.split(SECTION_SEPARATOR);
  const sections: SyntacticSection[] = [];
  let sectionOffset = PULSE_PREFIX.length + equals + 1;
  for (let sectionIndex = 0; sectionIndex < sectionTexts.length; sectionIndex += 1) {
    const sectionText = sectionTexts[sectionIndex] ?? '';
    const parsed = parseSection(sectionText, sectionOffset, text, sectionIndex, diagnostics);
    if (parsed !== null) sections.push(parsed);
    sectionOffset += sectionText.length + SECTION_SEPARATOR.length;
  }

  if (
    diagnostics.some((item) => item.severity === 'error') ||
    globals.length !== 3 ||
    sections.length !== sectionTexts.length
  ) {
    return { syntax: null, diagnostics: sortDiagnostics(diagnostics) };
  }
  const syntax: SyntacticPulse = Object.freeze({
    kind: 'syntactic-pulse',
    source,
    globals: Object.freeze(globals as [NumericToken, NumericToken, NumericToken]),
    sections: Object.freeze(sections),
    span: sourceSpan(text, 0, text.length)
  });
  return { syntax, diagnostics: sortDiagnostics(diagnostics) };
}

export function parsePulseText(
  input: string | Uint8Array,
  options: ParseOptions = {}
): ParseResult {
  const safeOptions = options !== null && typeof options === 'object' ? options : {};
  const recognitionOptions: {
    maxBytes?: number;
    allowBom?: boolean;
  } = {};
  if (safeOptions.maxBytes !== undefined) recognitionOptions.maxBytes = safeOptions.maxBytes;
  if (safeOptions.allowBom !== undefined) recognitionOptions.allowBom = safeOptions.allowBom;
  const recognition: RecognitionResult = recognizeInput(input, recognitionOptions);
  if (recognition.format !== 'pulse-text' || recognition.source === null) {
    return Object.freeze({
      accepted: false,
      recognition,
      syntax: null,
      pulse: null,
      diagnostics: recognition.diagnostics
    });
  }
  const parsed = parseSyntax(recognition.source);
  const syntaxDiagnostics = sortDiagnostics([...recognition.diagnostics, ...parsed.diagnostics]);
  const semanticDiagnostics =
    parsed.syntax === null ? [] : validateSyntax(parsed.syntax, safeOptions.rules).diagnostics;
  const pulse =
    parsed.syntax === null
      ? null
      : pulseFromSyntax(parsed.syntax, syntaxDiagnostics, safeOptions.rules);
  const diagnostics = sortDiagnostics([...syntaxDiagnostics, ...semanticDiagnostics]);
  return Object.freeze({
    accepted: pulse !== null && !diagnostics.some((item) => item.severity === 'error'),
    recognition,
    syntax: parsed.syntax,
    pulse,
    diagnostics
  });
}
