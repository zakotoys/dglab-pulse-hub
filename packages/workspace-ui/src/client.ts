import type {
  BatchDataDto,
  DiffDataDto,
  EditDataDto,
  EditCommandDto,
  InspectDataDto,
  OperationEnvelope,
  ReviewedAssistCommandDto,
  RenderDataDto
} from '@dglab-pulse-hub/contracts';

export type EditPayload = EditCommandDto;
export type AssistPayload = ReviewedAssistCommandDto;

export interface BrowserWorkspaceFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly type?: string;
}

export interface ManagedWorkspaceFile {
  readonly name: string;
  readonly relativePath: string;
}

export type WorkspaceFile = BrowserWorkspaceFile | ManagedWorkspaceFile;

export interface LocalPulseFile {
  readonly name: string;
  readonly relativePath: string;
  readonly byteSize: number;
  readonly modifiedAt: string;
}

export interface LocalPulseIndex {
  readonly rootPath: string;
  readonly files: readonly LocalPulseFile[];
}

export interface LocalPulseImportResult {
  readonly index: LocalPulseIndex;
  readonly imported: readonly LocalPulseFile[];
}

export interface LocalFileManagerClient {
  readonly list: (signal?: AbortSignal) => Promise<LocalPulseIndex>;
  readonly import: (multiple: boolean, signal?: AbortSignal) => Promise<LocalPulseImportResult>;
  readonly importDropped: (file: File, signal?: AbortSignal) => Promise<LocalPulseImportResult>;
  readonly open: (relativePath: string, signal?: AbortSignal) => Promise<WorkspaceOperation>;
}

export interface WorkspaceDocument {
  readonly displayName: string;
  readonly digest: string;
  /** Browser adapters retain text locally; the native adapter intentionally does not. */
  readonly text?: string;
}

export interface WorkspaceArtifact {
  readonly bytes: Uint8Array;
  readonly displayName: string;
  readonly contentType?: string;
}

export interface WorkspaceOperation {
  readonly envelope: OperationEnvelope;
  readonly document?: WorkspaceDocument;
  /** Plain text produced by QR decoding, before inspection. */
  readonly decodedText?: string;
  readonly editData?: EditDataDto;
  readonly artifact?: WorkspaceArtifact;
}

export interface WorkspaceClient {
  /** Determines whether the source control uses browser file inputs or native dialogs. */
  readonly fileMode: 'browser' | 'native';
  readonly open: (signal?: AbortSignal) => Promise<WorkspaceOperation>;
  readonly importFile: (file: WorkspaceFile, signal?: AbortSignal) => Promise<WorkspaceOperation>;
  readonly localFiles?: LocalFileManagerClient;
  readonly inspect: (
    text: string,
    displayName: string,
    signal?: AbortSignal
  ) => Promise<WorkspaceOperation>;
  readonly decodeQr: (text: string, signal?: AbortSignal) => Promise<WorkspaceOperation>;
  readonly export: (
    document: WorkspaceDocument,
    format: 'pulse-text' | 'qr-envelope',
    mode: 'source' | 'canonical',
    signal?: AbortSignal
  ) => Promise<WorkspaceOperation>;
  readonly renderPreview: (
    document: WorkspaceDocument,
    format: 'svg' | 'png' | 'jpg',
    signal?: AbortSignal
  ) => Promise<WorkspaceOperation>;
  readonly edit: (
    document: WorkspaceDocument,
    command: EditPayload,
    signal?: AbortSignal
  ) => Promise<WorkspaceOperation>;
  readonly assist: (
    document: WorkspaceDocument,
    input: AssistPayload,
    signal?: AbortSignal
  ) => Promise<WorkspaceOperation>;
  readonly diff: (
    document: WorkspaceDocument,
    comparison?: WorkspaceFile,
    signal?: AbortSignal
  ) => Promise<WorkspaceOperation>;
  readonly batchInspect: (
    files?: readonly WorkspaceFile[],
    signal?: AbortSignal
  ) => Promise<WorkspaceOperation>;
  readonly batchExport: (
    files?: readonly WorkspaceFile[],
    mode?: 'source' | 'canonical',
    signal?: AbortSignal
  ) => Promise<WorkspaceOperation>;
  readonly undo: (
    document: WorkspaceDocument,
    target?: WorkspaceDocument,
    signal?: AbortSignal
  ) => Promise<WorkspaceOperation>;
  readonly redo: (
    document: WorkspaceDocument,
    target?: WorkspaceDocument,
    signal?: AbortSignal
  ) => Promise<WorkspaceOperation>;
  readonly downloadArtifact: (
    id: string,
    signal?: AbortSignal
  ) => Promise<WorkspaceArtifact | null>;
  readonly saveArtifact: (
    artifact: WorkspaceArtifact,
    suggestedName: string,
    signal?: AbortSignal
  ) => Promise<OperationEnvelope>;
  /** Native adapters may reset their private history after replacing a source. */
  readonly onHistoryReset?: (listener: (operation: WorkspaceOperation) => void) => () => void;
  readonly dispose?: () => void;
}

export type WorkspaceInspectData = InspectDataDto;
export type WorkspaceBatchData = BatchDataDto;
export type WorkspaceDiffData = DiffDataDto;
export type WorkspaceRenderData = RenderDataDto;

export function documentFromInspect(
  envelope: OperationEnvelope,
  displayName: string,
  text?: string
): WorkspaceDocument | null {
  if (envelope.status !== 'success') return null;
  const result = envelope.result;
  if (typeof result !== 'object' || result === null || !('sourceDigest' in result)) return null;
  const digest = (result as { readonly sourceDigest?: unknown }).sourceDigest;
  if (typeof digest !== 'string' || !/^[0-9a-f]{16}$/i.test(digest)) return null;
  return Object.freeze({ displayName, digest, ...(text === undefined ? {} : { text }) });
}

export function operationWithDocument(
  envelope: OperationEnvelope,
  displayName: string,
  text?: string
): WorkspaceOperation {
  const document = documentFromInspect(envelope, displayName, text);
  return Object.freeze({ envelope, ...(document === null ? {} : { document }) });
}
