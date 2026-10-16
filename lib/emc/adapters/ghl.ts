import { ENV } from "@lib/env";

// emc-only GoHighLevel API v2 client. self-contained on purpose: lib/ghl-client.ts and
// lib/custom-fields.ts are legacy and are not reused here.
// rule: request and response bodies hold contact PII — they never go into errors or logs.

const TIMEOUT_MS = 10_000;

export type EmcHandoffStatus = "requested" | "sent" | "pending" | "failed" | "completed";

export class GhlApiError extends Error {
  readonly status: number; // HTTP status, 0 when no response arrived (timeout / network)
  readonly path: string;
  readonly method: string;

  constructor(method: string, path: string, status: number, reason?: string) {
    // only method, path and status — never a body
    super(
      `GHL ${method} ${path} failed: ${status ? `HTTP ${status}` : "no response"}${reason ? ` (${reason})` : ""}`,
    );
    this.name = "GhlApiError";
    this.status = status;
    this.path = path;
    this.method = method;
  }
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

async function ghlFetch<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ENV.BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${ENV.TOKEN}`,
        Version: ENV.API_VERSION,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // the cause is dropped on purpose: undici errors can echo request details
    const name = err instanceof Error ? err.name : "";
    const reason = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network error";
    throw new GhlApiError(method, path, 0, reason);
  }

  if (!res.ok) {
    // drain without reading into anything that could be logged
    await res.body?.cancel().catch(() => {});
    throw new GhlApiError(method, path, res.status);
  }

  if (res.status === 204) return {} as T;
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GhlApiError(method, path, res.status, "invalid JSON response");
  }
}

const enc = encodeURIComponent;

// --- custom fields ---

export interface GhlCustomField {
  id: string;
  name: string;
  fieldKey: string; // e.g. "contact.emc_handoff_status"
  dataType: string;
  model?: string;
  picklistOptions?: string[];
  [k: string]: unknown;
}

// one fetch per cold start; a failed load is not cached so the next call retries
let fieldsPromise: Promise<GhlCustomField[]> | undefined;

export function listCustomFields(): Promise<GhlCustomField[]> {
  if (!fieldsPromise) {
    fieldsPromise = ghlFetch<{ customFields?: GhlCustomField[] }>(
      "GET",
      `/locations/${enc(ENV.LOCATION_ID)}/customFields?model=contact`,
    )
      .then((r) => r.customFields ?? [])
      .catch((err) => {
        fieldsPromise = undefined;
        throw err;
      });
  }
  return fieldsPromise;
}

// "contact.emc_handoff_status" and "emc_handoff_status" both resolve to the same field
function bareKey(k: string): string {
  const s = k.trim().toLowerCase();
  return s.startsWith("contact.") ? s.slice("contact.".length) : s;
}

async function resolveFieldIds(keys: string[]): Promise<Map<string, string>> {
  const fields = await listCustomFields();
  const byKey = new Map<string, string>();
  for (const f of fields) {
    if (f.model && f.model !== "contact") continue;
    if (f.fieldKey) byKey.set(bareKey(f.fieldKey), f.id);
  }

  const out = new Map<string, string>();
  const missing: string[] = [];
  for (const k of keys) {
    const id = byKey.get(bareKey(k));
    if (id) out.set(k, id);
    else missing.push(k);
  }
  if (missing.length) {
    // keys are our own constants, not PII
    throw new Error(
      `Unknown GHL contact custom field key(s): ${missing.join(", ")} — create them with scripts/create-emc-fields.ts`,
    );
  }
  return out;
}

// values keyed by GHL field key (with or without "contact."). the v2 docs (UpdateContactDto →
// TextField / SingleSelectField …) name the value property `field_value`; reads return `value`.
// null clears the field (sent as "").
export async function updateContactCustomFields(
  contactId: string,
  values: Record<string, string | string[] | null>,
): Promise<void> {
  const keys = Object.keys(values);
  if (!keys.length) return;
  const ids = await resolveFieldIds(keys);
  const customFields = keys.map((k) => ({ id: ids.get(k)!, field_value: values[k] ?? "" }));
  await ghlFetch("PUT", `/contacts/${enc(contactId)}`, { customFields });
}

// emc_handoff_time is a TEXT field (GHL DATE fields keep no time of day), so the value is a fixed
// UTC string: readable for agents and sortable as text, e.g. "2026-10-16 21:05:09 UTC".
export function formatGhlDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error("formatGhlDateTime: invalid date");
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

// --- tags ---

export async function removeContactTags(contactId: string, tags: string[]): Promise<void> {
  if (!tags.length) return;
  await ghlFetch("DELETE", `/contacts/${enc(contactId)}/tags`, { tags });
}

// --- notes ---

export async function createContactNote(
  contactId: string,
  note: { title: string; body: string },
): Promise<string> {
  const r = await ghlFetch<{ note?: { id?: string } }>("POST", `/contacts/${enc(contactId)}/notes`, {
    title: note.title,
    body: note.body,
  });
  const id = r.note?.id;
  if (!id) throw new GhlApiError("POST", `/contacts/${enc(contactId)}/notes`, 200, "response had no note id");
  return id;
}

// --- contacts ---

// raw contact as GHL returns it (customFields come back as [{ id, value }])
export async function getContact(contactId: string): Promise<Record<string, unknown>> {
  const r = await ghlFetch<{ contact?: Record<string, unknown> }>("GET", `/contacts/${enc(contactId)}`);
  if (!r.contact) throw new GhlApiError("GET", `/contacts/${enc(contactId)}`, 200, "response had no contact");
  return r.contact;
}
