import { describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION, RULE_VERSION, type OperationEnvelope } from '@dglab-pulse-hub/contracts';
import {
  fileExportActionFailureMessage,
  finalizeQrImageAction,
  qrImageActionFailureMessage,
  qrImageUnavailableMessage
} from '../src/workflow.js';
import type { WorkspaceArtifact, WorkspaceOperation } from '../src/client.js';

const artifact: WorkspaceArtifact = {
  bytes: new Uint8Array([0xff, 0xd8, 0xff]),
  displayName: 'sample.qr.jpg',
  contentType: 'image/jpeg'
};

const successEnvelope: OperationEnvelope = {
  schemaVersion: SCHEMA_VERSION,
  ruleVersion: RULE_VERSION,
  operation: 'export',
  status: 'success',
  result: null,
  diagnostics: []
};

const operation: WorkspaceOperation = { envelope: successEnvelope, artifact };

describe('QR image actions', () => {
  it('exposes QR availability before an unsupported action is pressed', () => {
    expect(qrImageUnavailableMessage(3)).toBeNull();
    expect(qrImageUnavailableMessage(4)).toBe(
      'QR image unavailable: DGLAB QR export supports at most three sections.'
    );
  });

  it('keeps preview generation isolated from artifact download', async () => {
    const saveArtifact = vi.fn();

    const result = await finalizeQrImageAction(operation, 'preview', saveArtifact);

    expect(result).toEqual({ operation });
    expect(saveArtifact).not.toHaveBeenCalled();
  });

  it('saves the generated artifact for the download action', async () => {
    const saveArtifact = vi.fn().mockResolvedValue(successEnvelope);
    const signal = new AbortController().signal;

    const result = await finalizeQrImageAction(operation, 'download', saveArtifact, signal);

    expect(saveArtifact).toHaveBeenCalledWith(artifact, 'sample.qr.jpg', signal);
    expect(result).toEqual({ operation, saveEnvelope: successEnvelope });
  });

  it('summarizes a failed preview without exposing repeated diagnostics', () => {
    const envelope: OperationEnvelope = {
      ...successEnvelope,
      status: 'rejected',
      result: null,
      diagnostics: [
        {
          code: 'PULSE_QR_SECTION_LIMIT',
          severity: 'error',
          stage: 'qr',
          message: 'DGLAB QR export supports at most three sections; the source contains more.',
          location: { path: 'sections' }
        },
        {
          code: 'PULSE_SEMANTIC_UNVERIFIED_SECTION_COUNT',
          severity: 'warning',
          stage: 'semantic',
          message: 'More than three sections are not verified.',
          location: { path: 'sections' }
        }
      ]
    };

    expect(qrImageActionFailureMessage(envelope, 'preview')).toBe(
      'QR image preview unavailable. DGLAB QR export supports at most three sections; the source contains more.'
    );
  });
});

describe('pulse file export actions', () => {
  it('reports a cancelled save without exposing export diagnostics', () => {
    expect(fileExportActionFailureMessage({
      ...successEnvelope,
      operation: 'write-file',
      status: 'cancelled',
      diagnostics: [{
        code: 'PULSE_TASK_CANCELLED',
        severity: 'info',
        stage: 'task',
        message: 'Artifact save was cancelled.',
        location: { path: '$' }
      }]
    })).toBe('Pulse file export cancelled.');
  });
});
