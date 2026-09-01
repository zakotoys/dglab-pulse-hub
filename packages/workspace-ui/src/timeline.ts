export interface TimelinePointLike {
  readonly timeMs: number;
}

export interface TimelineSectionPointLike {
  readonly source: {
    readonly sectionIndex: number;
  };
}

/** Return the source section for a selected stream point, or null for an
 * invalid index. Keeping this lookup separate ensures every timeline input
 * updates the section editor to the same source context. */
export function timelineSectionForPoint(
  points: readonly TimelineSectionPointLike[],
  pointIndex: number
): number | null {
  if (!Number.isSafeInteger(pointIndex) || pointIndex < 0 || pointIndex >= points.length)
    return null;
  const point = points[pointIndex];
  if (
    point === undefined ||
    !Number.isSafeInteger(point.source.sectionIndex) ||
    point.source.sectionIndex < 0
  )
    return null;
  return point.source.sectionIndex;
}

/** Resolve keyboard navigation against the logical stream, keeping the
 * selected index inside the available point range. */
export function timelineIndexForKey(
  key: string,
  currentIndex: number | null,
  pointCount: number
): number | null {
  if (!Number.isSafeInteger(pointCount) || pointCount <= 0) return null;
  const current =
    currentIndex === null || !Number.isSafeInteger(currentIndex)
      ? 0
      : Math.min(pointCount - 1, Math.max(0, currentIndex));
  if (key === 'Home') return 0;
  if (key === 'End') return pointCount - 1;
  if (key === 'ArrowLeft') return Math.max(0, current - 1);
  if (key === 'ArrowRight') return Math.min(pointCount - 1, current + 1);
  return null;
}

/**
 * Finds the closest source point by logical time without requiring the
 * visual polyline to contain every point. The input is expected to be in
 * stream order; ties resolve to the earlier point for stable hover behavior.
 */
export function nearestTimelinePointIndex(
  points: readonly TimelinePointLike[],
  timeMs: number
): number | null {
  if (points.length === 0 || !Number.isFinite(timeMs)) return null;
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const point = points[middle];
    if (point === undefined || point.timeMs < timeMs) low = middle + 1;
    else high = middle;
  }
  const right = low;
  const left = Math.max(0, right - 1);
  const leftPoint = points[left];
  const rightPoint = points[right];
  if (leftPoint === undefined) return rightPoint === undefined ? null : right;
  if (rightPoint === undefined) return left;
  const leftDistance = Math.abs(timeMs - leftPoint.timeMs);
  const rightDistance = Math.abs(rightPoint.timeMs - timeMs);
  return leftDistance <= rightDistance ? left : right;
}

export function timelineTimeAtClientX(
  clientX: number,
  left: number,
  width: number,
  totalDurationMs: number
): number | null {
  if (
    ![clientX, left, width, totalDurationMs].every(Number.isFinite) ||
    width <= 0 ||
    totalDurationMs < 0
  )
    return null;
  const ratio = Math.max(0, Math.min(1, (clientX - left) / width));
  return ratio * totalDurationMs;
}
