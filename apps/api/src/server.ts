import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TempArtifactStore } from '@dglab-pulse-hub/application';
import { registerApiRoutes, type ApiRouteLimits } from './routes.js';

export interface ApiOptions {
  readonly maxBytes?: number;
  readonly maxExpandedPoints?: number;
  readonly maxExpandedDurationMs?: number;
  readonly maxBatchFiles?: number;
  readonly maxBatchTotalBytes?: number;
  readonly batchConcurrency?: number;
  readonly processingTimeoutMs?: number;
  readonly artifactLifetimeMs?: number;
  readonly artifactCleanupIntervalMs?: number;
  readonly artifactStore?: TempArtifactStore;
  readonly logger?: boolean;
  /** Set an explicit origin when the API is served separately from the web UI. */
  readonly corsOrigin?: string;
}

const DEFAULT_API_LIMITS = Object.freeze({
  maxBytes: 2_000_000,
  maxExpandedPoints: 1_000_000,
  maxExpandedDurationMs: 86_400_000,
  maxBatchFiles: 100,
  maxBatchTotalBytes: 20_000_000,
  batchConcurrency: 4,
  processingTimeoutMs: 90_000,
  artifactLifetimeMs: 15 * 60 * 1000,
  artifactCleanupIntervalMs: 60 * 1000
});

function validPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

export function buildServer(options: ApiOptions = {}): FastifyInstance {
  if (options.maxBytes !== undefined && !validPositiveSafeInteger(options.maxBytes)) {
    throw new RangeError('API maxBytes must be a positive safe integer.');
  }
  if (
    options.maxExpandedPoints !== undefined &&
    !validPositiveSafeInteger(options.maxExpandedPoints)
  ) {
    throw new RangeError('API maxExpandedPoints must be a positive safe integer.');
  }
  if (
    options.maxExpandedDurationMs !== undefined &&
    !validPositiveSafeInteger(options.maxExpandedDurationMs)
  ) {
    throw new RangeError('API maxExpandedDurationMs must be a positive safe integer.');
  }
  if (options.maxBatchFiles !== undefined && !validPositiveSafeInteger(options.maxBatchFiles)) {
    throw new RangeError('API maxBatchFiles must be a positive safe integer.');
  }
  if (
    options.maxBatchTotalBytes !== undefined &&
    !validPositiveSafeInteger(options.maxBatchTotalBytes)
  ) {
    throw new RangeError('API maxBatchTotalBytes must be a positive safe integer.');
  }
  if (
    options.batchConcurrency !== undefined &&
    !validPositiveSafeInteger(options.batchConcurrency)
  ) {
    throw new RangeError('API batchConcurrency must be a positive safe integer.');
  }
  if (
    options.processingTimeoutMs !== undefined &&
    !validPositiveSafeInteger(options.processingTimeoutMs)
  ) {
    throw new RangeError('API processingTimeoutMs must be a positive safe integer.');
  }
  if (
    options.artifactLifetimeMs !== undefined &&
    !validPositiveSafeInteger(options.artifactLifetimeMs)
  ) {
    throw new RangeError('API artifactLifetimeMs must be a positive safe integer.');
  }
  if (
    options.artifactCleanupIntervalMs !== undefined &&
    !validPositiveSafeInteger(options.artifactCleanupIntervalMs)
  ) {
    throw new RangeError('API artifactCleanupIntervalMs must be a positive safe integer.');
  }
  if (
    options.corsOrigin !== undefined &&
    (typeof options.corsOrigin !== 'string' ||
      options.corsOrigin.length === 0 ||
      (options.corsOrigin !== '*' && !isOrigin(options.corsOrigin)))
  ) {
    throw new RangeError('API corsOrigin must be "*" or a valid origin.');
  }
  const limits: ApiRouteLimits = {
    maxBytes: options.maxBytes ?? DEFAULT_API_LIMITS.maxBytes,
    maxExpandedPoints: options.maxExpandedPoints ?? DEFAULT_API_LIMITS.maxExpandedPoints,
    maxExpandedDurationMs:
      options.maxExpandedDurationMs ?? DEFAULT_API_LIMITS.maxExpandedDurationMs,
    maxBatchFiles: options.maxBatchFiles ?? DEFAULT_API_LIMITS.maxBatchFiles,
    maxBatchTotalBytes: options.maxBatchTotalBytes ?? DEFAULT_API_LIMITS.maxBatchTotalBytes,
    batchConcurrency: options.batchConcurrency ?? DEFAULT_API_LIMITS.batchConcurrency,
    processingTimeoutMs: options.processingTimeoutMs ?? DEFAULT_API_LIMITS.processingTimeoutMs
  };
  const artifactStore =
    options.artifactStore ??
    new TempArtifactStore(
      options.artifactLifetimeMs ?? DEFAULT_API_LIMITS.artifactLifetimeMs,
      options.artifactCleanupIntervalMs ?? DEFAULT_API_LIMITS.artifactCleanupIntervalMs
    );
  const ownsArtifactStore = options.artifactStore === undefined;
  const app = Fastify({
    logger: options.logger === true,
    // JSON envelopes add a small amount of framing; routes still enforce the
    // raw waveform byte limit before invoking application code.
    bodyLimit: Math.max(limits.maxBytes, limits.maxBatchTotalBytes) + 65_536
  });

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body)
  );
  void app.register(multipart, {
    // Let the adapter observe `truncated` and return the same contract
    // envelope as its own byte accounting.  Multipart's default exception
    // would otherwise bypass the operation mapper with a generic 413.
    throwFileSizeLimit: false,
    limits: {
      fileSize: limits.maxBytes,
      fieldSize: Math.min(limits.maxBytes, limits.maxBatchTotalBytes),
      files: limits.maxBatchFiles,
      fields: Math.max(8, limits.maxBatchFiles + 8),
      parts: limits.maxBatchFiles * 2 + 12
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header(
      'cross-origin-resource-policy',
      options.corsOrigin === undefined ? 'same-origin' : 'cross-origin'
    );
    reply.header('cache-control', 'no-store');
    const requestOrigin =
      typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
    const corsAllowed =
      options.corsOrigin !== undefined &&
      (options.corsOrigin === '*' ||
        requestOrigin === undefined ||
        requestOrigin === options.corsOrigin);
    if (corsAllowed) {
      reply.header('access-control-allow-origin', options.corsOrigin);
      reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
      reply.header('access-control-allow-headers', 'content-type');
      reply.header('access-control-max-age', '600');
      reply.header(
        'access-control-expose-headers',
        [
          'content-disposition',
          'x-pulse-result',
          'x-pulse-schema-version',
          'x-pulse-rule-version',
          'x-pulse-stream-digest'
        ].join(',')
      );
      reply.header('vary', 'Origin');
    }
    return payload;
  });

  if (options.corsOrigin !== undefined) {
    app.options('*', async (request, reply) => {
      const requestOrigin =
        typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
      if (
        options.corsOrigin !== '*' &&
        requestOrigin !== undefined &&
        requestOrigin !== options.corsOrigin
      ) {
        return reply.code(403).send();
      }
      return reply.code(204).send();
    });
  }

  app.addHook('onClose', async () => {
    if (ownsArtifactStore) await artifactStore.dispose();
    else await artifactStore.cleanupExpired();
  });

  registerApiRoutes(app, { limits, artifactStore });
  return app;
}

