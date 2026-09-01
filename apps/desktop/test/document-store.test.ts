import { describe, expect, it } from 'vitest';
import { DocumentStore, type SourceSnapshot } from '../src/document-store.js';

const SNAPSHOT: SourceSnapshot = {
  digest: '0123456789abcdef',
  content: new Uint8Array([1, 2, 3]),
  path: '/tmp/source.pulse'
};

describe('DocumentStore', () => {
  it('does not expose mutable snapshot bytes or history internals', () => {
    const store = new DocumentStore();
    store.reset(SNAPSHOT);

    const current = store.current;
    const original = store.original;
    const history = store.history;
    const byDigest = store.currentFor(SNAPSHOT.digest);
    const selected = store.select(0);
    if (
      current === null ||
      original === null ||
      history[0] === undefined ||
      byDigest === null ||
      selected === null
    ) {
      throw new Error('Expected a reset document.');
    }

    current.content[0] = 9;
    original.content[1] = 9;
    history[0].content[2] = 9;
    byDigest.content[0] = 9;
    selected.content[1] = 9;
    expect(() => {
      (history as SourceSnapshot[]).length = 0;
    }).toThrow();

    expect(Array.from(store.current?.content ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(store.original?.content ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(store.currentFor(SNAPSHOT.digest)?.content ?? [])).toEqual([1, 2, 3]);
    expect(store.history).toHaveLength(1);
    expect(store.history).not.toBe(history);
  });

  it('copies snapshots restored after a failed update', () => {
    const store = new DocumentStore();
    const restored: SourceSnapshot = {
      digest: SNAPSHOT.digest,
      content: new Uint8Array([4, 5, 6]),
      path: SNAPSHOT.path
    };

    store.restoreCurrent(restored, true);
    restored.content[0] = 9;

    expect(Array.from(store.current?.content ?? [])).toEqual([4, 5, 6]);
    expect(store.dirty).toBe(true);
  });
});
