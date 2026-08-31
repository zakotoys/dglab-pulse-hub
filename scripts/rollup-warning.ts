import type { RollupLog, WarningHandlerWithDefault } from 'rollup';

export function handleRollupWarning(
  warning: RollupLog,
  defaultHandler: WarningHandlerWithDefault
): void {
  const source = (warning.id ?? '').replaceAll('\\', '/');
  const knownZodAnnotation = warning.code === 'INVALID_ANNOTATION' &&
    source.includes('/node_modules/zod/') &&
    warning.message.includes('contains an annotation that Rollup cannot interpret due to the position of the comment.');
  if (knownZodAnnotation) return;
  defaultHandler(warning);
}
