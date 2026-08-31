export {
  assistProposalFingerprint,
  isAssistProposalValid,
  reviewedAssistMatches,
  type AssistProposalFingerprintInput
} from '@dglab-pulse-hub/core';

interface InspectionResultLike {
  readonly status: string;
}

/** Keep a candidate out of the visible document until its inspection passes. */
export async function inspectThenCommit<T, TResult extends InspectionResultLike>(
  candidate: T,
  inspect: (candidate: T) => Promise<TResult>,
  commit: (candidate: T) => void,
  canCommit: () => boolean = () => true
): Promise<TResult> {
  const inspected = await inspect(candidate);
  if (inspected.status === 'success' && canCommit()) commit(candidate);
  return inspected;
}
