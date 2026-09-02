import { describe, expect, it, vi } from 'vitest';

const { mediaAdd, mediaRevert } = vi.hoisted(() => ({
  mediaAdd: vi.fn(),
  mediaRevert: vi.fn()
}));

vi.mock('gsap', () => ({
  default: {
    matchMedia: () => ({ add: mediaAdd, revert: mediaRevert })
  }
}));

import { withMotionPreferences } from '../src/motion.js';

describe('motion preferences', () => {
  it('runs animations when the browser has no reduced-motion preference', () => {
    mediaAdd.mockImplementation((queries, callback) => {
      expect(queries).toMatchObject({
        reduceMotion: '(prefers-reduced-motion: reduce)',
        noPreference: '(prefers-reduced-motion: no-preference)'
      });
      callback({ conditions: { reduceMotion: false, noPreference: true } });
    });

    const animate = vi.fn();
    const cleanup = withMotionPreferences(animate);

    expect(animate).toHaveBeenCalledWith(false);
    cleanup();
    expect(mediaRevert).toHaveBeenCalledOnce();
  });
});
