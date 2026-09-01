import {
  assistCommandSchema,
  editCommandSchema,
  type AssistCommandDto,
  type EditCommandDto,
  type ReviewedAssistCommandDto
} from '@dglab-pulse-hub/contracts';
import {
  DIAGNOSTIC_CODES,
  location,
  makeDiagnostic,
  type Diagnostic,
  type DiagnosticCode
} from '@dglab-pulse-hub/core';

export type EditCommand = EditCommandDto;
export type AssistCommand = AssistCommandDto;
export type ReviewedAssistCommand = ReviewedAssistCommandDto;

export interface CommandParseError {
  readonly code: DiagnosticCode;
  readonly field: string;
  readonly message: string;
}

export type CommandParseResult<T> =
  | { readonly value: T; readonly error: null }
  | { readonly value: null; readonly error: CommandParseError };

function invalidCommand(
  issues: readonly { readonly path: readonly unknown[]; readonly message: string }[],
  fallbackField: string,
  fallbackMessage: string,
  code: DiagnosticCode
): CommandParseResult<never> {
  const issue = issues[0];
  const path = issue?.path[0];
  return {
    value: null,
    error: {
      code,
      field: typeof path === 'string' ? path : fallbackField,
      message: issue?.message ?? fallbackMessage
    }
  };
}

export function parseEditCommand(value: unknown): CommandParseResult<EditCommand> {
  const parsed = editCommandSchema.safeParse(value);
  return parsed.success
    ? { value: parsed.data, error: null }
    : invalidCommand(
        parsed.error.issues,
        'command',
        'Edit command is invalid.',
        DIAGNOSTIC_CODES.EDIT_VALUE
      );
}

export function parseAssistCommand(value: unknown): CommandParseResult<ReviewedAssistCommand> {
  const parsed = assistCommandSchema.safeParse(value);
  if (!parsed.success) {
    return invalidCommand(
      parsed.error.issues,
      'command',
      'Assist command is invalid.',
      DIAGNOSTIC_CODES.EDIT_VALUE
    );
  }
  if (!parsed.data.reviewed) {
    return {
      value: null,
      error: {
        code: DIAGNOSTIC_CODES.EDIT_NOT_REVIEWED,
        field: 'reviewed',
        message: 'Assist requires explicit review and valid endpoints.'
      }
    };
  }
  return { value: { ...parsed.data, reviewed: true }, error: null };
}

export function commandParseDiagnostic(error: CommandParseError): Diagnostic {
  return makeDiagnostic(error.code, 'error', 'semantic', error.message, location(error.field));
}
