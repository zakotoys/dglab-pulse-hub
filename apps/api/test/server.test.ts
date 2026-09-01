import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { buildServer } from '../src/server.js';
import { operationEnvelopeSchema } from '@dglab-pulse-hub/contracts';
import {
  encodeQr,
  TempArtifactStore,
  type ArtifactDescriptor,
  type ArtifactPutOptions
} from '@dglab-pulse-hub/application';

const VALID_TEXT = 'Dungeonlab+pulse:0,1,8=27,7,32,3,1/0-1,50-0,100-1';

const apps: Array<Awaited<ReturnType<typeof buildServer>>> = [];
const stores: TempArtifactStore[] = [];

class SelectiveArtifactStore extends TempArtifactStore {
  public readonly staged: ArtifactDescriptor[] = [];
  private puts = 0;

  public constructor(private readonly failAt: number) {
    super(10_000, 10_000);
  }

  public override async put(
    displayName: string,
    content: Uint8Array,
    options: ArtifactPutOptions = {}
  ): Promise<ArtifactDescriptor> {
    this.puts += 1;
    if (this.failAt === 0 || this.puts === this.failAt)
      throw new Error('injected artifact staging failure');
    const descriptor = await super.put(displayName, content, options);
    this.staged.push(descriptor);
    return descriptor;
  }
}

class DelayedArtifactStore extends TempArtifactStore {
  public readonly staged: ArtifactDescriptor[] = [];
  public readonly entered: Promise<void>;
  private readonly gate: Promise<void>;
  private releaseGate: (() => void) | null = null;
  private resolveEntered: (() => void) | null = null;

  public constructor() {
    super(10_000, 10_000);
    this.entered = new Promise<void>((resolve) => {
      this.resolveEntered = resolve;
    });
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  public release(): void {
    this.releaseGate?.();
    this.releaseGate = null;
  }

  public override async put(
    displayName: string,
    content: Uint8Array,
    options: ArtifactPutOptions = {}
  ): Promise<ArtifactDescriptor> {
    const descriptor = await super.put(displayName, content, options);
    this.staged.push(descriptor);
    this.resolveEntered?.();
    this.resolveEntered = null;
    await this.gate;
    return descriptor;
  }
}

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
  while (stores.length > 0) await stores.pop()?.dispose();
});

