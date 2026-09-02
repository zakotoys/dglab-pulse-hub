import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElectronWorkspaceClient } from '../src/client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Electron workspace client', () => {
  it('uses one preload file-manager boundary for list, import and open', async () => {
    const listWorkspace = vi.fn().mockResolvedValue({
      rootPath: '/managed',
      files: [
        {
          name: 'saved.pulse',
          relativePath: 'saved.pulse',
          byteSize: 42,
          modifiedAt: '2026-09-02T00:00:00.000Z'
        }
      ]
    });
    const openWorkspaceFile = vi.fn().mockResolvedValue({});
    const importLocalFiles = vi.fn().mockResolvedValue({
      index: { rootPath: '/managed', files: [] },
      imported: []
    });
    const importDroppedFile = vi.fn().mockResolvedValue({
      index: { rootPath: '/managed', files: [] },
      imported: []
    });
    vi.stubGlobal('window', {
      pulseDesktop: { listWorkspace, importLocalFiles, openWorkspaceFile, importDroppedFile }
    });
    const client = createElectronWorkspaceClient();
    const droppedFile = { name: 'external.pulse' } as File;

    await expect(client.localFiles?.list()).resolves.toMatchObject({
      rootPath: '/managed',
      files: [{ relativePath: 'saved.pulse', byteSize: 42 }]
    });
    await client.localFiles?.import(false);
    await client.localFiles?.importDropped(droppedFile);
    await client.localFiles?.open('saved.pulse');

    expect(importLocalFiles).toHaveBeenCalledWith(false);
    expect(openWorkspaceFile).toHaveBeenCalledWith('saved.pulse');
    expect(importDroppedFile).toHaveBeenCalledWith(droppedFile);
  });

  it('passes managed file references to diff and batch operations', async () => {
    const diff = vi.fn().mockResolvedValue({});
    const batchInspect = vi.fn().mockResolvedValue({});
    const batchExport = vi.fn().mockResolvedValue({});
    vi.stubGlobal('window', { pulseDesktop: { diff, batchInspect, batchExport } });
    const client = createElectronWorkspaceClient();
    const document = { displayName: 'source.pulse', digest: '0123456789abcdef' };
    const comparison = { name: 'compare.pulse', relativePath: 'compare.pulse' };
    const files = [comparison, { name: 'other.pulse', relativePath: 'archive/other.pulse' }];

    await client.diff(document, comparison);
    await client.batchInspect(files);
    await client.batchExport(files, 'canonical');

    expect(diff).toHaveBeenCalledWith({
      sourceDigest: document.digest,
      relativePath: 'compare.pulse'
    });
    expect(batchInspect).toHaveBeenCalledWith({
      relativePaths: ['compare.pulse', 'archive/other.pulse']
    });
    expect(batchExport).toHaveBeenCalledWith({
      relativePaths: ['compare.pulse', 'archive/other.pulse'],
      mode: 'canonical'
    });
  });

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
