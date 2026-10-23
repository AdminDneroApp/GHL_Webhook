import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getClientIp } from "@lib/client-ip";
import { isAllowedGhlLocation, verifyGhlWebhookToken } from "@lib/emc/auth";
import { SanitizeError, sanitizePayload } from "@lib/emc/sanitize";
import { GhlEmcPayloadSchema } from "@lib/emc/ghl-schema";
import { runIntake } from "@lib/emc/services/intake";
import { flags } from "@lib/emc/config/flags";
import { payloadShape } from "@lib/emc/payload-shape";
import { ENV } from "@lib/env";
import { normalizePhone } from "@lib/phone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// the after() send retries EMC inline (up to 3 × 10s timeouts plus backoff), so leave room for it
export const maxDuration = 60;

// ghl → emc, step 1: a GHL workflow webhook (tag "emc-handoff-requested" added) enters here, gets sanitized,
// and the intake service records the cycle/revision, removes the tag and mirrors the status. the EMC send
// (step 2, or the dry-run preview send with EMC_FORWARD_PREVIEW) runs after the response via after().
// server-to-server only: no OPTIONS / CORS handler, so browsers can't call this route
const MAX_BODY_BYTES = 256 * 1024;

const AUTH_ERRORS: Record<number, string> = {
  401: "Unauthorized",
  503: "Service unavailable",
};

export async function POST(req: Request) {
  // returned on every response and logged, so one GHL execution can be traced end to end
  const forwardId = randomUUID();
  const ip = getClientIp(req);

  // every response is logged as sent: our bodies never carry contact values (issues hold paths only)
  const reply = (status: number, body: Record<string, unknown>) => {
    const out = { ...body, forwardId };
    console.log("EMC_GHL_RESPONSE", JSON.stringify({ status, body: out }));
    return NextResponse.json(out, {
      status,
      headers: { "x-forward-id": forwardId, "Cache-Control": "no-store" },
    });
  };

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

    // what GHL sent, by key names only (authenticated requests only)
    console.log("EMC_GHL_PAYLOAD_SHAPE", JSON.stringify({ forwardId, shape: payloadShape(clean) }));
    if (flags.EMC_GHL_DEBUG_BODY) {
      // TESTING ONLY — contains contact PII. EMC_GHL_DEBUG_BODY must be off in normal operation
      console.warn("EMC_GHL_DEBUG_BODY", JSON.stringify({ forwardId, body: clean }));
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
    // the GHL adapter is single-location: it uses ENV.LOCATION_ID's token and custom fields. serving
    // other sub-accounts needs a per-location token (and field map) first.
    if (locationId !== ENV.LOCATION_ID) {
      return reject(403, "location_not_supported", { error: "Forbidden" });
    }

    // webhook 1 is only a trigger: the contact id is what the intake (and later the send) works from
    const ghlContactId = payload.contact_id;
    if (!ghlContactId) return reject(400, "missing_contact_id", { error: "Missing contact_id" });

    // missing phone/email is not a 400 anymore: the intake rejects it (tag removed + note), and a 200
    // keeps GHL from retrying
    const hasIdentity = !!normalizePhone(payload.phone, ENV.DEFAULT_COUNTRY as "US" | "SV") || !!payload.email;

    const result = await runIntake({
      ghlContactId,
      locationId,
      forwardId,
      hasIdentity,
      workflowId: payload.workflow?.id,
    });

    console.log("EMC_GHL_INTAKE", JSON.stringify({
      forwardId,
      ghlContactId,
      outcome: result.outcome,
      handoffId: result.handoffId,
      revision: result.revision,
      ghlSyncPending: result.ghlSyncPending,
      dryRun: result.dryRun,
      ...(result.previewScheduled ? { previewScheduled: true } : {}),
      ...(result.sendScheduled ? { sendScheduled: true } : {}),
    }));

    return reply(200, {
      received: true,
      outcome: result.outcome,
      ...(result.handoffId ? { handoffId: result.handoffId } : {}),
      ...(result.revision !== undefined ? { revision: result.revision } : {}),
      ...(result.dryRun ? { dryRun: true } : {}),
    });
  } catch (err) {
    console.error("EMC_GHL_ERROR", JSON.stringify({
      forwardId,
      message: err instanceof Error ? err.message : String(err),
    }));
    return reply(500, { error: "Internal error" });
  }
}
