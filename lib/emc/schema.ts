import { z } from "zod";

// provisional contract — EMC hasn't shared their payload spec yet.
// the usual contact fields are typed and normalized; any other field passes through (already
// sanitized) so we can see what EMC actually sends and tighten this once the spec is agreed.
export const EmcHandoffSchema = z
  .looseObject({
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    email: z.string().trim().toLowerCase().pipe(z.email()).optional(),
    phone: z.string().max(40).optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "Payload is empty" });

export type EmcHandoff = z.infer<typeof EmcHandoffSchema>;
