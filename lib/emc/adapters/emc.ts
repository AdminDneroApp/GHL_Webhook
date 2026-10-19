// webhook 2 client: POST the lead to EMC's n8n webhook and classify the response.
// rule: request and response bodies hold contact PII — they never go into errors or logs. callers get
// the status, the classification and externalId (EMC's lead id) only.

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_EXTERNAL_ID_LENGTH = 200;

// sent: EMC has it · retry: try again later · failed: EMC refused it · closed: 409, EMC closed the lead
export type EmcClassification = "sent" | "retry" | "failed" | "closed";

export interface EmcSendResult {
  classification: EmcClassification;
  status: number; // HTTP status, 0 when no response arrived
  externalId?: string;
  reason?: "timeout" | "network_error" | "redirect";
}

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

// EMC's webhook auth: the raw token (EMC_BEARER) in their custom n8n header "dnero-auth". sent only when
// configured, so the send keeps working if EMC ever drops auth. a saved "Bearer " prefix is stripped. never logged.
function authHeader(): Record<string, string> {
  const token = process.env.EMC_BEARER?.trim().replace(/^Bearer\s+/i, "");
  return token ? { "dnero-auth": token } : {};
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

export async function sendToEmc(body: unknown, idempotencyKey: string): Promise<EmcSendResult> {
  const url = webhookUrl();

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Idempotency-Key": idempotencyKey,
        ...authHeader(),
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // the cause is dropped on purpose: undici errors can echo request details
    const name = err instanceof Error ? err.name : "";
    const reason = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error";
    return { classification: "retry", status: 0, reason };
  }

  const classification = classifyStatus(res.status);
  if (classification !== "sent") {
    await res.body?.cancel().catch(() => {});
    return {
      classification,
      status: res.status,
      ...(res.status >= 300 && res.status < 400 ? { reason: "redirect" as const } : {}),
    };
  }

  let externalId: string | undefined;
  try {
    externalId = externalIdFrom(await readCapped(res));
  } catch {
    // body read failed after a 2xx: EMC has the lead, just no id
  }
  return { classification, status: res.status, ...(externalId ? { externalId } : {}) };
}
