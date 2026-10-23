// webhook 2 (DNERO → EMC): the 28 outbound fields = 4 standard (contact) + 23 custom (fields) + notes.
// change fields here. the snapshot builder (services/snapshot.ts) applies each entry's normalizer.
// CONTEXT §4 Webhook 2, §5.1, §5.2

import { normalizePhone } from "@lib/phone";

export type OutboundType =
  | "text"
  | "single-select"
  | "multi-select"
  | "date"
  | "text-box-list"
  | "phone"
  | "email"
  | "notes";

export type OutboundSection = "contact" | "fields" | "notes";

export type TextBoxListValue = Record<string, string | null>;
export type OutboundValue = string | string[] | TextBoxListValue | null;

export interface NormalizeContext {
  key: string; // the entry's ghlKey, used in warnings
  defaultCountry: "US" | "SV";
  // text-box-list only: option id → label, from the custom field definition
  optionLabels?: Map<string, string>;
  warn: (warning: string) => void; // names only, never values
}

export interface OutboundField {
  ghlKey: string; // GHL key without "contact."
  outKey: string; // key in the webhook 2 body
  section: OutboundSection;
  type: OutboundType;
  contactProp?: string; // standard fields: the property on GHL's contact object
}

const std = (ghlKey: string, outKey: string, type: OutboundType): OutboundField => ({
  ghlKey,
  outKey,
  section: "contact",
  type,
  contactProp: outKey,
});

const custom = (ghlKey: string, type: OutboundType): OutboundField => ({
  ghlKey,
  outKey: ghlKey,
  section: "fields",
  type,
});

export const OUTBOUND_CONTRACT: readonly OutboundField[] = [
  // --- standard fields → body.contact
  std("first_name", "firstName", "text"),
  std("last_name", "lastName", "text"),
  std("email", "email", "email"),
  std("phone", "phone", "phone"),

  // --- custom fields → body.fields. Contact folder
  custom("call_status", "single-select"),
  custom("transfer_date", "date"),
  custom("created_date", "date"), // a Single line field in GHL, but holds MM/DD/YYYY
  // Pre-Qualification Questions folder
  custom("telemarketer", "multi-select"),
  custom("emc_loan_officer", "multi-select"), // replaces transfer_to ("Loan Officer")
  custom("add_real_estate_agent", "multi-select"),
  custom("type_of_deal", "multi-select"),
  custom("ciudad_donde_vives_en_california", "text"),
  custom("city_of_purchase", "text"),
  custom("state_of_purchase", "text"),
  custom("cul_es_tu_objetivo_principal_al_refinanciar", "multi-select"),
  custom("property_type", "multi-select"),
  custom("occupancy", "multi-select"),
  custom("ssn__itin", "multi-select"),
  custom("gross_monthly_income", "text"),
  custom("credit_score", "text"),
  custom("employement_status", "multi-select"), // typo kept as in GHL
  custom("have_you_worked_fulltime_for_the_last_two_years", "single-select"),
  custom("have_you_filed_for_a_bankruptcy", "multi-select"), // replaces bankruptcy_in_the_past_year
  custom("if_so_when_did_you_file_bankrupcy", "date"), // date picker; typo kept as in GHL
  custom("taxes_from_the_last_2_years", "multi-select"),
  custom("cosigner_information", "text-box-list"),
  custom("brief_explanation", "text"), // multi line

  // --- notes → body.notes, [{ title, body }] read from GET /contacts/{id}/notes
  { ghlKey: "notes", outKey: "notes", section: "notes", type: "notes" },
];

// --- normalizers. empty text / single-select → null, empty multi-select → [], every key always present

function asText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) {
    const parts = raw.map(asText).filter((s): s is string => s !== null);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof raw === "object") return null;
  const s = String(raw).trim();
  return s ? s : null;
}

function asList(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map(asText).filter((s): s is string => s !== null);
}

const pad = (n: number) => String(n).padStart(2, "0");

function validYmd(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

// GHL gives MM/DD/YYYY (text fields, webhook payloads), epoch millis (DATE fields) or ISO strings
export function toIsoDate(raw: unknown): string | null | undefined {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? new Date(raw).toISOString().slice(0, 10) : undefined;
  }
  const s = asText(raw);
  if (s === null) return null;
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return validYmd(+m[3], +m[1], +m[2]) ?? undefined;
  if (/^\d{10,14}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10);
  m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(s);
  if (m) return validYmd(+m[1], +m[2], +m[3]) ?? undefined;
  return undefined; // not a date we understand
}

function textBoxList(raw: unknown, ctx: NormalizeContext): TextBoxListValue | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (asText(raw) !== null) ctx.warn(`unexpected_shape:${ctx.key}`);
    return null;
  }
  const labels = ctx.optionLabels ?? new Map<string, string>();
  const knownLabels = new Set(labels.values());
  const out: TextBoxListValue = {};
  let unknown = 0;
  let filled = 0;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const label = labels.get(id);
    // a key that already is a label is kept as is; an unknown id keeps its id as the key
    if (!label && !knownLabels.has(id)) unknown++;
    const v = asText(value);
    if (v !== null) filled++;
    out[label ?? id] = v;
  }
  if (unknown) ctx.warn(`unknown_option_ids:${ctx.key}(${unknown})`);
  return filled ? out : null;
}

export function normalizeValue(
  type: Exclude<OutboundType, "notes">,
  raw: unknown,
  ctx: NormalizeContext,
): OutboundValue {
  switch (type) {
    case "text":
      return asText(raw);
    case "single-select":
      return asList(raw)[0] ?? null;
    case "multi-select":
      return asList(raw);
    case "date": {
      const iso = toIsoDate(raw);
      if (iso === undefined) {
        ctx.warn(`unparsed_date:${ctx.key}`);
        return asText(raw); // kept as GHL gave it rather than dropped
      }
      return iso;
    }
    case "phone": {
      const s = asText(raw);
      return s ? (normalizePhone(s, ctx.defaultCountry) ?? null) : null;
    }
    case "email":
      return asText(raw)?.toLowerCase() ?? null;
    case "text-box-list":
      return textBoxList(raw, ctx);
  }
}
