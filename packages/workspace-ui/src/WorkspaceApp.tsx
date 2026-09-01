import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';
import {
  SCHEMA_VERSION,
  RULE_VERSION,
  batchDataSchema,
  diffDataSchema,
  inspectDataSchema,
  type BatchDataDto,
  type DiffDataDto,
  type InspectDataDto,
  type OperationEnvelope
} from '@dglab-pulse-hub/contracts';
import {
  PreviewPlaybackController,
  previewQuadraticAssist,
  type QuadraticAssistPoint,
  type WaveformStream
} from '@dglab-pulse-hub/core';
import { nearestTimelinePointIndex, timelineIndexForKey, timelineSectionForPoint, timelineTimeAtClientX } from './timeline.js';
import {
  type EditPayload,
  type WorkspaceArtifact,
  type WorkspaceClient,
  type WorkspaceDocument,
  type WorkspaceFile,
  type WorkspaceOperation
} from './client.js';
import {
  assistProposalFingerprint,
  isAssistProposalValid,
  reviewedAssistMatches,
  type AssistProposalFingerprintInput
} from './workflow.js';

type StreamPoint = NonNullable<InspectDataDto['stream']>['points'][number];

function failureEnvelope(
  operation: string,
  message: string,
  code = 'PULSE_ADAPTER_READ_FAILED',
  status: 'rejected' | 'failed' | 'cancelled' = 'failed'
): OperationEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    ruleVersion: RULE_VERSION,
    operation: /^[a-z][a-z0-9-]{0,79}$/.test(operation) ? operation : 'request',
    status,
    result: null,
    diagnostics: [{
      code,
      severity: status === 'cancelled' ? 'info' : 'error',
      stage: status === 'cancelled' ? 'task' : 'adapter',
      message,
      location: { path: '$' }
    }]
  };
}

function inspectResult(envelope: OperationEnvelope): InspectDataDto | null {
  if (envelope.status !== 'success') return null;
  const parsed = inspectDataSchema.safeParse(envelope.result);
  return parsed.success ? parsed.data : null;
}

function batchResult(envelope: OperationEnvelope): BatchDataDto | null {
  if (envelope.status !== 'success') return null;
  const parsed = batchDataSchema.safeParse(envelope.result);
  return parsed.success ? parsed.data : null;
}

function diffResult(envelope: OperationEnvelope): DiffDataDto | null {
  if (envelope.status !== 'success') return null;
  const parsed = diffDataSchema.safeParse(envelope.result);
  return parsed.success ? parsed.data : null;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    // Keep a leading BOM visible to the API so source-snapshot export can
    // preserve the exact input bytes. Core recognition applies the explicit
    // BOM policy after this boundary.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function formatMs(value: number): string {
  if (!Number.isFinite(value)) return '--';
  if (value >= 60_000) return Math.floor(value / 60_000) + 'm ' + Math.floor(value / 1_000) % 60 + 's';
  return (value / 1_000).toFixed(value < 10_000 ? 2 : 1) + 's';
}

function downsample<T>(values: readonly T[], limit: number): readonly T[] {
  if (values.length <= limit || limit < 2) return values;
  const step = (values.length - 1) / (limit - 1);
  const output: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    const value = values[Math.round(index * step)];
    if (value !== undefined) output.push(value);
  }
  return output;
}

function assistPointsForSection(
  metadata: InspectDataDto['metadata'] | null,
  sectionIndex: number
): readonly QuadraticAssistPoint[] {
  const section = metadata?.sections.find((item) => item.sectionIndex === sectionIndex);
  if (section === undefined) return [];
  return section.sourcePoints.map((point) => ({
    strength: point.strength,
    anchor: point.anchor
  }));
}

export interface WorkspaceAppProps {
  readonly client: WorkspaceClient;
}

