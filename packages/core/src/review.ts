/** Inputs that define one reviewed quadratic assist proposal. */
export interface AssistProposalFingerprintInput {
  readonly sourceDigest: string;
  readonly sectionIndex: number;
  readonly sectionPointCount: number;
  /** Selection context used to seed the editable proposal fields. */
  readonly contextPointIndex: number;
  readonly startPointIndex: number;
  readonly endPointIndex: number;
  readonly startStrength: number;
  readonly endStrength: number;
}

function numberToken(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  return String(value);
}

/**
 * Return a deterministic identity for the exact proposal and source snapshot
 * a user reviewed. Numeric values are compared by their semantic Number value,
 * so equivalent spellings such as `1` and `1.0` share an identity.
 */
export function assistProposalFingerprint(input: AssistProposalFingerprintInput): string {
  return JSON.stringify([
    input.sourceDigest,
    numberToken(input.sectionIndex),
    numberToken(input.sectionPointCount),
    numberToken(input.contextPointIndex),
    numberToken(input.startPointIndex),
    numberToken(input.endPointIndex),
    numberToken(input.startStrength),
    numberToken(input.endStrength)
  ]);
}

export function reviewedAssistMatches(
  input: AssistProposalFingerprintInput,
  reviewedFingerprint: string | null
): boolean {
  return reviewedFingerprint !== null && reviewedFingerprint === assistProposalFingerprint(input);
}

/** Validate the bounded interval and endpoint values used by the assist UI. */
export function isAssistProposalValid(input: AssistProposalFingerprintInput): boolean {
  return (
    Number.isSafeInteger(input.sectionIndex) &&
    input.sectionIndex >= 0 &&
    Number.isSafeInteger(input.sectionPointCount) &&
    input.sectionPointCount > 0 &&
    Number.isSafeInteger(input.startPointIndex) &&
    input.startPointIndex >= 0 &&
    Number.isSafeInteger(input.endPointIndex) &&
    input.endPointIndex > input.startPointIndex &&
    input.endPointIndex < input.sectionPointCount &&
    Number.isFinite(input.startStrength) &&
    input.startStrength >= 0 &&
    input.startStrength <= 100 &&
    Number.isFinite(input.endStrength) &&
    input.endStrength >= 0 &&
    input.endStrength <= 100
  );
}
