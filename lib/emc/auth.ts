import { createHash, createHmac, timingSafeEqual } from "crypto";
import { ENV } from "@lib/env";

// signed requests older or newer than this are rejected (replay protection)
const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

export type EmcAuthResult =
  | { ok: true; keyIndex: number }
  | { ok: false; status: 401 | 403 | 503; reason: string };

function list(v: string): string[] {
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

// hashing first gives equal-length buffers, so neither content nor length leaks through timing
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// layer 1 + 2: optional IP allow-list, then a required API key. fails closed when no key is configured.
export function verifyEmcApiKey(req: Request, ip: string): EmcAuthResult {
  const keys = list(ENV.EMC_API_KEYS);
  if (!keys.length) return { ok: false, status: 503, reason: "not_configured" };

  const allowedIps = list(ENV.EMC_ALLOWED_IPS);
  if (allowedIps.length && !allowedIps.includes(ip)) {
    return { ok: false, status: 403, reason: "ip_not_allowed" };
  }

  const presented = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!presented) return { ok: false, status: 401, reason: "missing_key" };

  // compare against every key so timing doesn't reveal which one matched
  let keyIndex = -1;
  keys.forEach((k, i) => {
    if (safeEqual(k, presented) && keyIndex < 0) keyIndex = i;
  });
  if (keyIndex < 0) return { ok: false, status: 401, reason: "invalid_key" };

  return { ok: true, keyIndex };
}

// ghl → emc flow: GHL workflow webhooks can't sign requests, so a shared secret header is the
// strongest check GHL supports. same header name as /api/webhook, but its own secret. fails closed.
export function verifyGhlWebhookToken(req: Request): { ok: true } | { ok: false; status: 401 | 503; reason: string } {
  const tokens = list(ENV.EMC_GHL_WEBHOOK_TOKENS);
  if (!tokens.length) return { ok: false, status: 503, reason: "not_configured" };

  const presented = req.headers.get("x-webhook-token")?.trim();
  if (!presented) return { ok: false, status: 401, reason: "missing_token" };

  let matched = false;
  for (const t of tokens) {
    if (safeEqual(t, presented)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, status: 401, reason: "invalid_token" };
}

// only our own sub-accounts may trigger the flow — defaults to the main location
export function isAllowedGhlLocation(locationId: string): boolean {
  return list(ENV.EMC_GHL_LOCATION_IDS || ENV.LOCATION_ID).includes(locationId);
}

export type EmcSignatureResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; reason: string };

// layer 3 (required): HMAC-SHA256 hex of `${timestamp}.${idempotencyKey}.${rawBody}`.
// the idempotency key is signed too, so a captured request can't be replayed under a new key.
// fails closed when no secret is configured.
export function verifyEmcSignature(req: Request, rawBody: string, idempotencyKey: string): EmcSignatureResult {
  const secrets = list(ENV.EMC_SIGNING_SECRET);
  if (!secrets.length) return { ok: false, status: 503, reason: "signing_not_configured" };

  const timestamp = req.headers.get("x-emc-timestamp") || "";
  const signature = (req.headers.get("x-emc-signature") || "").replace(/^sha256=/i, "").toLowerCase();
  if (!timestamp || !signature) return { ok: false, status: 401, reason: "missing_signature" };

  // accepts unix seconds or milliseconds
  const ts = Number(timestamp);
  const tsMs = ts < 1e12 ? ts * 1000 : ts;
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > SIGNATURE_TOLERANCE_MS) {
    return { ok: false, status: 401, reason: "stale_signature" };
  }

  // any configured secret may match (rotation); all are checked so timing doesn't reveal which
  const signed = `${timestamp}.${idempotencyKey}.${rawBody}`;
  let matched = false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(signed).digest("hex");
    if (safeEqual(expected, signature)) matched = true;
  }
  if (!matched) return { ok: false, status: 401, reason: "invalid_signature" };

  return { ok: true };
}
