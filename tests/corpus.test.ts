import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePulse } from '@dglab-pulse-hub/core';
import { buildReport } from '../scripts/corpus-report.js';
import { verifyCorpus } from '../scripts/corpus-verify.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = join(root, 'tests', 'fixtures');

describe('checked-in corpus fixtures', () => {
  it('matches every manifest expectation, including invalid encoding', async () => {
    const manifest = JSON.parse(await readFile(join(fixtureRoot, 'manifest.json'), 'utf8')) as {
      fixtures: readonly {
        path: string;
        encoding?: string;
        expectation: 'accepted' | 'rejected';
      }[];
    };
    for (const fixture of manifest.fixtures) {
      const raw = await readFile(join(fixtureRoot, fixture.path));
      const bytes =
        fixture.encoding === 'hex'
          ? Buffer.from(raw.toString('utf8').replace(/\s+/g, ''), 'hex')
          : raw;
      const parsed = parsePulse(new Uint8Array(bytes));
      expect(parsed.accepted, fixture.path).toBe(fixture.expectation === 'accepted');
      if (fixture.encoding === 'hex') {
        expect(
          parsed.diagnostics.some((item) => item.code === 'PULSE_RECOGNIZE_INVALID_ENCODING')
        ).toBe(true);
      }
    }
  });

  it('produces stable aggregate reports with no expectation mismatches', async () => {
    const first = await buildReport();
    const second = await buildReport();
    expect(first).toEqual(second);
    expect(first.expectationMismatches).toBe(0);
    expect(first.fileCount).toBeGreaterThan(0);
  });

  it('verifies the canonical fixed-section QR contract', async () => {
    const report = await verifyCorpus(fixtureRoot);

    expect(report.failureCount).toBe(0);
    expect(report.qrRoundTrips).toBe(2);
    expect(report.failures).toEqual([]);
  });
});
