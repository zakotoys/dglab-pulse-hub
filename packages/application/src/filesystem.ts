import { createHash, randomUUID } from 'node:crypto';
import { linkSync, renameSync } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  open
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DIAGNOSTIC_CODES, makeDiagnostic, location, type Diagnostic } from '@dglab-pulse-hub/core';
import { operationResult, type OperationResult } from './result.js';

export interface FileReadData {
  readonly displayName: string;
  readonly byteSize: number;
  readonly digest: string;
  readonly content: Uint8Array;
}

export interface FileReadOptions {
  readonly maxBytes?: number;
}

export const DEFAULT_FILE_MAX_BYTES = 2_000_000;

function validMaxBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function invalidLimit(operation: string): OperationResult<never> {
  return operationResult(operation, 'rejected', null, [
    makeDiagnostic(
      DIAGNOSTIC_CODES.RESOURCE_BYTES_LIMIT,
      'error',
      'resource',
      'Byte limit must be a non-negative safe integer.',
      location('$')
    )
  ]);
}

function stableReadError(): string {
  return 'Unable to read input file.';
}

function stableWriteError(): string {
  return 'Unable to write output file.';
}

class FileTooLargeError extends Error {}
class NotRegularFileError extends Error {}

/** Read through an open descriptor in bounded chunks. The initial stat is only
 * an early rejection; the byte-by-byte budget remains enforced while reading
 * so a file that grows between stat and read cannot force an oversized
 * allocation. */
async function readBoundedFile(filePath: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(filePath, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new NotRegularFileError();
    if (info.size > maxBytes) throw new FileTooLargeError();
    const chunks: Buffer[] = [];
    let total = 0;
    const chunkSize = 64 * 1024;
    while (true) {
      const remaining = maxBytes - total;
      // Read one byte beyond the budget when the remaining window is small;
      // this detects growth without ever allocating maxBytes + 1 at once.
      const requested = remaining >= chunkSize ? chunkSize : remaining + 1;
      const buffer = Buffer.allocUnsafe(requested);
      const read = await handle.read(buffer, 0, requested, null);
      if (read.bytesRead === 0) break;
      if (read.bytesRead > remaining) throw new FileTooLargeError();
      total += read.bytesRead;
      chunks.push(
        read.bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, read.bytesRead)
      );
    }
    const finalInfo = await handle.stat();
    if (finalInfo.size > maxBytes || total > maxBytes) throw new FileTooLargeError();
    return new Uint8Array(Buffer.concat(chunks, total));
  } finally {
    await handle.close();
  }
}

export async function readInputFile(
  filePath: string,
  options: FileReadOptions = {}
): Promise<OperationResult<FileReadData>> {
  const safeOptions = options !== null && typeof options === 'object' ? options : {};
  const maxBytes = safeOptions.maxBytes ?? DEFAULT_FILE_MAX_BYTES;
  if (!validMaxBytes(maxBytes) || typeof filePath !== 'string' || filePath.length === 0) {
    return invalidLimit('read-file');
  }
  try {
    const content = await readBoundedFile(filePath, maxBytes);
    return operationResult(
      'read-file',
      'success',
      {
        displayName: sanitizeDisplayName(basename(filePath)),
        byteSize: content.byteLength,
        digest: createHash('sha256').update(content).digest('hex'),
        content
      },
      []
    );
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      return operationResult('read-file', 'rejected', null, [
        makeDiagnostic(
          DIAGNOSTIC_CODES.RECOGNIZE_SIZE_LIMIT,
          'error',
          'resource',
          'Input file exceeds the byte limit.',
          location('$')
        )
      ]);
    }
    if (error instanceof NotRegularFileError) {
      return operationResult('read-file', 'rejected', null, [
        makeDiagnostic(
          DIAGNOSTIC_CODES.ADAPTER_READ,
          'error',
          'adapter',
          'Input path is not a regular file.',
          location('$')
        )
      ]);
    }
    return operationResult('read-file', 'failed', null, [
      makeDiagnostic(
        DIAGNOSTIC_CODES.ADAPTER_READ,
        'error',
        'adapter',
        stableReadError(),
        location('$')
      )
    ]);
  }
}

export interface AtomicWriteOptions {
  readonly overwrite?: boolean;
  readonly signal?: AbortSignal;
}

export interface FileWriteData {
  readonly displayName: string;
  readonly byteSize: number;
}

