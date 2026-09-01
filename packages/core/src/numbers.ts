import type { NumericToken, SourceSpan } from './types.js';

export interface ParsedNumber {
  readonly value: number;
  readonly canonical: string;
  readonly integer: boolean;
}

/**
 * Decimal syntax accepted by the current profile. Exponents are accepted as
 * ASCII numeric syntax, then normalized without relying on binary float
 * formatting. Infinity and NaN are intentionally excluded.
 *
 * The format is deliberately bounded. `Number("0e+1000000000")` is finite,
 * but expanding that lexeme to a canonical decimal would otherwise allocate
 * an unbounded string before validation gets a chance to reject it.
 */
export const DECIMAL_PATTERN =
  /^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?$/;

export const MAX_NUMERIC_LEXEME_LENGTH = 128;
export const MAX_NUMERIC_EXPONENT = 1_000;

export function parseNumericLexeme(lexeme: string): ParsedNumber | null {
  if (typeof lexeme !== 'string') return null;
  if (lexeme.length === 0 || lexeme.length > MAX_NUMERIC_LEXEME_LENGTH) {
    return null;
  }
  if (!DECIMAL_PATTERN.test(lexeme)) return null;
  const exponentMarker = Math.max(lexeme.indexOf('e'), lexeme.indexOf('E'));
  if (exponentMarker >= 0) {
    const exponent = Number(lexeme.slice(exponentMarker + 1));
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_NUMERIC_EXPONENT) {
      return null;
    }
  }
  const value = Number(lexeme);
  if (!Number.isFinite(value)) return null;
  const canonical = normalizeDecimal(lexeme);
  // Do not silently turn a non-zero decimal that underflows the JS number
  // representation into the legal zero value.  Zero is a meaningful pulse
  // strength/index and must remain distinguishable from an unrepresentable
  // numeric token.
  if (canonical !== '0' && value === 0) return null;
  return {
    value,
    canonical,
    integer: !canonical.includes('.')
  };
}

/**
 * Normalize a decimal/exponent lexeme exactly enough for semantic equality.
 * The function never rounds; it only moves the decimal point and trims
 * insignificant zeroes.
 */
export function normalizeDecimal(lexeme: string): string {
  if (typeof lexeme !== 'string') return '';
  // This function is also public and may be called with untrusted text. Keep
  // malformed/oversized values inert instead of allowing repeat() to allocate
  // an attacker-controlled amount of memory. Parser callers validate first.
  if (
    lexeme.length === 0 ||
    lexeme.length > MAX_NUMERIC_LEXEME_LENGTH ||
    !DECIMAL_PATTERN.test(lexeme)
  ) {
    return lexeme;
  }
  let text = lexeme;
  let sign = '';
  if (text.startsWith('+') || text.startsWith('-')) {
    if (text.startsWith('-')) sign = '-';
    text = text.slice(1);
  }
  const exponentIndex = Math.max(text.indexOf('e'), text.indexOf('E'));
  let exponent = 0;
  if (exponentIndex >= 0) {
    exponent = Number(text.slice(exponentIndex + 1));
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_NUMERIC_EXPONENT) {
      return lexeme;
    }
    text = text.slice(0, exponentIndex);
  }
  const dotIndex = text.indexOf('.');
  const integerPart = dotIndex >= 0 ? text.slice(0, dotIndex) : text;
  const fractionPart = dotIndex >= 0 ? text.slice(dotIndex + 1) : '';
  const rawDigits = integerPart + fractionPart;
  const firstSignificant = rawDigits.search(/[1-9]/);
  if (firstSignificant < 0) return '0';
  const digits = rawDigits.slice(firstSignificant);
  // Removing leading zeroes shifts the decimal point by the same amount.
  const decimalPosition = integerPart.length + exponent - firstSignificant;
  let result: string;
  if (decimalPosition <= 0) {
    result = '0.' + '0'.repeat(-decimalPosition) + digits;
  } else if (decimalPosition >= digits.length) {
    result = digits + '0'.repeat(decimalPosition - digits.length);
  } else {
    result = digits.slice(0, decimalPosition) + '.' + digits.slice(decimalPosition);
  }
  if (result.includes('.')) {
    result = result.replace(/0+$/, '').replace(/\.$/, '');
  }
  result = result.replace(/^0+(?=\d)/, '');
  if (result === '' || result === '0') return '0';
  return sign === '-' && result !== '0' ? '-' + result : result;
}

export function tokenFromLexeme(lexeme: string, span: SourceSpan): NumericToken | null {
  const parsed = parseNumericLexeme(lexeme);
  if (parsed === null) return null;
  return Object.freeze({
    lexeme,
    value: parsed.value,
    canonical: parsed.canonical,
    span
  });
}

export function isSafeIntegerNumber(value: number): boolean {
  return Number.isSafeInteger(value);
}

/**
 * A small deterministic non-cryptographic digest keeps the core independent
 * from Node's crypto module. Adapters may additionally attach a SHA-256 hash
 * when a security-grade content identifier is required.
 */
export function stableDigest(bytes: Uint8Array): string {
  let high = 0x811c9dc5;
  let low = 0x01000193;
  for (const byte of bytes) {
    high ^= byte;
    high = Math.imul(high, 0x01000193);
    low ^= byte ^ high;
    low = Math.imul(low, 0x01000193);
  }
  return (high >>> 0).toString(16).padStart(8, '0') + (low >>> 0).toString(16).padStart(8, '0');
}

export function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

export function decodeUtf8(input: Uint8Array): {
  readonly text: string | null;
  readonly invalid: boolean;
} {
  try {
    return {
      // Preserve a leading U+FEFF so recognition can report BOM policy
      // explicitly instead of having the decoder erase evidence.
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input),
      invalid: false
    };
  } catch {
    return { text: null, invalid: true };
  }
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const lineStartCache = new Map<string, readonly number[]>();
const MAX_CACHED_SOURCE_LOCATIONS = 8;

function lineStartsFor(text: string): readonly number[] {
  const cached = lineStartCache.get(text);
  if (cached !== undefined) return cached;
  const starts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  const frozen = Object.freeze(starts);
  lineStartCache.set(text, frozen);
  if (lineStartCache.size > MAX_CACHED_SOURCE_LOCATIONS) {
    const oldest = lineStartCache.keys().next().value;
    if (typeof oldest === 'string') lineStartCache.delete(oldest);
  }
  return frozen;
}

export function sourceSpan(text: string, start: number, end: number): SourceSpan {
  if (typeof text !== 'string') text = '';
  const startNumber = Number.isFinite(start) ? Math.trunc(start) : 0;
  const endNumber = Number.isFinite(end) ? Math.trunc(end) : startNumber;
  const safeStart = Math.max(0, Math.min(text.length, startNumber));
  const safeEnd = Math.max(safeStart, Math.min(text.length, endNumber));
  const starts = lineStartsFor(text);
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    const value = starts[middle];
    if (value !== undefined && value <= safeStart) low = middle;
    else high = middle;
  }
  const lineStart = starts[low] ?? 0;
  return Object.freeze({
    start: safeStart,
    end: safeEnd,
    line: low + 1,
    column: safeStart - lineStart + 1
  });
}

export function trailingNewline(text: string): '' | '\n' | '\r\n' {
  if (typeof text !== 'string') return '';
  if (text.endsWith('\r\n')) return '\r\n';
  if (text.endsWith('\n')) return '\n';
  return '';
}
