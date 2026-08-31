import type { WaveformPoint, WaveformStream } from './types.js';

export interface RenderOptions {
  readonly width?: number;
  readonly height?: number;
  readonly title?: string;
  readonly maxRenderedPoints?: number;
  readonly showLabels?: boolean;
}

export interface PlotScenePoint {
  readonly x: number;
  readonly intensityY: number;
  readonly frequencyY: number;
  readonly sourceIndex: number;
}

export interface PlotScene {
  readonly width: number;
  readonly height: number;
  readonly padding: number;
  readonly points: readonly PlotScenePoint[];
  readonly streamDigest: string;
  readonly title: string;
}

const MAX_RENDER_PIXELS = 4_000_000;

export function createPlotScene(
  stream: WaveformStream,
  options: RenderOptions = {}
): PlotScene {
  let width = clampDimension(options.width ?? 1200);
  let height = clampDimension(options.height ?? 520);
  // Image adapters allocate one RGBA byte per channel. Bound the product as
  // well as each dimension so an otherwise valid request cannot allocate
  // hundreds of megabytes in a single preview operation.
  const pixels = width * height;
  if (pixels > MAX_RENDER_PIXELS) {
    const scale = Math.sqrt(MAX_RENDER_PIXELS / pixels);
    width = Math.max(160, Math.floor(width * scale));
    height = Math.max(160, Math.floor(height * scale));
  }
  const padding = 48;
  const requestedMaxPoints = options.maxRenderedPoints ?? 5000;
  const maxPoints = Number.isSafeInteger(requestedMaxPoints)
    ? Math.max(2, requestedMaxPoints)
    : 5000;
  const points = downsample(stream.points, maxPoints);
  // Empty streams are valid (for example, when every section is disabled).
  // Keep the derived range finite so future labels/paths cannot inherit the
  // reduce identities of +/-Infinity.
  const minFrequency = points.length === 0
    ? 0
    : points.reduce(
      (value, point) => Math.min(value, point.frequencyIndex),
      Number.POSITIVE_INFINITY
    );
  const maxFrequency = points.length === 0
    ? 0
    : points.reduce(
      (value, point) => Math.max(value, point.frequencyIndex),
      Number.NEGATIVE_INFINITY
    );
  const frequencySpan = Math.max(1, maxFrequency - minFrequency);
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  const scenePoints = points.map((point) => ({
    x: padding + (point.timeMs / Math.max(1, stream.totalDurationMs)) * innerWidth,
    intensityY: padding + (1 - point.intensity / 100) * innerHeight,
    frequencyY: padding + (1 - (point.frequencyIndex - minFrequency) / frequencySpan) * innerHeight,
    sourceIndex: point.index
  }));
  return Object.freeze({
    width,
    height,
    padding,
    points: Object.freeze(scenePoints),
    streamDigest: stream.digest,
    title: options.title ?? 'Pulse waveform preview'
  });
}

export function renderSvg(
  stream: WaveformStream,
  options: RenderOptions = {}
): string {
  const scene = createPlotScene(stream, options);
  const intensityPath = scene.points
    .map((point, index) => (index === 0 ? 'M' : 'L') + point.x.toFixed(2) + ',' + point.intensityY.toFixed(2))
    .join(' ');
  const frequencyPath = scene.points
    .map((point, index) => (index === 0 ? 'M' : 'L') + point.x.toFixed(2) + ',' + point.frequencyY.toFixed(2))
    .join(' ');
  const labels = options.showLabels === false ? '' :
    '<text x="' + scene.padding + '" y="24" class="title">' + escapeXml(scene.title) + '</text>' +
    '<text x="' + scene.padding + '" y="' + (scene.height - 12) + '" class="axis-label">time (ms)</text>' +
    '<text x="12" y="' + (scene.padding + 4) + '" class="axis-label">100</text>' +
    '<text x="22" y="' + (scene.height - scene.padding) + '" class="axis-label">0</text>';
  const circles = scene.points
    .slice(0, 2000)
    .map((point) =>
      '<circle cx="' + point.x.toFixed(2) + '" cy="' + point.intensityY.toFixed(2) +
      '" r="2" data-source-index="' + point.sourceIndex + '" />'
    ).join('');
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + scene.width + '" height="' + scene.height +
      '" viewBox="0 0 ' + scene.width + ' ' + scene.height + '" role="img" aria-labelledby="title desc">',
    '<title id="title">' + escapeXml(scene.title) + '</title>',
    '<desc id="desc">Waveform stream with ' + stream.points.length + ' points and total duration ' +
      stream.totalDurationMs + ' milliseconds. Stream digest ' + escapeXml(stream.digest) + '.</desc>',
    '<style>.axis{stroke:#9ca3af;stroke-width:1}.grid{stroke:#e5e7eb;stroke-width:1}.intensity{fill:none;stroke:#e11d48;stroke-width:2}.frequency{fill:none;stroke:#2563eb;stroke-width:2}.points{fill:#be123c}.title{font:600 16px sans-serif;fill:#111827}.axis-label{font:12px sans-serif;fill:#4b5563}</style>',
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    '<line class="axis" x1="' + scene.padding + '" y1="' + scene.padding + '" x2="' + scene.padding +
      '" y2="' + (scene.height - scene.padding) + '"/>',
    '<line class="axis" x1="' + scene.padding + '" y1="' + (scene.height - scene.padding) +
      '" x2="' + (scene.width - scene.padding) + '" y2="' + (scene.height - scene.padding) + '"/>',
    '<path class="intensity" d="' + intensityPath + '"/>',
    '<path class="frequency" d="' + frequencyPath + '"/>',
    '<g class="points">' + circles + '</g>',
    labels,
    '</svg>'
  ].join('');
}

function downsample(
  points: readonly WaveformPoint[],
  maxPoints: number
): readonly WaveformPoint[] {
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  const sampled: WaveformPoint[] = [];
  for (let index = 0; index < maxPoints; index += 1) {
    const point = points[Math.round(index * step)];
    if (point !== undefined) sampled.push(point);
  }
  return sampled;
}

function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return 1200;
  return Math.min(8000, Math.max(160, Math.round(value)));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
