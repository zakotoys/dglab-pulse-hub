import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElectronWorkspaceClient } from '../src/client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Electron workspace client', () => {
  it('omits text export mode from QR export IPC requests', async () => {
    const exportPulse = vi.fn().mockResolvedValue({});
    vi.stubGlobal('window', {
      pulseDesktop: { export: exportPulse }
    });
    const client = createElectronWorkspaceClient();
    const document = {
      displayName: '132-漂浮之羽.pulse',
      digest: '0123456789abcdef'
    };

    await client.export(document, 'qr-envelope', 'source');

    expect(exportPulse).toHaveBeenCalledWith({
      sourceDigest: document.digest,
      displayName: document.displayName,
      format: 'qr-envelope'
    });
  });

  it('keeps mode in pulse-text export IPC requests', async () => {
    const exportPulse = vi.fn().mockResolvedValue({});
    vi.stubGlobal('window', {
      pulseDesktop: { export: exportPulse }
    });
    const client = createElectronWorkspaceClient();
    const document = {
      displayName: 'source.pulse',
      digest: '0123456789abcdef'
    };

    await client.export(document, 'pulse-text', 'source');

    expect(exportPulse).toHaveBeenCalledWith({
      sourceDigest: document.digest,
      displayName: document.displayName,
      format: 'pulse-text',
      mode: 'source'
    });
  });

  it('delegates artifact saving to the native IPC adapter', async () => {
    const saveArtifact = vi.fn().mockResolvedValue({
      schemaVersion: 'pulse-contract-v1',
      ruleVersion: 'pulse-rules-v1',
      operation: 'write-file',
      status: 'success',
      result: { displayName: 'source.qr (1).jpg', byteSize: 3 },
      diagnostics: []
    });
    vi.stubGlobal('window', {
      pulseDesktop: { saveArtifact }
    });
    const client = createElectronWorkspaceClient();
    const artifact = {
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      displayName: 'source.qr.jpg',
      contentType: 'image/jpeg'
    };

    const result = await client.saveArtifact(artifact, artifact.displayName);

    expect(saveArtifact).toHaveBeenCalledWith({ artifact, suggestedName: 'source.qr.jpg' });
    expect(result).toMatchObject({
      operation: 'write-file',
      status: 'success',
      result: { displayName: 'source.qr (1).jpg' }
    });
  });
});