function validAtomicWriteOptions(value: unknown): value is AtomicWriteOptions {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  if (options.overwrite !== undefined && typeof options.overwrite !== 'boolean') return false;
  if (options.signal !== undefined) {
    const signal = options.signal;
    if (
      typeof signal !== 'object' ||
      signal === null ||
      typeof (signal as { readonly aborted?: unknown }).aborted !== 'boolean'
    ) {
      return false;
    }
  }
  return true;
}

function invalidWriteOptions(): OperationResult<never> {
  return operationResult('write-file', 'rejected', null, [
    makeDiagnostic(
      DIAGNOSTIC_CODES.ADAPTER_WRITE,
      'error',
      'adapter',
      'Write options must be an object with a boolean overwrite flag and a valid signal.',
      location('$')
    )
  ]);
}

export async function atomicWriteFile(
  filePath: string,
  content: Uint8Array,
  options: AtomicWriteOptions = {}
): Promise<OperationResult<FileWriteData>> {
  if (typeof filePath !== 'string' || filePath.length === 0 || !(content instanceof Uint8Array)) {
    return operationResult('write-file', 'rejected', null, [
      makeDiagnostic(
        DIAGNOSTIC_CODES.ADAPTER_WRITE,
        'error',
        'adapter',
        'Output path and content are required.',
        location('$')
      )
    ]);
  }
  if (!validAtomicWriteOptions(options)) return invalidWriteOptions();
  const overwrite = options.overwrite === true;
  const bytes = new Uint8Array(content);
  const targetDirectory = dirname(filePath);
  const displayName = sanitizeDisplayName(basename(filePath));
  let temporaryPath: string | null = null;
  try {
    if (options.signal?.aborted) {
      return operationResult('write-file', 'cancelled', null, [
        makeDiagnostic(
          'PULSE_TASK_CANCELLED',
          'info',
          'task',
          'Write was cancelled.',
          location('$')
        )
      ]);
    }
    await mkdir(targetDirectory, { recursive: true });
    if (!overwrite) {
      try {
        await access(filePath);
        return operationResult('write-file', 'rejected', null, [
          makeDiagnostic(
            DIAGNOSTIC_CODES.ADAPTER_CONFLICT,
            'error',
            'adapter',
            'Output file already exists.',
            location('$')
          )
        ]);
      } catch {
        // Target does not exist, which is the expected path for safe create.
      }
    }
    temporaryPath = join(targetDirectory, '.' + displayName + '.' + randomUUID() + '.tmp');
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.signal?.aborted) {
      await rm(temporaryPath, { force: true });
      temporaryPath = null;
      return operationResult('write-file', 'cancelled', null, [
        makeDiagnostic(
          'PULSE_TASK_CANCELLED',
          'info',
          'task',
          'Write was cancelled.',
          location('$')
        )
      ]);
    }
    // The final same-directory metadata operation is deliberately synchronous.
    // It is the cancellation linearization point: an AbortController cannot
    // dispatch between the last check above and this syscall on the JS thread.
    // Using an awaited rename/link here would re-open a cancellation window.
    if (overwrite) {
      renameSync(temporaryPath, filePath);
    } else {
      // `rename` replaces an existing destination on POSIX, so it cannot be
      // used for a no-clobber write after the advisory access check above.
      // Creating a hard link to the fully-synced temporary file is atomic and
      // fails with EEXIST when another writer won the race.
      try {
        linkSync(temporaryPath, filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        temporaryPath = null;
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { readonly code?: unknown }).code)
            : '';
        if (code === 'EEXIST') {
          return operationResult('write-file', 'rejected', null, [
            makeDiagnostic(
              DIAGNOSTIC_CODES.ADAPTER_CONFLICT,
              'error',
              'adapter',
              'Output file was created concurrently.',
              location('$')
            )
          ]);
        }
        throw error;
      }
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    temporaryPath = null;
    return operationResult(
      'write-file',
      'success',
      {
        displayName,
        byteSize: bytes.byteLength
      },
      []
    );
  } catch (error) {
    if (temporaryPath !== null) await rm(temporaryPath, { force: true }).catch(() => undefined);
    return operationResult('write-file', 'failed', null, [
      makeDiagnostic(
        DIAGNOSTIC_CODES.ADAPTER_WRITE,
        'error',
        'adapter',
        stableWriteError(),
        location('$')
      )
    ]);
  }
}

export interface ArtifactDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly byteSize: number;
  readonly expiresAt: number;
  readonly contentType: string;
}

export interface ArtifactPutOptions {
  readonly contentType?: string;
}

const ARTIFACT_DIRECTORY_PREFIX = 'dglab-pulse-';
const ARTIFACT_OWNER_FILE = '.owner';
const ARTIFACT_OWNER_TOKEN = randomUUID();

