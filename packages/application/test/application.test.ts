import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyPulseEdit,
  atomicWriteFile,
  decodeQr,
  diffPulses,
  encodeQr,
  exportBatch,
  exportPulse,
  inspectBatch,
  inspectPulse,
  readInputFile,
  renderPreviewImage,
  SingleFileTask,
  TempArtifactStore,
  toOperationDto
} from '../src/index.js';
import { operationResult } from '../src/result.js';
import { operationEnvelopeSchema } from '@dglab-pulse-hub/contracts';
import { expandWaveform, parsePulse, sourceSpan } from '@dglab-pulse-hub/core';

const VALID_TEXT =
  'Dungeonlab+pulse:0,1,8=27,7,32,3,1/0-1,50-0,100-1';

function qrEnvelopeFor(text: string): string {
  const base64 = Buffer.from(text, 'utf8').toString('base64');
  return '#DGLAB-PULSE#' + gzipSync(Buffer.from(base64, 'utf8')).toString('hex');
}

describe('application boundaries', () => {
  it('encodes empty streams without non-finite render coordinates', () => {
    const pulse = parsePulse(
      'Dungeonlab+pulse:0,1,0=0,0,0,1,0/0-1,100-1+section+10,20,0,3,0/100-1,0-1'
    ).pulse;
    expect(pulse).not.toBeNull();
    if (pulse === null) return;
    const stream = expandWaveform(pulse).stream;
    expect(stream).not.toBeNull();
    if (stream === null) return;
    for (const format of ['svg', 'png', 'jpg'] as const) {
      const image = renderPreviewImage(stream, format, { width: 160, height: 160 });
      expect(image.bytes.byteLength).toBeGreaterThan(0);
      if (format === 'svg') {
        expect(new TextDecoder().decode(image.bytes)).not.toMatch(/(?:NaN|Infinity)/);
      }
    }
  });
  it('encodes a parsed pulse once and produces a contract-safe QR envelope', () => {
    const encoded = encodeQr(VALID_TEXT);
    expect(encoded.content).toMatch(/^#DGLAB-PULSE#[0-9a-f]+$/);
    const decoded = decodeQr(encoded.content ?? '');
    expect(decoded.accepted).toBe(true);
    expect(decoded.pulseText).toBeTruthy();
  });

  it('rejects unsupported runtime export options instead of falling back', () => {
    const result = exportPulse(VALID_TEXT, { format: 'other' as never });
    expect(result.status).toBe('rejected');
    expect(result.data).toBeNull();
    expect(result.diagnostics.some((item) => item.code === 'PULSE_EXPORT_UNSUPPORTED_FORMAT')).toBe(true);

    const mode = exportPulse(VALID_TEXT, { mode: 'future' as never });
    expect(mode.status).toBe('rejected');
    expect(mode.diagnostics.some((item) => item.code === 'PULSE_EXPORT_UNSUPPORTED_MODE')).toBe(true);
  });

  it('rejects invalid atomic write options before touching the filesystem', async () => {
    const invalidOverwrite = await atomicWriteFile(
      join(tmpdir(), 'pulse-invalid-write-options.pulse'),
      new Uint8Array([1]),
      { overwrite: 'yes' as never }
    );
    expect(invalidOverwrite.status).toBe('rejected');
    expect(invalidOverwrite.data).toBeNull();
    expect(invalidOverwrite.diagnostics[0]?.code).toBe('PULSE_ADAPTER_WRITE_FAILED');

    const invalidSignal = await atomicWriteFile(
      join(tmpdir(), 'pulse-invalid-write-signal.pulse'),
      new Uint8Array([1]),
      { signal: { aborted: 'no' } as never }
    );
    expect(invalidSignal.status).toBe('rejected');
    expect(invalidSignal.data).toBeNull();
  });

  it('linearizes an atomic write before a queued cancellation can interrupt commit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-write-linearization-'));
    const path = join(directory, 'output.pulse');
    const controller = new AbortController();
    let abortedReads = 0;
    const signal = new Proxy(controller.signal, {
      get(target, property) {
        if (property === 'aborted') {
          abortedReads += 1;
          const value = target.aborted;
          if (abortedReads === 3) queueMicrotask(() => controller.abort());
          return value;
        }
        return Reflect.get(target, property, target);
      }
    }) as AbortSignal;
    try {
      const result = await atomicWriteFile(path, new Uint8Array([42]), { signal });
      expect(result.status).toBe('success');
      expect(controller.signal.aborted).toBe(true);
      expect(await readFile(path)).toEqual(Buffer.from([42]));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('projects inspect results through the strict public envelope', () => {
    const result = inspectPulse(VALID_TEXT);
    const envelope = toOperationDto(result);
    expect(operationEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain('sourceText');
  });

  it('keeps disabled section source points available without adding them to playback', () => {
    const text = 'Dungeonlab+pulse:0,1,0=0,0,0,1,1/0-1,100-1+section+0,0,0,1,0/25-0,75-1';
    const result = toOperationDto(inspectPulse(text));
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    const parsed = operationEnvelopeSchema.parse(result);
    const data = parsed.result as {
      metadata: { sections: Array<{ enabled: boolean; sourcePoints: Array<{ strengthDecimal: string }> }> };
      stream: { points: unknown[] };
    };
    expect(data.stream.points).toHaveLength(2);
    expect(data.metadata.sections[1]?.enabled).toBe(false);
    expect(data.metadata.sections[1]?.sourcePoints.map((point) => point.strengthDecimal)).toEqual(['25', '75']);
  });

  it('does not publish file bytes through the public read-file projection', () => {
    const envelope = toOperationDto(operationResult('read-file', 'success', {
      displayName: 'source.pulse',
      byteSize: 3,
      digest: 'abc123',
      content: new Uint8Array([1, 2, 3])
    }, []));
    expect(envelope.result).toEqual({ displayName: 'source.pulse', byteSize: 3, digest: 'abc123' });
    expect(JSON.stringify(envelope)).not.toContain('content');
  });

  it('rejects invalid batch limits without starting work', async () => {
    const result = await exportBatch(
      [{ displayName: 'one.pulse', content: VALID_TEXT }],
      { concurrency: 0, maxFiles: 0 }
    );
    expect(result.status).toBe('rejected');
    expect(result.data).toBeNull();
    expect(result.diagnostics.some((item) => item.code === 'PULSE_TASK_INPUT_LIMIT')).toBe(true);

    const malformedOptions = await inspectBatch(
      [{ displayName: 'one.pulse', content: VALID_TEXT }],
      null as never
    );
    expect(malformedOptions.status).toBe('success');
    expect(malformedOptions.data?.items).toHaveLength(1);
  });

  it('does not attach inspect data when stream expansion is rejected', () => {
    const result = inspectPulse(VALID_TEXT, { maxExpandedPoints: 1 });
    expect(result.status).toBe('rejected');
    expect(result.data).toBeNull();
    expect(result.diagnostics.some((item) => item.code === 'PULSE_RESOURCE_EXPANDED_POINTS_LIMIT')).toBe(true);
  });

  it('applies the input byte limit to QR-decompressed pulse text', () => {
    const repetitive = Array.from({ length: 1_000 }, () => '0-0').join(',');
    const oversizedPulse = 'Dungeonlab+pulse:0,1,0=0,0,99,1,1/' + repetitive;
    const envelope = qrEnvelopeFor(oversizedPulse);
    // Compression keeps the envelope below the limit while the decoded pulse
    // text is several kilobytes. This distinguishes the outer QR limit from
    // the nested pulse parser limit.
    expect(new TextEncoder().encode(envelope).byteLength).toBeLessThan(500);
    expect(new TextEncoder().encode(oversizedPulse).byteLength).toBeGreaterThan(500);
    const result = inspectPulse(envelope, { maxBytes: 500 });
    expect(result.status).toBe('rejected');
    expect(result.data).toBeNull();
    expect(result.diagnostics.some((item) => item.code === 'PULSE_RECOGNIZE_SIZE_LIMIT')).toBe(true);
  });

  it('rejects files that exceed the configured byte limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-read-limit-'));
    const path = join(directory, 'large.pulse');
    try {
      await writeFile(path, Buffer.alloc(32, 0x41));
      const result = await readInputFile(path, { maxBytes: 8 });
      expect(result.status).toBe('rejected');
      expect(result.data).toBeNull();
      expect(result.diagnostics[0]?.code).toBe('PULSE_RECOGNIZE_SIZE_LIMIT');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('applies byte limits to already-built Pulse inputs', () => {
    const parsed = parsePulse(VALID_TEXT);
    expect(parsed.pulse).not.toBeNull();
    if (parsed.pulse === null) return;

    const exported = exportPulse(parsed.pulse, { maxBytes: 8 });
    expect(exported.status).toBe('rejected');
    expect(exported.data).toBeNull();
    expect(exported.diagnostics.some((item) => item.code === 'PULSE_RECOGNIZE_SIZE_LIMIT' || item.code === 'PULSE_RESOURCE_BYTES_LIMIT')).toBe(true);

    const edited = applyPulseEdit(parsed.pulse, {
      maxBytes: 8,
      command: { kind: 'duration', sectionIndex: 0, value: 1 }
    });
    expect(edited.status).toBe('rejected');
    expect(edited.data).toBeNull();
    expect(edited.diagnostics.some((item) => item.code === 'PULSE_RECOGNIZE_SIZE_LIMIT' || item.code === 'PULSE_RESOURCE_BYTES_LIMIT')).toBe(true);

    const diff = diffPulses(parsed.pulse, parsed.pulse, { maxBytes: 8 });
    expect(diff.status).toBe('rejected');
    expect(diff.data).toBeNull();
    expect(diff.diagnostics.some((item) => item.code === 'PULSE_RECOGNIZE_SIZE_LIMIT' || item.code === 'PULSE_RESOURCE_BYTES_LIMIT')).toBe(true);
  });

  it('rejects QR encoding before parsing text above the decoded byte budget', () => {
    const result = encodeQr(VALID_TEXT, { maxDecodedBytes: 8 });
    expect(result.content).toBeNull();
    expect(result.diagnostics.some((item) => item.code === 'PULSE_RECOGNIZE_SIZE_LIMIT')).toBe(true);
  });

  it('rejects unsafe batch item IDs before projecting results', async () => {
    const result = await inspectBatch([
      { id: '../source', displayName: 'source.pulse', content: VALID_TEXT }
    ]);
    expect(result.status).toBe('rejected');
    expect(result.data).toBeNull();
    expect(result.diagnostics.some((item) => item.code === 'PULSE_TASK_INPUT_LIMIT')).toBe(true);
  });

  it('rejects an oversized batch item before starting nested work', async () => {
    let progressCalls = 0;
    const result = await inspectBatch([
      { displayName: 'large.pulse', content: new Uint8Array(32) }
    ], {
      maxBytes: 8,
      onProgress: () => { progressCalls += 1; }
    });
    expect(result.status).toBe('rejected');
    expect(result.data).toBeNull();
    expect(progressCalls).toBe(0);
    expect(result.diagnostics.some((item) => item.code === 'PULSE_TASK_INPUT_LIMIT')).toBe(true);
  });

  it('uses the terminal cancelled envelope without exposing a partial payload', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await inspectBatch([
      { displayName: 'cancelled.pulse', content: VALID_TEXT }
    ], { signal: controller.signal });
    expect(result.status).toBe('cancelled');
    expect(result.data).toBeNull();
    expect(result.diagnostics.some((item) => item.code === 'PULSE_TASK_CANCELLED')).toBe(true);
  });

  it('keeps single-file task transitions deterministic for cancellation and timeout', async () => {
    const cancelled = new SingleFileTask('cancel-me', 'inspect');
    const running = cancelled.run(async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return operationResult('inspect', signal.aborted ? 'cancelled' : 'success', null, []);
    });
    cancelled.cancel();
    const cancelledResult = await running;
    expect(cancelledResult.status).toBe('cancelled');
    expect(cancelled.snapshot().state).toBe('cancelled');

    const timed = new SingleFileTask('timeout-me', 'inspect');
    const timeoutResult = await timed.run(() => new Promise(() => undefined), { timeoutMs: 5 });
    expect(timeoutResult.status).toBe('failed');
    expect(timeoutResult.diagnostics[0]?.code).toBe('PULSE_TASK_TIMEOUT');
    expect(timed.snapshot().state).toBe('failed');
  });

  it('fails closed when a task operation returns an invalid result envelope', async () => {
    const invalidStatus = new SingleFileTask('invalid-status', 'inspect');
    const invalidStatusResult = await invalidStatus.run(() => ({
      status: 'future',
      data: { value: 1 },
      diagnostics: []
    } as never));
    expect(invalidStatusResult.status).toBe('failed');
    expect(invalidStatusResult.data).toBeNull();
    expect(invalidStatusResult.diagnostics[0]?.code).toBe('PULSE_TASK_INVALID_TRANSITION');

    const nullSuccess = new SingleFileTask('null-success', 'inspect');
    const nullSuccessResult = await nullSuccess.run(() => ({
      status: 'success',
      data: null,
      diagnostics: []
    } as never));
    expect(nullSuccessResult.status).toBe('failed');
    expect(nullSuccessResult.data).toBeNull();
    expect(nullSuccessResult.diagnostics[0]?.code).toBe('PULSE_TASK_INVALID_TRANSITION');

    const rejectedData = new SingleFileTask('rejected-data', 'inspect');
    const rejectedDataResult = await rejectedData.run(() => ({
      status: 'rejected',
      data: { value: 1 },
      diagnostics: []
    } as never));
    expect(rejectedDataResult.status).toBe('failed');
    expect(rejectedDataResult.data).toBeNull();
    expect(rejectedDataResult.diagnostics[0]?.code).toBe('PULSE_TASK_INVALID_TRANSITION');
  });

  it('settles a task promptly when cancellation aborts a non-cooperative operation', async () => {
    const task = new SingleFileTask('hanging-cancel', 'inspect');
    const running = task.run(() => new Promise<never>(() => undefined));
    await Promise.resolve();
    const cancelled = task.cancel();
    await expect(running).resolves.toMatchObject({ status: 'cancelled', data: null });
    expect(cancelled.status).toBe('cancelled');
    expect(task.snapshot().state).toBe('cancelled');
  });

  it('keeps timeout terminal when cancellation races the timeout callback', async () => {
    const task = new SingleFileTask('timeout-race', 'inspect');
    const running = task.run(() => new Promise<never>(() => undefined), { timeoutMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const cancellation = task.cancel();
    const result = await running;
    expect(result.status).toBe('failed');
    expect(result.diagnostics[0]?.code).toBe('PULSE_TASK_TIMEOUT');
    expect(cancellation.status).toBe('failed');
    expect(task.snapshot().state).toBe('failed');
  });

  it('serializes concurrent artifact-store initialization', async () => {
    const store = new TempArtifactStore(10_000, 10_000);
    try {
      const [first, second] = await Promise.all([
        store.put('first.txt', new Uint8Array([1])),
        store.put('second.txt', new Uint8Array([2]))
      ]);
      expect(await store.read(first.id)).toEqual(new Uint8Array([1]));
      expect(await store.read(second.id)).toEqual(new Uint8Array([2]));
    } finally {
      await store.dispose();
    }
  });

  it('distinguishes malformed gzip from a valid stream over the output limit', () => {
    const malformed = decodeQr('#DGLAB-PULSE#' + Buffer.from('not-a-gzip').toString('hex'));
    expect(malformed.accepted).toBe(false);
    expect(malformed.diagnostics.some((item) => item.code === 'PULSE_QR_INVALID_GZIP')).toBe(true);

    const oversized = gzipSync(Buffer.alloc(1024, 0x41));
    const limited = decodeQr('#DGLAB-PULSE#' + oversized.toString('hex'), {
      maxDecompressedBytes: 32
    });
    expect(limited.accepted).toBe(false);
    expect(limited.diagnostics.some((item) => item.code === 'PULSE_QR_DECOMPRESSED_LIMIT')).toBe(true);
    expect(limited.diagnostics.some((item) => item.code === 'PULSE_QR_INVALID_GZIP')).toBe(false);
  });

  it('rejects a valid gzip member followed by trailing bytes', () => {
    const encoded = encodeQr(VALID_TEXT);
    expect(encoded.content).not.toBeNull();
    const envelope = encoded.content!;
    const compressed = Buffer.from(envelope.slice('#DGLAB-PULSE#'.length), 'hex');
    const withTrailingBytes = Buffer.concat([compressed, Buffer.from([0, 1, 2])]);

    const decoded = decodeQr('#DGLAB-PULSE#' + withTrailingBytes.toString('hex'));

    expect(decoded.accepted).toBe(false);
    expect(decoded.pulseText).toBeNull();
    expect(decoded.diagnostics.some((item) => item.code === 'PULSE_QR_INVALID_GZIP')).toBe(true);
  });

  it('rejects non-canonical Base64 and accepts URL fragment envelopes', () => {
    const encoded = encodeQr(VALID_TEXT);
    expect(encoded.content).not.toBeNull();
    const content = encoded.content!;
    const compressed = Buffer.from(content.slice('#DGLAB-PULSE#'.length), 'hex');
    const decodedText = Buffer.from(compressed);
    // A valid gzip carrying a syntactically invalid Base64 payload exercises
    // the strict padding path without relying on forgiving Buffer decoding.
    const invalidBase64 = gzipSync(Buffer.from('Zh==', 'utf8'));
    const invalid = decodeQr('#DGLAB-PULSE#' + invalidBase64.toString('hex'));
    expect(invalid.diagnostics.some((item) => item.code === 'PULSE_QR_INVALID_BASE64')).toBe(true);
    expect(decodedText.byteLength).toBeGreaterThan(0);

    const fromUrl = decodeQr('https://example.test/share' + content);
    expect(fromUrl.accepted).toBe(true);
  });

  it('supports every explicit edit command and verifies the canonical round trip', () => {
    const source = 'Dungeonlab+pulse:0,1,0=10,20,1,3,1/0-1,50-0,100-1';
    const commands = [
      { kind: 'strength', sectionIndex: 0, pointIndex: 1, value: 42 },
      { kind: 'anchor', sectionIndex: 0, pointIndex: 1, value: 1 as const },
      { kind: 'frequency', sectionIndex: 0, startIndex: 11, endIndex: 22 },
      { kind: 'duration', sectionIndex: 0, value: 4 },
      {
        kind: 'add-point', sectionIndex: 0, atIndex: 1, point: {
          strength: 25,
          strengthDecimal: '25',
          strengthRaw: '25',
          anchor: 0 as const,
          sourceSpan: sourceSpan('', 0, 0)
        }
      },
      { kind: 'remove-point', sectionIndex: 0, pointIndex: 1 }
    ] as const;
    for (const command of commands) {
      const result = applyPulseEdit(source, { command });
      expect(result.status, command.kind).toBe('success');
      expect(result.data?.roundTripVerified, command.kind).toBe(true);
      expect(result.data?.changeRecords.length, command.kind).toBeGreaterThan(0);
      expect(parsePulse(result.data?.bytes ?? new Uint8Array()).accepted, command.kind).toBe(true);
    }
  });

  it('expires and atomically consumes artifacts', async () => {
    const store = new TempArtifactStore(10, 10);
    const artifact = await store.put('download.txt', new Uint8Array([7, 8]), { contentType: 'text/plain' });
    expect(store.descriptor(artifact.id)?.displayName).toBe('download.txt');
    const [first, second] = await Promise.all([store.consume(artifact.id), store.consume(artifact.id)]);
    expect([first, second].filter((value) => value !== null)).toHaveLength(1);
    expect(await store.consume(artifact.id)).toBeNull();
    const expired = await store.put('expired.txt', new Uint8Array([1]));
    await store.cleanupExpired(expired.expiresAt + 1);
    expect(store.descriptor(expired.id)).toBeNull();
    expect(await store.read(expired.id)).toBeNull();
    await store.dispose();
    await expect(store.put('after-close.txt', new Uint8Array([1]))).rejects.toThrow(/disposed/i);
  });

  it('copies artifact bytes, waits for disposal, and removes dead-process directories', async () => {
    const orphan = await mkdtemp(join(tmpdir(), 'dglab-pulse-'));
    await writeFile(join(orphan, '.owner'), JSON.stringify({ version: 1, pid: process.pid, token: 'stale-process-token' }));
    const deadOrphan = await mkdtemp(join(tmpdir(), 'dglab-pulse-'));
    await writeFile(join(deadOrphan, '.owner'), JSON.stringify({ version: 1, pid: Number.MAX_SAFE_INTEGER, token: 'dead' }));
    const store = new TempArtifactStore(10_000, 10_000);
    await store.init();
    try {
      await expect(access(orphan)).rejects.toThrow();
      await expect(access(deadOrphan)).rejects.toThrow();
      const source = new Uint8Array([3, 4]);
      const artifact = await store.put('copied.bin', source);
      source[0] = 99;
      expect(await store.read(artifact.id)).toEqual(new Uint8Array([3, 4]));
      const pending = Promise.allSettled([
        store.put('during-dispose-a.bin', new Uint8Array([1])),
        store.put('during-dispose-b.bin', new Uint8Array([2]))
      ]);
      await store.dispose();
      await pending;
      expect(await store.read(artifact.id)).toBeNull();
    } finally {
      await store.dispose();
      await rm(orphan, { recursive: true, force: true });
      await rm(deadOrphan, { recursive: true, force: true });
    }
  });

  it('cleans an artifact directory left by an abruptly stopped process', async () => {
    const childScript = [
      "import { TempArtifactStore } from './packages/application/src/filesystem.ts';",
      'const store = new TempArtifactStore(60_000, 60_000);',
      "await store.put('crash.txt', new Uint8Array([1, 2, 3]));",
      "console.log(store.directory);",
      'setInterval(() => undefined, 1_000);'
    ].join('\n');
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childScript], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const directory = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('artifact child did not initialize')), 5_000);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        const line = output.split(/\r?\n/)[0]?.trim();
        if (line !== undefined && line.length > 0) {
          clearTimeout(timeout);
          resolve(line);
        }
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code) => {
        if (output.trim() === '') {
          clearTimeout(timeout);
          reject(new Error('artifact child exited before initialization (' + String(code) + ')'));
        }
      });
    });
    try {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await expect(access(directory)).resolves.toBeUndefined();
      const store = new TempArtifactStore(60_000, 60_000);
      try {
        await store.init();
        await expect(access(directory)).rejects.toThrow();
      } finally {
        await store.dispose();
      }
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('redacts private source payloads and absolute paths in public projections', () => {
    const privateResult = operationResult('unknown', 'success', {
      sourceText: VALID_TEXT,
      bytes: new Uint8Array([1, 2, 3]),
      path: '/private/source.pulse'
    }, []);
    const envelope = toOperationDto(privateResult);
    expect(operationEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain(VALID_TEXT);
    expect(JSON.stringify(envelope)).not.toContain('/private/source.pulse');
    expect(JSON.stringify(envelope)).not.toContain('sourceText');
  });

  it('fails closed for malformed public payloads and source-bearing change values', () => {
    const malformedBatch = toOperationDto(operationResult('batch', 'success', { items: 'not-an-array' }, []));
    expect(malformedBatch.status).toBe('failed');
    expect(malformedBatch.result).toBeNull();

    const encoded = toOperationDto(operationResult('qr-encode', 'success', {
      content: '#DGLAB-PULSE#' + VALID_TEXT
    }, []));
    expect(encoded.status).toBe('failed');
    expect(encoded.result).toBeNull();

    const edited = toOperationDto(operationResult('edit', 'success', {
      format: 'pulse-text',
      mode: 'canonical',
      text: VALID_TEXT,
      bytes: new TextEncoder().encode(VALID_TEXT),
      byteSize: new TextEncoder().encode(VALID_TEXT).byteLength,
      sourceDigest: '0123456789abcdef',
      roundTripVerified: true,
      changeRecords: [{
        id: 'change-1',
        kind: 'edit',
        description: 'changed',
        path: 'sections[0].points[0].strength',
        before: VALID_TEXT,
        after: VALID_TEXT
      }]
    }, []));
    expect(edited.status).toBe('success');
    expect(JSON.stringify(edited)).not.toContain(VALID_TEXT);
  });

  it('normalizes non-success application results to a null payload', () => {
    const result = operationResult('inspect', 'failed', { partial: true }, []);
    expect(result.data).toBeNull();
  });
});
