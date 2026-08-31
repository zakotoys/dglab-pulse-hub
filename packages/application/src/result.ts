import type { Diagnostic, RuleVersion } from '@dglab-pulse-hub/core';

export const CONTRACT_VERSION = 'pulse-contract-v1' as const;
export type OperationStatus = 'success' | 'rejected' | 'failed' | 'cancelled';

export interface OperationTiming {
  readonly startedAt?: number;
  readonly durationMs?: number;
}

export interface OperationResult<T> {
  readonly schemaVersion: typeof CONTRACT_VERSION;
  readonly ruleVersion: RuleVersion;
  readonly operation: string;
  readonly status: OperationStatus;
  readonly data: T | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly timing?: OperationTiming;
  readonly operationId?: string;
}

export function operationResult(
  operation: string,
  status: OperationStatus,
  data: null,
  diagnostics: readonly Diagnostic[],
  options?: {
    readonly startedAt?: number;
    readonly durationMs?: number;
    readonly operationId?: string;
  }
): OperationResult<never>;
export function operationResult<T>(
  operation: string,
  status: OperationStatus,
  data: T | null,
  diagnostics: readonly Diagnostic[],
  options?: {
    readonly startedAt?: number;
    readonly durationMs?: number;
    readonly operationId?: string;
  }
): OperationResult<T>;
export function operationResult<T>(
  operation: string,
  status: OperationStatus,
  data: T | null,
  diagnostics: readonly Diagnostic[],
  options: {
    readonly startedAt?: number;
    readonly durationMs?: number;
    readonly operationId?: string;
  } = {}
): OperationResult<T> {
  const result: {
    schemaVersion: typeof CONTRACT_VERSION;
    ruleVersion: RuleVersion;
    operation: string;
    status: OperationStatus;
    data: T | null;
    diagnostics: readonly Diagnostic[];
    timing?: OperationTiming;
    operationId?: string;
  } = {
    schemaVersion: CONTRACT_VERSION,
    ruleVersion: 'pulse-rules-v1',
    operation,
    status,
    // Non-success states are terminal and never carry a partial payload.
    data: status === 'success' ? data : null,
    diagnostics: Object.freeze([...diagnostics])
  };
  if (options.startedAt !== undefined || options.durationMs !== undefined) {
    const timing: OperationTiming = {};
    if (options.startedAt !== undefined) {
      (timing as { startedAt?: number }).startedAt = options.startedAt;
    }
    if (options.durationMs !== undefined) {
      (timing as { durationMs?: number }).durationMs = options.durationMs;
    }
    result.timing = Object.freeze(timing);
  }
  if (options.operationId !== undefined) result.operationId = options.operationId;
  return Object.freeze(result);
}

export function statusFromDiagnostics(
  diagnostics: readonly Diagnostic[],
  hasData = false
): OperationStatus {
  if (diagnostics.some((item) => item.severity === 'error')) return 'rejected';
  return hasData ? 'success' : 'rejected';
}
