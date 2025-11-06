import { ENV } from "./env";

type HeadersInit = Record<string, string>;
const baseHeaders: HeadersInit = {
  Authorization: `Bearer ${ENV.TOKEN}`,
  Version: ENV.API_VERSION,
  "Content-Type": "application/json",
};

type CF = { id: string; name: string; model: string; dataType?: string };

const CF_CACHE: {
  contact?: Map<string, CF>;
  loaded?: boolean;
} = {};

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${ENV.BASE_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...baseHeaders, ...(init?.headers as HeadersInit) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} @ ${path} :: ${text}`);
  }
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

async function loadContactFields(): Promise<Map<string, CF>> {
  if (CF_CACHE.contact && CF_CACHE.loaded) return CF_CACHE.contact;
  const data = await apiFetch<{ customFields?: CF[] }>(
    `/locations/${encodeURIComponent(ENV.LOCATION_ID)}/customFields`
  );
  const map = new Map<string, CF>();
  for (const f of data.customFields || []) {
    if (String(f.model).toLowerCase() === "contact") {
      map.set(f.name.toLowerCase(), f);
    }
  }
  CF_CACHE.contact = map;
  CF_CACHE.loaded = true;
  return map;
}

const STANDARD_KEYS = new Set(
  [
    // contacto estándar
    "first_name", "last_name", "full_name", "email", "phone", "tags",
    "address1", "city", "state", "country", "timezone", "date_created",
    "postal_code", "company_name", "website", "date_of_birth", "contact_source",
    "full_address", "contact_type", "gclid",
    // ubicación 
    "location",
    // oportunidad 
    "opportunity_name", "status", "lead_value", "opportunity_source", "source",
    "pipleline_stage", "pipeline_id", "id", "pipeline_name",
    // campaign/user/appointment/order/invoice/task/note/message/workflow
    "campaign", "user", "calendar", "order", "invoice", "task", "note",
    "message", "workflow",
    // auxiliares 
    "contact_id", "owner", "headers", "triggerData", "contact", "attributionSource",
    "customData", 
  ].map((s) => s.toLowerCase())
);

function normalizeCustomValue(raw: unknown, dataType?: string): any {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    const trimmed = raw.map((v) => String(v).trim()).filter(Boolean);
    if (!trimmed.length) return undefined;
    const multiTypes = new Set([
      "CHECKBOX",
      "CHECKBOXES",
      "MULTI_SELECT",
      "SELECT_MULTI",
    ]);
    return dataType && multiTypes.has(dataType.toUpperCase())
      ? trimmed
      : trimmed.join(", ");
  }
  if (typeof raw === "object") {
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
  const s = String(raw).trim();
  return s.length ? s : undefined;
}

export async function mapCustomFieldsFromPayload(payload: Record<string, any>) {
  const map = await loadContactFields();
  const out: { id: string; value: any }[] = [];

  // 1) root-level custom keys
  for (const [k, v] of Object.entries(payload)) {
    const keyLc = k.toLowerCase();
    if (STANDARD_KEYS.has(keyLc)) continue; 
    const cf = map.get(keyLc);
    if (!cf) continue;
    const value = normalizeCustomValue(v, cf.dataType);
    if (value === undefined) continue;
    out.push({ id: cf.id, value });
  }

  // 2) customData block 
  const customData = payload?.customData;
  if (customData && typeof customData === "object") {
    for (const [k, v] of Object.entries(customData)) {
      const cf = map.get(k.toLowerCase());
      if (!cf) continue;
      const value = normalizeCustomValue(v, cf.dataType);
      if (value === undefined) continue;
      out.push({ id: cf.id, value });
    }
  }

  const overrideJson = process.env.CUSTOM_FIELD_MAP_JSON;
  if (overrideJson) {
    try {
      const manual: Record<string, string> = JSON.parse(overrideJson);
      for (const [name, id] of Object.entries(manual)) {
        const raw =
          payload[name] ??
          payload[name.toLowerCase()] ??
          customData?.[name] ??
          customData?.[name.toLowerCase()];
        if (raw == null) continue;
        const value = normalizeCustomValue(raw);
        if (value === undefined) continue;
        if (!out.some((x) => x.id === id)) out.push({ id, value });
      }
    } catch {
    }
  }

  return out;
}
