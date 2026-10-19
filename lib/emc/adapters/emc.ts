// webhook 2 client: POST the lead to EMC's n8n webhook and classify the response.
// rule: request and response bodies hold contact PII — they never go into errors or logs. callers get
// the status, the classification and externalId (EMC's lead id) only.

import { createHash } from "crypto";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_EXTERNAL_ID_LENGTH = 200;

// sent: EMC has it · retry: try again later · failed: EMC refused it · closed: 409, EMC closed the lead
export type EmcClassification = "sent" | "retry" | "failed" | "closed";

// what was sent, for diagnostics — header names, never header values; the token only as length + hash
export interface EmcRequestInfo {
  target: string; // host + first path segment, e.g. "emortgage.app.n8n.cloud/webhook" (vs /webhook-test)
  headerNames: string[];
  auth: {
    header: "Authorization";
    scheme: "raw";
    tokenLength: number;
    tokenSha256: string; // first 8 hex chars, to compare with: printf %s "<token>" | shasum -a 256
    hadBearerPrefix: boolean; // EMC_BEARER was saved as "Bearer …" (stripped before sending)
    hadSurroundingSpaces: boolean; // EMC_BEARER had leading/trailing whitespace (trimmed before sending)
  } | null;
}

export interface EmcSendResult {
  classification: EmcClassification;
  status: number; // HTTP status, 0 when no response arrived
  externalId?: string;
  reason?: "timeout" | "network_error" | "redirect";
  request: EmcRequestInfo;
  errorBody?: string; // only with { captureErrorBody: true } and a non-2xx — the caller gates it behind a debug flag
}

export interface EmcSendOptions {
  captureErrorBody?: boolean;
}

const MAX_ERROR_BODY_CHARS = 1000;

export class EmcConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmcConfigError";
  }
}

function webhookUrl(): string {
  const raw = process.env.EMC_WEBHOOK_URL?.trim();
  if (!raw) throw new EmcConfigError("EMC_WEBHOOK_URL is not set");
  try {
    return new URL(raw).toString();
  } catch {
    // the URL itself is not echoed
    throw new EmcConfigError("EMC_WEBHOOK_URL is not a valid URL");
  }
}

// EMC's webhook auth (EMC_BEARER, set by EMC). sent only when configured, so the send keeps working if
// EMC ever drops auth. accepts the token with or without a "Bearer " prefix. never logged.
function authHeader(): { headers: Record<string, string>; info: EmcRequestInfo["auth"] } {
  const raw = process.env.EMC_BEARER ?? "";
  const trimmed = raw.trim();
  const token = trimmed.replace(/^Bearer\s+/i, "");
  if (!token) return { headers: {}, info: null };
  return {
    headers: { Authorization: token }, // raw token, no "Bearer " prefix (EMC's n8n header auth)
    info: {
      header: "Authorization",
      scheme: "raw",
      tokenLength: token.length,
      tokenSha256: createHash("sha256").update(token).digest("hex").slice(0, 8),
      hadBearerPrefix: token !== trimmed,
      hadSurroundingSpaces: raw !== trimmed,
    },
  };
}

function targetOf(url: string): string {
  const u = new URL(url);
  return `${u.host}/${u.pathname.split("/").filter(Boolean)[0] ?? ""}`;
}

export function classifyStatus(status: number): EmcClassification {
  if (status >= 200 && status < 300) return "sent";
  if (status === 409) return "closed";
  if (status === 429 || status >= 500) return "retry";
  return "failed"; // other 4xx, and 3xx (redirects are not followed)
}

// reads at most MAX_RESPONSE_BYTES; a bigger body is cut (and then won't parse, so no externalId)
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BYTES).toString("utf8");
}

function externalIdFrom(text: string): string | undefined {
  try {
    const data = JSON.parse(text) as unknown;
    // n8n's "Respond to Webhook" may wrap the object in an array
    const obj = (Array.isArray(data) ? data[0] : data) as { externalId?: unknown } | null;
    const id = obj && typeof obj === "object" ? obj.externalId : undefined;
    if ((typeof id === "string" && id.trim()) || typeof id === "number") {
      return String(id).trim().slice(0, MAX_EXTERNAL_ID_LENGTH);
    }
  } catch {
    // not JSON: a 2xx still counts as sent
  }
  return undefined;
}

export async function sendToEmc(
  body: unknown,
  idempotencyKey: string,
  opts: EmcSendOptions = {},
): Promise<EmcSendResult> {
  const url = webhookUrl();
  const auth = authHeader();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Idempotency-Key": idempotencyKey,
    ...auth.headers,
  };
  const request: EmcRequestInfo = { target: targetOf(url), headerNames: Object.keys(headers), auth: auth.info };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // the cause is dropped on purpose: undici errors can echo request details
    const name = err instanceof Error ? err.name : "";
    const reason = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error";
    return { classification: "retry", status: 0, reason, request };
  }

  const classification = classifyStatus(res.status);
  if (classification !== "sent") {
    let errorBody: string | undefined;
    if (opts.captureErrorBody) {
      errorBody = await readCapped(res).then((t) => t.slice(0, MAX_ERROR_BODY_CHARS)).catch(() => undefined);
    } else {
      await res.body?.cancel().catch(() => {});
    }
    return {
      classification,
      status: res.status,
      ...(res.status >= 300 && res.status < 400 ? { reason: "redirect" as const } : {}),
      request,
      ...(errorBody !== undefined ? { errorBody } : {}),
    };
  }

  let externalId: string | undefined;
  try {
    externalId = externalIdFrom(await readCapped(res));
  } catch {
    // body read failed after a 2xx: EMC has the lead, just no id
  }
  return { classification, status: res.status, ...(externalId ? { externalId } : {}), request };
}
