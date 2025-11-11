import { NextResponse } from "next/server";
import { z } from "zod";
import { ENV } from "@lib/env";
import { normalizePhone } from "@lib/phone";
import { upsertContactAtLocation } from "@lib/ghl-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Schema = z.object({
  firstName: z.string().trim().optional(),
  lastName:  z.string().trim().optional(),
  phone:     z.string().trim().optional(),
  email:     z.string().email().trim().optional(),
});

export async function POST(req: Request) {
  try {
    // Optional protection header
    if (ENV.DNEROWEB_TOKEN) {
      const token = req.headers.get("x-dneroweb-token");
      if (token !== ENV.DNEROWEB_TOKEN) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const raw = await req.text();
    if (!raw?.trim()) return NextResponse.json({ error: "Empty body" }, { status: 400 });

    let data: unknown;
    try { data = JSON.parse(raw); } 
    catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

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

    return NextResponse.json({ id: res.id });
  } catch (err: any) {
    console.error("DNEROWEB_ERROR", err?.message || err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