interface ArtifactOwnerRecord {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
}

function isArtifactOwnerRecord(value: unknown): value is ArtifactOwnerRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.pid === 'number' &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.token === 'string' &&
    record.token.length > 0
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { readonly code?: unknown }).code)
        : '';
    return code === 'EPERM';
  }
}

export class TempArtifactStore {
  private directory: string | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly artifacts = new Map<
    string,
    { readonly path: string; readonly descriptor: ArtifactDescriptor }
  >();
  private readonly consuming = new Set<string>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private activePuts = 0;
  private idlePromise: Promise<void> | null = null;
  private idleResolve: (() => void) | null = null;

  public constructor(
    private readonly lifetimeMs = 15 * 60 * 1000,
    private readonly cleanupIntervalMs = Math.max(1_000, Math.floor(lifetimeMs / 2))
  ) {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) {
      throw new RangeError('Artifact lifetime must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(cleanupIntervalMs) || cleanupIntervalMs <= 0) {
      throw new RangeError('Artifact cleanup interval must be a positive safe integer.');
    }
  }

  public async init(): Promise<void> {
    if (this.disposed) throw new Error('Artifact store is disposed.');
    if (this.directory !== null) return;
    if (this.initPromise !== null) return this.initPromise;
    const pending = (async (): Promise<void> => {
      await this.cleanupOrphanDirectories();
      const directory = await mkdtemp(join(tmpdir(), ARTIFACT_DIRECTORY_PREFIX));
      try {
        const owner: ArtifactOwnerRecord = {
          version: 1,
          pid: process.pid,
          token: ARTIFACT_OWNER_TOKEN
        };
        await writeFile(join(directory, ARTIFACT_OWNER_FILE), JSON.stringify(owner), {
          encoding: 'utf8',
          mode: 0o600
        });
        this.directory = directory;
        this.cleanupTimer = setInterval(() => {
          void this.cleanupExpired();
        }, this.cleanupIntervalMs);
        this.cleanupTimer.unref?.();
      } catch (error) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    })();
    this.initPromise = pending;
    try {
      await pending;
    } finally {
      if (this.initPromise === pending) this.initPromise = null;
    }
  }

