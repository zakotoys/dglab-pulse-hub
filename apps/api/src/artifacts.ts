import { basename } from 'node:path';
import {
  DIAGNOSTIC_CODES,
  location,
  makeDiagnostic,
  sortDiagnostics,
  type Diagnostic
} from '@dglab-pulse-hub/core';
import {
  operationResult,
  sanitizeDisplayName,
  type BatchData,
  type ExportData,
  type OperationResult,
  type TempArtifactStore
} from '@dglab-pulse-hub/application';
import { adapterDiagnostic, requestCancelled, requestResult } from './http.js';

export function artifactMissing(): OperationResult<never> {
  return operationResult('artifact', 'rejected', null, [
    makeDiagnostic(
      DIAGNOSTIC_CODES.ADAPTER_READ,
      'error',
      'adapter',
      'Artifact is missing or expired.',
      location('$')
    )
  ]);
}

export async function stageBatchExports(
  data: BatchData<ExportData>,
  store: TempArtifactStore,
  signal: AbortSignal
): Promise<OperationResult<BatchData<ExportData>>> {
  const stagedIds: string[] = [];
  const items: Array<BatchData<ExportData>['items'][number]> = [];
  const removeStaged = async (): Promise<void> => {
    if (stagedIds.length === 0) return;
    await Promise.all(stagedIds.splice(0).map((id) => store.remove(id)));
  };
  try {
    for (const item of data.items) {
      if (signal.aborted) {
        await removeStaged();
        return requestCancelled(signal);
      }
      if (item.status !== 'success' || item.data === null) {
        items.push(item);
        continue;
      }
      try {
        const artifact = await putRequestArtifact(
          store,
          item.data.displayName,
          item.data.bytes,
          { contentType: 'text/plain' },
          signal
        );
        if (artifact === null) {
          await removeStaged();
          return requestCancelled(signal);
        }
        stagedIds.push(artifact.id);
        items.push(
          Object.freeze({
            ...item,
            data: Object.freeze({
              ...item.data,
              downloadId: artifact.id,
              contentType: 'text/plain'
            })
          })
        );
      } catch {
        items.push(
          Object.freeze({
            ...item,
            status: 'failed' as const,
            diagnostics: [
              ...item.diagnostics,
              adapterDiagnostic(
                DIAGNOSTIC_CODES.ADAPTER_WRITE,
                'Batch export artifact could not be staged.'
              )
            ],
            data: null
          })
        );
      }
    }
  } catch {
    await removeStaged();
    return operationResult('batch', 'failed', null, [
      adapterDiagnostic(
        DIAGNOSTIC_CODES.ADAPTER_WRITE,
        'Batch export artifacts could not be staged.'
      )
    ]);
  }
  // The request may disconnect immediately after the final put. Do not return
  // a success envelope with handles that are about to become unreachable.
  if (signal.aborted) {
    await removeStaged();
    return requestCancelled(signal);
  }
  const succeeded = items.filter((item) => item.status === 'success').length;
  const rejected = items.filter((item) => item.status === 'rejected').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const cancelled = items.some((item) => item.status === 'cancelled');
  const warningFiles = items.filter((item) =>
    item.diagnostics.some((diagnostic) => diagnostic.severity === 'warning')
  ).length;
  const status = cancelled
    ? 'cancelled'
    : succeeded > 0
      ? 'success'
      : failed > 0
        ? 'failed'
        : 'rejected';
  // A failed batch cannot expose any artifact handle. This also protects the
  // lifecycle if a custom store reports a staged item that is later marked
  // failed by an adapter boundary.
  if (succeeded === 0) await removeStaged();
  const resultData = {
    ...data,
    completed: items.length,
    succeeded,
    rejected,
    failed,
    warningFiles,
    cancelled,
    items: Object.freeze(items)
  };
  return operationResult(
    'batch',
    status,
    status === 'success' ? resultData : null,
    sortDiagnostics(items.flatMap((item) => item.diagnostics))
  );
}

