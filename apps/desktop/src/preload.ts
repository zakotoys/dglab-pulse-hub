import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  EditCommandDto,
  OperationEnvelopeDto,
  ReviewedAssistCommandDto
} from '@dglab-pulse-hub/contracts';
import type { Locale } from '@dglab-pulse-hub/workspace-ui';

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
  readonly command: EditCommandDto;
}

export type DesktopAssistRequest = ReviewedAssistCommandDto & {
  readonly sourceDigest: string;
};

export interface DesktopDiffRequest {
  readonly sourceDigest: string;
  readonly relativePath: string;
}

export interface DesktopQrRequest {
  readonly text: string;
}

export interface DesktopHistoryRequest {
  readonly sourceDigest: string;
}

export type DesktopHistoryResetListener = (envelope: OperationEnvelopeDto) => void;

export interface DesktopBatchExportRequest {
  readonly relativePaths: readonly string[];
  readonly mode?: 'canonical' | 'source';
  readonly overwrite?: boolean;
}

export interface DesktopBatchRequest {
  readonly relativePaths: readonly string[];
}

export interface DesktopWorkspaceFile {
  readonly name: string;
  readonly relativePath: string;
  readonly byteSize: number;
  readonly modifiedAt: string;
}

export interface DesktopWorkspaceIndex {
  readonly rootPath: string;
  readonly files: readonly DesktopWorkspaceFile[];
}

export interface DesktopWorkspaceImportResult {
  readonly index: DesktopWorkspaceIndex;
  readonly imported: readonly DesktopWorkspaceFile[];
}

contextBridge.exposeInMainWorld(
  'pulseDesktop',
  Object.freeze({
    setLocale: (locale: Locale): Promise<void> =>
      ipcRenderer.invoke('pulse:set-locale', { locale }),
    listWorkspace: (): Promise<DesktopWorkspaceIndex> => ipcRenderer.invoke('pulse:workspace-list'),
    importLocalFiles: (multiple: boolean): Promise<DesktopWorkspaceImportResult> =>
      ipcRenderer.invoke('pulse:workspace-import', { multiple }),
    openWorkspaceFile: (relativePath: string): Promise<OperationEnvelopeDto> =>
      ipcRenderer.invoke('pulse:workspace-open', { relativePath }),
    importDroppedFile: (file: File): Promise<DesktopWorkspaceImportResult> =>
      ipcRenderer.invoke('pulse:import-dropped', { path: webUtils.getPathForFile(file) }),
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
    batchInspect: (payload: DesktopBatchRequest): Promise<OperationEnvelopeDto> =>
      ipcRenderer.invoke('pulse:batch-inspect', payload),
    batchExport: (payload: DesktopBatchExportRequest): Promise<OperationEnvelopeDto> =>
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
