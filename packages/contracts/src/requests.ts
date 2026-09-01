import { z } from 'zod';

const safeIntegerSchema = z.number().int().refine(Number.isSafeInteger, 'Expected a safe integer.');
const nonNegativeIndexSchema = safeIntegerSchema.nonnegative();
const percentageSchema = z.number().finite().min(0).max(100);
const anchorSchema = z.union([z.literal(0), z.literal(1)]);

const strengthEditSchema = z
  .object({
    kind: z.literal('strength'),
    sectionIndex: nonNegativeIndexSchema,
    pointIndex: nonNegativeIndexSchema,
    value: percentageSchema
  })
  .strict();

const anchorEditSchema = z
  .object({
    kind: z.literal('anchor'),
    sectionIndex: nonNegativeIndexSchema,
    pointIndex: nonNegativeIndexSchema,
    value: anchorSchema
  })
  .strict();

const frequencyEditSchema = z
  .object({
    kind: z.literal('frequency'),
    sectionIndex: nonNegativeIndexSchema,
    startIndex: safeIntegerSchema.min(0).max(83),
    endIndex: safeIntegerSchema.min(0).max(83)
  })
  .strict();

const durationEditSchema = z
  .object({
    kind: z.literal('duration'),
    sectionIndex: nonNegativeIndexSchema,
    value: safeIntegerSchema.min(0).max(99)
  })
  .strict();

const addPointEditSchema = z
  .object({
    kind: z.literal('add-point'),
    sectionIndex: nonNegativeIndexSchema,
    value: percentageSchema,
    anchor: anchorSchema,
    atIndex: nonNegativeIndexSchema.optional()
  })
  .strict();

const removePointEditSchema = z
  .object({
    kind: z.literal('remove-point'),
    sectionIndex: nonNegativeIndexSchema,
    pointIndex: nonNegativeIndexSchema
  })
  .strict();

/** The JSON-safe edit command shared by HTTP, Electron, and workspace UI. */
export const editCommandSchema = z.discriminatedUnion('kind', [
  strengthEditSchema,
  anchorEditSchema,
  frequencyEditSchema,
  durationEditSchema,
  addPointEditSchema,
  removePointEditSchema
]);

/** Assist input is deliberately separate from edit commands because it requires
 * an explicit human review acknowledgement before the application can apply it. */
export const assistCommandSchema = z
  .object({
    sectionIndex: nonNegativeIndexSchema,
    startPointIndex: nonNegativeIndexSchema,
    endPointIndex: nonNegativeIndexSchema,
    startStrength: percentageSchema,
    endStrength: percentageSchema,
    reviewed: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.startPointIndex >= value.endPointIndex) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endPointIndex'],
        message: 'Assist end point must be greater than its start point.'
      });
    }
  });

export type EditCommandDto = z.infer<typeof editCommandSchema>;
export type AssistCommandDto = z.infer<typeof assistCommandSchema>;
export type ReviewedAssistCommandDto = Omit<AssistCommandDto, 'reviewed'> & {
  readonly reviewed: true;
};
