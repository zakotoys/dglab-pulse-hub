#!/usr/bin/env node
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  applyPulseEdit,
  atomicWriteFile,
  decodeQr,
  encodeQr,
  exportBatch,
  exportPulse,
  inspectBatch,
  inspectPulse,
  renderPreviewImage,
  type BatchInput
} from '@dglab-pulse-hub/application';
import {
  DIAGNOSTIC_CODES,
  parsePulse,
  semanticallyEqual,
  type Diagnostic,
  type Pulse,
  type WaveformStream
} from '@dglab-pulse-hub/core';

interface CorpusFile {
  readonly path: string;
  readonly name: string;
  readonly bytes: Uint8Array;
}

interface Failure {
  readonly kind: string;
  readonly file: string;
  readonly detail: string;
}

interface MutableReport {
  readonly sourceDirectory: string;
  files: number;
  accepted: number;
  rejected: number;
  parseThrows: number;
  inspectSuccess: number;
  sourceExports: number;
  canonicalExports: number;
  qrRoundTrips: number;
  renderedImages: number;
  edits: number;
  batchInspectSuccess: number;
  batchExportSuccess: number;
  writtenArtifacts: number;
  warningCount: number;
  failureCount: number;
  readonly warningCodes: Map<string, number>;
  readonly rejectedCodes: Map<string, number>;
  readonly failures: Failure[];
}

interface CorpusReport {
  readonly sourceDirectory: string;
  readonly files: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly parseThrows: number;
  readonly inspectSuccess: number;
  readonly sourceExports: number;
  readonly canonicalExports: number;
  readonly qrRoundTrips: number;
  readonly renderedImages: number;
  readonly edits: number;
  readonly batchInspectSuccess: number;
  readonly batchExportSuccess: number;
  readonly writtenArtifacts: number;
  readonly warningCount: number;
  readonly warningCodes: Readonly<Record<string, number>>;
  readonly rejectedCodes: Readonly<Record<string, number>>;
  readonly failureCount: number;
  readonly failures: readonly Failure[];
}

const EXPECTED_QR_UNSUPPORTED_CODES: ReadonlySet<string> = new Set([
  DIAGNOSTIC_CODES.QR_SECTION_LIMIT,
  DIAGNOSTIC_CODES.QR_FIRST_SECTION_DISABLED,
  DIAGNOSTIC_CODES.QR_INTENSITY
]);

async function pulseFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await pulseFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.pulse')) files.push(path);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function diagnostics(report: MutableReport, values: readonly Diagnostic[]): void {
  for (const diagnostic of values) {
    if (diagnostic.severity === 'warning') {
      report.warningCount += 1;
      increment(report.warningCodes, diagnostic.code);
    }
  }
}

function failure(report: MutableReport, kind: string, file: string, detail: string): void {
  report.failureCount += 1;
  if (report.failures.length < 40) report.failures.push({ kind, file, detail });
}

function isExpectedQrUnsupported(diagnostics: readonly Diagnostic[]): boolean {
  const errors = diagnostics.filter((item) => item.severity === 'error');
  return errors.length > 0 && errors.every((item) => EXPECTED_QR_UNSUPPORTED_CODES.has(item.code));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function streamError(stream: WaveformStream): string | null {
  if (!Number.isFinite(stream.totalDurationMs) || stream.totalDurationMs < 0)
    return 'invalid total duration';
  if (!Number.isFinite(stream.timeGranularityMs) || stream.timeGranularityMs <= 0)
    return 'invalid time granularity';
  let previousTime = -1;
  for (let index = 0; index < stream.points.length; index += 1) {
    const point = stream.points[index];
    if (
      point === undefined ||
      point.index !== index ||
      !Number.isSafeInteger(point.index) ||
      point.timeMs < previousTime ||
      !Number.isFinite(point.timeMs) ||
      point.timeMs < 0 ||
      !Number.isFinite(point.durationMs) ||
      point.durationMs <= 0 ||
      !Number.isFinite(point.frequencyIndex) ||
      !Number.isFinite(point.intensity) ||
      point.intensity < 0 ||
      point.intensity > 100
    ) {
      return 'stream contains an invalid or non-finite point';
    }
    previousTime = point.timeMs;
  }
  for (const segment of stream.segments) {
    if (
      !Number.isFinite(segment.startMs) ||
      segment.startMs < 0 ||
      !Number.isFinite(segment.durationMs) ||
      segment.durationMs < 0 ||
      !Number.isSafeInteger(segment.pointStart) ||
      segment.pointStart < 0 ||
      !Number.isSafeInteger(segment.pointCount) ||
      segment.pointCount < 0
    ) {
      return 'stream contains an invalid segment';
    }
  }
  return null;
}

function imageError(format: 'svg' | 'png' | 'jpg', bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) return format + ' image is empty';
  if (format === 'svg') {
    const text = new TextDecoder().decode(bytes);
    return text.startsWith('<svg ') && text.includes('</svg>') ? null : 'invalid SVG output';
  }
  if (format === 'png') {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    return signature.every((value, index) => bytes[index] === value)
      ? null
      : 'invalid PNG signature';
  }
  return bytes[0] === 0xff && bytes[1] === 0xd8 ? null : 'invalid JPG signature';
}

