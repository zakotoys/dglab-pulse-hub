import { describe, expect, it } from 'vitest';
import {
  nearestTimelinePointIndex,
  timelineIndexForKey,
  timelineSectionForPoint,
  timelineTimeAtClientX
} from '../src/timeline.js';

const points = [{ timeMs: 0 }, { timeMs: 100 }, { timeMs: 300 }];
const sectionedPoints = [
  { timeMs: 0, source: { sectionIndex: 0 } },
  { timeMs: 100, source: { sectionIndex: 0 } },
  { timeMs: 200, source: { sectionIndex: 1 } }
];

describe('desktop timeline point lookup', () => {
  it('resolves the complete source stream with deterministic ties', () => {
    expect(nearestTimelinePointIndex([], 10)).toBeNull();
    expect(nearestTimelinePointIndex(points, -20)).toBe(0);
    expect(nearestTimelinePointIndex(points, 0)).toBe(0);
    expect(nearestTimelinePointIndex(points, 200)).toBe(1);
    expect(nearestTimelinePointIndex(points, 280)).toBe(2);
    expect(nearestTimelinePointIndex(points, 320)).toBe(2);
    expect(timelineIndexForKey('Home', 2, points.length)).toBe(0);
    expect(timelineIndexForKey('End', 0, points.length)).toBe(2);
    expect(timelineIndexForKey('ArrowLeft', 0, points.length)).toBe(0);
    expect(timelineIndexForKey('ArrowRight', 2, points.length)).toBe(2);
    expect(timelineIndexForKey('PageDown', 1, points.length)).toBeNull();
    expect(timelineIndexForKey('End', null, 0)).toBeNull();
    expect(timelineSectionForPoint(sectionedPoints, 2)).toBe(1);
    expect(timelineSectionForPoint(sectionedPoints, -1)).toBeNull();
    expect(timelineSectionForPoint(sectionedPoints, 3)).toBeNull();
  });

  it('clamps pointer coordinates to the logical stream duration', () => {
    expect(timelineTimeAtClientX(50, 100, 200, 1_000)).toBe(0);
    expect(timelineTimeAtClientX(200, 100, 200, 1_000)).toBe(500);
    expect(timelineTimeAtClientX(350, 100, 200, 1_000)).toBe(1_000);
    expect(timelineTimeAtClientX(0, 0, 0, 1_000)).toBeNull();
  });
});
