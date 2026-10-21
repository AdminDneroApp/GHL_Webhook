import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { Database } from "@lib/emc/db/client";
import { createCycle, withContactLock } from "@lib/emc/db/repositories";
import { handoffEvents } from "@lib/emc/db/schema";
import { processEmcHandoff } from "@lib/emc/handoff";
import { EmcHandoffSchema } from "@lib/emc/schema";
import { createTestDb } from "./helpers/pglite";

let db: Database;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await createTestDb());
});

afterAll(async () => {
  await client.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const VALID = {
  handoffId: "3f6c2b1e-8a4d-4c2b-9e1f-0a1b2c3d4e5f",
  revision: 2,
  externalId: "EMC-998",
  pipelineStage: "Collecting Docs",
  fields: { emc_loan_officer: ["Loan Officer B"], add_real_estate_agent: "Agent C" },
  notes: [{ title: "Docs received", body: "W2 and paystubs" }],
};

const ctx = (idempotencyKey = "idem-key-0001") => ({
  handoffId: "99999999-9999-4999-8999-999999999999",
  receivedAt: "2026-10-21T12:00:00.000Z",
  keyIndex: 0,
  idempotencyKey,
});

describe("EmcHandoffSchema v1", () => {
  it("accepts the draft body, the minimal reference and extra keys", () => {
    expect(EmcHandoffSchema.safeParse(VALID).success).toBe(true);
    expect(EmcHandoffSchema.safeParse({ handoffId: VALID.handoffId, revision: 1, externalId: "x" }).success).toBe(true);
    const extra = EmcHandoffSchema.safeParse({ ...VALID, somethingNew: 1, fields: { ...VALID.fields, other: "y" } });
    expect(extra.success).toBe(true);
    if (extra.success) {
      expect(extra.data.somethingNew).toBe(1);
      expect(extra.data.fields?.other).toBe("y");
    }
  });

  it.each([
    ["missing handoffId", { revision: 1, externalId: "x" }, "handoffId"],
    ["non-uuid handoffId", { ...VALID, handoffId: "abc" }, "handoffId"],
    ["missing revision", { handoffId: VALID.handoffId, externalId: "x" }, "revision"],
    ["revision 0", { ...VALID, revision: 0 }, "revision"],
    ["fractional revision", { ...VALID, revision: 1.5 }, "revision"],
    ["missing externalId", { handoffId: VALID.handoffId, revision: 1 }, "externalId"],
    ["numeric pipelineStage", { ...VALID, pipelineStage: 3 }, "pipelineStage"],
    ["fields not an object", { ...VALID, fields: "x" }, "fields"],
    ["dropdown number", { ...VALID, fields: { emc_loan_officer: 5 } }, "fields.emc_loan_officer"],
    ["note without body", { ...VALID, notes: [{ title: "t" }] }, "notes.0.body"],
  ])("rejects %s", (_name, body, path) => {
    const r = EmcHandoffSchema.safeParse(body);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path.join("."))).toContain(path);
  });
});

describe("processEmcHandoff (record only)", () => {
  async function eventsFor(handoffId: string) {
    return db.select().from(handoffEvents).where(eq(handoffEvents.handoffId, handoffId));
  }

  it("records emc_returned for an unknown cycle with key names only, and calls nothing external", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await processEmcHandoff(EmcHandoffSchema.parse(VALID), ctx(), db);
    expect(result).toEqual({ status: "accepted" });

    const [ev] = await eventsFor(VALID.handoffId);
    expect(ev).toMatchObject({
      event: "emc_returned",
      direction: "emc_to_dnero",
      revision: 2,
      externalId: "EMC-998",
      ghlContactId: null,
      before: null,
      after: null,
      meta: {
        unknownCycle: true,
        idempotencyKey: "idem-key-0001",
        requestId: ctx().handoffId,
        keys: ["handoffId", "revision", "externalId", "pipelineStage", "fields", "notes"],
        fieldKeys: ["emc_loan_officer", "add_real_estate_agent"],
        notesCount: 1,
        pipelineStagePresent: true,
      },
    });
    // no values in the event
    expect(JSON.stringify(ev.meta)).not.toMatch(/Collecting Docs|Loan Officer B|Agent C|W2/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("links a known cycle without changing its status", async () => {
    const { cycle } = await withContactLock("contact-1", (tx) => createCycle(tx, { ghlContactId: "contact-1", locationId: "loc" }), db);
    await processEmcHandoff(EmcHandoffSchema.parse({ ...VALID, handoffId: cycle.id, revision: 1, notes: undefined }), ctx("idem-key-0002"), db);

    const [ev] = await eventsFor(cycle.id);
    expect(ev).toMatchObject({ ghlContactId: "contact-1", statusBefore: "requested", statusAfter: "requested" });
    expect(ev.meta).not.toHaveProperty("unknownCycle");
    expect(ev.meta).toMatchObject({ notesCount: 0 });
  });

  it("logs the body only behind EMC_GHL_DEBUG_BODY", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await processEmcHandoff(EmcHandoffSchema.parse(VALID), ctx(), db);
    expect(warn).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/Collecting Docs|Loan Officer B|EMC-998/);

    vi.stubEnv("EMC_GHL_DEBUG_BODY", "true");
    await processEmcHandoff(EmcHandoffSchema.parse(VALID), ctx(), db);
    expect(warn).toHaveBeenCalledWith("EMC_HANDOFF_DEBUG_BODY", expect.stringContaining("Collecting Docs"));
  });
});
