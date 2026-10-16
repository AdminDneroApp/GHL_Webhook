import { describe, expect, it, vi } from "vitest";
import type { GhlCustomField } from "@lib/emc/adapters/ghl";
import { OUTBOUND_CONTRACT } from "@lib/emc/config/outbound-contract";
import { buildSnapshot, countFilled, type SnapshotGhl, type Webhook2Envelope } from "@lib/emc/services/snapshot";
import { CONTACT, CONTACT_ID, CUSTOM_FIELDS, NOTES } from "../fixtures/ghl-contact";

const ENVELOPE: Webhook2Envelope = {
  handoffId: "00000000-0000-4000-8000-0000000000aa",
  revision: 1,
  type: "create",
  changedFields: [],
  sentAt: "2026-10-16T15:30:00.000Z",
};

function mockGhl(over: { fields?: unknown[]; contact?: Record<string, unknown> } = {}) {
  return {
    getContact: vi.fn<SnapshotGhl["getContact"]>(async () => over.contact ?? CONTACT),
    listCustomFields: vi.fn<SnapshotGhl["listCustomFields"]>(async () => (over.fields ?? CUSTOM_FIELDS) as GhlCustomField[]),
    // what the adapter returns: { title, body } with "" for a missing title
    listContactNotes: vi.fn<SnapshotGhl["listContactNotes"]>(async () =>
      NOTES.map((n) => ({ title: "title" in n ? (n.title as string) : "", body: n.body })),
    ),
  } satisfies SnapshotGhl;
}

const build = (ghl = mockGhl(), envelope: Webhook2Envelope = ENVELOPE) =>
  buildSnapshot(CONTACT_ID, envelope, { ghl, defaultCountry: "US" });

describe("outbound contract", () => {
  it("has 27 entries: 4 contact + 22 fields + notes, unique keys", () => {
    expect(OUTBOUND_CONTRACT).toHaveLength(27);
    expect(OUTBOUND_CONTRACT.filter((f) => f.section === "contact")).toHaveLength(4);
    expect(OUTBOUND_CONTRACT.filter((f) => f.section === "fields")).toHaveLength(22);
    expect(OUTBOUND_CONTRACT.filter((f) => f.section === "notes")).toHaveLength(1);
    expect(new Set(OUTBOUND_CONTRACT.map((f) => f.outKey)).size).toBe(27);
  });
});

