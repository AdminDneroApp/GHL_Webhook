import { ENV } from "./env";

// phase 0 observability — records who calls each route and the shape of what they send.
// logs key names, tags and header presence only; never field values or token values.
// search Vercel logs for "OBSERVE_CALLER" / "OBSERVE_PAYLOAD".

const MAX_KEYS = 100;
const MAX_TAGS = 50;
const MAX_TAG_LEN = 100;

type TokenHeader = "x-webhook-token" | "x-dneroweb-token";

function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

// "missing" | "present" when no secret is configured to compare against; "valid" | "invalid" otherwise
function tokenStatus(req: Request, header: TokenHeader, expected: string): string {
  const v = req.headers.get(header);
  if (!v) return "missing";
  if (!expected) return "present";
  return v === expected ? "valid" : "invalid";
}

export function logCaller(route: string, req: Request, opts: { originAllowed?: boolean } = {}) {
  try {
    const corsOrigins = ENV.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
    console.log("OBSERVE_CALLER", JSON.stringify({
      route,
      origin: req.headers.get("origin"),
      referer: req.headers.get("referer"),
      entryUrl: req.headers.get("x-entry-url"),
      originAllowed: opts.originAllowed,
      userAgent: req.headers.get("user-agent"),
      ip: getClientIp(req),
      contentLength: req.headers.get("content-length"),
      webhookToken: tokenStatus(req, "x-webhook-token", ENV.WEBHOOK_TOKEN),
      dnerowebToken: tokenStatus(req, "x-dneroweb-token", ENV.DNEROWEB_TOKEN),
      config: {
        webhookTokenConfigured: !!ENV.WEBHOOK_TOKEN,
        dnerowebTokenConfigured: !!ENV.DNEROWEB_TOKEN,
        corsOriginsConfigured: corsOrigins.length,
      },
    }));
  } catch {
    // observability must never affect the request
  }
}

function keysOf(v: unknown): string[] | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  return Object.keys(v).slice(0, MAX_KEYS);
}

// tags arrive as an array or a comma-separated string depending on the sender
function tagsOf(v: unknown): string[] | undefined {
  const list = Array.isArray(v)
    ? v
    : typeof v === "string"
      ? v.split(",")
      : undefined;
  if (!list) return undefined;
  return list
    .map((t) => String(t).trim().slice(0, MAX_TAG_LEN))
    .filter(Boolean)
    .slice(0, MAX_TAGS);
}

export function logPayloadShape(route: string, data: unknown) {
  try {
    const p = data as Record<string, unknown> | null;
    console.log("OBSERVE_PAYLOAD", JSON.stringify({
      route,
      keys: keysOf(p),
      customDataKeys: keysOf(p?.customData),
      tags: tagsOf(p?.tags),
      hasPhone: !!p?.phone,
      hasEmail: !!p?.email,
    }));
  } catch {
    // observability must never affect the request
  }
}
