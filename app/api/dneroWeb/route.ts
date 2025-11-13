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
});

export async function OPTIONS(req: Request) {
  const origin = pickAllowedOrigin(req);
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(req: Request) {
  try {
    const origin = pickAllowedOrigin(req);
    const headers = corsHeaders(origin);
    // Optional protection header
    if (ENV.DNEROWEB_TOKEN) {
      const token = req.headers.get("x-dneroweb-token");
      if (token !== ENV.DNEROWEB_TOKEN) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
      }
    }

    const raw = await req.text();
    if (!raw?.trim()) return new Response(JSON.stringify({ error: "Empty body" }), { status: 400, headers });

    let data: unknown;
    try { data = JSON.parse(raw); }
    catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers }); }

    const parsed = Schema.safeParse(data);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid payload", issues: parsed.error.flatten() }, { status: 400 });
    }

    const { firstName, lastName } = parsed.data;
    const phone = normalizePhone(parsed.data.phone, ENV.DEFAULT_COUNTRY as any);
    const email = parsed.data.email;

    if (!phone && !email) {
      return NextResponse.json({ error: "Missing contact identity (phone or email required)" }, { status: 400 });
    }
    if (!ENV.DNEROWEB_LOCATION_ID) {
      return NextResponse.json({ error: "Server missing DNEROWEB_LOCATION_ID" }, { status: 500 });
    }

    const res = await upsertContactAtLocation(ENV.DNEROWEB_LOCATION_ID, {
      firstName, lastName, phone: phone || undefined, email,
    });

    return new Response(JSON.stringify({ id: res.id }), { status: 200, headers });
  } catch (err: any) {
    const headers = corsHeaders(pickAllowedOrigin(req));
    console.error("DNEROWEB_ERROR", err?.message || err);
    return new Response(JSON.stringify({ error: "Internal error" }), { status: 500, headers });
  }
}
