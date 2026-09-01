import type { OperationEnvelope } from '@dglab-pulse-hub/contracts';
import { DGLAB_QR_MAX_SECTIONS } from '@dglab-pulse-hub/core';
import type { WorkspaceClient, WorkspaceOperation } from './client.js';

export {
  assistProposalFingerprint,
  isAssistProposalValid,
  reviewedAssistMatches,
  type AssistProposalFingerprintInput
} from '@dglab-pulse-hub/core';

interface InspectionResultLike {
  readonly status: string;
}

/** Keep a candidate out of the visible document until its inspection passes. */
export async function inspectThenCommit<T, TResult extends InspectionResultLike>(
  candidate: T,
  inspect: (candidate: T) => Promise<TResult>,
  commit: (candidate: T) => void,
  canCommit: () => boolean = () => true
): Promise<TResult> {
  const inspected = await inspect(candidate);
  if (inspected.status === 'success' && canCommit()) commit(candidate);
  return inspected;
}

export type QrImageAction = 'preview' | 'download';

export interface QrImageActionResult {
  readonly operation: WorkspaceOperation;
  readonly saveEnvelope?: OperationEnvelope;
}

export function qrImageUnavailableMessage(sectionCount: number): string | null {
  return sectionCount > DGLAB_QR_MAX_SECTIONS
    ? 'QR image unavailable: DGLAB QR export supports at most three sections.'
    : null;
}

export function qrImageActionFailureMessage(
  envelope: OperationEnvelope,
  action: QrImageAction
): string {
  const prefix = action === 'preview' ? 'QR image preview unavailable.' : 'QR image export failed.';
  const diagnostic =
    envelope.diagnostics.find((item) => item.severity === 'error') ?? envelope.diagnostics[0];
  return diagnostic === undefined ? prefix : prefix + ' ' + diagnostic.message;
}

export function fileExportActionFailureMessage(envelope: OperationEnvelope): string {
  if (envelope.status === 'cancelled') return 'Pulse file export cancelled.';
  const prefix = 'Pulse file export failed.';
  const diagnostic =
    envelope.diagnostics.find((item) => item.severity === 'error') ?? envelope.diagnostics[0];
  return diagnostic === undefined ? prefix : prefix + ' ' + diagnostic.message;
}

export async function finalizeQrImageAction(
  operation: WorkspaceOperation,
  action: QrImageAction,
  saveArtifact: WorkspaceClient['saveArtifact'],
  signal?: AbortSignal
): Promise<QrImageActionResult> {
  if (
    action === 'preview' ||
    operation.envelope.status !== 'success' ||
    operation.artifact === undefined
  ) {
    return { operation };
  }
  const saveEnvelope = await saveArtifact(
    operation.artifact,
    operation.artifact.displayName || 'pulse.qr.jpg',
    signal
  );
  return { operation, saveEnvelope };
}
