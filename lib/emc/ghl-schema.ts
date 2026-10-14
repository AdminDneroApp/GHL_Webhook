import { z } from "zod";

// GHL leaves fields empty ("") when a contact has no value — treat those as absent
const optionalText = (max: number) =>
  z.preprocess((v) => (v === "" ? undefined : v), z.string().max(max).optional());

// standard GHL workflow "Webhook" action payload (snake_case contact fields + location / workflow /
// customData blocks). loose: GHL adds many more keys; only the fields mapped in outbound.ts ever leave.
export const GhlEmcPayloadSchema = z.looseObject({
  contact_id: optionalText(100),
  first_name: optionalText(100),
  last_name: optionalText(100),
  full_name: optionalText(200),
  email: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase() || undefined : v),
    z.email().optional(),
  ),
  phone: optionalText(40),
  tags: z.union([z.array(z.string()), z.string()]).optional(),
  address1: optionalText(200),
  city: optionalText(100),
  state: optionalText(100),
  postal_code: optionalText(20),
  country: optionalText(100),

  location: z.looseObject({ id: z.string().min(1) }).optional(),
  workflow: z.looseObject({ id: z.string().optional(), name: z.string().optional() }).optional(),
  // values set in the workflow's "Custom Data" section — the intended channel for extra EMC fields
  customData: z.record(z.string(), z.unknown()).optional(),
});

export type GhlEmcPayload = z.infer<typeof GhlEmcPayloadSchema>;
