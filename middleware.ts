import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@lib/rate-limit";

const RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  "/api/webhook":  { max: 60,  windowMs: 60_000 }, 
  "/api/contact":  { max: 20,  windowMs: 60_000 }, 
  "/api/dneroWeb": { max: 20,  windowMs: 60_000 }, 
  "/api/health":   { max: 120, windowMs: 60_000 }, 
};

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    (req as NextRequest & { ip?: string }).ip ??
    "unknown"
  );
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const config = RATE_LIMITS[pathname];

  if (!config) return NextResponse.next();

  const ip = getClientIp(req);
  const key = `${ip}:${pathname}`;
  const result = checkRateLimit(key, config.max, config.windowMs);

  const headers: Record<string, string> = {
    "X-RateLimit-Limit":     String(config.max),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset":     String(Math.ceil(result.resetAt / 1000)), 
  };

  if (!result.allowed) {
    return NextResponse.json(
      { error: "Too Many Requests" },
      {
        status: 429,
        headers: {
          ...headers,
          "Retry-After": String(
            Math.ceil((result.resetAt - Date.now()) / 1000),
          ),
        },
      },
    );
  }

  const res = NextResponse.next();
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

export const config = {
  matcher: ["/api/webhook", "/api/contact", "/api/dneroWeb", "/api/health"],
};
