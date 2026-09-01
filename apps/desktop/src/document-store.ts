import { resolve } from 'node:path';
import {
  inspectPulse,
  sanitizeDisplayName,
  type InspectData,
  type OperationResult
} from '@dglab-pulse-hub/application';

export interface SourceSnapshot {
  readonly digest: string;
  readonly content: Uint8Array;
  readonly path: string;
}

/** Owns the privileged document bytes and the undo/redo cursor. */
export class DocumentStore {
  private sourceSnapshot: SourceSnapshot | null = null;
  private originalSnapshot: SourceSnapshot | null = null;
  private documentDirty = false;
  private historySnapshots: SourceSnapshot[] = [];
  private historyCursor = -1;

  get current(): SourceSnapshot | null {
    return this.sourceSnapshot === null ? null : copySnapshot(this.sourceSnapshot);
  }

  get original(): SourceSnapshot | null {
    return this.originalSnapshot === null ? null : copySnapshot(this.originalSnapshot);
  }

  get history(): readonly SourceSnapshot[] {
    return Object.freeze(this.historySnapshots.map(copySnapshot));
  }

  get cursor(): number {
    return this.historyCursor;
  }

  get dirty(): boolean {
    return this.documentDirty;
  }

  currentFor(digest: string): SourceSnapshot | null {
    return this.sourceSnapshot !== null && this.sourceSnapshot.digest === digest
      ? copySnapshot(this.sourceSnapshot)
      : null;
  }

  hasUnsavedChanges(): boolean {
    return (
      this.documentDirty ||
      (this.sourceSnapshot !== null &&
        this.originalSnapshot !== null &&
        this.sourceSnapshot.digest !== this.originalSnapshot.digest)
    );
  }

  reset(snapshot: SourceSnapshot): void {
    const initial = copySnapshot(snapshot);
    this.sourceSnapshot = copySnapshot(initial);
    this.originalSnapshot = copySnapshot(initial);
    this.historySnapshots = [copySnapshot(initial)];
    this.historyCursor = 0;
    this.documentDirty = false;
  }

  record(): void {
    if (this.sourceSnapshot === null) return;
    const next = copySnapshot(this.sourceSnapshot);
    this.historySnapshots = [...this.historySnapshots.slice(0, this.historyCursor + 1), next];
    this.historyCursor = this.historySnapshots.length - 1;
    this.documentDirty = true;
    this.sourceSnapshot = copySnapshot(next);
  }

  select(index: number): SourceSnapshot | null {
    const snapshot = this.historySnapshots[index];
    if (snapshot === undefined) return null;
    const selected = copySnapshot(snapshot);
    this.sourceSnapshot = selected;
    this.historyCursor = index;
    this.documentDirty =
      this.originalSnapshot === null || selected.digest !== this.originalSnapshot.digest;
    return copySnapshot(selected);
  }

  update(content: Uint8Array, path: string, dirty: boolean): OperationResult<InspectData> {
    const inspected = inspectPulse(content, {
      input: {
        displayName: sanitizeDisplayName(path.split(/[\\/]/).pop() ?? 'pulse.pulse'),
        bytes: content.byteLength
      }
    });
    if (inspected.status === 'success' && inspected.data !== null) {
      this.sourceSnapshot = Object.freeze({
        digest: inspected.data.sourceDigest,
        content: new Uint8Array(content),
        path: resolve(path)
      });
      this.documentDirty = dirty;
    }
    return inspected;
  }

  restoreCurrent(snapshot: SourceSnapshot, dirty: boolean): void {
    this.sourceSnapshot = copySnapshot(snapshot);
    this.documentDirty = dirty;
  }

  setDirty(dirty: boolean): void {
    this.documentDirty = dirty;
  }

  clear(): void {
    this.sourceSnapshot = null;
    this.originalSnapshot = null;
    this.documentDirty = false;
    this.historySnapshots = [];
    this.historyCursor = -1;
  }
}

function copySnapshot(snapshot: SourceSnapshot): SourceSnapshot {
  return Object.freeze({
    digest: snapshot.digest,
    content: new Uint8Array(snapshot.content),
    path: snapshot.path
  });
}
