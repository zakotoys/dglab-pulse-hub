import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';
import { operationEnvelopeSchema } from '@dglab-pulse-hub/contracts';

const VALID_TEXT =
  'Dungeonlab+pulse:0,1,8=27,7,32,3,1/0-1,50-0,100-1';
const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

function io(): { stdout: string[]; stderr: string[]; adapter: { stdout: { write: (text: string) => void }; stderr: { write: (text: string) => void } } } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    adapter: {
      stdout: { write: (text: string) => stdout.push(text) },
      stderr: { write: (text: string) => stderr.push(text) }
    }
  };
}

describe('CLI adapter', () => {
  it('uses the public envelope for JSON inspect output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-'));
    directories.push(directory);
    const input = join(directory, 'source.pulse');
    await writeFile(input, VALID_TEXT, 'utf8');
    const capture = io();
    const code = await runCli(['inspect', input, '--json'], capture.adapter);
    expect(code).toBe(0);
    const envelope = JSON.parse(capture.stdout.join('')) as unknown;
    expect(operationEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('returns a contract envelope for QR JSON commands', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-'));
    directories.push(directory);
    const input = join(directory, 'source.pulse');
    await writeFile(input, VALID_TEXT, 'utf8');
    const capture = io();
    const code = await runCli(['qr-encode', input, '--json'], capture.adapter);
    expect(code).toBe(0);
    const envelope = JSON.parse(capture.stdout.join('')) as { result?: unknown };
    expect(operationEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.result).toBeTruthy();
  });

  it('rejects unknown options instead of silently ignoring them', async () => {
    const capture = io();
    const code = await runCli(['inspect', '--future'], capture.adapter);
    expect(code).toBe(2);
    expect(capture.stderr.join('')).toContain('Unknown option');
  });

  it('reports QR file read failures as failed operations', async () => {
    const capture = io();
    const code = await runCli(['qr-decode', '/definitely/missing/pulse.qr', '--json'], capture.adapter);
    expect(code).toBe(1);
    const envelope = JSON.parse(capture.stdout.join('')) as { operation?: unknown; status?: unknown; result?: unknown };
    expect(operationEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope).toMatchObject({ operation: 'qr-decode', status: 'failed', result: null });
  });

  it('does not overwrite an existing export unless requested', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-'));
    directories.push(directory);
    const input = join(directory, 'source.pulse');
    const output = join(directory, 'out.pulse');
    await writeFile(input, VALID_TEXT, 'utf8');
    await writeFile(output, 'original', 'utf8');
    const capture = io();
    const code = await runCli(['export', input, output, '--json'], capture.adapter);
    expect(code).toBe(2);
    expect(await readFile(output, 'utf8')).toBe('original');
  });

  it('preserves untouched source bytes by default and canonicalizes explicitly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-'));
    directories.push(directory);
    const input = join(directory, 'source.pulse');
    const source = VALID_TEXT + '\r\n';
    await writeFile(input, source, 'utf8');
    const untouched = join(directory, 'untouched.pulse');
    const canonical = join(directory, 'canonical.pulse');
    const first = io();
    expect(await runCli(['export', input, untouched], first.adapter)).toBe(0);
    expect(await readFile(untouched, 'utf8')).toBe(source);
    const second = io();
    expect(await runCli(['export', input, canonical, '--canonical'], second.adapter)).toBe(0);
    expect(await readFile(canonical, 'utf8')).toBe(VALID_TEXT);
  });

  it('rejects render encoder failures as a JSON operation envelope', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-cli-'));
    directories.push(directory);
    const input = join(directory, 'source.pulse');
    await writeFile(input, VALID_TEXT, 'utf8');
    const output = join(directory, 'preview.png');
    // A directory at the target path forces the adapter write branch while
    // still exercising the complete render operation.
    await mkdir(output);
    const capture = io();
    const code = await runCli(['render', input, output, '--format', 'png', '--json'], capture.adapter);
    expect(code).toBe(2);
    expect(operationEnvelopeSchema.safeParse(JSON.parse(capture.stdout.join(''))).success).toBe(true);
  });
});
