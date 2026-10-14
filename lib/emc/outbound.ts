import { ENV } from "@lib/env";
import { normalizePhone } from "@lib/phone";
import type { GhlEmcPayload } from "./ghl-schema";

// provisional outbound shape — EMC hasn't shared what they expect yet.
// data minimization: only these fields leave our system, never the full GHL payload.
export interface EmcLead {
  ghlContactId?: string;
  ghlLocationId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  tags: string[];
  address?: {
    address1?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
  customData?: Record<string, unknown>;
}

export function buildEmcLead(p: GhlEmcPayload, locationId: string): EmcLead {
  // tags: GHL sends a comma-separated string, other senders an array
  const tags = Array.isArray(p.tags)
    ? p.tags
    : typeof p.tags === "string"
      ? p.tags.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

  const firstName = p.first_name || p.full_name?.split(" ")?.[0] || undefined;
  const lastName = p.last_name || p.full_name?.split(" ")?.slice(1).join(" ") || undefined;

  const address = {
    address1: p.address1,
    city: p.city,
    state: p.state,
    postalCode: p.postal_code,
    country: p.country,
  };
  const hasAddress = Object.values(address).some(Boolean);

  return {
    ghlContactId: p.contact_id,
    ghlLocationId: locationId,
    firstName,
    lastName,
    email: p.email,
    phone: normalizePhone(p.phone, ENV.DEFAULT_COUNTRY as "US" | "SV"),
    tags,
    ...(hasAddress ? { address } : {}),
    ...(p.customData && Object.keys(p.customData).length ? { customData: p.customData } : {}),
  };
}

export interface ForwardContext {
  forwardId: string;
  receivedAt: string;
  workflowId?: string;
}

export interface ForwardResult {
  forwarded: boolean;
  status: "pending_emc_integration";
}

// EMC's receiving endpoint, auth and payload spec aren't defined yet — the outbound HTTP call plugs in here.
// for now the lead is built and its shape recorded (field names only, never values).
export async function forwardToEmc(lead: EmcLead, ctx: ForwardContext): Promise<ForwardResult> {
  console.log("EMC_FORWARD_PENDING", JSON.stringify({
    ...ctx,
    ghlContactId: lead.ghlContactId,
    fields: Object.entries(lead).filter(([, v]) => v !== undefined).map(([k]) => k),
    customDataKeys: lead.customData ? Object.keys(lead.customData) : [],
    tagCount: lead.tags.length,
  }));
  return { forwarded: false, status: "pending_emc_integration" };
}
