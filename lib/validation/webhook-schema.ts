import { z } from "zod";

// Esquema minimalista y flexible (aceptamos extras)
export const LocationSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postalCode: z.string().optional(),
  fullAddress: z.string().optional()
}).passthrough();

export const WebhookPayloadSchema = z.object({
  // Contacto
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  full_name: z.string().optional(),
  email: z.string().email().optional(),
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

  // Ubicación
  location: LocationSchema.optional(),

  // Oportunidad 
  opportunity_name: z.string().optional(),
  status: z.string().optional(),
  lead_value: z.union([z.number(), z.string()]).optional(),
  opportunity_source: z.string().optional(),
  source: z.string().optional(),
  pipleline_stage: z.string().optional(), // sic en tu payload
  pipeline_id: z.string().optional(),
  pipeline_name: z.string().optional(),
  id: z.string().optional(), // (nota: en tu guía es opportun. id, lo tratamos aparte)


}).passthrough();

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;