export async function putRequestArtifact(
  store: TempArtifactStore,
  displayName: string,
  content: Uint8Array,
  options: { readonly contentType?: string },
  signal: AbortSignal
): Promise<Awaited<ReturnType<TempArtifactStore['put']>> | null> {
  if (signal.aborted) return null;
  let resolveAborted: (() => void) | null = null;
  const aborted = new Promise<null>((resolve) => {
    resolveAborted = () => resolve(null);
  });
  const onAbort = (): void => resolveAborted?.();
  signal.addEventListener('abort', onAbort, { once: true });
  let pending: Promise<Awaited<ReturnType<TempArtifactStore['put']>>>;
  try {
    pending = store.put(displayName, content, options);
  } catch (error) {
    signal.removeEventListener('abort', onAbort);
    resolveAborted = null;
    throw error;
  }
  let artifact: Awaited<ReturnType<TempArtifactStore['put']>> | null;
  try {
    if (signal.aborted) onAbort();
    artifact = await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
    resolveAborted = null;
  }
  if (artifact === null) {
    // A store implementation may not support AbortSignal. Keep the request
    // responsive, then remove a late artifact when that operation completes.
    void pending.then((lateArtifact) => store.remove(lateArtifact.id)).catch(() => undefined);
    return null;
  }
  if (signal.aborted) {
    await store.remove(artifact.id);
    return null;
  }
  // A disconnect after staging must not leave the private artifact behind.
  // The one-shot download route removes it from the store first, so this
  // listener is harmless when a client successfully downloads the result.
  try {
    const removeOnAbort = (): void => {
      void store.remove(artifact.id);
    };
    signal.addEventListener('abort', removeOnAbort, { once: true });
    // Abort can race the check above. AbortSignal does not replay an event to a
    // listener added after it fired, so check again after registration.
    if (signal.aborted) {
      await store.remove(artifact.id);
      return null;
    }
  } catch {
    await store.remove(artifact.id);
    throw new Error('artifact-abort-hook-failed');
  }
  return artifact;
}

export async function stageArtifact<T extends object>(
  store: TempArtifactStore,
  operation: string,
  displayName: string,
  bytes: Uint8Array,
  data: T,
  diagnostics: readonly Diagnostic[],
  signal: AbortSignal,
  failureMessage: string
): Promise<
  OperationResult<T & { readonly downloadId: string; readonly contentType: 'text/plain' }>
> {
  let artifactId: string | null = null;
  try {
    const artifact = await putRequestArtifact(
      store,
      displayName,
      bytes,
      { contentType: 'text/plain' },
      signal
    );
    if (artifact === null) {
      return signal.aborted
        ? requestCancelled(signal)
        : operationResult(operation, 'failed', null, [
            adapterDiagnostic(DIAGNOSTIC_CODES.ADAPTER_WRITE, failureMessage)
          ]);
    }
    artifactId = artifact.id;
    const staged = requestResult(
      operationResult(
        operation,
        'success',
        { ...data, downloadId: artifact.id, contentType: 'text/plain' as const },
        diagnostics
      ),
      signal
    );
    if (staged.status !== 'success') await store.remove(artifact.id);
    return staged;
  } catch {
    if (artifactId !== null) await store.remove(artifactId);
    return requestResult(
      operationResult(operation, 'failed', null, [
        adapterDiagnostic(DIAGNOSTIC_CODES.ADAPTER_WRITE, failureMessage)
      ]),
      signal
    );
  }
}

export function asciiDisplayName(displayName: string): string {
  return (
    sanitizeDisplayName(basename(displayName))
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 180) || 'pulse-output'
  );
}

function encodeDispositionFileName(displayName: string): string {
  return encodeURIComponent(displayName).replace(
    /['()*]/g,
    (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase()
  );
}

export function contentDisposition(displayName: string): string {
  const safeName = sanitizeDisplayName(basename(displayName));
  const fallback = asciiDisplayName(safeName);
  if (safeName === fallback) return 'attachment; filename="' + fallback + '"';
  return (
    'attachment; filename="' +
    fallback +
    "\"; filename*=UTF-8''" +
    encodeDispositionFileName(safeName)
  );
}
