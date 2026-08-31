import {
  DIAGNOSTIC_CODES,
  makeDiagnostic,
  location,
  type Diagnostic
} from '@dglab-pulse-hub/core';
import {
  operationResult,
  type OperationResult,
  type OperationStatus
} from './result.js';

export type TaskState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'rejected'
  | 'failed'
  | 'cancelled';

const TERMINAL_STATES: readonly TaskState[] = [
  'succeeded',
  'rejected',
  'failed',
  'cancelled'
];

export interface TaskSnapshot<T> {
  readonly id: string;
  readonly operation: string;
  readonly state: TaskState;
  readonly result: OperationResult<T> | null;
}

export interface TaskRunOptions {
  readonly timeoutMs?: number;
}

function transitionAllowed(from: TaskState, to: TaskState): boolean {
  if (from === 'pending') return to === 'running' || to === 'cancelled';
  if (from === 'running') return TERMINAL_STATES.includes(to);
  return false;
}

function isOperationStatus(value: unknown): value is OperationStatus {
  return value === 'success' || value === 'rejected' || value === 'failed' || value === 'cancelled';
}

function isDiagnosticLike(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const locationValue = item.location;
  return typeof item.code === 'string' && item.code.length > 0 &&
    (item.severity === 'error' || item.severity === 'warning' || item.severity === 'info') &&
    typeof item.stage === 'string' && typeof item.message === 'string' &&
    locationValue !== null && typeof locationValue === 'object' &&
    typeof (locationValue as Record<string, unknown>).path === 'string';
}

function invalidOperationResult<T>(operation: string, message: string): OperationResult<T> {
  return operationResult(operation, 'failed', null, [
    makeDiagnostic(
      DIAGNOSTIC_CODES.TASK_INVALID_TRANSITION,
      'error',
      'task',
      message,
      location('$')
    )
  ]);
}

/** Normalize untrusted callback output before it can affect task state. */
function normalizeOperationResult<T>(operation: string, value: unknown): OperationResult<T> {
  if (value === null || typeof value !== 'object') {
    return invalidOperationResult(operation, 'Task operation returned an invalid result.');
  }
  const candidate = value as Record<string, unknown>;
  if (!isOperationStatus(candidate.status)) {
    return invalidOperationResult(operation, 'Task operation returned an invalid status.');
  }
  if (!Array.isArray(candidate.diagnostics) || !candidate.diagnostics.every(isDiagnosticLike)) {
    return invalidOperationResult(operation, 'Task operation returned invalid diagnostics.');
  }
  const data = candidate.data;
  if (candidate.status === 'success' && (data === null || data === undefined)) {
    return invalidOperationResult(operation, 'Successful task operation returned no result data.');
  }
  if (candidate.status !== 'success' && data !== null && data !== undefined) {
    return invalidOperationResult(operation, 'Non-successful task operation returned result data.');
  }
  const timingValue = candidate.timing;
  const timing = timingValue !== null && typeof timingValue === 'object'
    ? timingValue as Record<string, unknown>
    : undefined;
  if (timing !== undefined &&
      (timing.startedAt !== undefined && (!Number.isFinite(timing.startedAt) || typeof timing.startedAt !== 'number') ||
       timing.durationMs !== undefined && (!Number.isFinite(timing.durationMs) || typeof timing.durationMs !== 'number'))) {
    return invalidOperationResult(operation, 'Task operation returned invalid timing data.');
  }
  const operationId = candidate.operationId;
  if (operationId !== undefined && (typeof operationId !== 'string' || operationId.length === 0)) {
    return invalidOperationResult(operation, 'Task operation returned an invalid operation ID.');
  }
  const options: {
    readonly startedAt?: number;
    readonly durationMs?: number;
    readonly operationId?: string;
  } = {
    ...(timing?.startedAt !== undefined ? { startedAt: timing.startedAt as number } : {}),
    ...(timing?.durationMs !== undefined ? { durationMs: timing.durationMs as number } : {}),
    ...(operationId !== undefined ? { operationId: operationId as string } : {})
  };
  return operationResult(
    operation,
    candidate.status,
    candidate.status === 'success' ? data as T : null,
    candidate.diagnostics as Diagnostic[],
    options
  );
}

