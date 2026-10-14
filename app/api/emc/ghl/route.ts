import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getClientIp } from "@lib/client-ip";
import { isAllowedGhlLocation, verifyGhlWebhookToken } from "@lib/emc/auth";
import { SanitizeError, sanitizePayload } from "@lib/emc/sanitize";
import { GhlEmcPayloadSchema } from "@lib/emc/ghl-schema";
import { buildEmcLead, forwardToEmc } from "@lib/emc/outbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ghl → emc: a GHL workflow webhook enters here, gets sanitized, and is forwarded to EMC.
// server-to-server only: no OPTIONS / CORS handler, so browsers can't call this route
const MAX_BODY_BYTES = 256 * 1024;

const AUTH_ERRORS: Record<number, string> = {
  401: "Unauthorized",
  503: "Service unavailable",
};

export async function POST(req: Request) {
  // returned on every response and logged, so one GHL execution can be traced end to end
  const forwardId = randomUUID();
  const receivedAt = new Date().toISOString();
  const ip = getClientIp(req);

  const reply = (status: number, body: Record<string, unknown>) =>
    NextResponse.json({ ...body, forwardId }, {
      status,
      headers: { "x-forward-id": forwardId, "Cache-Control": "no-store" },
    });

  const reject = (status: number, reason: string, body: Record<string, unknown>) => {
    console.warn("EMC_GHL_REJECTED", JSON.stringify({ forwardId, ip, status, reason }));
    return reply(status, body);
  };

  try {
    // auth before reading the body — unauthenticated callers never get it parsed
    const auth = verifyGhlWebhookToken(req);
    if (!auth.ok) return reject(auth.status, auth.reason, { error: AUTH_ERRORS[auth.status] });

    const contentType = (req.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      return reject(415, "unsupported_content_type", { error: "Content-Type must be application/json" });
    }

    // declared size first, actual size after reading (covers missing or wrong content-length)
    if (Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
      return reject(413, "body_too_large", { error: "Payload too large" });
    }
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return reject(413, "body_too_large", { error: "Payload too large" });
    }
    if (!raw.trim()) return reject(400, "empty_body", { error: "Empty body" });

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return reject(400, "invalid_json", { error: "Invalid JSON" });
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return reject(400, "not_an_object", { error: "Payload must be a JSON object" });
    }

    let clean: unknown;
    try {
      clean = sanitizePayload(data);
    } catch (e) {
      if (e instanceof SanitizeError) return reject(400, "sanitize_failed", { error: "Payload rejected", reason: e.message });
      throw e;
    }

    const parsed = GhlEmcPayloadSchema.safeParse(clean);
    if (!parsed.success) {
      // paths and messages only — never echo the submitted values back
      const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      return reject(400, "validation_failed", { error: "Invalid payload", issues });
    }
    const payload = parsed.data;

    // a leaked token alone isn't enough: the payload must also come from one of our sub-accounts
    const locationId = payload.location?.id;
    if (!locationId || !isAllowedGhlLocation(locationId)) {
      return reject(403, "location_not_allowed", { error: "Forbidden" });
    }

    const lead = buildEmcLead(payload, locationId);
    if (!lead.phone && !lead.email) {
      return reject(400, "missing_identity", { error: "Missing contact identity (phone or email required)" });
    }

    const result = await forwardToEmc(lead, { forwardId, receivedAt, workflowId: payload.workflow?.id });

    return reply(200, { received: true, forwarded: result.forwarded, status: result.status });
  } catch (err) {
    console.error("EMC_GHL_ERROR", JSON.stringify({
      forwardId,
      message: err instanceof Error ? err.message : String(err),
    }));
    return reply(500, { error: "Internal error" });
  }
}
