import { contextBridge, ipcRenderer } from 'electron';
import type { OperationEnvelopeDto } from '@dglab-pulse-hub/contracts';

export interface DesktopExportRequest {
  readonly sourceDigest: string;
  readonly displayName?: string;
  readonly format?: 'pulse-text' | 'qr-envelope';
  readonly mode?: 'canonical' | 'source';
}

export interface DesktopExportArtifact {
  readonly bytes: Uint8Array;
  readonly displayName: string;
  readonly contentType: string;
}

export interface DesktopExportResponse {
  readonly envelope: OperationEnvelopeDto;
  readonly artifact?: DesktopExportArtifact;
}

export interface DesktopSaveArtifactRequest {
  readonly artifact: DesktopExportArtifact;
  readonly suggestedName: string;
}

export interface DesktopPreviewRequest {
  readonly sourceDigest: string;
  readonly displayName?: string;
  readonly format: 'svg' | 'png' | 'jpg';
}

export interface DesktopEditRequest {
  readonly sourceDigest: string;
  readonly command: {
    readonly kind: 'strength' | 'anchor' | 'frequency' | 'duration' | 'add-point' | 'remove-point';
    readonly sectionIndex: number;
    readonly pointIndex?: number;
    readonly value?: number;
    readonly startIndex?: number;
    readonly endIndex?: number;
    readonly atIndex?: number;
    readonly anchor?: 0 | 1;
  };
}

export interface DesktopAssistRequest {
  readonly sourceDigest: string;
  readonly sectionIndex: number;
  readonly startPointIndex: number;
  readonly endPointIndex: number;
  readonly startStrength: number;
  readonly endStrength: number;
  readonly reviewed: true;
}

export interface DesktopDiffRequest {
  readonly sourceDigest: string;
}

export interface DesktopQrRequest {
  readonly text: string;
}

export interface DesktopHistoryRequest {
  readonly sourceDigest: string;
}

export type DesktopHistoryResetListener = (envelope: OperationEnvelopeDto) => void;

export interface DesktopBatchExportRequest {
  readonly mode?: 'canonical' | 'source';
  readonly overwrite?: boolean;
}

contextBridge.exposeInMainWorld(
  'pulseDesktop',
  Object.freeze({
    open: (): Promise<OperationEnvelopeDto> => ipcRenderer.invoke('pulse:open'),
    inspectCurrent: (): Promise<OperationEnvelopeDto> =>
      ipcRenderer.invoke('pulse:inspect-current'),
    decodeQr: (payload: DesktopQrRequest): Promise<OperationEnvelopeDto> =>
      ipcRenderer.invoke('pulse:decode-qr', payload),
    edit: (payload: DesktopEditRequest): Promise<OperationEnvelopeDto> =>
      ipcRenderer.invoke('pulse:edit', payload),
    assist: (payload: DesktopAssistRequest): Promise<OperationEnvelopeDto> =>
      ipcRenderer.invoke('pulse:assist', payload),
    diff: (payload: DesktopDiffRequest): Promise<OperationEnvelopeDto> =>
      ipcRenderer.invoke('pulse:diff', payload),
    undo: (payload: DesktopHistoryRequest): Promise<OperationEnvelopeDto> =>
      ipcRenderer.invoke('pulse:undo', payload),
    redo: (payload: DesktopHistoryRequest): Promise<OperationEnvelopeDto> =>
      ipcRenderer.invoke('pulse:redo', payload),
    onHistoryReset: (listener: DesktopHistoryResetListener): (() => void) => {
      const handler = (_event: unknown, value: unknown): void => {
        listener(value as OperationEnvelopeDto);
      };
      ipcRenderer.on('pulse:history-reset', handler);
      return () => ipcRenderer.removeListener('pulse:history-reset', handler);
    },
    batchInspect: (): Promise<OperationEnvelopeDto> => ipcRenderer.invoke('pulse:batch-inspect'),
    batchExport: (payload: DesktopBatchExportRequest = {}): Promise<OperationEnvelopeDto> =>
      ipcRenderer.invoke('pulse:batch-export', payload),
    renderPreview: (payload: DesktopPreviewRequest): Promise<OperationEnvelopeDto> =>
      ipcRenderer.invoke('pulse:render-preview', payload),
    export: (
      payload: DesktopExportRequest
    ): Promise<OperationEnvelopeDto | DesktopExportResponse> =>
      ipcRenderer.invoke('pulse:export', payload),
    saveArtifact: (payload: DesktopSaveArtifactRequest): Promise<OperationEnvelopeDto> =>
      ipcRenderer.invoke('pulse:save-artifact', payload),
    markDirty: (dirty: boolean): Promise<OperationEnvelopeDto> =>
      ipcRenderer.invoke('pulse:mark-dirty', { dirty })
  })
);
