import type { WaveformPoint, WaveformStream } from './types.js';

export type PlaybackState = 'idle' | 'playing' | 'paused' | 'stopped' | 'ended';

export interface PlaybackSnapshot {
  readonly state: PlaybackState;
  readonly currentTimeMs: number;
  readonly currentPointIndex: number | null;
  readonly totalDurationMs: number;
  readonly progress: number;
}

export interface PlaybackClock {
  readonly now: () => number;
}

export interface PlaybackScheduler {
  readonly set: (callback: () => void, delayMs: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const defaultClock: PlaybackClock = Object.freeze({
  now: () => (globalThis.performance?.now() ?? Date.now())
});

const defaultScheduler: PlaybackScheduler = Object.freeze({
  set: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
  clear: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
});

export class PreviewPlaybackController {
  private readonly stream: WaveformStream;
  private readonly clock: PlaybackClock;
  private readonly scheduler: PlaybackScheduler;
  private readonly listeners = new Set<(snapshot: PlaybackSnapshot) => void>();
  private state: PlaybackState = 'idle';
  private currentTimeMs = 0;
  private anchorClockMs = 0;
  private anchorTimeMs = 0;
  private timer: unknown = null;

  public constructor(
    stream: WaveformStream,
    options: {
      readonly clock?: PlaybackClock;
      readonly scheduler?: PlaybackScheduler;
    } = {}
  ) {
    this.stream = stream;
    this.clock = options.clock ?? defaultClock;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  public subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  public snapshot(): PlaybackSnapshot {
    const total = this.stream.totalDurationMs;
    const currentPointIndex = pointAtTime(this.stream.points, this.currentTimeMs);
    return Object.freeze({
      state: this.state,
      currentTimeMs: this.currentTimeMs,
      currentPointIndex,
      totalDurationMs: total,
      progress: total <= 0 ? 0 : Math.min(1, this.currentTimeMs / total)
    });
  }

  public play(): PlaybackSnapshot {
    if (this.stream.totalDurationMs <= 0) {
      this.state = 'ended';
      this.currentTimeMs = 0;
      return this.emit();
    }
    if (this.state === 'ended' || this.state === 'stopped') {
      this.currentTimeMs = this.state === 'ended' ? 0 : this.currentTimeMs;
    }
    this.state = 'playing';
    this.anchorClockMs = this.clock.now();
    this.anchorTimeMs = this.currentTimeMs;
    this.schedule();
    return this.emit();
  }

  public pause(): PlaybackSnapshot {
    if (this.state === 'playing') {
      this.updateFromClock();
      this.state = 'paused';
      this.clearTimer();
      return this.emit();
    }
    return this.snapshot();
  }

  public stop(): PlaybackSnapshot {
    this.clearTimer();
    this.state = 'stopped';
    this.currentTimeMs = 0;
    this.anchorTimeMs = 0;
    return this.emit();
  }

  public seek(timeMs: number): PlaybackSnapshot {
    this.updateFromClock();
    this.currentTimeMs = clamp(timeMs, 0, this.stream.totalDurationMs);
    if (this.state === 'playing') {
      // A seek establishes a new clock origin; otherwise the next tick would
      // add elapsed time measured from the pre-seek origin a second time.
      this.anchorClockMs = this.clock.now();
      this.anchorTimeMs = this.currentTimeMs;
    }
    if (this.currentTimeMs >= this.stream.totalDurationMs && this.stream.totalDurationMs > 0) {
      this.state = 'ended';
      this.clearTimer();
    } else if (this.state === 'ended') {
      this.state = 'paused';
    }
    return this.emit();
  }

  public tick(): PlaybackSnapshot {
    if (this.state === 'playing') {
      this.updateFromClock();
      return this.emit();
    }
    return this.snapshot();
  }

  public dispose(): void {
    this.clearTimer();
    this.listeners.clear();
  }

  private updateFromClock(): void {
    if (this.state !== 'playing') return;
    const elapsed = Math.max(0, this.clock.now() - this.anchorClockMs);
    this.currentTimeMs = clamp(this.anchorTimeMs + elapsed, 0, this.stream.totalDurationMs);
    if (this.currentTimeMs >= this.stream.totalDurationMs) {
      this.currentTimeMs = this.stream.totalDurationMs;
      this.state = 'ended';
      this.clearTimer();
    }
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = this.scheduler.set(() => {
      this.timer = null;
      this.tick();
      if (this.state === 'playing') this.schedule();
    }, Math.max(10, this.stream.timeGranularityMs));
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.scheduler.clear(this.timer);
      this.timer = null;
    }
  }

  private emit(): PlaybackSnapshot {
    const snapshot = this.snapshot();
    this.listeners.forEach((listener) => listener(snapshot));
    return snapshot;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

function pointAtTime(points: readonly WaveformPoint[], timeMs: number): number | null {
  if (points.length === 0) return null;
  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const point = points[middle];
    if (point === undefined) break;
    if (timeMs < point.timeMs) {
      high = middle - 1;
    } else if (timeMs >= point.timeMs + point.durationMs) {
      low = middle + 1;
    } else {
      return middle;
    }
  }
  return Math.min(points.length - 1, Math.max(0, low));
}