  private async cleanupOrphanDirectories(): Promise<void> {
    let entries;
    try {
      entries = await readdir(tmpdir(), { withFileTypes: true });
    } catch {
      return;
    }
    const staleBefore = Date.now() - Math.max(this.lifetimeMs, this.cleanupIntervalMs);
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory() || !entry.name.startsWith(ARTIFACT_DIRECTORY_PREFIX)) return;
        const directory = join(tmpdir(), entry.name);
        try {
          let owner: unknown;
          try {
            owner = JSON.parse(
              await readFile(join(directory, ARTIFACT_OWNER_FILE), 'utf8')
            ) as unknown;
          } catch {
            const info = await stat(directory).catch(() => null);
            if (info === null || info.mtimeMs > staleBefore) return;
            await rm(directory, { recursive: true, force: true });
            return;
          }
          if (!isArtifactOwnerRecord(owner)) {
            const info = await stat(directory).catch(() => null);
            if (info === null || info.mtimeMs > staleBefore) return;
            await rm(directory, { recursive: true, force: true });
            return;
          }
          // A matching PID is only trustworthy when the per-process owner token
          // also matches. This handles PID reuse after an unclean process stop
          // while preserving directories owned by another live process.
          if (owner.pid === process.pid) {
            if (owner.token === ARTIFACT_OWNER_TOKEN) return;
            await rm(directory, { recursive: true, force: true });
            return;
          }
          if (processIsAlive(owner.pid)) return;
          await rm(directory, { recursive: true, force: true });
        } catch {
          // Cleanup is best effort; the active store still gets an isolated
          // directory and the periodic sweep can retry this entry later.
        }
      })
    );
  }

  public async put(
    displayName: string,
    content: Uint8Array,
    options: ArtifactPutOptions = {}
  ): Promise<ArtifactDescriptor> {
    if (this.disposed) throw new Error('Artifact store is disposed.');
    if (!(content instanceof Uint8Array)) throw new TypeError('Artifact content must be bytes.');
    if (typeof displayName !== 'string') throw new TypeError('Artifact display name must be text.');
    this.activePuts += 1;
    let path: string | null = null;
    let registered = false;
    try {
      await this.init();
      if (this.disposed || this.directory === null) throw new Error('Artifact store is disposed.');
      const id = randomUUID();
      const safeName = sanitizeDisplayName(displayName);
      path = join(this.directory, id + '-' + safeName);
      const contentType =
        typeof options.contentType === 'string' &&
        options.contentType.length <= 127 &&
        /^[A-Za-z0-9!#$%&*+.^_`|~-]+\/[A-Za-z0-9!#$%&*+.^_`|~-]+$/.test(options.contentType)
          ? options.contentType
          : 'application/octet-stream';
      await writeFile(path, new Uint8Array(content), { mode: 0o600 });
      const descriptor: ArtifactDescriptor = Object.freeze({
        id,
        displayName: safeName,
        byteSize: content.byteLength,
        expiresAt: Date.now() + this.lifetimeMs,
        contentType
      });
      this.artifacts.set(id, { path, descriptor });
      registered = true;
      return descriptor;
    } finally {
      if (!registered && path !== null) await rm(path, { force: true }).catch(() => undefined);
      this.activePuts -= 1;
      if (this.activePuts === 0 && this.idleResolve !== null) {
        this.idleResolve();
        this.idleResolve = null;
        this.idlePromise = null;
      }
    }
  }

  public async read(id: string): Promise<Uint8Array | null> {
    if (
      typeof id !== 'string' ||
      id.length > 128 ||
      !/^[A-Za-z0-9._~-]+$/.test(id) ||
      this.consuming.has(id)
    )
      return null;
    const artifact = this.artifacts.get(id);
    if (artifact === undefined) return null;
    if (artifact.descriptor.expiresAt <= Date.now()) {
      await this.remove(id);
      return null;
    }
    try {
      const bytes = new Uint8Array(await readFile(artifact.path));
      if (bytes.byteLength !== artifact.descriptor.byteSize) {
        await this.remove(id);
        return null;
      }
      return bytes;
    } catch {
      await this.remove(id);
      return null;
    }
  }

  /** Atomically claim and remove an artifact for a one-shot download. */
  public async consume(
    id: string
  ): Promise<{ readonly descriptor: ArtifactDescriptor; readonly bytes: Uint8Array } | null> {
    if (
      typeof id !== 'string' ||
      id.length > 128 ||
      !/^[A-Za-z0-9._~-]+$/.test(id) ||
      this.consuming.has(id)
    )
      return null;
    const artifact = this.artifacts.get(id);
    if (artifact === undefined) return null;
    if (artifact.descriptor.expiresAt <= Date.now()) {
      await this.remove(id);
      return null;
    }
    this.consuming.add(id);
    this.artifacts.delete(id);
    try {
      const bytes = new Uint8Array(await readFile(artifact.path));
      if (bytes.byteLength !== artifact.descriptor.byteSize) return null;
      return Object.freeze({ descriptor: artifact.descriptor, bytes });
    } catch {
      return null;
    } finally {
      this.consuming.delete(id);
      await rm(artifact.path, { force: true }).catch(() => undefined);
    }
  }

  public descriptor(id: string): ArtifactDescriptor | null {
    if (typeof id !== 'string' || id.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(id)) return null;
    const artifact = this.artifacts.get(id);
    if (artifact === undefined) return null;
    if (artifact.descriptor.expiresAt <= Date.now()) {
      void this.remove(id);
      return null;
    }
    return artifact.descriptor;
  }

  public async remove(id: string): Promise<void> {
    const artifact = this.artifacts.get(id);
    if (artifact === undefined) return;
    this.artifacts.delete(id);
    this.consuming.delete(id);
    await rm(artifact.path, { force: true }).catch(() => undefined);
  }

  public async cleanupExpired(now = Date.now()): Promise<void> {
    for (const [id, artifact] of this.artifacts) {
      if (artifact.descriptor.expiresAt <= now) await this.remove(id);
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed && this.directory === null && this.initPromise === null) return;
    this.disposed = true;
    const pending = this.initPromise;
    if (pending !== null) await pending.catch(() => undefined);
    if (this.activePuts > 0) {
      if (this.idlePromise === null) {
        this.idlePromise = new Promise<void>((resolve) => {
          this.idleResolve = resolve;
        });
      }
      await this.idlePromise;
    }
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const id of [...this.artifacts.keys()]) await this.remove(id);
    if (this.directory !== null) {
      await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
      this.directory = null;
    }
  }
}

export function sanitizeDisplayName(name: string): string {
  const source = typeof name === 'string' ? name : 'pulse-output.pulse';
  const base = basename(source).replace(/[\u0000-\u001f\u007f]/g, '_');
  const normalized = base.replace(/[\\/]+/g, '_').trim();
  if (normalized.length === 0 || normalized === '.' || normalized === '..')
    return 'pulse-output.pulse';
  return normalized.slice(0, 180);
}
