import { describe, expect, it } from 'vitest';
import {
  assistProposalFingerprint,
  isAssistProposalValid,
  reviewedAssistMatches,
  type AssistProposalFingerprintInput
} from '../src/review.js';

const proposal: AssistProposalFingerprintInput = {
  sourceDigest: '0123456789abcdef',
  sectionIndex: 1,
  sectionPointCount: 5,
  contextPointIndex: 2,
  startPointIndex: 1,
  endPointIndex: 4,
  startStrength: 12.5,
  endStrength: 87.5
};

describe('reviewed assist identity', () => {
  it('uses one bounded input rule for preview and apply', () => {
    expect(isAssistProposalValid(proposal)).toBe(true);
    expect(isAssistProposalValid({ ...proposal, startStrength: -0.01 })).toBe(false);
    expect(isAssistProposalValid({ ...proposal, endStrength: 100.01 })).toBe(false);
    expect(isAssistProposalValid({ ...proposal, endPointIndex: proposal.sectionPointCount })).toBe(false);
    expect(isAssistProposalValid({ ...proposal, endPointIndex: proposal.startPointIndex })).toBe(false);
  });

  it('accepts only the exact source and proposal that was reviewed', () => {
    const reviewed = assistProposalFingerprint(proposal);
    expect(reviewedAssistMatches(proposal, reviewed)).toBe(true);

    const changes: AssistProposalFingerprintInput[] = [
      { ...proposal, sourceDigest: 'fedcba9876543210' },
      { ...proposal, sectionIndex: 0 },
      { ...proposal, sectionPointCount: 6 },
      { ...proposal, contextPointIndex: 1 },
      { ...proposal, startPointIndex: 0 },
      { ...proposal, endPointIndex: 3 },
      { ...proposal, startStrength: 12.6 },
      { ...proposal, endStrength: 87.4 }
    ];

    changes.forEach((current) => {
      expect(reviewedAssistMatches(current, reviewed)).toBe(false);
    });
    expect(reviewedAssistMatches(proposal, null)).toBe(false);
  });
});
