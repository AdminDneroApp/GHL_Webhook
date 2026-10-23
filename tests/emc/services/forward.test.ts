import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { formatGhlDateTime, GhlApiError } from "@lib/emc/adapters/ghl";
import type { EmcSendResult } from "@lib/emc/adapters/emc";
import type { Database } from "@lib/emc/db/client";
import { addRevision, createCycle, getCycle, getRevisions, withContactLock } from "@lib/emc/db/repositories";
import { handoffEvents } from "@lib/emc/db/schema";
import { forwardRevision, type ForwardDeps } from "@lib/emc/services/forward";
import { createTestDb } from "../helpers/pglite";

let db: Database;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await createTestDb());
});

afterAll(async () => {
  await client.close();
});

const NOW = new Date("2026-10-23T15:30:00Z");

function harness(responses: (EmcSendResult | Error)[], existingExternalId: string | null = "ext-1") {
  const queue = [...responses];
  const sendToEmc = vi.fn<ForwardDeps["sendToEmc"]>(async () => {
    const next = queue.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  const buildSnapshot = vi.fn<ForwardDeps["buildSnapshot"]>(async (contactId, envelope) => ({
    body: { ...envelope, ghlContactId: contactId, externalId: existingExternalId, contact: {}, fields: {}, notes: [] },
    warnings: [],
  }));
  const ghl = {
    updateContactCustomFields: vi.fn<ForwardDeps["ghl"]["updateContactCustomFields"]>(async () => {}),
    formatGhlDateTime: vi.fn<ForwardDeps["ghl"]["formatGhlDateTime"]>(formatGhlDateTime),
  };
  const sleep = vi.fn<ForwardDeps["sleep"]>(async () => {});
  const deps: Partial<ForwardDeps> = {
    db,
    ghl,
    buildSnapshot,
    sendToEmc,
    sleep,
    newExternalId: () => "ext-new",
    now: () => NOW,
    retryDelaysMs: [10, 20],
  };
  return { deps, ghl, sendToEmc, buildSnapshot, sleep };
}

async function newCycle() {
  const { cycle } = await withContactLock("c1", (tx) => createCycle(tx, { ghlContactId: "c1", locationId: "loc-1" }), db);
  return cycle.id;
}

const send = (handoffId: string, deps: Partial<ForwardDeps>, revision = 1) =>
  forwardRevision({ handoffId, revision, type: revision === 1 ? "create" : "update", ghlContactId: "c1", forwardId: "fwd-1" }, deps);

const events = () => db.select().from(handoffEvents).orderBy(handoffEvents.id);
const ok: EmcSendResult = { classification: "sent", status: 200 };

beforeEach(async () => {
  await db.execute(sql`truncate handoff_events, handoff_revisions, handoff_cycles`);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("forwardRevision", () => {
  it("2xx → cycle sent, status + emc_handoff_time mirrored to GHL, sent event", async () => {
    const id = await newCycle();
    const h = harness([ok]);

    expect(await send(id, h.deps)).toBe("sent");
    expect(h.sendToEmc.mock.calls[0][1]).toBe(`${id}:r1`);
    expect(await getCycle(db, id)).toMatchObject({ status: "sent", externalId: "ext-1", closedAt: null });
    expect((await getRevisions(db, id))[0]).toMatchObject({ sendState: "sent", attempts: 1, lastHttpStatus: 200 });
    expect(h.ghl.updateContactCustomFields).toHaveBeenCalledWith("c1", {
      emc_handoff_status: "sent",
      emc_handoff_time: "2026-10-23 15:30:00 UTC",
    });
    expect((await events()).map((e) => [e.event, e.direction, e.statusBefore, e.statusAfter, e.httpStatus])).toEqual([
      ["sent", "dnero_to_emc", "requested", "sent", 200],
    ]);
  });

  it("contact without an external id → created and saved before the send", async () => {
    const id = await newCycle();
    const h = harness([ok], null);
    await send(id, h.deps);
    expect(h.ghl.updateContactCustomFields.mock.calls[0]).toEqual(["c1", { emc_handoff_external_id: "ext-new" }]);
    expect((h.sendToEmc.mock.calls[0][0] as { externalId: string }).externalId).toBe("ext-new");
    expect((await getCycle(db, id))?.externalId).toBe("ext-new");
  });

  it("retryable failures → retried inline, then sent", async () => {
    const id = await newCycle();
    const h = harness([{ classification: "retry", status: 0, reason: "timeout" }, { classification: "retry", status: 503 }, ok]);
    expect(await send(id, h.deps)).toBe("sent");
    expect(h.sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20]);
    expect((await getRevisions(db, id))[0]).toMatchObject({ sendState: "sent", attempts: 3 });
    expect((await events()).map((e) => e.event)).toEqual(["retry_scheduled", "retry_scheduled", "sent"]);
  });

  it("retries run out → cycle failed (closed), failed status + time mirrored", async () => {
    const id = await newCycle();
    const h = harness([new GhlApiError("GET", "/contacts/c1", 502), { classification: "retry", status: 500 }, { classification: "retry", status: 500 }]);
    expect(await send(id, h.deps)).toBe("failed");
    const cycle = await getCycle(db, id);
    expect(cycle).toMatchObject({ status: "failed" });
    expect(cycle?.closedAt).not.toBeNull();
    expect(h.ghl.updateContactCustomFields).toHaveBeenCalledWith("c1", {
      emc_handoff_status: "failed",
      emc_handoff_time: "2026-10-23 15:30:00 UTC",
    });
  });

  it("4xx → failed right away, no retry", async () => {
    const id = await newCycle();
    const h = harness([{ classification: "failed", status: 400 }]);
    expect(await send(id, h.deps)).toBe("failed");
    expect(h.sendToEmc).toHaveBeenCalledTimes(1);
    expect((await getCycle(db, id))?.status).toBe("failed");
  });

  it("409 → cycle completed, conflict event", async () => {
    const id = await newCycle();
    const h = harness([{ classification: "closed", status: 409 }]);
    expect(await send(id, h.deps)).toBe("closed");
    expect((await getCycle(db, id))?.status).toBe("completed");
    expect((await events()).map((e) => e.event)).toEqual(["conflict"]);
  });

  it("a failed older revision doesn't fail the cycle (a newer one is on its way)", async () => {
    const id = await newCycle();
    await withContactLock("c1", (tx) => addRevision(tx, id), db);
    const h = harness([{ classification: "failed", status: 400 }]);
    expect(await send(id, h.deps, 1)).toBe("failed");
    expect((await getCycle(db, id))?.status).toBe("requested");
    expect((await getRevisions(db, id))[0].sendState).toBe("superseded");
    expect(h.ghl.updateContactCustomFields).not.toHaveBeenCalled();
  });

  it("a revision sent on an already-sent cycle refreshes emc_handoff_time", async () => {
    const id = await newCycle();
    await send(id, harness([ok]).deps);
    await withContactLock("c1", (tx) => addRevision(tx, id), db);
    const h = harness([ok]);
    expect(await send(id, h.deps, 2)).toBe("sent");
    expect(h.ghl.updateContactCustomFields).toHaveBeenCalledWith("c1", expect.objectContaining({ emc_handoff_status: "sent" }));
  });

  it("GHL mirror failure → ghl_sync_pending, the send still counts", async () => {
    const id = await newCycle();
    const h = harness([ok]);
    h.ghl.updateContactCustomFields.mockRejectedValueOnce(new GhlApiError("PUT", "/contacts/c1", 503));
    expect(await send(id, h.deps)).toBe("sent");
    expect(await getCycle(db, id)).toMatchObject({ status: "sent", ghlSyncPending: true });
    expect((await events()).map((e) => [e.event, e.httpStatus])).toEqual([["sent", 200], ["ghl_sync_failed", 503]]);
  });
});
