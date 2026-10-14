import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getClientIp } from "@lib/client-ip";
import { isKvConfigured } from "@lib/kv";
import { verifyEmcApiKey, verifyEmcSignature } from "@lib/emc/auth";
import { claimIdempotencyKey, hashBody, isValidIdempotencyKey } from "@lib/emc/idempotency";
import { SanitizeError, sanitizePayload } from "@lib/emc/sanitize";
import { EmcHandoffSchema } from "@lib/emc/schema";
import { processEmcHandoff } from "@lib/emc/handoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// server-to-server only: no OPTIONS / CORS handler, so browsers can't call this route
const MAX_BODY_BYTES = 256 * 1024;

const AUTH_ERRORS: Record<number, string> = {
  401: "Unauthorized",
  403: "Forbidden",
  503: "Service unavailable",
};

export async function POST(req: Request) {
  // returned to EMC on every response so both sides can trace a single handoff in logs
  const handoffId = randomUUID();
  const receivedAt = new Date().toISOString();
  const ip = getClientIp(req);

  const reply = (status: number, body: Record<string, unknown>, id: string = handoffId, extraHeaders: Record<string, string> = {}) =>
    NextResponse.json({ ...body, handoffId: id }, {
      status,
      headers: { "x-handoff-id": id, "Cache-Control": "no-store", ...extraHeaders },
    });

  const reject = (status: number, reason: string, body: Record<string, unknown>) => {
    console.warn("EMC_HANDOFF_REJECTED", JSON.stringify({ handoffId, ip, status, reason }));
    return reply(status, body);
  };

  try {
    // auth before reading the body — unauthenticated callers never get it parsed
    const auth = verifyEmcApiKey(req, ip);
    if (!auth.ok) return reject(auth.status, auth.reason, { error: AUTH_ERRORS[auth.status] });

    // idempotency is mandatory, so without its store nothing is processed
    if (!isKvConfigured()) return reject(503, "idempotency_store_not_configured", { error: "Service unavailable" });

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

    // read before the signature check, because the key is part of the signed string
    const idempotencyKey = req.headers.get("idempotency-key")?.trim() || "";
    if (!idempotencyKey) return reject(400, "missing_idempotency_key", { error: "Idempotency-Key header is required" });
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return reject(400, "invalid_idempotency_key", { error: "Idempotency-Key must be 8-200 chars of A-Z a-z 0-9 . _ : -" });
    }

    // signature covers the exact raw bytes, so it is checked before any parsing
    const sig = verifyEmcSignature(req, raw, idempotencyKey);
    if (!sig.ok) return reject(sig.status, sig.reason, { error: AUTH_ERRORS[sig.status] });

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

    const parsed = EmcHandoffSchema.safeParse(clean);
    if (!parsed.success) {
      // paths and messages only — never echo the submitted values back
      const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      return reject(400, "validation_failed", { error: "Invalid payload", issues });
    }

    // only valid, authenticated requests reach the store — rejected ones can be retried with the same key
    let claim;
    try {
      claim = await claimIdempotencyKey(idempotencyKey, hashBody(raw), handoffId);
    } catch (e) {
      console.error("EMC_IDEMPOTENCY_STORE_ERROR", JSON.stringify({ handoffId, message: e instanceof Error ? e.message : String(e) }));
      return reply(503, { error: "Service unavailable" });
    }

    if (claim.kind === "replay") {
      console.log("EMC_HANDOFF_REPLAYED", JSON.stringify({ handoffId: claim.handoffId, retryId: handoffId, idempotencyKey }));
      return reply(claim.response.status, claim.response.body, claim.handoffId, { "Idempotent-Replayed": "true" });
    }
    if (claim.kind === "in_progress") {
      return reject(409, "idempotency_in_progress", { error: "A request with this Idempotency-Key is still being processed; retry later" });
    }
    if (claim.kind === "conflict") {
      return reject(422, "idempotency_conflict", { error: "Idempotency-Key was already used with a different payload" });
    }

    let result;
    try {
      result = await processEmcHandoff(parsed.data, { handoffId, receivedAt, keyIndex: auth.keyIndex, idempotencyKey });
    } catch (e) {
      // free the key so EMC's retry is processed instead of blocked
      await claim.release().catch(() => {});
      throw e;
    }

    const response = { status: 202, body: { received: true, status: result.status } };
    // processing already succeeded — a failure to record it is logged, not returned to EMC
    await claim.complete(response).catch((e) =>
      console.error("EMC_IDEMPOTENCY_COMPLETE_ERROR", JSON.stringify({ handoffId, message: e instanceof Error ? e.message : String(e) })),
    );

    return reply(response.status, response.body);
  } catch (err) {
    console.error("EMC_HANDOFF_ERROR", JSON.stringify({
      handoffId,
      message: err instanceof Error ? err.message : String(err),
    }));
    return reply(500, { error: "Internal error" });
  }
}