export async function startServer(
  options: ApiOptions & { readonly port?: number; readonly host?: string } = {}
): Promise<FastifyInstance> {
  const port = options.port ?? Number(process.env.PULSE_API_PORT ?? 8787);
  if (!validPositiveSafeInteger(port) || port > 65_535)
    throw new RangeError('API port must be between 1 and 65535.');
  const app = buildServer(options);
  try {
    await app.listen({ port, host: options.host ?? process.env.PULSE_API_HOST ?? '127.0.0.1' });
    return app;
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

const entryPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
const modulePath = resolve(fileURLToPath(import.meta.url));
const isMainModule =
  entryPath !== null &&
  (() => {
    try {
      return realpathSync(entryPath) === realpathSync(modulePath);
    } catch {
      return entryPath === modulePath;
    }
  })();
if (isMainModule) {
  const run = async (): Promise<void> => {
    const server = await startServer({ logger: true });
    let closing = false;
    const shutdown = async (): Promise<void> => {
      if (closing) return;
      closing = true;
      try {
        await server.close();
      } catch {
        process.stderr.write('Unable to stop API server cleanly.\n');
        process.exitCode = 1;
      }
    };
    process.once('SIGTERM', () => {
      void shutdown();
    });
    process.once('SIGINT', () => {
      void shutdown();
    });
  };
  run().catch(() => {
    process.stderr.write('Unable to start API server.\n');
    process.exitCode = 1;
  });
}
