import { ENV } from "./env";

const allowed = (ENV.CORS_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

export function pickAllowedOrigin(req: Request): string | null {
  const o = req.headers.get("origin");
  if (!o) return null;
  if (allowed.length === 0) return o; // allow any if not configured (optional)
  return allowed.includes(o) ? o : null;
}

export function corsHeaders(origin: string | null) {
  const h = new Headers();
  if (origin) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin"); // caching safety
  }
  h.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, x-dneroweb-token");
  h.set("Access-Control-Max-Age", "86400");
  return h;
}
