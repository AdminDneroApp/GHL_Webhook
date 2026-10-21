import { z } from "zod";

// webhook 3 contract v1 — EMC's first draft (CONTEXT §4). still lenient: unknown keys pass through
// (already sanitized) so we can see what EMC actually sends and tighten this once the spec is agreed.

const dropdownValue = z.union([z.string().max(200), z.array(z.string().max(200)).max(50)]);

export const EmcHandoffSchema = z.looseObject({
  // cycle reference — required
  handoffId: z.uuid(),
  revision: z.number().int().min(1),
  externalId: z.string().min(1).max(200),

  pipelineStage: z.string().min(1).max(200).optional(),
  fields: z
    .looseObject({
      emc_loan_officer: dropdownValue.optional(),
      add_real_estate_agent: dropdownValue.optional(),
    })
    .optional(),
  notes: z
    .array(z.object({ title: z.string().max(200), body: z.string().min(1).max(5000) }))
    .max(50)
    .optional(),
});

export type EmcHandoff = z.infer<typeof EmcHandoffSchema>;