describe("buildSnapshot", () => {
  it("builds the full webhook 2 body from the fixture", async () => {
    const { body, warnings } = await build();

    expect(Object.keys(body)).toEqual([
      "handoffId", "revision", "type", "changedFields", "ghlContactId", "sentAt", "contact", "fields", "notes",
    ]);
    expect(body).not.toHaveProperty("previousHandoffId");
    expect(body).toMatchObject({ ...ENVELOPE, ghlContactId: CONTACT_ID });

    expect(body.contact).toEqual({
      firstName: "Testa",
      lastName: "Fakerson",
      email: "testa.fakerson@example.com",
      phone: "+15555550142",
    });

    expect(body.fields).toEqual({
      call_status: "Contacted",
      transfer_date: "2026-10-15",
      created_date: "2026-10-16",
      telemarketer: ["Agent Uno"],
      transfer_to: [],
      add_real_estate_agent: [],
      type_of_deal: ["Refinance", "Cash Out"],
      ciudad_donde_vives_en_california: "Faketown",
      city_of_purchase: null,
      state_of_purchase: "CA",
      cul_es_tu_objetivo_principal_al_refinanciar: ["Lower payment"],
      property_type: ["Single Family"],
      occupancy: ["Primary"],
      ssn__itin: ["SSN"],
      gross_monthly_income: "6500",
      credit_score: "700-719",
      employement_status: ["W2"],
      have_you_worked_fulltime_for_the_last_two_years: null,
      bankruptcy_in_the_past_year: {
        "Filed by": "DNERO Agent",
        "Discharge Date": "01/02/2025",
        "99999999-ffff-4fff-8fff-000000000009": "orphan",
      },
      taxes_from_the_last_2_years: ["2024", "2025"],
      cosigner_information: { "Co-Signer Name": "Co Fakerson", Relationship: null },
      brief_explanation: "Wants a lower rate.",
    });

    expect(body.notes).toEqual([
      { title: "Call 1", body: "Called, interested." },
      { title: "", body: "Sent docs list." },
    ]);

    // names and counts only
    expect(warnings).toEqual(["unknown_option_ids:bankruptcy_in_the_past_year(1)"]);
    expect(countFilled(body)).toBe(23);
  });

  it("every contract key is present with the right type", async () => {
    const { body } = await build();
    for (const f of OUTBOUND_CONTRACT) {
      if (f.section === "notes") {
        expect(Array.isArray(body.notes)).toBe(true);
        continue;
      }
      const v = (f.section === "contact" ? body.contact : body.fields)[f.outKey];
      expect(v, f.outKey).not.toBeUndefined();
      if (f.type === "multi-select") expect(Array.isArray(v), f.outKey).toBe(true);
      else if (f.type === "text-box-list") expect(v === null || (typeof v === "object" && !Array.isArray(v)), f.outKey).toBe(true);
      else expect(v === null || typeof v === "string", f.outKey).toBe(true);
      if (f.type === "date" && v !== null) expect(v, f.outKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("an empty contact → null / [] for every field, nothing missing", async () => {
    const { body, warnings } = await build(mockGhl({ contact: { id: CONTACT_ID } }));
    expect(Object.values(body.contact)).toEqual([null, null, null, null]);
    for (const f of OUTBOUND_CONTRACT.filter((e) => e.section === "fields")) {
      expect(body.fields[f.outKey], f.outKey).toEqual(f.type === "multi-select" ? [] : null);
    }
    expect(warnings).toEqual([]);
    expect(countFilled(body)).toBe(1); // the notes
  });

  it("missing field definitions → warnings by key, value null / []", async () => {
    const fields = CUSTOM_FIELDS.filter((f) => !["f_credit", "f_taxes"].includes(f.id));
    const { body, warnings } = await build(mockGhl({ fields }));
    expect(body.fields.credit_score).toBeNull();
    expect(body.fields.taxes_from_the_last_2_years).toEqual([]);
    expect(warnings).toEqual(
      expect.arrayContaining(["missing_field:credit_score", "missing_field:taxes_from_the_last_2_years"]),
    );
  });

  it("text-box-list without option labels → ids kept as keys, warned", async () => {
    const fields = CUSTOM_FIELDS.map((f) => (f.id === "f_cosigner" ? { ...f, picklistOptions: [] } : f));
    const { body, warnings } = await build(mockGhl({ fields }));
    expect(body.fields.cosigner_information).toEqual({
      "22222222-bbbb-4bbb-8bbb-000000000001": "Co Fakerson",
      "22222222-bbbb-4bbb-8bbb-000000000002": null,
    });
    expect(warnings).toEqual(
      expect.arrayContaining(["no_option_labels:cosigner_information", "unknown_option_ids:cosigner_information(2)"]),
    );
  });

  it("dates: MM/DD/YYYY, epoch millis (number or string), ISO; junk kept and warned", async () => {
    const dateFor = async (value: unknown) => {
      const contact = { ...CONTACT, customFields: [{ id: "f_transfer_date", value }] };
      const r = await build(mockGhl({ contact }));
      return [r.body.fields.transfer_date, r.warnings] as const;
    };
    expect(await dateFor("3/7/2026")).toEqual(["2026-03-07", []]);
    expect(await dateFor("1792022400000")).toEqual(["2026-10-15", []]);
    expect(await dateFor("2026-10-15T00:00:00.000Z")).toEqual(["2026-10-15", []]);
    expect(await dateFor("")).toEqual([null, []]);
    expect(await dateFor("13/40/2026")).toEqual(["13/40/2026", ["unparsed_date:transfer_date"]]);
  });

  it("includes previousHandoffId only when given", async () => {
    const { body } = await build(mockGhl(), { ...ENVELOPE, previousHandoffId: "prev-1" });
    expect(body.previousHandoffId).toBe("prev-1");
  });

  it("warnings never carry values", async () => {
    const fields = CUSTOM_FIELDS.filter((f) => f.id !== "f_credit");
    const { warnings } = await build(mockGhl({ fields }));
    const text = JSON.stringify(warnings);
    for (const v of ["DNERO Agent", "orphan", "Testa", "fakerson", "555"]) expect(text).not.toContain(v);
  });
});