function mapObject(map: Map<string, number>): Readonly<Record<string, number>> {
  return Object.fromEntries(
    [...map.entries()].sort(([left], [right]) => left.localeCompare(right))
  );
}

function finalize(report: MutableReport): CorpusReport {
  return {
    sourceDirectory: report.sourceDirectory,
    files: report.files,
    accepted: report.accepted,
    rejected: report.rejected,
    parseThrows: report.parseThrows,
    inspectSuccess: report.inspectSuccess,
    sourceExports: report.sourceExports,
    canonicalExports: report.canonicalExports,
    qrRoundTrips: report.qrRoundTrips,
    renderedImages: report.renderedImages,
    edits: report.edits,
    batchInspectSuccess: report.batchInspectSuccess,
    batchExportSuccess: report.batchExportSuccess,
    writtenArtifacts: report.writtenArtifacts,
    warningCount: report.warningCount,
    warningCodes: mapObject(report.warningCodes),
    rejectedCodes: mapObject(report.rejectedCodes),
    failureCount: report.failureCount,
    failures: Object.freeze([...report.failures])
  };
}

export async function verifyCorpus(directory: string): Promise<CorpusReport> {
  const root = resolve(directory);
  const paths = await pulseFiles(root);
  const report: MutableReport = {
    sourceDirectory: root,
    files: paths.length,
    accepted: 0,
    rejected: 0,
    parseThrows: 0,
    inspectSuccess: 0,
    sourceExports: 0,
    canonicalExports: 0,
    qrRoundTrips: 0,
    renderedImages: 0,
    edits: 0,
    batchInspectSuccess: 0,
    batchExportSuccess: 0,
    writtenArtifacts: 0,
    warningCount: 0,
    failureCount: 0,
    warningCodes: new Map(),
    rejectedCodes: new Map(),
    failures: []
  };
  if (paths.length === 0) failure(report, 'empty-corpus', '.', 'No .pulse files were found.');

  const files: CorpusFile[] = [];
  const accepted: Array<CorpusFile & { readonly pulse: Pulse }> = [];
  for (const path of paths) {
    const name = relative(root, path);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(path));
    } catch {
      failure(report, 'read', name, 'file could not be read');
      continue;
    }
    const file = { path, name, bytes };
    files.push(file);
    let parsed;
    try {
      parsed = parsePulse(bytes);
    } catch (error) {
      report.parseThrows += 1;
      failure(report, 'parse-throw', name, error instanceof Error ? error.message : String(error));
      continue;
    }
    diagnostics(report, parsed.diagnostics);
    if (parsed.pulse === null) {
      report.rejected += 1;
      for (const diagnostic of parsed.diagnostics) {
        if (diagnostic.severity === 'error') increment(report.rejectedCodes, diagnostic.code);
      }
      continue;
    }
    report.accepted += 1;
    accepted.push({ ...file, pulse: parsed.pulse });

    try {
      const inspected = inspectPulse(bytes, {
        input: { displayName: basename(path), bytes: bytes.byteLength },
        includeStream: true
      });
      diagnostics(report, inspected.diagnostics);
      if (
        inspected.status !== 'success' ||
        inspected.data === null ||
        inspected.data.stream === null
      ) {
        failure(
          report,
          'inspect',
          name,
          inspected.status + ': ' + inspected.diagnostics.map((item) => item.code).join(',')
        );
        continue;
      }
      report.inspectSuccess += 1;
      const streamFailure = streamError(inspected.data.stream);
      if (streamFailure !== null) failure(report, 'stream', name, streamFailure);

      for (const mode of ['source', 'canonical'] as const) {
        const exported = exportPulse(bytes, { displayName: basename(path), mode });
        diagnostics(report, exported.diagnostics);
        if (
          exported.status !== 'success' ||
          exported.data === null ||
          exported.data.roundTripVerified !== true
        ) {
          failure(
            report,
            'export-' + mode,
            name,
            exported.status + ': ' + exported.diagnostics.map((item) => item.code).join(',')
          );
          continue;
        }
        if (mode === 'source' && !equalBytes(bytes, exported.data.bytes)) {
          failure(report, 'export-source-bytes', name, 'source export changed the original bytes');
        }
        const roundTrip = parsePulse(exported.data.bytes);
        if (roundTrip.pulse === null || !semanticallyEqual(parsed.pulse, roundTrip.pulse)) {
          failure(
            report,
            'export-round-trip-' + mode,
            name,
            roundTrip.diagnostics.map((item) => item.code).join(',')
          );
        } else if (mode === 'source') report.sourceExports += 1;
        else report.canonicalExports += 1;
      }

      const encoded = encodeQr(parsed.pulse);
      diagnostics(report, encoded.diagnostics);
      if (encoded.content === null) {
        if (!isExpectedQrUnsupported(encoded.diagnostics)) {
          failure(
            report,
            'qr-encode',
            name,
            encoded.diagnostics.map((item) => item.code).join(',')
          );
        }
      } else {
        const decoded = decodeQr(encoded.content);
        diagnostics(report, decoded.diagnostics);
        const roundTrip = decoded.pulseText === null ? null : parsePulse(decoded.pulseText);
        // The App QR envelope always materializes three sections, so compare
        // its canonical envelope instead of the source section count.
        const reencoded =
          roundTrip?.pulse === null || roundTrip === null ? null : encodeQr(roundTrip.pulse);
        if (
          !decoded.accepted ||
          roundTrip?.pulse === null ||
          roundTrip === null ||
          reencoded === null ||
          reencoded.content !== encoded.content
        ) {
          failure(
            report,
            'qr-round-trip',
            name,
            [...decoded.diagnostics, ...(reencoded?.diagnostics ?? [])]
              .map((item) => item.code)
              .join(',')
          );
        } else report.qrRoundTrips += 1;
      }

      for (const format of ['svg', 'png', 'jpg'] as const) {
        const image = renderPreviewImage(inspected.data.stream, format);
        const invalidImage = imageError(format, image.bytes);
        if (invalidImage !== null) failure(report, 'render-' + format, name, invalidImage);
        else report.renderedImages += 1;
      }

      const sectionIndex = parsed.pulse.sections.findIndex(
        (section) => section.pulseElement.points.length > 0
      );
      const firstPoint =
        sectionIndex < 0 ? undefined : parsed.pulse.sections[sectionIndex]?.pulseElement.points[0];
      if (firstPoint !== undefined) {
        const edited = applyPulseEdit(bytes, {
          command: {
            kind: 'strength',
            sectionIndex,
            pointIndex: 0,
            value: firstPoint.strength === 100 ? 0 : 100
          }
        });
        diagnostics(report, edited.diagnostics);
        if (
          edited.status !== 'success' ||
          edited.data === null ||
          edited.data.roundTripVerified !== true
        ) {
          failure(
            report,
            'edit',
            name,
            edited.status + ': ' + edited.diagnostics.map((item) => item.code).join(',')
          );
        } else report.edits += 1;
      }
    } catch (error) {
      failure(
        report,
        'pipeline-throw',
        name,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  const totalBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  const maxBytes = Math.max(1, ...files.map((file) => file.bytes.byteLength));
  const batchInputs: readonly BatchInput[] = files.map((file, index) => ({
    id: 'file-' + String(index),
    displayName: 'file-' + String(index) + '.pulse',
    content: file.bytes
  }));
  const expectedByIndex = files.map((file) => accepted.some((item) => item.path === file.path));
  const batchOptions = {
    concurrency: 8,
    maxFiles: Math.max(1, files.length),
    maxTotalBytes: Math.max(1, totalBytes),
    maxBytes
  };
  const inspectedBatch = await inspectBatch(batchInputs, batchOptions);
  diagnostics(report, inspectedBatch.diagnostics);
  if (inspectedBatch.status !== 'success' || inspectedBatch.data === null) {
    failure(
      report,
      'batch-inspect',
      '.',
      inspectedBatch.status + ': ' + inspectedBatch.diagnostics.map((item) => item.code).join(',')
    );
  } else {
    report.batchInspectSuccess = inspectedBatch.data.items.filter(
      (item, index) => item.status === (expectedByIndex[index] ? 'success' : 'rejected')
    ).length;
    if (report.batchInspectSuccess !== files.length)
      failure(
        report,
        'batch-inspect-items',
        '.',
        'batch item statuses differ from single-file parsing'
      );
  }

  const exportedBatch = await exportBatch(
    files.map((file, index) => ({
      id: 'file-' + String(index),
      displayName: 'file-' + String(index) + '.pulse',
      outputDisplayName: 'export-' + String(index) + '.pulse',
      content: file.bytes
    })),
    { ...batchOptions, mode: 'canonical' }
  );
  diagnostics(report, exportedBatch.diagnostics);
  let artifactDirectory: string | null = null;
  try {
    if (exportedBatch.status !== 'success' || exportedBatch.data === null) {
      failure(
        report,
        'batch-export',
        '.',
        exportedBatch.status + ': ' + exportedBatch.diagnostics.map((item) => item.code).join(',')
      );
    } else {
      report.batchExportSuccess = exportedBatch.data.items.filter((item, index) => {
        if (!expectedByIndex[index]) return item.status === 'rejected';
        return item.status === 'success' && item.data?.roundTripVerified === true;
      }).length;
      if (report.batchExportSuccess !== files.length)
        failure(report, 'batch-export-items', '.', 'batch export item results are incomplete');
      artifactDirectory = await mkdtemp(join(tmpdir(), 'pulse-corpus-verify-'));
      for (const item of exportedBatch.data.items) {
        if (item.status !== 'success' || item.data === null) continue;
        const target = join(artifactDirectory, item.data.displayName);
        const written = await atomicWriteFile(target, item.data.bytes);
        if (written.status !== 'success') {
          failure(
            report,
            'write',
            item.displayName,
            written.diagnostics.map((diagnostic) => diagnostic.code).join(',')
          );
          continue;
        }
        const persisted = new Uint8Array(await readFile(target));
        if (!equalBytes(persisted, item.data.bytes))
          failure(
            report,
            'write-bytes',
            item.displayName,
            'written bytes differ from export bytes'
          );
        else report.writtenArtifacts += 1;
      }
    }
  } finally {
    if (artifactDirectory !== null) await rm(artifactDirectory, { recursive: true, force: true });
  }
  return finalize(report);
}

function printReport(report: CorpusReport): void {
  process.stdout.write(
    [
      'pulse corpus verification',
      'source: ' + report.sourceDirectory,
      'files: ' + report.files,
      'accepted/rejected: ' + report.accepted + '/' + report.rejected,
      'parse throws: ' + report.parseThrows,
      'inspect success: ' + report.inspectSuccess,
      'source/canonical exports: ' + report.sourceExports + '/' + report.canonicalExports,
      'QR round-trips: ' + report.qrRoundTrips,
      'rendered images: ' + report.renderedImages,
      'edits: ' + report.edits,
      'batch inspect/export items: ' + report.batchInspectSuccess + '/' + report.batchExportSuccess,
      'written artifacts: ' + report.writtenArtifacts,
      'intentional warnings: ' + report.warningCount,
      'unexpected failures: ' + report.failureCount,
      'rejected diagnostic codes: ' +
        (Object.entries(report.rejectedCodes)
          .map(([code, count]) => code + '=' + count)
          .join(', ') || 'none'),
      'warning diagnostic codes: ' +
        (Object.entries(report.warningCodes)
          .map(([code, count]) => code + '=' + count)
          .join(', ') || 'none')
    ].join('\n') + '\n'
  );
  if (report.failureCount > 0) {
    for (const item of report.failures)
      process.stdout.write('  ' + item.kind + ' [' + item.file + '] ' + item.detail + '\n');
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const directory = args.find((arg) => arg !== '--json');
  if (directory === undefined || args.some((arg) => arg !== '--json' && arg === '')) {
    process.stderr.write('Usage: corpus-verify <directory> [--json]\n');
    return 2;
  }
  try {
    const report = await verifyCorpus(directory);
    if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else printReport(report);
    return report.failureCount === 0 ? 0 : 1;
  } catch {
    process.stderr.write('Corpus verification could not be completed.\n');
    return 1;
  }
}

const entryPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
const modulePath = fileURLToPath(import.meta.url);
if (entryPath !== null && entryPath === modulePath) process.exitCode = await main();
