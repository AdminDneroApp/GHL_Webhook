import { NextResponse } from "next/server";
import { z } from "zod";
import { ENV } from "@lib/env";
import { normalizePhone } from "@lib/phone";
import { upsertContact } from "@lib/ghl-client";
import { corsHeaders, pickAllowedOrigin } from "@lib/cors";
import { mapCustomFieldsFromPayload } from "@lib/custom-fields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// loose so unknown keys pass through to the custom-fields resolver
const Schema = z.object({
  firstName: z.string().trim().optional(),
  lastName:  z.string().trim().optional(),
  phone:     z.string().trim().optional(),
  email:     z.string().email().trim().optional(),
  tags:      z.array(z.string().trim()).optional(),
}).loose();

export async function OPTIONS(req: Request) {
  const origin = pickAllowedOrigin(req);
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(req: Request) {
  // x-entry-url logged for source tracking
  const entryUrl = req.headers.get("x-entry-url");
  console.log("CONTACT_REQUEST_RECEIVED", entryUrl ? { entryUrl } : {});
  try {
    const origin = pickAllowedOrigin(req);
    const headers = corsHeaders(origin);

    // parse + validate
    const raw = await req.text();
    if (!raw?.trim()) return new Response(JSON.stringify({ error: "Empty body" }), { status: 400, headers });
    console.log("CONTACT_RAW_PAYLOAD", raw);
    let data: unknown;
    try { data = JSON.parse(raw); }
    catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers }); }

    const parsed = Schema.safeParse(data);
    console.log("CONTACT_PAYLOAD", JSON.stringify(data));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid payload", issues: parsed.error.issues }, { status: 400 });
    }

    const { firstName, lastName, tags } = parsed.data;
    const phone = normalizePhone(parsed.data.phone, ENV.DEFAULT_COUNTRY as any);
    const email = parsed.data.email;

    if (!phone && !email) {
      return NextResponse.json({ error: "Missing contact identity (phone or email required)" }, { status: 400 });
    }
    if (!ENV.LOCATION_ID) {
      return NextResponse.json({ error: "Server missing LOCATION_ID" }, { status: 500 });
    }

    // resolve any extra fields as GHL custom fields
    const customFields = await mapCustomFieldsFromPayload(parsed.data as Record<string, any>);
    console.log("Upserting Contact contact:", { firstName, lastName, phone, email, tags, customFields });

    // upsert to main account
    try {
      await upsertContact({
        firstName,
        lastName,
        phone: phone || undefined,
        email,
        tags,
        customFields: customFields.length ? customFields : undefined,
      });

      return new Response(JSON.stringify({ success: true }), { status: 200, headers });
    } catch (error) {
      console.error("CONTACT_UPSERT_ERROR", error);
      return new Response(JSON.stringify({ error: "Failed to upsert contact" }), { status: 500, headers });
    }
  } catch (err: any) {
    const headers = corsHeaders(pickAllowedOrigin(req));
    console.error("CONTACT_ERROR", err?.message || err);
    return new Response(JSON.stringify({ error: "Internal error" }), { status: 500, headers });
  }
}
