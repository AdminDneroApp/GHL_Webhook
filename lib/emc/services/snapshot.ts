import * as ghlAdapter from "../adapters/ghl";
import type { GhlCustomField } from "../adapters/ghl";
import {
  normalizeValue,
  OUTBOUND_CONTRACT,
  type OutboundValue,
  type NormalizeContext,
} from "../config/outbound-contract";
import { ENV } from "@lib/env";

// step 2: the webhook 2 body, built from the GHL API (never from the webhook 1 payload: its custom
// fields are keyed by display name). every revision sends the full lead.
// rule: values never go into warnings, errors or logs — key names only.

export type Webhook2Type = "create" | "update";

export interface Webhook2Envelope {
  handoffId: string;
  revision: number;
  type: Webhook2Type;
  changedFields: string[];
  previousHandoffId?: string;
  sentAt: string; // ISO timestamp
}

export interface Webhook2Body extends Omit<Webhook2Envelope, "previousHandoffId"> {
  previousHandoffId?: string;
  ghlContactId: string;
  contact: Record<string, OutboundValue>;
  fields: Record<string, OutboundValue>;
  notes: { title: string; body: string }[];
}

export interface SnapshotResult {
  body: Webhook2Body;
  warnings: string[];
}

export type SnapshotGhl = Pick<typeof ghlAdapter, "getContact" | "listCustomFields" | "listContactNotes">;

export interface SnapshotDeps {
  ghl: SnapshotGhl;
  defaultCountry: "US" | "SV";
}

function bareKey(k: string): string {
  const s = k.trim().toLowerCase();
  return s.startsWith("contact.") ? s.slice("contact.".length) : s;
}

// text-box-list option id → label. read from textBoxListOptions, or picklistOptions when its items
// are objects (the v2 read schema doesn't document where these live)
function optionLabels(field: GhlCustomField): Map<string, string> {
  const out = new Map<string, string>();
  for (const list of [field.textBoxListOptions, field.picklistOptions]) {
    if (!Array.isArray(list)) continue;
    for (const o of list) {
      if (!o || typeof o !== "object") continue;
      const { id, label } = o as { id?: unknown; label?: unknown };
      if (typeof id === "string" && typeof label === "string" && label.trim()) out.set(id, label.trim());
    }
  }
  return out;
}

export async function buildSnapshot(
  contactId: string,
  envelope: Webhook2Envelope,
  deps: Partial<SnapshotDeps> = {},
): Promise<SnapshotResult> {
  const ghl = deps.ghl ?? ghlAdapter;
  const defaultCountry = deps.defaultCountry ?? (ENV.DEFAULT_COUNTRY as "US" | "SV");

  const [contact, definitions, notes] = await Promise.all([
    ghl.getContact(contactId),
    ghl.listCustomFields(),
    ghl.listContactNotes(contactId),
  ]);

  const warnings: string[] = [];
  const warn = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };

  const defsByKey = new Map<string, GhlCustomField>();
  for (const f of definitions) {
    if (f.model && f.model !== "contact") continue;
    if (f.fieldKey) defsByKey.set(bareKey(f.fieldKey), f);
  }

  // the contact's custom values come back as [{ id, value }] (some responses use field_value)
  const valuesById = new Map<string, unknown>();
  const rawCustom = Array.isArray(contact.customFields) ? contact.customFields : [];
  for (const cf of rawCustom as { id?: unknown; value?: unknown; field_value?: unknown }[]) {
    if (cf && typeof cf.id === "string") valuesById.set(cf.id, cf.value !== undefined ? cf.value : cf.field_value);
  }

  const out: Pick<Webhook2Body, "contact" | "fields"> = { contact: {}, fields: {} };
  for (const entry of OUTBOUND_CONTRACT) {
    if (entry.type === "notes") continue;
    const ctx: NormalizeContext = { key: entry.ghlKey, defaultCountry, warn };

    let raw: unknown;
    if (entry.section === "contact") {
      raw = contact[entry.contactProp ?? entry.outKey];
    } else {
      const def = defsByKey.get(entry.ghlKey);
      if (!def) {
        warn(`missing_field:${entry.ghlKey}`);
      } else {
        raw = valuesById.get(def.id);
        if (entry.type === "text-box-list") {
          ctx.optionLabels = optionLabels(def);
          if (!ctx.optionLabels.size) warn(`no_option_labels:${entry.ghlKey}`);
        }
      }
    }
    out[entry.section === "contact" ? "contact" : "fields"][entry.outKey] = normalizeValue(entry.type, raw, ctx);
  }

  const { previousHandoffId, ...rest } = envelope;
  const body: Webhook2Body = {
    handoffId: rest.handoffId,
    revision: rest.revision,
    type: rest.type,
    changedFields: rest.changedFields,
    ...(previousHandoffId ? { previousHandoffId } : {}),
    ghlContactId: contactId,
    sentAt: rest.sentAt,
    contact: out.contact,
    fields: out.fields,
    notes: notes.map((n) => ({ title: n.title ?? "", body: n.body ?? "" })),
  };
  return { body, warnings };
}

// how many of the 27 keys carry a value — a count for logs, never the values
export function countFilled(body: Webhook2Body): number {
  const filled = (v: OutboundValue) => (Array.isArray(v) ? v.length > 0 : v !== null);
  return (
    Object.values(body.contact).filter(filled).length +
    Object.values(body.fields).filter(filled).length +
    (body.notes.length ? 1 : 0)
  );
}