export class SingleFileTask<T> {
  private current: TaskSnapshot<T>;
  private readonly controller: AbortController;
  private cancelWaiter: ((result: OperationResult<T>) => void) | null = null;

  public constructor(
    id: string,
    operation: string,
    controller = new AbortController()
  ) {
    this.controller = controller;
    this.current = Object.freeze({
      id,
      operation,
      state: 'pending',
      result: null
    });
  }

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public snapshot(): TaskSnapshot<T> {
    return this.current;
  }

  public cancel(): OperationResult<T> {
    if (TERMINAL_STATES.includes(this.current.state)) {
      return this.current.result ?? operationResult(
        this.current.operation,
        'cancelled',
        null,
        [this.invalidTransition('Task is already terminal.')]
      );
    }
    const result = operationResult<T>(
      this.current.operation,
      'cancelled',
      null as T | null,
      [
        makeDiagnostic(
          DIAGNOSTIC_CODES.TASK_CANCELLED,
          'info',
          'task',
          'Task was cancelled.',
          location('$')
        )
      ]
    );
    // Transition before aborting so the abort listener installed by `run`
    // cannot race this explicit cancellation with a second result.
    this.transition('cancelled', result);
    this.controller.abort();
    this.cancelWaiter?.(result);
    this.cancelWaiter = null;
    return result;
  }