describe('HTTP adapter', () => {
  function multipartPayload(
    parts: readonly { name: string; filename?: string; contentType?: string; value: string }[]
  ): { body: string; contentType: string } {
    const boundary = 'pulse-test-boundary';
    const body =
      parts
        .map((part) => {
          const disposition =
            part.filename === undefined
              ? `Content-Disposition: form-data; name="${part.name}"`
              : `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"`;
          const type =
            part.contentType === undefined ? '' : `\r\nContent-Type: ${part.contentType}`;
          return `--${boundary}\r\n${disposition}${type}\r\n\r\n${part.value}\r\n`;
        })
        .join('') + `--${boundary}--\r\n`;
    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
  }

  it('returns a strict envelope for inspect', async () => {
    const app = buildServer();
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/inspect',
      headers: { 'content-type': 'text/plain' },
      payload: VALID_TEXT
    });
    expect(response.statusCode).toBe(200);
    expect(operationEnvelopeSchema.safeParse(response.json()).success).toBe(true);
  });

  it('preserves invalid UTF-8 as a rejection', async () => {
    const app = buildServer();
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/inspect',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from([0xff, 0xfe])
    });
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(
      body.diagnostics.some(
        (item: { code: string }) => item.code === 'PULSE_RECOGNIZE_INVALID_ENCODING'
      )
    ).toBe(true);
  });

  it('rejects empty, null, and array JSON bodies as contract errors', async () => {
    const app = buildServer();
    apps.push(app);
    await app.ready();
    for (const payload of ['', 'null', '[]']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/pulses/inspect',
        headers: { 'content-type': 'application/json' },
        payload
      });
      expect(response.statusCode).toBe(422);
      const body = response.json();
      expect(body.result).toBeNull();
      expect(operationEnvelopeSchema.safeParse(body).success).toBe(true);
    }
  });

  it(
    'keeps malformed, unknown-field, and wrong-type JSON failures ' + 'contract-safe across routes',
    async () => {
      const app = buildServer();
      apps.push(app);
      await app.ready();
      const routeCases: readonly {
        readonly url: string;
        readonly valid: Record<string, unknown>;
        readonly wrongField: string;
      }[] = [
        { url: '/api/v1/pulses/inspect', valid: { text: VALID_TEXT }, wrongField: 'displayName' },
        { url: '/api/v1/pulses/export', valid: { text: VALID_TEXT }, wrongField: 'format' },
        { url: '/api/v1/pulses/qr/encode', valid: { text: VALID_TEXT }, wrongField: 'text' },
        { url: '/api/v1/pulses/qr/decode', valid: { text: 'not-a-qr' }, wrongField: 'text' },
        {
          url: '/api/v1/pulses/edit',
          valid: { text: VALID_TEXT, kind: 'strength', sectionIndex: 0, pointIndex: 1, value: 42 },
          wrongField: 'value'
        },
        {
          url: '/api/v1/pulses/assist',
          valid: {
            text: VALID_TEXT,
            sectionIndex: 0,
            startPointIndex: 0,
            endPointIndex: 2,
            startStrength: 10,
            endStrength: 90,
            reviewed: true
          },
          wrongField: 'reviewed'
        },
        {
          url: '/api/v1/pulses/preview',
          valid: { text: VALID_TEXT, format: 'svg' },
          wrongField: 'format'
        },
        {
          url: '/api/v1/pulses/diff',
          valid: { before: VALID_TEXT, after: VALID_TEXT },
          wrongField: 'before'
        },
        {
          url: '/api/v1/pulses/batch/inspect',
          valid: { items: [{ displayName: 'one.pulse', text: VALID_TEXT }] },
          wrongField: 'items'
        },
        {
          url: '/api/v1/pulses/batch/export',
          valid: { items: [{ displayName: 'one.pulse', text: VALID_TEXT }] },
          wrongField: 'items'
        }
      ];
      for (const route of routeCases) {
        const unknown = await app.inject({
          method: 'POST',
          url: route.url,
          headers: { 'content-type': 'application/json' },
          payload: { ...route.valid, unexpected: true }
        });
        expect(unknown.statusCode, route.url + ' unknown').toBe(422);
        expect(
          operationEnvelopeSchema.safeParse(unknown.json()).success,
          route.url + ' unknown schema'
        ).toBe(true);
        expect(unknown.json().result, route.url + ' unknown result').toBeNull();

        const wrong = {
          ...route.valid,
          [route.wrongField]:
            route.wrongField === 'reviewed'
              ? 'yes'
              : route.wrongField === 'text' ||
                  route.wrongField === 'format' ||
                  route.wrongField === 'displayName'
                ? 1
                : 'wrong-type'
        };
        const wrongResponse = await app.inject({
          method: 'POST',
          url: route.url,
          headers: { 'content-type': 'application/json' },
          payload: wrong
        });
        expect(wrongResponse.statusCode, route.url + ' wrong type').toBe(422);
        expect(
          operationEnvelopeSchema.safeParse(wrongResponse.json()).success,
          route.url + ' wrong schema'
        ).toBe(true);
        expect(wrongResponse.json().result, route.url + ' wrong result').toBeNull();

        const malformed = await app.inject({
          method: 'POST',
          url: route.url,
          headers: { 'content-type': 'application/json' },
          payload: '{"text":'
        });
        expect(malformed.statusCode, route.url + ' malformed').toBe(422);
        expect(
          operationEnvelopeSchema.safeParse(malformed.json()).success,
          route.url + ' malformed schema'
        ).toBe(true);
        expect(malformed.json().result, route.url + ' malformed result').toBeNull();
      }
    }
  );

  it('rejects unsupported export options instead of canonical fallback', async () => {
    const app = buildServer();
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/export',
      headers: { 'content-type': 'application/json' },
      payload: { text: VALID_TEXT, format: 'future-format' }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().result).toBeNull();

    const incompatibleMode = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/export',
      headers: { 'content-type': 'application/json' },
      payload: { text: VALID_TEXT, format: 'qr-envelope', mode: 'source' }
    });
    expect(incompatibleMode.statusCode).toBe(422);
    expect(incompatibleMode.json().result).toBeNull();
  });

  it('streams QR export as a JPEG image with an image filename', async () => {
    const app = buildServer();
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/export',
      headers: { 'content-type': 'application/json' },
      payload: { text: VALID_TEXT, format: 'qr-envelope', displayName: 'source.pulse' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/jpeg');
    expect(response.headers['content-disposition']).toBe('attachment; filename="source.qr.jpg"');
    expect(response.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(JSON.parse(response.headers['x-pulse-result'] ?? 'null')).toMatchObject({
      format: 'qr-envelope',
      displayName: 'source.qr.jpg',
      contentType: 'image/jpeg',
      roundTripVerified: true
    });
  });

  it('keeps QR export headers valid for non-ASCII source filenames', async () => {
    const app = buildServer();
    apps.push(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('API test server did not expose an address.');
    const payload = JSON.stringify({
      text: VALID_TEXT,
      format: 'qr-envelope',
      displayName: '132-漂浮之羽.pulse'
    });
    const response = await new Promise<{
      statusCode: number;
      headers: IncomingHttpHeaders;
      body: Buffer;
    }>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/api/v1/pulses/export',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload)
          }
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () =>
            resolve({
              statusCode: incoming.statusCode ?? 0,
              headers: incoming.headers,
              body: Buffer.concat(chunks)
            })
          );
          incoming.on('error', reject);
        }
      );
      request.on('error', reject);
      request.end(payload);
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/jpeg');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="132-____.qr.jpg"; filename*=UTF-8\'\'' +
        '132-%E6%BC%82%E6%B5%AE%E4%B9%8B%E7%BE%BD.qr.jpg'
    );
    expect(response.body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(JSON.parse(String(response.headers['x-pulse-result']))).toMatchObject({
      format: 'qr-envelope',
      displayName: '132-____.qr.jpg',
      contentType: 'image/jpeg',
      roundTripVerified: true
    });
  });

  it('enforces the application byte limit', async () => {
    const app = buildServer({ maxBytes: 8 });
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/inspect',
      headers: { 'content-type': 'text/plain' },
      payload: VALID_TEXT
    });
    expect(response.statusCode).toBe(422);
    expect(
      response
        .json()
        .diagnostics.some(
          (item: { code: string }) =>
            item.code === 'PULSE_RECOGNIZE_SIZE_LIMIT' || item.code === 'PULSE_TASK_INPUT_LIMIT'
        )
    ).toBe(true);
  });

  it('accepts raw octet-stream input and applies security headers', async () => {
    const app = buildServer();
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/inspect',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from(VALID_TEXT, 'utf8')
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('accepts one named multipart file and rejects over-posted fields', async () => {
    const app = buildServer();
    apps.push(app);
    await app.ready();
    const valid = multipartPayload([
      { name: 'file', filename: 'sample.pulse', contentType: 'text/plain', value: VALID_TEXT }
    ]);
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/inspect',
      headers: { 'content-type': valid.contentType },
      payload: valid.body
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().result.metadata.file.displayName).toBe('sample.pulse');

    const extra = multipartPayload([
      { name: 'file', filename: 'sample.pulse', contentType: 'text/plain', value: VALID_TEXT },
      { name: 'unexpected', value: 'nope' }
    ]);
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/inspect',
      headers: { 'content-type': extra.contentType },
      payload: extra.body
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().result).toBeNull();
  });

  it('handles QR encode/decode through the versioned envelope and one-shot artifact', async () => {
    const app = buildServer();
    apps.push(app);
    await app.ready();
    const encoded = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/qr/encode',
      headers: { 'content-type': 'application/json' },
      payload: { text: VALID_TEXT }
    });
    expect(encoded.statusCode).toBe(200);
    const content = encoded.json().result.content as string;
    expect(content).toBe(encodeQr(VALID_TEXT).content);
    const decoded = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/qr/decode',
      headers: { 'content-type': 'text/plain' },
      payload: content
    });
    expect(decoded.statusCode).toBe(200);
    const id = decoded.json().result.downloadId as string;
    expect(decoded.body).not.toContain(VALID_TEXT);
    const [first, second] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/v1/artifacts/' + id }),
      app.inject({ method: 'GET', url: '/api/v1/artifacts/' + id })
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 422]);
    const success = first.statusCode === 200 ? first : second;
    expect(success.body).toBe(
      'Dungeonlab+pulse:0,1,8=27,7,32,3,1/0-1,50-0,100-1+' +
        'section+0,20,20,1,0/0-1,100-1+section+0,20,20,1,0/0-1,100-1'
    );
  });

  it('returns an edit artifact for canonical commands and rejects flat aliases', async () => {
    const app = buildServer();
    apps.push(app);
    await app.ready();
    const edited = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/edit',
      headers: { 'content-type': 'application/json' },
      payload: {
        text: VALID_TEXT,
        kind: 'strength',
        sectionIndex: 0,
        pointIndex: 1,
        value: 42
      }
    });
    expect(edited.statusCode).toBe(200);
    const editResult = edited.json().result as { downloadId: string; byteSize: number };
    expect(editResult.downloadId).toMatch(/^[A-Za-z0-9._~-]+$/);
    const artifact = await app.inject({
      method: 'GET',
      url: '/api/v1/artifacts/' + editResult.downloadId
    });
    expect(artifact.statusCode).toBe(200);
    expect(artifact.body).toContain('42-1');

    const alias = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/edit',
      headers: { 'content-type': 'application/json' },
      payload: { text: VALID_TEXT, sectionIndex: 0, pointIndex: 1, strength: 42 }
    });
    expect(alias.statusCode).toBe(422);
    expect(alias.json().result).toBeNull();

    const mixedCommand = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/edit',
      headers: { 'content-type': 'application/json' },
      payload: {
        text: VALID_TEXT,
        kind: 'strength',
        sectionIndex: 0,
        pointIndex: 1,
        value: 42,
        anchor: 1
      }
    });
    expect(mixedCommand.statusCode).toBe(422);
    expect(mixedCommand.json().result).toBeNull();
  });

  it('renders SVG, PNG, and JPG previews and rejects unsupported formats', async () => {
    const app = buildServer();
    apps.push(app);
    await app.ready();
    for (const format of ['svg', 'png', 'jpg'] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/pulses/preview',
        headers: { 'content-type': 'application/json' },
        payload: { text: VALID_TEXT, format }
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain(
        format === 'svg' ? 'image/svg+xml' : format === 'png' ? 'image/png' : 'image/jpeg'
      );
      expect(JSON.parse(response.headers['x-pulse-result'] ?? 'null')).toMatchObject({
        format,
        displayName: 'pulse-preview.' + format,
        streamDigest: expect.any(String)
      });
      expect(response.rawPayload.length).toBeGreaterThan(16);
    }
    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/preview',
      headers: { 'content-type': 'application/json' },
      payload: { text: VALID_TEXT, format: 'bmp' }
    });
    expect(unsupported.statusCode).toBe(422);
    expect(unsupported.json().result).toBeNull();
  });

  it('expires injected artifact stores without taking ownership', async () => {
    const store = new TempArtifactStore(5, 5);
    const app = buildServer({ artifactStore: store });
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/edit',
      headers: { 'content-type': 'application/json' },
      payload: { text: VALID_TEXT, kind: 'duration', sectionIndex: 0, value: 1 }
    });
    expect(response.statusCode).toBe(200);
    const id = response.json().result.downloadId as string;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.cleanupExpired();
    expect(store.descriptor(id)).toBeNull();
    await app.close();
    // The caller owns an injected store and can still dispose it explicitly.
    await store.dispose();
  });

  it('keeps an injected store usable after the API closes', async () => {
    const store = new TempArtifactStore(10_000, 10_000);
    const app = buildServer({ artifactStore: store });
    apps.push(app);
    await app.ready();
    await app.close();
    const artifact = await store.put('still-owned.txt', new Uint8Array([1, 2, 3]));
    expect(await store.read(artifact.id)).toEqual(new Uint8Array([1, 2, 3]));
    await store.dispose();
  });

  it('answers CORS preflight only when an origin is configured', async () => {
    const app = buildServer({ corsOrigin: 'http://localhost:5173' });
    apps.push(app);
    await app.ready();
    const response = await app.inject({ method: 'OPTIONS', url: '/api/v1/pulses/inspect' });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
  });

  it('normalizes JSON batch inspect/export requests and keeps partial item results', async () => {
    const app = buildServer();
    apps.push(app);
    await app.ready();
    const inspect = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/batch/inspect',
      headers: { 'content-type': 'application/json' },
      payload: {
        items: [
          { id: 'good', displayName: 'good.pulse', text: VALID_TEXT },
          { id: 'bad', displayName: 'bad.pulse', text: 'not-a-pulse' }
        ],
        concurrency: 2
      }
    });
    expect(inspect.statusCode).toBe(200);
    const inspectBody = inspect.json();
    expect(inspectBody.status).toBe('success');
    expect(inspectBody.result.succeeded).toBe(1);
    expect(inspectBody.result.rejected).toBe(1);
    expect(inspectBody.result.items[0].result).toBeTruthy();
    expect(inspectBody.result.items[1].result).toBeNull();

    const exported = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/batch/export',
      headers: { 'content-type': 'application/json' },
      payload: {
        items: [
          {
            id: 'good',
            displayName: 'good.pulse',
            outputDisplayName: 'copy.pulse',
            text: VALID_TEXT
          }
        ]
      }
    });
    expect(exported.statusCode).toBe(200);
    const exportResult = exported.json().result.items[0].result;
    expect(exportResult.downloadId).toMatch(/^[A-Za-z0-9._~-]+$/);
    const artifact = await app.inject({
      method: 'GET',
      url: '/api/v1/artifacts/' + exportResult.downloadId
    });
    expect(artifact.statusCode).toBe(200);
    expect(artifact.body).toBe(VALID_TEXT);
  });

  it('keeps successful batch artifacts when a later staging operation fails', async () => {
    const store = new SelectiveArtifactStore(2);
    stores.push(store);
    const app = buildServer({ artifactStore: store });
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/batch/export',
      headers: { 'content-type': 'application/json' },
      payload: {
        items: [
          { id: 'first', displayName: 'first.pulse', text: VALID_TEXT },
          { id: 'second', displayName: 'second.pulse', text: VALID_TEXT.replace('50-0', '42-0') }
        ]
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('success');
    expect(body.result.succeeded).toBe(1);
    expect(body.result.failed).toBe(1);
    const first = body.result.items.find((item: { id: string }) => item.id === 'first');
    const second = body.result.items.find((item: { id: string }) => item.id === 'second');
    expect(first.result.downloadId).toBe(store.staged[0]?.id);
    expect(second.status).toBe('failed');
    expect(second.result).toBeNull();
    const downloaded = await app.inject({
      method: 'GET',
      url: '/api/v1/artifacts/' + first.result.downloadId
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.body).toContain('Dungeonlab+pulse:');
  });

  it('does not retain artifacts when every batch staging operation fails', async () => {
    const store = new SelectiveArtifactStore(0);
    stores.push(store);
    const app = buildServer({ artifactStore: store });
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/batch/export',
      headers: { 'content-type': 'application/json' },
      payload: {
        items: [
          { id: 'first', displayName: 'first.pulse', text: VALID_TEXT },
          { id: 'second', displayName: 'second.pulse', text: VALID_TEXT.replace('50-0', '42-0') }
        ]
      }
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().result).toBeNull();
    expect(store.staged).toHaveLength(0);
  });

  it('removes a staged artifact when the client disconnects before the response', async () => {
    const store = new DelayedArtifactStore();
    stores.push(store);
    const app = buildServer({ artifactStore: store, processingTimeoutMs: 5_000 });
    apps.push(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('API test server did not expose an address.');
    const payload = JSON.stringify({
      items: [{ id: 'disconnect', displayName: 'disconnect.pulse', text: VALID_TEXT }]
    });
    let clientRequest: ReturnType<typeof httpRequest> | null = null;
    const clientDone = new Promise<void>((resolve) => {
      clientRequest = httpRequest(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/api/v1/pulses/batch/export',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload)
          }
        },
        (_response: IncomingMessage) => {
          resolve();
        }
      );
      clientRequest.once('error', () => resolve());
      clientRequest.end(payload);
    });
    await store.entered;
    clientRequest?.destroy();
    await new Promise((resolve) => setTimeout(resolve, 25));
    store.release();
    await clientDone;
    for (
      let attempt = 0;
      attempt < 40 && store.staged.some((item) => store.descriptor(item.id) !== null);
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(store.staged.length).toBeGreaterThan(0);
    expect(store.staged.every((item) => store.descriptor(item.id) === null)).toBe(true);
  });

  it('times out a blocked batch staging operation and removes its artifacts', async () => {
    const store = new DelayedArtifactStore();
    stores.push(store);
    const app = buildServer({ artifactStore: store, processingTimeoutMs: 250 });
    apps.push(app);
    await app.ready();
    const responsePromise = app.inject({
      method: 'POST',
      url: '/api/v1/pulses/batch/export',
      headers: { 'content-type': 'application/json' },
      payload: { items: [{ id: 'timeout', displayName: 'timeout.pulse', text: VALID_TEXT }] }
    });
    await store.entered;
    await new Promise((resolve) => setTimeout(resolve, 280));
    const responseOrTimeout = await Promise.race([
      responsePromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))
    ]);
    store.release();
    if (responseOrTimeout === null)
      throw new Error('Timed-out staging request did not return while the store was blocked.');
    const response = responseOrTimeout;
    expect(response.statusCode).toBe(408);
    const body = response.json();
    expect(body.status).toBe('failed');
    expect(body.result).toBeNull();
    expect(
      body.diagnostics.some((item: { code: string }) => item.code === 'PULSE_TASK_TIMEOUT')
    ).toBe(true);
    for (
      let attempt = 0;
      attempt < 40 && store.staged.some((item) => store.descriptor(item.id) !== null);
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(store.staged.every((item) => store.descriptor(item.id) === null)).toBe(true);
  });

  it('accepts repeated multipart files for batch inspection', async () => {
    const app = buildServer();
    apps.push(app);
    await app.ready();
    const payload = multipartPayload([
      { name: 'file', filename: 'one.pulse', contentType: 'text/plain', value: VALID_TEXT },
      { name: 'file', filename: 'two.pulse', contentType: 'text/plain', value: VALID_TEXT },
      { name: 'concurrency', value: '2' }
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/batch/inspect',
      headers: { 'content-type': payload.contentType },
      payload: payload.body
    });
    expect(response.statusCode).toBe(200);
    expect(
      response.json().result.items.map((item: { displayName: string }) => item.displayName)
    ).toEqual(['one.pulse', 'two.pulse']);
  });

  it('rejects duplicate multipart options and invalid manifests', async () => {
    const app = buildServer();
    apps.push(app);
    await app.ready();
    const duplicateOption = multipartPayload([
      { name: 'file', filename: 'one.pulse', contentType: 'text/plain', value: VALID_TEXT },
      { name: 'file', filename: 'two.pulse', contentType: 'text/plain', value: VALID_TEXT },
      { name: 'concurrency', value: '1' },
      { name: 'concurrency', value: '2' }
    ]);
    const duplicateResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/batch/inspect',
      headers: { 'content-type': duplicateOption.contentType },
      payload: duplicateOption.body
    });
    expect(duplicateResponse.statusCode).toBe(422);
    expect(duplicateResponse.json().result).toBeNull();

    const invalidManifest = multipartPayload([
      { name: 'file', filename: 'one.pulse', contentType: 'text/plain', value: VALID_TEXT },
      { name: 'file', filename: 'two.pulse', contentType: 'text/plain', value: VALID_TEXT },
      { name: 'manifest', value: JSON.stringify([{ id: 'same' }, { id: 'same' }]) }
    ]);
    const manifestResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/batch/inspect',
      headers: { 'content-type': invalidManifest.contentType },
      payload: invalidManifest.body
    });
    expect(manifestResponse.statusCode).toBe(422);
    expect(manifestResponse.json().result).toBeNull();
  });

  it('rejects invalid multipart fields and size limits', async () => {
    const wrongFieldApp = buildServer();
    apps.push(wrongFieldApp);
    await wrongFieldApp.ready();
    const wrongField = multipartPayload([
      { name: 'upload', filename: 'one.pulse', contentType: 'text/plain', value: VALID_TEXT },
      { name: 'file', filename: 'two.pulse', contentType: 'text/plain', value: VALID_TEXT }
    ]);
    const wrongFieldResponse = await wrongFieldApp.inject({
      method: 'POST',
      url: '/api/v1/pulses/batch/inspect',
      headers: { 'content-type': wrongField.contentType },
      payload: wrongField.body
    });
    expect(wrongFieldResponse.statusCode).toBe(422);
    expect(wrongFieldResponse.json().result).toBeNull();

    const perFileApp = buildServer({ maxBytes: 8 });
    apps.push(perFileApp);
    await perFileApp.ready();
    const perFile = multipartPayload([
      { name: 'file', filename: 'large.pulse', contentType: 'text/plain', value: VALID_TEXT }
    ]);
    const perFileResponse = await perFileApp.inject({
      method: 'POST',
      url: '/api/v1/pulses/batch/inspect',
      headers: { 'content-type': perFile.contentType },
      payload: perFile.body
    });
    expect(perFileResponse.statusCode).toBe(422);
    expect(perFileResponse.json().result).toBeNull();
    expect(
      perFileResponse
        .json()
        .diagnostics.some((item: { code: string }) => item.code === 'PULSE_TASK_INPUT_LIMIT')
    ).toBe(true);

    const aggregateApp = buildServer({ maxBatchTotalBytes: 10 });
    apps.push(aggregateApp);
    await aggregateApp.ready();
    const aggregate = multipartPayload([
      { name: 'file', filename: 'one.pulse', contentType: 'text/plain', value: '123456' },
      { name: 'file', filename: 'two.pulse', contentType: 'text/plain', value: '123456' }
    ]);
    const aggregateResponse = await aggregateApp.inject({
      method: 'POST',
      url: '/api/v1/pulses/batch/inspect',
      headers: { 'content-type': aggregate.contentType },
      payload: aggregate.body
    });
    expect(aggregateResponse.statusCode).toBe(422);
    expect(aggregateResponse.json().result).toBeNull();
    expect(
      aggregateResponse
        .json()
        .diagnostics.some((item: { code: string }) => item.code === 'PULSE_TASK_INPUT_LIMIT')
    ).toBe(true);

    const countApp = buildServer({ maxBatchFiles: 1 });
    apps.push(countApp);
    await countApp.ready();
    const tooManyFiles = multipartPayload([
      { name: 'file', filename: 'one.pulse', contentType: 'text/plain', value: 'a' },
      { name: 'file', filename: 'two.pulse', contentType: 'text/plain', value: 'b' }
    ]);
    const countResponse = await countApp.inject({
      method: 'POST',
      url: '/api/v1/pulses/batch/inspect',
      headers: { 'content-type': tooManyFiles.contentType },
      payload: tooManyFiles.body
    });
    expect(countResponse.statusCode).toBe(422);
    expect(countResponse.json().result).toBeNull();
    expect(
      countResponse
        .json()
        .diagnostics.some((item: { code: string }) => item.code === 'PULSE_TASK_INPUT_LIMIT')
    ).toBe(true);
  });

  it('returns semantic diff data and rejects source-bearing public values', async () => {
    const app = buildServer();
    apps.push(app);
    await app.ready();
    const changed = VALID_TEXT.replace('50-0', '42-0');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/diff',
      headers: { 'content-type': 'application/json' },
      payload: { before: VALID_TEXT, after: changed }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.result.diff.equal).toBe(false);
    expect(JSON.stringify(body)).not.toContain(VALID_TEXT);
    expect(operationEnvelopeSchema.safeParse(body).success).toBe(true);
  });

  it('rejects multipart diff requests with extra or ambiguous files', async () => {
    const app = buildServer();
    apps.push(app);
    await app.ready();
    const extra = multipartPayload([
      { name: 'file', filename: 'before.pulse', contentType: 'text/plain', value: VALID_TEXT },
      { name: 'file', filename: 'after.pulse', contentType: 'text/plain', value: VALID_TEXT },
      { name: 'file', filename: 'unexpected.pulse', contentType: 'text/plain', value: VALID_TEXT }
    ]);
    const extraResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/diff',
      headers: { 'content-type': extra.contentType },
      payload: extra.body
    });
    expect(extraResponse.statusCode).toBe(422);
    expect(extraResponse.json().result).toBeNull();

    const mixed = multipartPayload([
      { name: 'before', filename: 'before.pulse', contentType: 'text/plain', value: VALID_TEXT },
      { name: 'file', filename: 'after.pulse', contentType: 'text/plain', value: VALID_TEXT }
    ]);
    const mixedResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/diff',
      headers: { 'content-type': mixed.contentType },
      payload: mixed.body
    });
    expect(mixedResponse.statusCode).toBe(422);
    expect(mixedResponse.json().result).toBeNull();

    const named = multipartPayload([
      { name: 'before', filename: 'before.pulse', contentType: 'text/plain', value: VALID_TEXT },
      {
        name: 'after',
        filename: 'after.pulse',
        contentType: 'text/plain',
        value: VALID_TEXT.replace('50-0', '42-0')
      }
    ]);
    const namedResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/diff',
      headers: { 'content-type': named.contentType },
      payload: named.body
    });
    expect(namedResponse.statusCode).toBe(200);
    expect(operationEnvelopeSchema.safeParse(namedResponse.json()).success).toBe(true);

    const limitedApp = buildServer({ maxBytes: 8 });
    apps.push(limitedApp);
    await limitedApp.ready();
    const oversized = multipartPayload([
      { name: 'file', filename: 'before.pulse', contentType: 'text/plain', value: VALID_TEXT },
      { name: 'file', filename: 'after.pulse', contentType: 'text/plain', value: VALID_TEXT }
    ]);
    const limitedResponse = await limitedApp.inject({
      method: 'POST',
      url: '/api/v1/pulses/diff',
      headers: { 'content-type': oversized.contentType },
      payload: oversized.body
    });
    expect(limitedResponse.statusCode).toBe(422);
    expect(limitedResponse.json().result).toBeNull();
    expect(
      limitedResponse
        .json()
        .diagnostics.some((item: { code: string }) => item.code === 'PULSE_TASK_INPUT_LIMIT')
    ).toBe(true);
  });

  it('enforces the batch byte limit before starting item work', async () => {
    const app = buildServer({ maxBatchTotalBytes: 10 });
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/batch/inspect',
      headers: { 'content-type': 'application/json' },
      payload: { items: [{ displayName: 'large.pulse', text: VALID_TEXT }] }
    });
    expect(response.statusCode).toBe(422);
    expect(
      response
        .json()
        .diagnostics.some((item: { code: string }) => item.code === 'PULSE_TASK_INPUT_LIMIT')
    ).toBe(true);
  });

  it('requires review and stages a deterministic quadratic assist', async () => {
    const app = buildServer();
    apps.push(app);
    await app.ready();
    const unreviewed = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/assist',
      headers: { 'content-type': 'application/json' },
      payload: {
        text: VALID_TEXT,
        sectionIndex: 0,
        startPointIndex: 0,
        endPointIndex: 2,
        startStrength: 10,
        endStrength: 90,
        reviewed: false
      }
    });
    expect(unreviewed.statusCode).toBe(422);
    expect(
      unreviewed
        .json()
        .diagnostics.some((item: { code: string }) => item.code === 'PULSE_EDIT_NOT_REVIEWED')
    ).toBe(true);
    const reviewed = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/assist',
      headers: { 'content-type': 'application/json' },
      payload: {
        text: VALID_TEXT,
        sectionIndex: 0,
        startPointIndex: 0,
        endPointIndex: 2,
        startStrength: 10,
        endStrength: 90,
        reviewed: true
      }
    });
    expect(reviewed.statusCode).toBe(200);
    const result = reviewed.json().result;
    expect(result.downloadId).toMatch(/^[A-Za-z0-9._~-]+$/);
    expect(
      result.changeRecords.some((record: { kind: string }) => record.kind === 'interpolation')
    ).toBe(true);
  });

  it('allows assist edits on disabled sections without playback points', async () => {
    const app = buildServer();
    apps.push(app);
    await app.ready();
    const source = 'Dungeonlab+pulse:1,1,8=0,10,2,3,0/0-1,50-0,100-1+section+10,20,0,2,1/100-1,0-1';
    const reviewed = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/assist',
      headers: { 'content-type': 'application/json' },
      payload: {
        text: source,
        sectionIndex: 0,
        startPointIndex: 0,
        endPointIndex: 2,
        startStrength: 20,
        endStrength: 80,
        reviewed: true
      }
    });
    expect(reviewed.statusCode).toBe(200);
    const result = reviewed.json().result as {
      downloadId: string;
      changeRecords: Array<{ path: string }>;
    };
    expect(result.changeRecords.map((record) => record.path)).toEqual([
      'sections[0].points[0].strength',
      'sections[0].points[2].strength',
      'sections[0].points[1].strength'
    ]);

    const artifact = await app.inject({
      method: 'GET',
      url: '/api/v1/artifacts/' + result.downloadId
    });
    expect(artifact.statusCode).toBe(200);
    expect(artifact.body).toContain('/20-1,65-0,80-1+section+10,20,0,2,1/100-1,0-1');

    const inspected = await app.inject({
      method: 'POST',
      url: '/api/v1/pulses/inspect',
      headers: { 'content-type': 'text/plain' },
      payload: artifact.body
    });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().result.stream.points).toHaveLength(2);
    expect(inspected.json().result.metadata.sections[0].enabled).toBe(false);
    expect(
      inspected
        .json()
        .result.metadata.sections[0].sourcePoints.map(
          (point: { strengthDecimal: string }) => point.strengthDecimal
        )
    ).toEqual(['20', '65', '80']);
  });
});
