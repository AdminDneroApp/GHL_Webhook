import { NextResponse } from "next/server";
import { z } from "zod";
import { ENV } from "@lib/env";
import { normalizePhone } from "@lib/phone";
import { upsertContactAtLocation } from "@lib/ghl-client";
import { corsHeaders, pickAllowedOrigin } from "@lib/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Schema = z.object({
  firstName: z.string().trim().optional(),
  lastName:  z.string().trim().optional(),
  phone:     z.string().trim().optional(),
  email:     z.string().email().trim().optional(),
  tags:      z.array(z.string().trim()).optional(),
  timeOfPurchase: z.string().trim().optional(),
  cityOfPurchase: z.string().trim().optional(),
  objectiveRefinance: z.string().trim().optional(),
  californiaCity: z.string().trim().optional(),
  wordPress_source: z.string().trim().optional(),
});

export async function OPTIONS(req: Request) {
  const origin = pickAllowedOrigin(req);
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(req: Request) {
  console.log("CONTACT_REQUEST_RECEIVED");
  try {
    const origin = pickAllowedOrigin(req);
    const headers = corsHeaders(origin);
    const raw = await req.text();
    if (!raw?.trim()) return new Response(JSON.stringify({ error: "Empty body" }), { status: 400, headers });
    console.log("CONTACT_RAW_PAYLOAD", raw);
    let data: unknown;
    try { data = JSON.parse(raw); }
    catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers }); }

    const parsed = Schema.safeParse(data);
    console.log("CONTACT_PAYLOAD", JSON.stringify(data));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid payload", issues: parsed.error.flatten() }, { status: 400 });
    }

    const { firstName, lastName, tags, timeOfPurchase, cityOfPurchase, objectiveRefinance, californiaCity, wordPress_source } = parsed.data;
    const phone = normalizePhone(parsed.data.phone, ENV.DEFAULT_COUNTRY as any);
    const email = parsed.data.email;

    if (!phone && !email) {
      return NextResponse.json({ error: "Missing contact identity (phone or email required)" }, { status: 400 });
    }
    if (!ENV.LOCATION_ID) {
      return NextResponse.json({ error: "Server missing CONTACT_LOCATION_ID" }, { status: 500 });
    }

    console.log("Upserting Contact contact:", { firstName, lastName, phone, email, tags });
    try {
      const res = await upsertContactAtLocation(ENV.LOCATION_ID, {
        firstName,
        lastName,
        phone: phone || undefined,
        email,
        tags,
        timeOfPurchase,
        cityOfPurchase,
        objectiveRefinance,
        californiaCity,
        wordPress_source,
        toogle: false
      });

      return new Response(JSON.stringify({ id: res.id }), { status: 200, headers });
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
