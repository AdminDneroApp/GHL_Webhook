import { z } from "zod";

// looseObject on both schemas — unknown fields flow through to the custom-fields resolver
export const LocationSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postalCode: z.string().optional(),
  fullAddress: z.string().optional(),
});

export const WebhookPayloadSchema = z.looseObject({
  // contact
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  full_name: z.string().optional(),
  email: z.email().optional(),
  phone: z.string().optional(),
  tags: z.union([z.array(z.string()), z.string()]).optional(),
  address1: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postal_code: z.string().optional(),
  website: z.string().optional(),
  date_of_birth: z.string().optional(),
  company_name: z.string().optional(),
  date_created: z.string().optional(),

  // location
  location: LocationSchema.optional(),

  // opportunity
  opportunity_name: z.string().optional(),
  status: z.string().optional(),
  lead_value: z.union([z.number(), z.string()]).optional(),
  opportunity_source: z.string().optional(),
  source: z.string().optional(),
  pipleline_stage: z.string().optional(),
  pipeline_id: z.string().optional(),
  pipeline_name: z.string().optional(),
  id: z.string().optional(),
});

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;
