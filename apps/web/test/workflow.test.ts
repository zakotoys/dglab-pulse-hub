import { describe, expect, it, vi } from 'vitest';
import { inspectThenCommit } from '../src/workflow.js';

describe('edit inspection transaction', () => {
  it('never commits a candidate when re-inspection rejects it', async () => {
    const commit = vi.fn();
    const inspected = await inspectThenCommit(
      'candidate.pulse',
      async () => ({ status: 'rejected' as const }),
      commit
    );

    expect(inspected.status).toBe('rejected');
    expect(commit).not.toHaveBeenCalled();
  });

  it('commits only after re-inspection succeeds', async () => {
    const commit = vi.fn();
    const inspected = await inspectThenCommit(
      'candidate.pulse',
      async (candidate) => {
        expect(candidate).toBe('candidate.pulse');
        return { status: 'success' as const };
      },
      commit
    );

    expect(inspected.status).toBe('success');
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith('candidate.pulse');
  });

  it('does not commit a stale successful result after the request is superseded', async () => {
    const commit = vi.fn();
    const inspected = await inspectThenCommit(
      'candidate.pulse',
      async () => ({ status: 'success' as const }),
      commit,
      () => false
    );

    expect(inspected.status).toBe('success');
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not commit when re-inspection is cancelled', async () => {
    const commit = vi.fn();
    const inspected = await inspectThenCommit(
      'candidate.pulse',
      async () => ({ status: 'cancelled' as const }),
      commit
    );

    expect(inspected.status).toBe('cancelled');
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not commit after a re-inspection transport failure', async () => {
    const commit = vi.fn();
    const inspected = await inspectThenCommit(
      'candidate.pulse',
      async () => ({ status: 'failed' as const }),
      commit
    );

    expect(inspected.status).toBe('failed');
    expect(commit).not.toHaveBeenCalled();
  });

  it('checks the commit token after the asynchronous inspection resolves', async () => {
    const commit = vi.fn();
    let release: (() => void) | null = null;
    let current = true;
    const inspectedPromise = inspectThenCommit(
      'candidate.pulse',
      () => new Promise<{ status: 'success' }>((resolve) => {
        release = () => resolve({ status: 'success' });
      }),
      commit,
      () => current
    );
    current = false;
    release?.();
    const inspected = await inspectedPromise;

    expect(inspected.status).toBe('success');
    expect(commit).not.toHaveBeenCalled();
  });
});
