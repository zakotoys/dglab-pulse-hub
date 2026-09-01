import { encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import QRCode from 'qrcode';
import {
  createPlotScene,
  renderSvg,
  type RenderOptions,
  type WaveformStream
} from '@dglab-pulse-hub/core';

export type ImageFormat = 'svg' | 'png' | 'jpg';

export interface ImageExport {
  readonly format: 'svg' | 'png' | 'jpg';
  readonly mimeType: 'image/svg+xml' | 'image/png' | 'image/jpeg';
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly streamDigest: string;
}

export interface QrImageExport {
  readonly format: 'jpg';
  readonly mimeType: 'image/jpeg';
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

const QR_IMAGE_SIZE = 1_024;
const QR_QUIET_ZONE_MODULES = 4;

/** Render the already-verified QR envelope as a printable JPEG artifact. */
export function renderQrImage(content: string): QrImageExport {
  if (typeof content !== 'string' || content.length === 0) {
    throw new TypeError('QR content must be non-empty text.');
  }
  const symbol = QRCode.create(content, { errorCorrectionLevel: 'M' });
  const moduleCount = symbol.modules.size;
  const totalModules = moduleCount + QR_QUIET_ZONE_MODULES * 2;
  const scale = Math.max(1, Math.floor(QR_IMAGE_SIZE / totalModules));
  const renderedSize = totalModules * scale;
  const offset = Math.floor((QR_IMAGE_SIZE - renderedSize) / 2);
  const rgba = new Uint8Array(QR_IMAGE_SIZE * QR_IMAGE_SIZE * 4);
  rgba.fill(255);

  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (symbol.modules.get(row, column) !== 1) continue;
      const left = offset + (column + QR_QUIET_ZONE_MODULES) * scale;
      const top = offset + (row + QR_QUIET_ZONE_MODULES) * scale;
      for (let y = top; y < top + scale; y += 1) {
        const rowOffset = y * QR_IMAGE_SIZE * 4;
        for (let x = left; x < left + scale; x += 1) {
          const pixelOffset = rowOffset + x * 4;
          rgba[pixelOffset] = 0;
          rgba[pixelOffset + 1] = 0;
          rgba[pixelOffset + 2] = 0;
          rgba[pixelOffset + 3] = 255;
        }
      }
    }
  }

  return Object.freeze({
    format: 'jpg',
    mimeType: 'image/jpeg',
    bytes: encodeJpeg({
      data: Buffer.from(rgba),
      width: QR_IMAGE_SIZE,
      height: QR_IMAGE_SIZE
    }, 100).data,
    width: QR_IMAGE_SIZE,
    height: QR_IMAGE_SIZE
  });
}

export function renderPreviewImage(
  stream: WaveformStream,
  format: ImageFormat,
  options: RenderOptions = {}
): ImageExport {
  assertRenderableStream(stream);
  const scene = createPlotScene(stream, options);
  if (format === 'svg') {
    const text = renderSvg(stream, options);
    return Object.freeze({
      format: 'svg',
      mimeType: 'image/svg+xml',
      bytes: new TextEncoder().encode(text),
      width: scene.width,
      height: scene.height,
      streamDigest: stream.digest
    });
  }
  const rgba = new Uint8Array(scene.width * scene.height * 4);
  for (let index = 0; index < scene.width * scene.height; index += 1) {
    rgba[index * 4] = 255;
    rgba[index * 4 + 1] = 255;
    rgba[index * 4 + 2] = 255;
    rgba[index * 4 + 3] = 255;
  }
  drawLine(rgba, scene.width, scene.height, scene.padding, scene.padding, scene.padding, scene.height - scene.padding, [156, 163, 175, 255]);
  drawLine(rgba, scene.width, scene.height, scene.padding, scene.height - scene.padding, scene.width - scene.padding, scene.height - scene.padding, [156, 163, 175, 255]);
  for (let index = 1; index < scene.points.length; index += 1) {
    const previous = scene.points[index - 1];
    const current = scene.points[index];
    if (previous === undefined || current === undefined) continue;
    drawLine(rgba, scene.width, scene.height, previous.x, previous.intensityY, current.x, current.intensityY, [225, 29, 72, 255]);
    drawLine(rgba, scene.width, scene.height, previous.x, previous.frequencyY, current.x, current.frequencyY, [37, 99, 235, 255]);
  }
  let bytes: Uint8Array;
  let mimeType: ImageExport['mimeType'];
  let outputFormat: 'png' | 'jpg';
  if (format === 'png') {
    const png = new PNG({ width: scene.width, height: scene.height });
    png.data = Buffer.from(rgba);
    bytes = PNG.sync.write(png);
    mimeType = 'image/png';
    outputFormat = 'png';
  } else if (format === 'jpg') {
    bytes = encodeJpeg({
      data: Buffer.from(rgba),
      width: scene.width,
      height: scene.height
    }, 90).data;
    mimeType = 'image/jpeg';
    outputFormat = 'jpg';
  } else {
    throw new Error('Unsupported image format: ' + format);
  }
  return Object.freeze({
    format: outputFormat,
    mimeType,
    bytes,
    width: scene.width,
    height: scene.height,
    streamDigest: stream.digest
  });
}

function drawLine(
  pixels: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: readonly [number, number, number, number]
): void {
  if (![x0, y0, x1, y1].every(Number.isFinite)) return;
  let x = Math.round(x0);
  let y = Math.round(y0);
  const endX = Math.round(x1);
  const endY = Math.round(y1);
  const dx = Math.abs(endX - x);
  const sx = x < endX ? 1 : -1;
  const dy = -Math.abs(endY - y);
  const sy = y < endY ? 1 : -1;
  let error = dx + dy;
  while (true) {
    if (x >= 0 && x < width && y >= 0 && y < height) {
      const offset = (y * width + x) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
    }
    if (x === endX && y === endY) break;
    const doubled = 2 * error;
    if (doubled >= dy) {
      error += dy;
      x += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y += sy;
    }
  }
}

function assertRenderableStream(stream: WaveformStream): void {
  if (stream === null || typeof stream !== 'object' || !Array.isArray(stream.points) ||
      typeof stream.digest !== 'string' || !Number.isFinite(stream.totalDurationMs) || stream.totalDurationMs < 0) {
    throw new TypeError('Waveform stream is not renderable.');
  }
  for (const point of stream.points) {
    if (point === null || typeof point !== 'object' ||
        !Number.isSafeInteger(point.index) || point.index < 0 ||
        !Number.isFinite(point.timeMs) || point.timeMs < 0 ||
        !Number.isFinite(point.durationMs) || point.durationMs < 0 ||
        !Number.isFinite(point.frequencyIndex) ||
        !Number.isFinite(point.intensity) || point.intensity < 0 || point.intensity > 100) {
      throw new TypeError('Waveform stream contains an invalid point.');
    }
  }
}