  public async run(
    operation: (signal: AbortSignal) => OperationResult<T> | Promise<OperationResult<T>>,
    options: TaskRunOptions = {}
  ): Promise<OperationResult<T>> {
    const safeOptions: TaskRunOptions = options !== null && typeof options === 'object' ? options : {};
    if (!this.transition('running', null)) {
      return operationResult(
        this.current.operation,
        'failed',
        null,
        [this.invalidTransition('Task can only be run once.')]
      );
    }
    if (safeOptions.timeoutMs !== undefined &&
        (!Number.isSafeInteger(safeOptions.timeoutMs) || safeOptions.timeoutMs <= 0)) {
      const result = operationResult<T>(this.current.operation, 'failed', null, [
        makeDiagnostic(
          DIAGNOSTIC_CODES.TASK_TIMEOUT,
          'error',
          'task',
          'Task timeout must be a positive safe integer.',
          location('timeoutMs')
        )
      ]);
      this.transition('failed', result);
      return result;
    }
    if (this.signal.aborted) return this.cancel();
    const startedAt = Date.now();
    let timeoutTriggered = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let timeoutValue: OperationResult<T> | null = null;
    let resolveCancellation: ((result: OperationResult<T>) => void) | null = null;
    const cancellation = new Promise<OperationResult<T>>((resolve) => {
      resolveCancellation = resolve;
    });
    const abortListener = (): void => {
      if (this.current.state !== 'running') return;
      const result = operationResult<T>(this.current.operation, 'cancelled', null, [
        makeDiagnostic(
          DIAGNOSTIC_CODES.TASK_CANCELLED,
          'info',
          'task',
          'Task was cancelled.',
          location('$')
        )
      ]);
      this.transition('cancelled', result);
      resolveCancellation?.(result);
    };
    this.cancelWaiter = (result) => resolveCancellation?.(result);
    this.controller.signal.addEventListener('abort', abortListener, { once: true });
    // An externally supplied controller may have been aborted between the
    // initial check above and listener registration.
    if (this.signal.aborted) abortListener();
    const timeoutPromise = safeOptions.timeoutMs === undefined
      ? null
      : new Promise<OperationResult<T>>((resolve) => {
          timeout = setTimeout(() => {
            if (this.current.state !== 'running') return;
            timeoutTriggered = true;
            timeoutValue = operationResult<T>(this.current.operation, 'failed', null, [
              makeDiagnostic(
                DIAGNOSTIC_CODES.TASK_TIMEOUT,
                'error',
                'task',
                'Task processing exceeded the configured timeout.',
                location('$')
              )
            ]);
            // Make timeout terminal before aborting so it wins a concurrent
            // caller cancellation deterministically.
            this.transition('failed', timeoutValue);
            this.controller.abort();
            resolve(timeoutValue);
          }, safeOptions.timeoutMs);
        });
    try {
      const operationPromise = Promise.resolve().then(() => operation(this.signal));
      const contenders: Array<Promise<OperationResult<T>>> = [operationPromise, cancellation];
      if (timeoutPromise !== null) contenders.push(timeoutPromise);
      const result = await Promise.race(contenders);
      if (this.current.state === 'cancelled' || this.current.state === 'failed' && timeoutValue !== null) {
        return this.current.result ?? result;
      }
      if (timeoutTriggered || (safeOptions.timeoutMs !== undefined && Date.now() - startedAt >= safeOptions.timeoutMs)) {
        const timedOut = timeoutValue ?? operationResult<T>(this.current.operation, 'failed', null, [
          makeDiagnostic(
            DIAGNOSTIC_CODES.TASK_TIMEOUT,
            'error',
            'task',
            'Task processing exceeded the configured timeout.',
            location('$')
          )
        ]);
        this.transition('failed', timedOut);
        this.controller.abort();
        return timedOut;
      }
      const normalized = normalizeOperationResult<T>(this.current.operation, result);
      if (normalized.status === 'cancelled' || this.signal.aborted) {
        const cancelled = normalized.status === 'cancelled'
          ? normalized
          : operationResult(this.current.operation, 'cancelled', null, [
              makeDiagnostic(
                DIAGNOSTIC_CODES.TASK_CANCELLED,
                'info',
                'task',
                'Task was cancelled.',
                location('$')
              )
            ]);
        this.transition('cancelled', cancelled);
        return cancelled;
      }
      const nextState: TaskState = normalized.status === 'success'
        ? 'succeeded'
        : normalized.status === 'rejected'
          ? 'rejected'
          : 'failed';
      this.transition(nextState, normalized);
      return normalized;
    } catch {
      if (this.current.state === 'cancelled' || this.current.state === 'failed' && timeoutValue !== null) {
        return this.current.result ?? operationResult(this.current.operation, this.current.state === 'cancelled' ? 'cancelled' : 'failed', null, [
          makeDiagnostic(
            this.current.state === 'cancelled' ? DIAGNOSTIC_CODES.TASK_CANCELLED : DIAGNOSTIC_CODES.TASK_TIMEOUT,
            this.current.state === 'cancelled' ? 'info' : 'error',
            'task',
            this.current.state === 'cancelled' ? 'Task was cancelled.' : 'Task processing exceeded the configured timeout.',
            location('$')
          )
        ]);
      }
      const result = operationResult<T>(this.current.operation, 'failed', null as T | null, [
        makeDiagnostic(
          timeoutTriggered ? DIAGNOSTIC_CODES.TASK_TIMEOUT : DIAGNOSTIC_CODES.TASK_INVALID_TRANSITION,
          'error',
          'task',
          timeoutTriggered ? 'Task processing exceeded the configured timeout.' : 'Task operation failed unexpectedly.',
          location('$')
        )
      ]);
      this.transition('failed', result);
      return result;
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      this.controller.signal.removeEventListener('abort', abortListener);
      this.cancelWaiter = null;
    }
  }

  private invalidTransition(message: string): Diagnostic {
    return makeDiagnostic(
      DIAGNOSTIC_CODES.TASK_INVALID_TRANSITION,
      'error',
      'task',
      message,
      location('$')
    );
  }

  private transition(
    state: TaskState,
    result: OperationResult<T> | null
  ): boolean {
    if (!transitionAllowed(this.current.state, state)) return false;
    this.current = Object.freeze({
      ...this.current,
      state,
      result
    });
    return true;
  }
}
