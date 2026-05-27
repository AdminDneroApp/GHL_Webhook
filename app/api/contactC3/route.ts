import { NextResponse } from "next/server";
import { z } from "zod";
import { ENV } from "@lib/env";
import { normalizePhone } from "@lib/phone";
import { upsertContactC3 } from "@lib/ghl-client";
import { corsHeaders, pickAllowedOrigin } from "@lib/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// strict schema — C3 doesn't resolve custom fields, no need for loose
const Schema = z.object({
  firstName: z.string().trim().optional(),
  lastName:  z.string().trim().optional(),
  phone:     z.string().trim().optional(),
  email:     z.string().email().trim().optional(),
  tags:      z.array(z.string().trim()).optional(),
});

export async function OPTIONS(req: Request) {
  const origin = pickAllowedOrigin(req);
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(req: Request) {
  try {
    const origin = pickAllowedOrigin(req);
    console.log("C3_REQUEST_ORIGIN", { origin, allowed: !!origin });
    const headers = corsHeaders(origin);

    // parse + validate
    const raw = await req.text();
    if (!raw?.trim()) {
      console.error("C3_EMPTY_BODY");
      return new Response(JSON.stringify({ error: "Empty body" }), { status: 400, headers });
    }

    let data: unknown;
    try { data = JSON.parse(raw); }
    catch (e: any) {
      console.error("C3_INVALID_JSON", e?.message);
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
    }

    console.log("C3_CONTACT_PAYLOAD", JSON.stringify(data));
    const parsed = Schema.safeParse(data);
    if (!parsed.success) {
      console.error("C3_VALIDATION_FAILED", JSON.stringify(parsed.error.flatten()));
      return NextResponse.json({ error: "Invalid payload", issues: parsed.error.flatten() }, { status: 400 });
    }

    const { firstName, lastName, tags } = parsed.data;
    const phone = normalizePhone(parsed.data.phone, ENV.DEFAULT_COUNTRY as any);
    const email = parsed.data.email;
    console.log("C3_PARSED", { firstName, lastName, phone, email, tags });

    if (!phone && !email) {
      console.error("C3_MISSING_IDENTITY", { phone, email });
      return NextResponse.json({ error: "Missing contact identity (phone or email required)" }, { status: 400 });
    }
    if (!ENV.GHL_C3_LOCATION_ID || !ENV.GHL_C3_INTEGRATION_KEY) {
      console.error("C3_MISSING_ENV", { GHL_C3_LOCATION_ID: !!ENV.GHL_C3_LOCATION_ID, GHL_C3_INTEGRATION_KEY: !!ENV.GHL_C3_INTEGRATION_KEY });
      return new Response(JSON.stringify({ error: "Server misconfigured" }), { status: 500, headers });
    }

    // upsert to C3 sub-account using its own integration key
    console.log("C3_UPSERTING_CONTACT", { firstName, lastName, phone, email, tags });

    const res = await upsertContactC3({
      firstName,
      lastName,
      phone: phone || undefined,
      email,
      tags,
    });

    console.log("C3_UPSERT_SUCCESS", { id: res.id });
    return new Response(JSON.stringify({ id: res.id }), { status: 200, headers });
  } catch (err: any) {
    const headers = corsHeaders(pickAllowedOrigin(req));
    console.error("C3_CONTACT_ERROR", err?.message || err);
    return new Response(JSON.stringify({ error: "Internal error" }), { status: 500, headers });
  }
}