export function WorkspaceApp({ client }: WorkspaceAppProps): ReactElement {
  const [fileName, setFileName] = useState('');
  const [workspaceDocument, setWorkspaceDocument] = useState<WorkspaceDocument | null>(null);
  const [envelope, setEnvelope] = useState<OperationEnvelope | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<number | null>(null);
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);
  const [selectedSection, setSelectedSection] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [message, setMessage] = useState('');
  const [qrInput, setQrInput] = useState('');
  const [exportMode, setExportMode] = useState<'source' | 'canonical'>('source');
  const [previewFormat, setPreviewFormat] = useState<'svg' | 'png' | 'jpg'>('svg');
  const [strengthInput, setStrengthInput] = useState('');
  const [anchorInput, setAnchorInput] = useState<0 | 1>(0);
  const [frequencyStartInput, setFrequencyStartInput] = useState('');
  const [frequencyEndInput, setFrequencyEndInput] = useState('');
  const [durationInput, setDurationInput] = useState('');
  const [addStrengthInput, setAddStrengthInput] = useState('50');
  const [addAnchorInput, setAddAnchorInput] = useState<0 | 1>(0);
  const [compareText, setCompareText] = useState('');
  const [compareFile, setCompareFile] = useState<WorkspaceFile | null>(null);
  const [compareName, setCompareName] = useState('compare.pulse');
  const [diffEnvelope, setDiffEnvelope] = useState<OperationEnvelope | null>(null);
  const [assistStartInput, setAssistStartInput] = useState('0');
  const [assistEndInput, setAssistEndInput] = useState('2');
  const [assistStartStrengthInput, setAssistStartStrengthInput] = useState('0');
  const [assistEndStrengthInput, setAssistEndStrengthInput] = useState('100');
  const [assistReviewedFingerprint, setAssistReviewedFingerprint] = useState<string | null>(null);
  const [assistPreview, setAssistPreview] = useState<readonly number[]>([]);
  const [qrArtifact, setQrArtifact] = useState<WorkspaceArtifact | null>(null);
  const [qrPreviewUrl, setQrPreviewUrl] = useState<string | null>(null);
  const [batchFiles, setBatchFiles] = useState<readonly WorkspaceFile[]>([]);
  const [batchEnvelope, setBatchEnvelope] = useState<OperationEnvelope | null>(null);
  const [batchMode, setBatchMode] = useState<'inspect' | 'export'>('inspect');
  const [batchProgress, setBatchProgress] = useState({ completed: 0, total: 0 });
  const [dragActive, setDragActive] = useState(false);
  const [history, setHistory] = useState<readonly WorkspaceDocument[]>([]);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const abortController = useRef<AbortController | null>(null);
  const interactionGeneration = useRef(0);
  const compareLoadGeneration = useRef(0);
  const batchDownloadGeneration = useRef(0);
  const historyRef = useRef<readonly WorkspaceDocument[]>([]);
  const cursorRef = useRef(-1);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selectedPointRef = useRef<number | null>(null);

  function updateSelectedPoint(index: number | null): void {
    selectedPointRef.current = index;
    setSelectedPoint(index);
  }

  // Contract parsing allocates fresh objects. Keep the parsed view model
  // stable between renders so effects that synchronize form fields do not
  // turn every render into another state update.
  const result = useMemo(
    () => envelope === null ? null : inspectResult(envelope),
    [envelope]
  );
  const stream = result?.stream ?? null;
  const diagnostics = envelope?.diagnostics ?? [];
  const sections = result?.metadata.sections ?? [];
  const section = sections[selectedSection] ?? sections[0];
  const point = selectedPoint !== null && stream !== null ? stream.points[selectedPoint] : undefined;
  const hoveredPoint = hoveredPointIndex !== null && stream !== null ? stream.points[hoveredPointIndex] : undefined;
  const dirty = workspaceDocument !== null && historyCursor > 0;
  const canUndo = historyCursor > 0;
  const canRedo = historyCursor >= 0 && historyCursor < history.length - 1;
  const batch = useMemo(
    () => batchEnvelope === null ? null : batchResult(batchEnvelope),
    [batchEnvelope]
  );
  const diff = useMemo(
    () => diffEnvelope === null ? null : diffResult(diffEnvelope),
    [diffEnvelope]
  );
  const assistStart = Number(assistStartInput);
  const assistEnd = Number(assistEndInput);
  const assistStartStrength = Number(assistStartStrengthInput);
  const assistEndStrength = Number(assistEndStrengthInput);
  const assistFingerprintInput: AssistProposalFingerprintInput = {
    sourceDigest: result?.sourceDigest ?? '',
    sectionIndex: section?.sectionIndex ?? -1,
    sectionPointCount: section?.pointCount ?? 0,
    contextPointIndex: selectedPoint ?? -1,
    startPointIndex: assistStart,
    endPointIndex: assistEnd,
    startStrength: assistStartStrength,
    endStrength: assistEndStrength
  };
  const assistFingerprint = assistProposalFingerprint(assistFingerprintInput);
  const assistReviewed = reviewedAssistMatches(assistFingerprintInput, assistReviewedFingerprint);
  const assistPoints = useMemo(
    () => section === undefined ? [] : assistPointsForSection(result?.metadata ?? null, section.sectionIndex),
    [result?.metadata, section?.sectionIndex]
  );
  const playback = useMemo(() => {
    if (stream === null) return null;
    return new PreviewPlaybackController(stream as unknown as WaveformStream, { playbackRate: 0.2 });
  }, [stream?.digest]);
  useEffect(() => () => {
    interactionGeneration.current += 1;
    abortController.current?.abort();
    abortController.current = null;
    client.dispose?.();
  }, []);

  useEffect(() => {
    const unsubscribe = client.onHistoryReset?.((operation) => {
      if (operation.document === undefined) return;
      applyOperationView(operation);
      resetHistory(operation.document);
      setExportMode('source');
    });
    return unsubscribe;
  }, [client]);

  useEffect(() => {
    if (playback === null) {
      setPlaying(false);
      setPlayhead(0);
      return;
    }
    const unsubscribe = playback.subscribe((snapshot) => {
      setPlaying(snapshot.state === 'playing');
      setPlayhead(snapshot.currentTimeMs);
      if (snapshot.state !== 'idle' && snapshot.currentPointIndex !== null) {
        selectStreamPoint(snapshot.currentPointIndex);
      }
    });
    return () => {
      unsubscribe();
      playback.dispose();
    };
  }, [playback]);

  useEffect(() => {
    if (qrArtifact === null) {
      setQrPreviewUrl(null);
      return;
    }
    const bytes = qrArtifact.bytes.slice().buffer as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([bytes], {
      type: qrArtifact.contentType ?? 'image/jpeg'
    }));
    setQrPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [qrArtifact]);

  useEffect(() => {
    if (point !== undefined) {
      setStrengthInput(point.intensityDecimal);
      setAnchorInput(point.anchor);
    }
    if (section !== undefined) {
      setFrequencyStartInput(String(section.frequencyStartIndex));
      setFrequencyEndInput(String(section.frequencyEndIndex));
      setDurationInput(String(section.durationIndex));
    }
    if (point !== undefined && point.source.sectionIndex === selectedSection) {
      setAssistStartInput(String(Math.max(0, point.source.controlPointIndex - 1)));
      setAssistEndInput(String(Math.min((section?.pointCount ?? 3) - 1, point.source.controlPointIndex + 1)));
      setAssistStartStrengthInput(point.intensityDecimal);
      setAssistEndStrengthInput(point.intensityDecimal);
    }
  }, [point, section]);

  useEffect(() => {
    if (section === undefined || !isAssistProposalValid(assistFingerprintInput)) {
      setAssistPreview([]);
      return;
    }
    setAssistPreview(previewQuadraticAssist(assistPoints, {
      startPointIndex: assistStart,
      endPointIndex: assistEnd,
      startStrength: assistStartStrength,
      endStrength: assistEndStrength
    }) ?? []);
  }, [section, assistPoints, assistStart, assistEnd, assistStartStrength, assistEndStrength]);

  function beginRequest(label: string): AbortController {
    interactionGeneration.current += 1;
    abortController.current?.abort();
    const controller = new AbortController();
    abortController.current = controller;
    setBusy(true);
    setBusyLabel(label);
    setMessage('');
    return controller;
  }

  function isCurrentRequest(controller: AbortController): boolean {
    // Controller identity is the request token. Aborting an older request
    // does not make its already-resolved promise safe to apply.
    return abortController.current === controller;
  }

  function isCurrentInteraction(generation: number): boolean {
    return interactionGeneration.current === generation;
  }

  function endRequest(controller: AbortController): void {
    if (abortController.current === controller) {
      abortController.current = null;
      setBusy(false);
      setBusyLabel('');
    }
  }

  function applyInspectionView(nextEnvelope: OperationEnvelope): void {
    const nextResult = inspectResult(nextEnvelope);
    setEnvelope(nextEnvelope);
    if (nextResult !== null) {
      const nextPointIndex = nextResult.stream === null || nextResult.stream.points.length === 0
        ? null
        : selectedPointRef.current === null
          ? 0
          : Math.min(selectedPointRef.current, nextResult.stream.points.length - 1);
      updateSelectedPoint(nextPointIndex);
      setSelectedSection((current) => {
        const pointSection = nextPointIndex === null || nextResult.stream === null
          ? null
          : timelineSectionForPoint(nextResult.stream.points, nextPointIndex);
        return pointSection === null
          ? Math.min(current, Math.max(0, nextResult.metadata.sections.length - 1))
          : pointSection;
      });
      setHoveredPointIndex(null);
    } else {
      updateSelectedPoint(null);
      setHoveredPointIndex(null);
    }
    setPlayhead(0);
    setPlaying(false);
  }

  function applyOperationView(operation: WorkspaceOperation): void {
    applyInspectionView(operation.envelope);
    setQrArtifact(null);
    const nextResult = inspectResult(operation.envelope);
    const nextDocument = operation.document ?? (nextResult === null ? null : {
      displayName: nextResult.metadata.file.displayName,
      digest: nextResult.sourceDigest
    });
    if (nextDocument !== null) {
      setWorkspaceDocument(nextDocument);
      setFileName(nextDocument.displayName);
    }
  }

  function resetHistory(document: WorkspaceDocument): void {
    const next = Object.freeze([document]);
    historyRef.current = next;
    cursorRef.current = 0;
    setHistory(next);
    setHistoryCursor(0);
    setAssistReviewedFingerprint(null);
  }

  function clearHistory(): void {
    const next: readonly WorkspaceDocument[] = Object.freeze([]);
    historyRef.current = next;
    cursorRef.current = -1;
    setHistory(next);
    setHistoryCursor(-1);
  }

  function clearDocumentState(): void {
    setFileName('');
    setWorkspaceDocument(null);
    setSelectedSection(0);
    updateSelectedPoint(null);
    setHoveredPointIndex(null);
    setPlaying(false);
    setPlayhead(0);
    setExportMode('source');
    setAssistPreview([]);
    setAssistReviewedFingerprint(null);
    setQrArtifact(null);
    setDiffEnvelope(null);
    clearHistory();
  }

  function commitHistory(document: WorkspaceDocument): void {
    const next = Object.freeze([...historyRef.current.slice(0, cursorRef.current + 1), document]);
    historyRef.current = next;
    cursorRef.current = next.length - 1;
    setHistory(next);
    setHistoryCursor(next.length - 1);
  }

  async function importFile(file: File): Promise<void> {
    const controller = beginRequest('Importing');
    try {
      const operation = await client.importFile({
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        ...(file.type === '' ? {} : { type: file.type })
      }, controller.signal);
      if (!isCurrentRequest(controller)) return;
      if (operation.envelope.status !== 'success' || operation.document === undefined) {
        clearDocumentState();
        setEnvelope(operation.envelope);
        return;
      }
      applyOperationView(operation);
      setExportMode('source');
      resetHistory(operation.document);
    } catch (error) {
      if (!isCurrentRequest(controller)) return;
      clearDocumentState();
      if (error instanceof DOMException && error.name === 'AbortError') setEnvelope(failureEnvelope('inspect', 'Import was cancelled.', 'PULSE_TASK_CANCELLED', 'cancelled'));
      else setEnvelope(failureEnvelope('inspect', 'The selected file could not be imported.'));
    } finally {
      endRequest(controller);
    }
  }

  async function openNativeDocument(): Promise<void> {
    const controller = beginRequest('Opening');
    try {
      const operation = await client.open(controller.signal);
      if (!isCurrentRequest(controller)) return;
      if (operation.envelope.status !== 'success' || operation.document === undefined) {
        clearDocumentState();
        setEnvelope(operation.envelope);
        return;
      }
      applyOperationView(operation);
      setExportMode('source');
      resetHistory(operation.document);
    } catch (error) {
      if (!isCurrentRequest(controller)) return;
      clearDocumentState();
      setEnvelope(error instanceof DOMException && error.name === 'AbortError'
        ? failureEnvelope('inspect', 'Open was cancelled.', 'PULSE_TASK_CANCELLED', 'cancelled')
        : failureEnvelope('inspect', 'The selected file could not be opened.'));
    } finally {
      endRequest(controller);
    }
  }

  function openDocument(): void {
    if (client.fileMode === 'native') {
      void openNativeDocument();
    } else {
      fileInputRef.current?.click();
    }
  }

  function handleDropzoneDragEnter(event: ReactDragEvent<HTMLLabelElement>): void {
    if (client.fileMode !== 'browser') return;
    event.preventDefault();
    if (!busy) setDragActive(true);
  }

  function handleDropzoneDragOver(event: ReactDragEvent<HTMLLabelElement>): void {
    if (client.fileMode !== 'browser') return;
    event.preventDefault();
    if (!busy) {
      event.dataTransfer.dropEffect = 'copy';
      setDragActive(true);
    }
  }

  function handleDropzoneDragLeave(event: ReactDragEvent<HTMLLabelElement>): void {
    if (client.fileMode !== 'browser') return;
    event.preventDefault();
    const related = event.relatedTarget;
    if (related === null || !(related instanceof Node) || !event.currentTarget.contains(related)) {
      setDragActive(false);
    }
  }

  function handleDropzoneDrop(event: ReactDragEvent<HTMLLabelElement>): void {
    if (client.fileMode !== 'browser') return;
    event.preventDefault();
    setDragActive(false);
    if (busy) return;
    const file = event.dataTransfer.files?.[0];
    if (file !== undefined) void importFile(file);
  }

  function handleDropzoneKeyDown(event: React.KeyboardEvent<HTMLLabelElement>): void {
    if (busy || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    openDocument();
  }

  async function importQrText(): Promise<void> {
    if (qrInput.trim() === '') return;
    const controller = beginRequest('Decoding QR');
    try {
      const operation = await client.decodeQr(qrInput, controller.signal);
      if (!isCurrentRequest(controller)) return;
      if (operation.envelope.status !== 'success' || operation.document === undefined) {
        clearDocumentState();
        setEnvelope(operation.envelope);
        return;
      }
      applyOperationView(operation);
      setExportMode('source');
      resetHistory(operation.document);
    } catch (error) {
      if (!isCurrentRequest(controller)) return;
      clearDocumentState();
      if (error instanceof DOMException && error.name === 'AbortError') setEnvelope(failureEnvelope('qr-decode', 'QR decoding was cancelled.', 'PULSE_TASK_CANCELLED', 'cancelled'));
      else setEnvelope(failureEnvelope('qr-decode', 'QR content could not be decoded.'));
    } finally {
      endRequest(controller);
    }
  }

  async function exportCurrent(format: 'pulse-text' | 'qr-envelope' = 'pulse-text'): Promise<void> {
    if (workspaceDocument === null) return;
    const controller = beginRequest('Exporting');
    try {
      const operation = await client.export(workspaceDocument, format, exportMode, controller.signal);
      if (!isCurrentRequest(controller)) return;
      if (operation.envelope.status !== 'success') {
        setEnvelope(operation.envelope);
        return;
      }
      if (operation.artifact !== undefined) {
        const saved = await client.saveArtifact(
          operation.artifact,
          format === 'qr-envelope' ? (operation.artifact.displayName || 'pulse.qr.jpg') : (fileName || 'pulse.pulse'),
          controller.signal
        );
        if (saved.status !== 'success') {
          setEnvelope(saved);
          return;
        }
      }
      if (format === 'qr-envelope') setQrArtifact(operation.artifact ?? null);
      setMessage(format === 'qr-envelope' ? 'QR image downloaded.' : 'Pulse file downloaded.');
    } catch (error) {
      if (!isCurrentRequest(controller)) return;
      if (error instanceof DOMException && error.name === 'AbortError') setMessage('Export cancelled.');
      else setMessage('Export failed.');
    } finally {
      endRequest(controller);
    }
  }

  async function renderPreview(): Promise<void> {
    if (workspaceDocument === null) return;
    const controller = beginRequest('Rendering preview');
    try {
      const operation = await client.renderPreview(workspaceDocument, previewFormat, controller.signal);
      if (!isCurrentRequest(controller)) return;
      if (operation.envelope.status !== 'success') {
        setEnvelope(operation.envelope);
        return;
      }
      if (operation.artifact !== undefined) {
        const saved = await client.saveArtifact(operation.artifact, 'pulse-preview.' + previewFormat, controller.signal);
        if (saved.status !== 'success') {
          setEnvelope(saved);
          return;
        }
      }
      setMessage(previewFormat.toUpperCase() + ' preview downloaded.');
    } catch (error) {
      if (!isCurrentRequest(controller)) return;
      if (error instanceof DOMException && error.name === 'AbortError') setMessage('Preview rendering cancelled.');
      else setMessage('Preview rendering failed.');
    } finally {
      endRequest(controller);
    }
  }

  async function applyEdit(command: EditPayload): Promise<void> {
    if (workspaceDocument === null) return;
    const controller = beginRequest('Applying edit');
    try {
      const operation = await client.edit(workspaceDocument, command, controller.signal);
      if (!isCurrentRequest(controller)) return;
      if (operation.envelope.status !== 'success' || operation.document === undefined) {
        setEnvelope(operation.envelope);
        return;
      }
      applyOperationView(operation);
      commitHistory(operation.document);
      setExportMode('canonical');
      setMessage('Edit applied. The source snapshot remains available through undo.');
    } catch (error) {
      if (!isCurrentRequest(controller)) return;
      if (error instanceof DOMException && error.name === 'AbortError') setMessage('Edit cancelled.');
      else setMessage('Edit failed.');
    } finally {
      endRequest(controller);
    }
  }

  async function loadCompareFile(file: File): Promise<void> {
    const generation = ++compareLoadGeneration.current;
    const interaction = ++interactionGeneration.current;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const decoded = decodeUtf8(bytes);
      if (generation !== compareLoadGeneration.current || !isCurrentInteraction(interaction)) return;
      if (decoded === null) {
        setDiffEnvelope(failureEnvelope('diff', 'The comparison file is not valid UTF-8.', 'PULSE_RECOGNIZE_INVALID_ENCODING', 'rejected'));
        setCompareText('');
        return;
      }
      setCompareName(file.name);
      setCompareText(decoded);
      setCompareFile({ name: file.name, bytes, ...(file.type === '' ? {} : { type: file.type }) });
      setDiffEnvelope(null);
      setMessage('Comparison file ready. Run diff to review semantic changes.');
    } catch {
      if (generation !== compareLoadGeneration.current || !isCurrentInteraction(interaction)) return;
      setDiffEnvelope(failureEnvelope('diff', 'The comparison file could not be read.', 'PULSE_ADAPTER_READ_FAILED', 'failed'));
    }
  }

  async function runDiff(): Promise<void> {
    if (workspaceDocument === null || (client.fileMode === 'browser' && compareFile === null)) return;
    const controller = beginRequest('Comparing documents');
    try {
      const operation = await client.diff(
        workspaceDocument,
        client.fileMode === 'browser' ? compareFile ?? undefined : undefined,
        controller.signal
      );
      if (!isCurrentRequest(controller)) return;
      setDiffEnvelope(operation.envelope);
    } catch (error) {
      if (!isCurrentRequest(controller)) return;
      setDiffEnvelope(error instanceof DOMException && error.name === 'AbortError'
        ? failureEnvelope('diff', 'Comparison was cancelled.', 'PULSE_TASK_CANCELLED', 'cancelled')
        : failureEnvelope('diff', 'The documents could not be compared.'));
    } finally {
      endRequest(controller);
    }
  }

  function previewAssist(): void {
    if (section === undefined || !isAssistProposalValid(assistFingerprintInput)) {
      setAssistPreview([]);
      setMessage('Choose a valid point interval and endpoint strengths before previewing.');
      return;
    }
    const values = previewQuadraticAssist(assistPoints, {
      startPointIndex: assistStart,
      endPointIndex: assistEnd,
      startStrength: assistStartStrength,
      endStrength: assistEndStrength
    });
    if (values === null) {
      setAssistPreview([]);
      setMessage('The selected section does not expose a previewable point range.');
      return;
    }
    setAssistPreview(values);
    setAssistReviewedFingerprint(null);
    setMessage('Curve proposal refreshed. Review each value before applying it.');
  }

  async function applyAssist(): Promise<void> {
    if (workspaceDocument === null || !assistReviewed || section === undefined) {
      setMessage('Review the proposed curve and confirm it before applying.');
      return;
    }
    const controller = beginRequest('Applying reviewed curve');
    try {
      const operation = await client.assist(workspaceDocument, {
          sectionIndex: section.sectionIndex,
          startPointIndex: assistStart,
          endPointIndex: assistEnd,
          startStrength: assistStartStrength,
          endStrength: assistEndStrength,
          reviewed: true
        }, controller.signal);
      if (!isCurrentRequest(controller)) return;
      if (operation.envelope.status !== 'success' || operation.document === undefined) {
        setEnvelope(operation.envelope);
        return;
      }
      applyOperationView(operation);
      commitHistory(operation.document);
      setExportMode('canonical');
      setAssistReviewedFingerprint(null);
      setMessage('Reviewed curve applied.');
    } catch (error) {
      if (!isCurrentRequest(controller)) return;
      setMessage(error instanceof DOMException && error.name === 'AbortError' ? 'Curve application cancelled.' : 'Curve application failed.');
    } finally {
      endRequest(controller);
    }
  }

  async function runBatch(): Promise<void> {
    if (client.fileMode === 'browser' && batchFiles.length === 0) return;
    const controller = beginRequest(batchMode === 'inspect' ? 'Inspecting batch' : 'Exporting batch');
    setBatchProgress({ completed: 0, total: batchFiles.length });
    try {
      const operation = batchMode === 'inspect'
        ? await client.batchInspect(client.fileMode === 'browser' ? batchFiles : undefined, controller.signal)
        : await client.batchExport(client.fileMode === 'browser' ? batchFiles : undefined, exportMode, controller.signal);
      if (!isCurrentRequest(controller)) return;
      setBatchEnvelope(operation.envelope);
      if (operation.envelope.status === 'success') {
        const completed = batchResult(operation.envelope)?.completed ?? batchFiles.length;
        setBatchProgress({ completed, total: batchResult(operation.envelope)?.total ?? batchFiles.length });
      }
      setMessage(batchMode === 'inspect' ? 'Batch inspection complete.' : 'Batch export complete. Download successful items below.');
    } catch (error) {
      if (!isCurrentRequest(controller)) return;
      setBatchEnvelope(error instanceof DOMException && error.name === 'AbortError'
        ? failureEnvelope('batch', 'Batch task was cancelled.', 'PULSE_TASK_CANCELLED', 'cancelled')
        : failureEnvelope('batch', 'The batch task could not be completed.'));
    } finally {
      endRequest(controller);
    }
  }

  async function downloadBatchItem(index: number): Promise<void> {
    const item = batch?.items[index];
    if (item === undefined || item.status !== 'success' || typeof item.result !== 'object' || item.result === null) return;
    const result = item.result as { readonly downloadId?: unknown; readonly displayName?: unknown; readonly contentType?: unknown };
    if (typeof result.downloadId !== 'string') return;
    const generation = ++batchDownloadGeneration.current;
    const interaction = ++interactionGeneration.current;
    try {
      if (generation !== batchDownloadGeneration.current || !isCurrentInteraction(interaction)) return;
      const artifact = await client.downloadArtifact(result.downloadId);
      if (artifact === null) {
        setMessage(item.displayName + ' is no longer available.');
        return;
      }
      const saved = await client.saveArtifact(artifact, typeof result.displayName === 'string' ? result.displayName : item.displayName);
      if (saved.status !== 'success') setMessage(item.displayName + ' could not be downloaded.');
    } catch {
      if (generation !== batchDownloadGeneration.current || !isCurrentInteraction(interaction)) return;
      setMessage(item.displayName + ' could not be downloaded.');
    }
  }

  async function downloadAllBatch(): Promise<void> {
    if (batch === null) return;
    for (let index = 0; index < batch.items.length; index += 1) await downloadBatchItem(index);
  }

  async function moveHistory(direction: -1 | 1): Promise<void> {
    const nextCursor = cursorRef.current + direction;
    const target = historyRef.current[nextCursor];
    const current = workspaceDocument;
    if (target === undefined || current === null) return;
    const controller = beginRequest(direction < 0 ? 'Undoing' : 'Redoing');
    try {
      const operation = direction < 0
        ? await client.undo(current, target, controller.signal)
        : await client.redo(current, target, controller.signal);
      if (!isCurrentRequest(controller) || operation.envelope.status !== 'success' || operation.document === undefined) return;
      applyOperationView(operation);
      cursorRef.current = nextCursor;
      setHistoryCursor(nextCursor);
      setExportMode(nextCursor === 0 ? 'source' : 'canonical');
      setMessage(direction < 0 ? 'Undo applied.' : 'Redo applied.');
    } catch {
      // Keep the cursor at the last accepted snapshot if an adapter exception
      // escapes inspectText before the target has been committed.
    } finally {
      endRequest(controller);
    }
  }

  function timelinePointFromClientX(event: { readonly clientX: number }, element: SVGSVGElement): number | null {
    if (stream === null || stream.points.length === 0) return null;
    const rect = element.getBoundingClientRect();
    const timeMs = timelineTimeAtClientX(event.clientX, rect.left, rect.width, stream.totalDurationMs);
    return timeMs === null ? null : nearestTimelinePointIndex(stream.points, timeMs);
  }

  function selectTimeline(event: ReactMouseEvent<SVGSVGElement>): void {
    const index = timelinePointFromClientX(event, event.currentTarget);
    selectStreamPoint(index);
  }

  function hoverTimeline(event: ReactPointerEvent<SVGSVGElement>): void {
    const index = timelinePointFromClientX(event, event.currentTarget);
    setHoveredPointIndex(index);
  }

  function focusTimeline(): void {
    if (hoveredPointIndex !== null || selectedPoint === null) return;
    setHoveredPointIndex(selectedPoint);
  }

  function selectStreamPoint(index: number | null): void {
    if (index === null || stream === null) return;
    const nextSection = timelineSectionForPoint(stream.points, index);
    if (nextSection === null) return;
    updateSelectedPoint(index);
    setSelectedSection(nextSection);
  }

  function moveTimelinePoint(direction: -1 | 1): void {
    const next = timelineIndexForKey(direction < 0 ? 'ArrowLeft' : 'ArrowRight', selectedPoint, stream?.points.length ?? 0);
    if (next === null) return;
    selectStreamPoint(next);
    setHoveredPointIndex(next);
  }

  function moveTimelineToKey(key: string): void {
    const next = timelineIndexForKey(key, selectedPoint, stream?.points.length ?? 0);
    if (next === null) return;
    selectStreamPoint(next);
    setHoveredPointIndex(next);
  }

  function selectSection(index: number): void {
    setSelectedSection(index);
    if (stream === null) return;
    const first = stream.points.findIndex((item) => item.source.sectionIndex === index);
    updateSelectedPoint(first >= 0 ? first : null);
  }

  const plot = useMemo(() => {
    if (stream === null || stream.points.length === 0) return { intensity: '', frequency: '' };
    const points = downsample(stream.points, 1_600);
    const width = 960;
    const height = 240;
    const x = (item: StreamPoint) => item.timeMs / Math.max(1, stream.totalDurationMs) * width;
    return {
      intensity: points.map((item) => x(item).toFixed(2) + ',' + (height - item.intensity * 2.05).toFixed(2)).join(' '),
      frequency: points.map((item) => x(item).toFixed(2) + ',' + (height - item.frequencyIndex / 83 * height).toFixed(2)).join(' ')
    };
  }, [stream]);

  return (
    <main className="shell">
      <header className="topbar"><div className="brand"><span className="brand-mark">PH</span><div><strong>Pulse Hub</strong><small>DG-LAB waveform workbench</small></div></div><div className="version">rules {result?.recognition.ruleVersion ?? RULE_VERSION}</div></header>
      <section className="workspace">
        <aside className="sidebar" aria-label="Document controls">
          <div className="section-heading"><span>Source</span><span className="status-dot" data-state={envelope?.status ?? 'idle'} /></div>
          <label className={'dropzone' + (dragActive ? ' is-dragging' : '')} role="button" tabIndex={busy ? -1 : 0} aria-disabled={busy} onClick={(event) => { if (client.fileMode === 'native') { event.preventDefault(); openDocument(); } }} onKeyDown={handleDropzoneKeyDown} onDragEnter={handleDropzoneDragEnter} onDragOver={handleDropzoneDragOver} onDragLeave={handleDropzoneDragLeave} onDrop={handleDropzoneDrop}>{client.fileMode === 'browser' && <input ref={fileInputRef} type="file" accept=".pulse,.txt,text/plain" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file !== undefined) void importFile(file); event.currentTarget.value = ''; }} />}<span className="upload-icon" aria-hidden="true">↑</span><b>{busy ? busyLabel : client.fileMode === 'native' ? 'Open pulse file' : 'Open pulse file'}</b><small>UTF-8 .pulse or QR text</small></label>
          <div className="qr-import"><label htmlFor="qr-input">QR content or URL</label><textarea id="qr-input" rows={3} value={qrInput} onChange={(event) => setQrInput(event.target.value)} disabled={busy} /><button className="secondary" disabled={busy || qrInput.trim() === ''} onClick={() => void importQrText()}>Decode QR</button></div>
          <div className="sidebar-block compare-block">
            <div className="section-heading"><span>Compare</span><span className="muted">semantic</span></div>
            {client.fileMode === 'browser' && <label className="file-picker"><span>Select a second file</span><input type="file" accept=".pulse,.txt,text/plain" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file !== undefined) void loadCompareFile(file); event.currentTarget.value = ''; }} /></label>}
            <small className="field-note">{client.fileMode === 'native' ? 'Choose a file when you run diff' : compareText === '' ? 'No comparison loaded' : compareName}</small>
            <button className="secondary" disabled={busy || workspaceDocument === null || (client.fileMode === 'browser' && compareFile === null)} onClick={() => void runDiff()}>Run diff</button>
          </div>
          <div className="sidebar-block batch-block">
            <div className="section-heading"><span>Batch</span><span className="muted">{batchFiles.length || 'none'}</span></div>
            {client.fileMode === 'browser' && <label className="file-picker"><span>Choose multiple files</span><input type="file" multiple accept=".pulse,.txt,text/plain" disabled={busy} onChange={(event) => { const selected = Array.from(event.target.files ?? []).slice(0, 100); void Promise.all(selected.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), ...(file.type === '' ? {} : { type: file.type }) }))).then((files) => { setBatchFiles(files); setBatchEnvelope(null); setBatchProgress({ completed: 0, total: files.length }); }); event.currentTarget.value = ''; }} /></label>}
            <div className="segmented" role="group" aria-label="Batch operation"><button type="button" data-active={batchMode === 'inspect'} onClick={() => setBatchMode('inspect')} disabled={busy}>Inspect</button><button type="button" data-active={batchMode === 'export'} onClick={() => setBatchMode('export')} disabled={busy}>Export</button></div>
            {batchProgress.total > 0 && <div className="batch-progress" aria-live="polite"><span style={{ width: (batchProgress.completed / batchProgress.total * 100) + '%' }} /><small>{batchProgress.completed}/{batchProgress.total} files read</small></div>}
            <button className="secondary" disabled={busy || (client.fileMode === 'browser' && batchFiles.length === 0)} onClick={() => void runBatch()}>Run batch</button>
          </div>
          {fileName !== '' && <div className="file-chip"><span aria-hidden="true">◇</span><div><b title={fileName}>{fileName}</b><small>{result?.metadata.file.byteSize ?? 0} bytes{dirty ? ' · unsaved' : ''}</small></div></div>}
          {result !== null && <div className="sidebar-block"><div className="section-heading"><span>Pulse</span><span className="muted">r{result.pulse.revision}</span></div><dl className="compact"><div><dt>Sections</dt><dd>{result.metadata.pulse.sectionCount}</dd></div><div><dt>Enabled</dt><dd>{result.metadata.pulse.enabledSectionCount}</dd></div><div><dt>Duration</dt><dd>{formatMs(result.metadata.pulse.effectiveDurationMs)}</dd></div><div><dt>Points</dt><dd>{result.metadata.stream.stats.pointCount}</dd></div></dl></div>}
          <div className="sidebar-block"><div className="section-heading"><span>History</span><span className="muted">{history.length}</span></div><div className="history-actions"><button className="icon-button" aria-label="Undo" disabled={!canUndo || busy} onClick={() => void moveHistory(-1)}>↶</button><button className="icon-button" aria-label="Redo" disabled={!canRedo || busy} onClick={() => void moveHistory(1)}>↷</button></div></div>
          <div className="sidebar-block"><div className="section-heading"><span>Export</span></div><label className="select-label">Text mode<select value={exportMode} onChange={(event) => setExportMode(event.target.value as 'source' | 'canonical')} disabled={busy}><option value="source" disabled={dirty}>Source snapshot</option><option value="canonical">Canonical</option></select></label><button className="action" disabled={workspaceDocument === null || busy} onClick={() => void exportCurrent()}>↓ <span>Export .pulse</span></button><button className="action" disabled={workspaceDocument === null || busy} onClick={() => void exportCurrent('qr-envelope')}>⌁ <span>Export QR image</span></button></div>
          <div className="sidebar-block"><div className="section-heading"><span>Preview image</span></div><div className="preview-actions"><select aria-label="Preview format" value={previewFormat} onChange={(event) => setPreviewFormat(event.target.value as 'svg' | 'png' | 'jpg')} disabled={busy}><option value="svg">SVG</option><option value="png">PNG</option><option value="jpg">JPG</option></select><button className="secondary" disabled={workspaceDocument === null || busy} onClick={() => void renderPreview()}>↓ Download</button></div></div>
          {busy && <button className="cancel" onClick={() => abortController.current?.abort()}>Cancel current task</button>}
          {message !== '' && <p className="notice" role="status">{message}</p>}
        </aside>
        <div className="content">
          <section className="hero-row"><div><p className="eyebrow">WORKSPACE</p><h1>{fileName || 'Open a pulse document'}</h1><p className="subline">{result === null ? 'Ready for a .pulse or QR input.' : result.recognition.profile + ' · ' + result.recognition.format}</p></div>{envelope !== null && <div className="badge" data-status={envelope.status}>{envelope.status}</div>}</section>
          {diagnostics.length > 0 && <section className="diagnostics" aria-live="polite"><div className="section-heading"><span>Diagnostics</span><span className="muted">{diagnostics.length}</span></div>{diagnostics.map((item, index) => <div className="diagnostic" data-severity={item.severity} key={item.code + index}><span className="severity" aria-hidden="true">{item.severity === 'error' ? '!' : item.severity === 'warning' ? '△' : 'i'}</span><div><b>{item.code}</b><p>{item.message}</p><small>{item.location.path}{item.location.span === undefined ? '' : ' · line ' + item.location.span.line + ', column ' + item.location.span.column}{item.suggestion === undefined ? '' : ' · ' + item.suggestion}</small></div></div>)}</section>}
          {qrPreviewUrl !== null && <section className="panel qr-preview-panel" aria-live="polite"><div className="panel-head"><div><p className="eyebrow">QR EXPORT</p><h2>Generated QR image</h2></div><span className="muted">JPG</span></div><img className="qr-preview-image" src={qrPreviewUrl} alt="Generated pulse QR code" /></section>}
          {stream !== null ? <>
            <section className="panel timeline-panel"><div className="panel-head"><div><p className="eyebrow">WAVEFORM STREAM</p><h2>Intensity and frequency</h2></div><div className="legend"><span><i className="swatch intensity" />Intensity</span><span><i className="swatch frequency" />Frequency index</span></div></div><div className="timeline-wrap"><svg viewBox="0 0 960 280" role="img" aria-label="Waveform stream timeline. Hover or focus to inspect point metadata." tabIndex={0} onClick={selectTimeline} onPointerMove={hoverTimeline} onPointerLeave={() => setHoveredPointIndex(null)} onFocus={focusTimeline} onKeyDown={(event) => { const key = event.key; if (key === 'ArrowRight') moveTimelinePoint(1); else if (key === 'ArrowLeft') moveTimelinePoint(-1); else if (key === 'Home' || key === 'End') moveTimelineToKey(key); else return; event.preventDefault(); }}><line className="axis" x1="0" y1="240" x2="960" y2="240" /><line className="axis" x1="0" y1="0" x2="0" y2="240" /><polyline className="line frequency" points={plot.frequency} /><polyline className="line intensity" points={plot.intensity} />{stream.points.length > 0 && <line className="cursor" x1={(playhead / Math.max(1, stream.totalDurationMs) * 960).toFixed(2)} x2={(playhead / Math.max(1, stream.totalDurationMs) * 960).toFixed(2)} y1="0" y2="240" />}</svg>{hoveredPoint !== undefined && <div className="timeline-tooltip" role="status" aria-live="polite"><strong>Point {hoveredPoint.index + 1}</strong><span>{formatMs(hoveredPoint.timeMs)} · {hoveredPoint.intensityDecimal} intensity · frequency {hoveredPoint.frequencyIndex}</span><small>Section {hoveredPoint.source.sectionIndex + 1} · repetition {hoveredPoint.source.repetitionIndex + 1} · {hoveredPoint.source.origin}</small></div>}<div className="time-labels"><span>0 ms</span><span>{formatMs(stream.totalDurationMs)}</span></div></div><div className="playback"><button className="icon-button" aria-label={playing ? 'Pause preview playback' : 'Play preview playback'} onClick={() => { if (playback === null || stream.totalDurationMs <= 0) return; if (playing) playback.pause(); else playback.play(); }}>{playing ? 'Ⅱ' : '▶'}</button><button className="icon-button" aria-label="Stop preview playback" onClick={() => { playback?.stop(); setPlayhead(0); }}>■</button><input aria-label="Preview playback position" type="range" min="0" max={Math.max(1, stream.totalDurationMs)} value={Math.min(playhead, stream.totalDurationMs)} onChange={(event) => { const value = Number(event.target.value); playback?.seek(value); setPlaying(false); }} /><span className="timecode">{formatMs(playhead)} / {formatMs(stream.totalDurationMs)}</span><span className="preview-label">Preview playback</span></div></section>
            <section className="visual-grid"><div className="panel intensity-panel"><div className="panel-head"><div><p className="eyebrow">INTENSITY MAP</p><h2>Current strength</h2></div><span className="muted">numeric + colour</span></div><div className="intensity-visual"><div className="intensity-ring" style={{ '--intensity': (point?.intensity ?? 0) + '%' } as CSSProperties} role="img" aria-label={'Current intensity ' + (point?.intensityDecimal ?? '0') + ' out of 100'}><span>{point?.intensityDecimal ?? '0'}</span><small>/ 100</small></div><div className="intensity-scale"><div className="colour-strip" /><div className="scale-labels"><span>0</span><span>50</span><span>100</span></div><p>{point === undefined ? 'Select a point to inspect its colour mapping.' : 'Colour is a secondary cue. The exact intensity remains visible as a number.'}</p></div></div></div><div className="panel stream-stats"><div className="panel-head"><div><p className="eyebrow">STREAM STATS</p><h2>Expanded snapshot</h2></div></div>{result !== null && <dl className="detail-grid"><div><dt>Points</dt><dd>{result.metadata.stream.stats.pointCount}</dd></div><div><dt>Total duration</dt><dd>{formatMs(result.metadata.stream.stats.totalDurationMs)}</dd></div><div><dt>Frequency range</dt><dd>{result.metadata.stream.stats.minFrequencyIndex ?? '--'} to {result.metadata.stream.stats.maxFrequencyIndex ?? '--'}</dd></div><div><dt>Mean intensity</dt><dd>{result.metadata.stream.stats.meanIntensity?.toFixed(2) ?? '--'}</dd></div><div><dt>Granularity</dt><dd>{formatMs(result.metadata.stream.timeGranularityMs)}</dd></div><div><dt>Warnings</dt><dd>{result.metadata.stream.warningCount}</dd></div></dl>}</div></section>
            <section className="lower-grid"><div className="panel"><div className="panel-head"><div><p className="eyebrow">SECTIONS</p><h2>Structure</h2></div></div><div className="section-list">{sections.map((item) => <button className="section-row" data-selected={item.sectionIndex === selectedSection} aria-pressed={item.sectionIndex === selectedSection} key={item.sectionIndex} onClick={() => selectSection(item.sectionIndex)}><span className="section-number">{String(item.sectionIndex + 1).padStart(2, '0')}</span><span><b>Section {item.sectionIndex + 1}</b><small>{item.enabled ? 'Enabled' : 'Disabled'} · mode {item.frequencyMode} · {item.pointCount} points</small></span><strong>{formatMs(item.effectiveDurationMs)}</strong></button>)}</div></div><div className="panel detail-panel"><div className="panel-head"><div><p className="eyebrow">POINT DETAIL</p><h2>{point === undefined ? 'Select a point' : 'Point ' + (point.index + 1)}</h2></div></div>{point === undefined || section === undefined ? <div className="empty">Select a timeline point or section.</div> : <><dl className="detail-grid"><div><dt>Time</dt><dd>{formatMs(point.timeMs)}</dd></div><div><dt>Duration</dt><dd>{formatMs(point.durationMs)}</dd></div><div><dt>Intensity</dt><dd>{point.intensityDecimal}</dd></div><div><dt>Frequency index</dt><dd>{point.frequencyIndex}</dd></div><div><dt>Section</dt><dd>{point.source.sectionIndex + 1}</dd></div><div><dt>Repetition</dt><dd>{point.source.repetitionIndex + 1}{section.repetitionCount > 1 ? ' of ' + section.repetitionCount : ''}</dd></div><div><dt>Origin</dt><dd>{point.source.origin}</dd></div></dl><div className="edit-stack"><label>Intensity <input type="number" min="0" max="100" step="0.01" value={strengthInput} onChange={(event) => setStrengthInput(event.target.value)} /><button className="secondary" disabled={busy} onClick={() => void applyEdit({ kind: 'strength', sectionIndex: point.source.sectionIndex, pointIndex: point.source.controlPointIndex, value: Number(strengthInput) })}>Apply</button></label><label>Anchor <select value={anchorInput} onChange={(event) => setAnchorInput(Number(event.target.value) as 0 | 1)}><option value={0}>Automatic</option><option value={1}>Anchor</option></select><button className="secondary" disabled={busy} onClick={() => void applyEdit({ kind: 'anchor', sectionIndex: point.source.sectionIndex, pointIndex: point.source.controlPointIndex, value: anchorInput })}>Apply</button></label></div></>}</div></section>
            <section className="panel controls-panel"><div className="panel-head"><div><p className="eyebrow">SECTION EDITOR</p><h2>Frequency, duration and points</h2></div><span className="muted">Section {(section?.sectionIndex ?? selectedSection) + 1}</span></div>{section !== undefined && <div className="editor-grid"><label>Start index<input type="number" min="0" max="83" step="1" value={frequencyStartInput} onChange={(event) => setFrequencyStartInput(event.target.value)} /></label><label>End index<input type="number" min="0" max="83" step="1" value={frequencyEndInput} onChange={(event) => setFrequencyEndInput(event.target.value)} /></label><button className="secondary" disabled={busy} onClick={() => void applyEdit({ kind: 'frequency', sectionIndex: section.sectionIndex, startIndex: Number(frequencyStartInput), endIndex: Number(frequencyEndInput) })}>Apply frequency</button><label>Duration index<input type="number" min="0" max="99" step="1" value={durationInput} onChange={(event) => setDurationInput(event.target.value)} /></label><button className="secondary" disabled={busy} onClick={() => void applyEdit({ kind: 'duration', sectionIndex: section.sectionIndex, value: Number(durationInput) })}>Apply duration</button><label>Add strength<input type="number" min="0" max="100" step="0.01" value={addStrengthInput} onChange={(event) => setAddStrengthInput(event.target.value)} /></label><label>Add type<select value={addAnchorInput} onChange={(event) => setAddAnchorInput(Number(event.target.value) as 0 | 1)}><option value={0}>Automatic</option><option value={1}>Anchor</option></select></label><button className="secondary" disabled={busy} onClick={() => void applyEdit({ kind: 'add-point', sectionIndex: section.sectionIndex, value: Number(addStrengthInput), anchor: addAnchorInput, atIndex: point?.source.sectionIndex === section.sectionIndex ? point.source.controlPointIndex : undefined })}>+ Add point</button><button className="danger-button" disabled={busy || point === undefined || point.source.sectionIndex !== section.sectionIndex} onClick={() => point !== undefined && void applyEdit({ kind: 'remove-point', sectionIndex: point.source.sectionIndex, pointIndex: point.source.controlPointIndex })}>− Remove selected point</button></div>}</section>
            <section className="panel assist-panel"><div className="panel-head"><div><p className="eyebrow">REVIEWED ASSIST</p><h2>Quadratic curve proposal</h2></div></div><p className="panel-copy">Set two control-point endpoints. The proposal stays local until you review and confirm it.</p><div className="assist-grid"><label>Start point<input type="number" min="0" step="1" value={assistStartInput} onChange={(event) => setAssistStartInput(event.target.value)} /></label><label>End point<input type="number" min="0" step="1" value={assistEndInput} onChange={(event) => setAssistEndInput(event.target.value)} /></label><label>Start strength<input type="number" min="0" max="100" step="0.01" value={assistStartStrengthInput} onChange={(event) => setAssistStartStrengthInput(event.target.value)} /></label><label>End strength<input type="number" min="0" max="100" step="0.01" value={assistEndStrengthInput} onChange={(event) => setAssistEndStrengthInput(event.target.value)} /></label></div><div className="assist-actions"><button className="secondary" disabled={busy || section === undefined} onClick={previewAssist}>Preview proposal</button><label className="review-check"><input type="checkbox" checked={assistReviewed} onChange={(event) => setAssistReviewedFingerprint(event.target.checked ? assistFingerprint : null)} disabled={busy || assistPreview.length === 0} /> I reviewed the proposed values</label><button className="secondary" disabled={busy || !assistReviewed || assistPreview.length === 0} onClick={() => void applyAssist()}>Apply reviewed curve</button></div>{assistPreview.length > 0 && <div className="assist-preview" aria-live="polite"><span>Proposed values</span>{assistPreview.map((value, index) => <code key={index}>{assistStart + index}: {value.toFixed(2)}</code>)}</div>}</section>
          </> : result !== null && <section className="panel empty-panel"><h2>No stream available</h2><p>Resolve the diagnostics before previewing this document.</p></section>}
          {diffEnvelope !== null && <section className="panel diff-panel"><div className="panel-head"><div><p className="eyebrow">DOCUMENT DIFF</p><h2>{diff?.diff.equal ? 'No semantic changes' : 'Changes between documents'}</h2></div><span className="badge" data-status={diffEnvelope.status}>{diffEnvelope.status}</span></div>{diff === null ? <div className="empty">{diffEnvelope.diagnostics.map((item) => item.message).join(' ')}</div> : <><div className="diff-summary"><span><b>{diff.diff.structural.length}</b> structural</span><span><b>{diff.diff.metadata.length}</b> metadata</span><span><b>{diff.diff.stream.length}</b> stream</span><span><b>{diff.diff.text.length}</b> text</span></div><div className="diff-list">{[...diff.diff.structural, ...diff.diff.metadata, ...diff.diff.stream].slice(0, 80).map((entry, index) => <div className="diff-row" key={entry.path + index}><code>{entry.path}</code><span>{String(entry.before ?? '∅')}</span><b>→</b><span>{String(entry.after ?? '∅')}</span></div>)}{diff.diff.structural.length + diff.diff.metadata.length + diff.diff.stream.length > 80 && <small className="field-note">Showing the first 80 field changes.</small>}</div></>}</section>}
          {batchEnvelope !== null && <section className="panel batch-results"><div className="panel-head"><div><p className="eyebrow">BATCH RESULTS</p><h2>{batch === null ? 'Batch task' : batch.completed + ' of ' + batch.total + ' complete'}</h2></div>{batchEnvelope.status === 'success' && batch !== null && batchMode === 'export' && batch.items.some((item) => item.status === 'success' && typeof item.result === 'object' && item.result !== null && typeof (item.result as { readonly downloadId?: unknown }).downloadId === 'string') && <button className="secondary" onClick={() => void downloadAllBatch()}>Download successful</button>}</div>{batch === null ? <div className="empty">{batchEnvelope.diagnostics.map((item) => item.message).join(' ')}</div> : <div className="batch-list">{batch.items.map((item, index) => { const itemResult = typeof item.result === 'object' && item.result !== null ? item.result as { readonly downloadId?: unknown } : null; const downloadable = item.status === 'success' && batchMode === 'export' && typeof itemResult?.downloadId === 'string'; return <div className="batch-row" key={item.id}><div><b>{item.displayName}</b><small>{item.status} · {item.diagnostics.length} diagnostics</small></div>{downloadable ? <button className="secondary" onClick={() => void downloadBatchItem(index)}>Download</button> : <span className="batch-status" data-status={item.status}>{item.status === 'success' && batchMode === 'export' ? 'saved' : item.status}</span>}</div>; })}</div>}</section>}
          {busy && <div className="busy-bar" role="status">{busyLabel}…</div>}
        </div>
      </section>
    </main>
  );
}
