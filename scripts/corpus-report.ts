#!/usr/bin/env node
import { readdir, readFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePulse,
  stableDigest,
  type Diagnostic,
  type ParseResult
} from '@dglab-pulse-hub/core';

type FixtureExpectation = 'accepted' | 'rejected';

interface ManifestFixture {
  readonly name: string;
  readonly path: string;
  readonly encoding?: 'utf8' | 'hex';
  readonly expectation: FixtureExpectation;
  readonly description: string;
}

interface Manifest {
  readonly schemaVersion: string;
  readonly fixtures: readonly ManifestFixture[];
}

interface FileReport {
  readonly name: string;
  readonly bytes: number;
  readonly digest: string;
  readonly accepted: boolean;
  readonly expected: FixtureExpectation | 'unknown';
  readonly sectionCount: number;
  readonly pointCount: number;
  readonly enabledSectionCount: number;
  readonly automaticPointCount: number;
  readonly modes: readonly number[];
  readonly diagnosticCodes: readonly string[];
}

interface CorpusReport {
  readonly schemaVersion: 'pulse-corpus-report-v1';
  readonly source: 'example' | 'synthetic-fixtures';
  readonly sourceDirectory: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly totalSections: number;
  readonly enabledSections: number;
  readonly totalPoints: number;
  readonly automaticPoints: number;
  readonly observed: {
    readonly sectionCounts: readonly number[];
    readonly pointCounts: readonly number[];
    readonly intensityRange: readonly [number, number] | null;
    readonly frequencyIndexRange: readonly [number, number] | null;
    readonly durationIndexRange: readonly [number, number] | null;
    readonly modes: readonly number[];
  };
  readonly files: readonly FileReport[];
  readonly expectationMismatches: number;
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const exampleDirectory = join(root, '.example');
const fixtureDirectory = join(root, 'tests', 'fixtures');
const manifestPath = join(fixtureDirectory, 'manifest.json');

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(): Promise<Manifest> {
  if (!(await exists(manifestPath))) return { schemaVersion: 'pulse-corpus-manifest-v1', fixtures: [] };
  const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (typeof value !== 'object' || value === null) throw new Error('Corpus manifest must be an object.');
  const record = value as Record<string, unknown>;
  const fixtures = Array.isArray(record.fixtures) ? record.fixtures : [];
  return {
    schemaVersion: typeof record.schemaVersion === 'string' ? record.schemaVersion : 'pulse-corpus-manifest-v1',
    fixtures: fixtures.filter((item): item is ManifestFixture => {
      if (typeof item !== 'object' || item === null) return false;
      const entry = item as Record<string, unknown>;
      return typeof entry.name === 'string' && typeof entry.path === 'string' &&
        (entry.expectation === 'accepted' || entry.expectation === 'rejected') &&
        typeof entry.description === 'string' &&
        (entry.encoding === undefined || entry.encoding === 'utf8' || entry.encoding === 'hex');
    }).sort((left, right) => left.name.localeCompare(right.name))
  };
}

async function sourceFiles(): Promise<{
  readonly source: CorpusReport['source'];
  readonly directory: string;
  readonly files: readonly { readonly name: string; readonly path: string; readonly expected: FixtureExpectation | 'unknown'; readonly encoding: 'utf8' | 'hex' }[];
}> {
  if (await exists(exampleDirectory)) {
    const names = (await readdir(exampleDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.pulse'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    return {
      source: 'example',
      directory: '.example',
      files: names.map((name) => ({ name, path: join(exampleDirectory, name), expected: 'unknown', encoding: 'utf8' }))
    };
  }
  const manifest = await readManifest();
  return {
    source: 'synthetic-fixtures',
    directory: 'tests/fixtures',
      files: manifest.fixtures.map((fixture) => ({
        name: fixture.name,
        path: join(root, 'tests', 'fixtures', fixture.path),
        expected: fixture.expectation,
        encoding: fixture.encoding ?? 'utf8'
      }))
  };
}

function pointStats(parsed: ParseResult): {
  readonly sectionCount: number;
  readonly pointCount: number;
  readonly enabledSectionCount: number;
  readonly automaticPointCount: number;
  readonly modes: readonly number[];
  readonly intensityRange: readonly [number, number] | null;
  readonly frequencyIndexRange: readonly [number, number] | null;
  readonly durationIndexRange: readonly [number, number] | null;
} {
  const sections = parsed.pulse?.sections ?? [];
  const points = sections.flatMap((section) => section.pulseElement.points);
  const intensities = points.map((point) => point.strength);
  const frequencies = sections.flatMap((section) => [section.frequencyStartIndex, section.frequencyEndIndex]);
  const durations = sections.map((section) => section.durationIndex);
  const range = (values: readonly number[]): readonly [number, number] | null =>
    values.length === 0 ? null : [Math.min(...values), Math.max(...values)];
  return {
    sectionCount: sections.length,
    pointCount: points.length,
    enabledSectionCount: sections.filter((section) => section.enabled).length,
    automaticPointCount: points.filter((point) => point.anchor === 0).length,
    modes: [...new Set(sections.map((section) => section.frequencyMode))].sort((a, b) => a - b),
    intensityRange: range(intensities),
    frequencyIndexRange: range(frequencies),
    durationIndexRange: range(durations)
  };
}

function reportFile(
  name: string,
  bytes: Uint8Array,
  expected: FixtureExpectation | 'unknown'
): FileReport {
  let parsed: ParseResult;
  try {
    parsed = parsePulse(bytes);
  } catch {
    parsed = {
      accepted: false,
      recognition: {
        format: 'unsupported',
        profile: 'unknown',
        ruleVersion: 'pulse-rules-v1',
        evidence: ['unverified'],
        source: null,
        diagnostics: []
      },
      syntax: null,
      pulse: null,
      diagnostics: []
    };
  }
  const stats = pointStats(parsed);
  const diagnostics: readonly Diagnostic[] = parsed.diagnostics;
  return {
    name,
    bytes: bytes.byteLength,
    digest: stableDigest(bytes),
    accepted: parsed.accepted,
    expected,
    sectionCount: stats.sectionCount,
    pointCount: stats.pointCount,
    enabledSectionCount: stats.enabledSectionCount,
    automaticPointCount: stats.automaticPointCount,
    modes: stats.modes,
    diagnosticCodes: [...new Set(diagnostics.map((diagnostic) => diagnostic.code))].sort()
  };
}

async function fixtureBytes(file: { readonly path: string; readonly encoding: 'utf8' | 'hex' }): Promise<Uint8Array> {
  const raw = await readFile(file.path);
  if (file.encoding !== 'hex') return new Uint8Array(raw);
  const text = raw.toString('utf8').replace(/\s+/g, '');
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(text)) throw new Error('Hex fixture is invalid.');
  return new Uint8Array(Buffer.from(text, 'hex'));
}

export async function buildReport(): Promise<CorpusReport> {
  const source = await sourceFiles();
  const reports: FileReport[] = [];
  for (const file of source.files) {
    try {
      reports.push(reportFile(file.name, await fixtureBytes(file), file.expected));
    } catch {
      reports.push({
        name: file.name,
        bytes: 0,
        digest: '',
        accepted: false,
        expected: file.expected,
        sectionCount: 0,
        pointCount: 0,
        enabledSectionCount: 0,
        automaticPointCount: 0,
        modes: [],
        diagnosticCodes: ['PULSE_ADAPTER_READ_FAILED']
      });
    }
  }
  reports.sort((left, right) => left.name.localeCompare(right.name));
  const acceptedReports = reports.filter((file) => file.accepted);
  const parsedStats = acceptedReports.map((file) => file);
  const ranges = (values: readonly number[]): readonly [number, number] | null =>
    values.length === 0 ? null : [Math.min(...values), Math.max(...values)];
  // Re-read accepted files for the observed scalar ranges. This keeps the
  // report schema compact while preserving deterministic per-file summaries.
  const intensityValues: number[] = [];
  const frequencyValues: number[] = [];
  const durationValues: number[] = [];
  for (const file of source.files) {
    const report = reports.find((item) => item.name === file.name);
    if (report?.accepted !== true) continue;
    try {
      const parsed = parsePulse(await fixtureBytes(file));
      const stats = pointStats(parsed);
      if (stats.intensityRange !== null) intensityValues.push(...stats.intensityRange);
      if (stats.frequencyIndexRange !== null) frequencyValues.push(...stats.frequencyIndexRange);
      if (stats.durationIndexRange !== null) durationValues.push(...stats.durationIndexRange);
    } catch {
      // The first pass already records the adapter failure; keep aggregation deterministic.
    }
  }
  const totalSections = reports.reduce((sum, file) => sum + file.sectionCount, 0);
  const enabledSections = reports.reduce((sum, file) => sum + file.enabledSectionCount, 0);
  const totalPoints = reports.reduce((sum, file) => sum + file.pointCount, 0);
  const automaticPoints = reports.reduce((sum, file) => sum + file.automaticPointCount, 0);
  return {
    schemaVersion: 'pulse-corpus-report-v1',
    source: source.source,
    sourceDirectory: source.directory,
    fileCount: reports.length,
    totalBytes: reports.reduce((sum, file) => sum + file.bytes, 0),
    totalSections,
    enabledSections,
    totalPoints,
    automaticPoints,
    observed: {
      sectionCounts: [...new Set(parsedStats.map((file) => file.sectionCount))].sort((a, b) => a - b),
      pointCounts: [...new Set(parsedStats.map((file) => file.pointCount))].sort((a, b) => a - b),
      intensityRange: ranges(intensityValues),
      frequencyIndexRange: ranges(frequencyValues),
      durationIndexRange: ranges(durationValues),
      modes: [...new Set(parsedStats.flatMap((file) => file.modes))].sort((a, b) => a - b)
    },
    files: reports,
    expectationMismatches: reports.filter((file) => file.expected !== 'unknown' &&
      ((file.expected === 'accepted') !== file.accepted)).length
  };
}

export function textReport(report: CorpusReport): string {
  const lines = [
    'pulse corpus report',
    'schema: ' + report.schemaVersion,
    'source: ' + report.source + ' (' + report.sourceDirectory + ')',
    'files: ' + report.fileCount,
    'bytes: ' + report.totalBytes,
    'sections: ' + report.totalSections + ' (' + report.enabledSections + ' enabled)',
    'points: ' + report.totalPoints + ' (' + report.automaticPoints + ' automatic)',
    'modes: ' + (report.observed.modes.join(',') || 'none'),
    'expectation mismatches: ' + report.expectationMismatches,
    '',
    'files:'
  ];
  for (const file of report.files) {
    lines.push('  ' + file.name + ' [' + (file.accepted ? 'accepted' : 'rejected') + '] ' +
      file.bytes + ' bytes, ' + file.sectionCount + ' sections, ' + file.pointCount + ' points');
  }
  return lines.join('\n') + '\n';
}

const entryPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
const modulePath = fileURLToPath(import.meta.url);
if (entryPath !== null && entryPath === modulePath) {
  const report = await buildReport();
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else process.stdout.write(textReport(report));
  if (report.expectationMismatches > 0) process.exitCode = 1;
}
