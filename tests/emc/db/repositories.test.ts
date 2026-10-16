import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { recordEvent } from "@lib/emc/audit";
import type { Database, Tx } from "@lib/emc/db/client";
import {
  addRevision,
  CONTACT_LOCK_NAMESPACE,
  createCycle,
  getActiveCycle,
  getCycle,
  getLastClosedCycle,
  getRevisions,
  setGhlSyncPending,
  withContactLock,
} from "@lib/emc/db/repositories";
import { handoffCycles, handoffEvents, handoffRevisions } from "@lib/emc/db/schema";
import { decideTagEvent } from "@lib/emc/domain/cycle";
import { createTestDb } from "../helpers/pglite";

let db: Database;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await createTestDb());
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.execute(sql`truncate handoff_events, handoff_revisions, handoff_cycles`);
});

const LOC = "loc-1";

// what the intake service will do inside the lock (minus GHL calls)
async function onTagAdded(tx: Tx, ghlContactId: string) {
  const activeCycle = await getActiveCycle(tx, ghlContactId);
  const lastClosedCycle = activeCycle ? null : await getLastClosedCycle(tx, ghlContactId);
  const decision = decideTagEvent({ activeCycle, lastClosedCycle });
  if (decision.kind === "new_cycle") {
    const { cycle, revision } = await createCycle(tx, {
      ghlContactId,
      locationId: LOC,
      previousHandoffId: decision.previousHandoffId,
    });
    await recordEvent(tx, {
      handoffId: cycle.id,
      revision: 1,
      ghlContactId,
      event: "requested",
      direction: "agent_to_dnero",
      statusAfter: "requested",
    });
    return { handoffId: cycle.id, revision: revision.revision };
  }
  const { revision } = await addRevision(tx, decision.handoffId);
  await recordEvent(tx, {
    handoffId: decision.handoffId,
    revision: revision.revision,
    ghlContactId,
    event: "revision_created",
    direction: "agent_to_dnero",
  });
  return { handoffId: decision.handoffId, revision: revision.revision };
}

describe("one active cycle per contact", () => {
  it("rejects a second active cycle for the same contact", async () => {
    await db.transaction((tx) => createCycle(tx, { ghlContactId: "c1", locationId: LOC }));
    await expect(
      db.transaction((tx) => createCycle(tx, { ghlContactId: "c1", locationId: LOC })),
    ).rejects.toThrow();

    // other contacts are unaffected
    await db.transaction((tx) => createCycle(tx, { ghlContactId: "c2", locationId: LOC }));
  });

  it.each(["completed", "failed"] as const)("allows a new cycle once the previous one is %s", async (status) => {
    const { cycle } = await db.transaction((tx) => createCycle(tx, { ghlContactId: "c1", locationId: LOC }));
    await db.update(handoffCycles).set({ status, closedAt: new Date() }).where(eq(handoffCycles.id, cycle.id));
    const next = await db.transaction((tx) => createCycle(tx, { ghlContactId: "c1", locationId: LOC }));
    expect(next.cycle.id).not.toBe(cycle.id);
  });

  it("rejects an unknown status (check constraint)", async () => {
    await expect(
      db.execute(sql`insert into handoff_cycles (ghl_contact_id, location_id, status) values ('c1', ${LOC}, 'bogus')`),
    ).rejects.toThrow();
  });
});

describe("cycles and revisions", () => {
  it("createCycle starts at revision 1 (create, queued)", async () => {
    const { cycle, revision } = await db.transaction((tx) =>
      createCycle(tx, { ghlContactId: "c1", locationId: LOC }),
    );
    expect(cycle).toMatchObject({ status: "requested", latestRevision: 1, ghlSyncPending: false });
    expect(cycle.previousHandoffId).toBeNull();
    expect(revision).toMatchObject({ handoffId: cycle.id, revision: 1, type: "create", sendState: "queued" });
  });

  it("addRevision numbers revisions 2, 3… and keeps the status", async () => {
    const { cycle } = await db.transaction((tx) => createCycle(tx, { ghlContactId: "c1", locationId: LOC }));
    const r2 = await db.transaction((tx) => addRevision(tx, cycle.id, { changedFields: ["email"] }));
    const r3 = await db.transaction((tx) => addRevision(tx, cycle.id));
    expect(r2.revision).toMatchObject({ revision: 2, type: "update", changedFields: ["email"] });
    expect(r3.revision.revision).toBe(3);
    expect(r3.cycle).toMatchObject({ latestRevision: 3, status: "requested" });
  });

  it("addRevision supersedes older queued/pending revisions only", async () => {
    const { cycle } = await db.transaction((tx) => createCycle(tx, { ghlContactId: "c1", locationId: LOC }));
    await db.transaction((tx) => addRevision(tx, cycle.id)); // r2 supersedes r1
    expect((await getRevisions(db, cycle.id)).map((r) => [r.revision, r.sendState, r.supersededBy])).toEqual([
      [1, "superseded", 2],
      [2, "queued", null],
    ]);

    // r2 was sent; r3 is pending retry. r4 supersedes r3 but leaves sent r2 alone.
    await db
      .update(handoffRevisions)
      .set({ sendState: "sent" })
      .where(sql`${handoffRevisions.handoffId} = ${cycle.id} and ${handoffRevisions.revision} = 2`);
    await db.transaction((tx) => addRevision(tx, cycle.id));
    await db
      .update(handoffRevisions)
      .set({ sendState: "pending" })
      .where(sql`${handoffRevisions.handoffId} = ${cycle.id} and ${handoffRevisions.revision} = 3`);
    const r4 = await db.transaction((tx) => addRevision(tx, cycle.id));

    expect(r4.superseded).toEqual([3]);
    expect((await getRevisions(db, cycle.id)).map((r) => [r.revision, r.sendState, r.supersededBy])).toEqual([
      [1, "superseded", 2],
      [2, "sent", null],
      [3, "superseded", 4],
      [4, "queued", null],
    ]);
  });

  it("addRevision fails for an unknown cycle", async () => {
    await expect(
      db.transaction((tx) => addRevision(tx, "00000000-0000-0000-0000-000000000000")),
    ).rejects.toThrow(/not found/);
  });

  it("getActiveCycle / getLastClosedCycle", async () => {
    const first = await db.transaction((tx) => createCycle(tx, { ghlContactId: "c1", locationId: LOC }));
    expect((await db.transaction((tx) => getActiveCycle(tx, "c1")))?.id).toBe(first.cycle.id);
    expect(await getLastClosedCycle(db, "c1")).toBeNull();

    await db
      .update(handoffCycles)
      .set({ status: "completed", closedAt: new Date() })
      .where(eq(handoffCycles.id, first.cycle.id));
    expect(await db.transaction((tx) => getActiveCycle(tx, "c1"))).toBeNull();
    expect((await getLastClosedCycle(db, "c1"))?.id).toBe(first.cycle.id);
  });

  it("setGhlSyncPending sets and clears the flag", async () => {
    const { cycle } = await db.transaction((tx) => createCycle(tx, { ghlContactId: "c1", locationId: LOC }));
    await setGhlSyncPending(db, cycle.id, true);
    expect((await getCycle(db, cycle.id))?.ghlSyncPending).toBe(true);
    await setGhlSyncPending(db, cycle.id, false);
    expect((await getCycle(db, cycle.id))?.ghlSyncPending).toBe(false);
  });

  it("updated_at moves on addRevision and setGhlSyncPending ($onUpdate)", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 15));
    const { cycle } = await db.transaction((tx) => createCycle(tx, { ghlContactId: "c1", locationId: LOC }));
    await tick();
    const r2 = await db.transaction((tx) => addRevision(tx, cycle.id));
    expect(r2.cycle.updatedAt.getTime()).toBeGreaterThan(cycle.updatedAt.getTime());
    await tick();
    await setGhlSyncPending(db, cycle.id, true);
    const after = await getCycle(db, cycle.id);
    expect(after!.updatedAt.getTime()).toBeGreaterThan(r2.cycle.updatedAt.getTime());
    expect(after!.createdAt.getTime()).toBe(cycle.createdAt.getTime());
  });

  it("recordEvent appends audit rows", async () => {
    const e = await recordEvent(db, { ghlContactId: "c1", event: "rejected", meta: { reason: "no_phone_or_email" } });
    expect(e.id).toBeGreaterThan(0);
    expect(e.meta).toEqual({ reason: "no_phone_or_email" });
  });
});

describe("withContactLock", () => {
  it("holds a per-contact advisory lock inside the transaction", async () => {
    const held = await withContactLock(
      "c1",
      async (tx) => {
        const res = await tx.execute(
          sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and classid = ${CONTACT_LOCK_NAMESPACE}`,
        );
        return (res as unknown as { rows: { n: number }[] }).rows[0].n;
      },
      db,
    );
    expect(held).toBe(1);
  });

  it("serializes two concurrent tag events into r1 + r2 of one cycle", async () => {
    const [a, b] = await Promise.all([
      withContactLock("c1", (tx) => onTagAdded(tx, "c1"), db),
      withContactLock("c1", (tx) => onTagAdded(tx, "c1"), db),
    ]);
    expect(a.handoffId).toBe(b.handoffId);
    expect([a.revision, b.revision].sort()).toEqual([1, 2]);

    const cycles = await db.select().from(handoffCycles);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].latestRevision).toBe(2);
    const events = await db.select().from(handoffEvents).orderBy(handoffEvents.id);
    expect(events.map((e) => [e.event, e.revision])).toEqual([
      ["requested", 1],
      ["revision_created", 2],
    ]);
  });

  it("opens a new cycle with previousHandoffId after completed", async () => {
    const first = await withContactLock("c1", (tx) => onTagAdded(tx, "c1"), db);
    await db
      .update(handoffCycles)
      .set({ status: "completed", closedAt: new Date() })
      .where(eq(handoffCycles.id, first.handoffId));
    const second = await withContactLock("c1", (tx) => onTagAdded(tx, "c1"), db);
    expect(second.revision).toBe(1);
    expect((await getCycle(db, second.handoffId))?.previousHandoffId).toBe(first.handoffId);
  });

  it("rolls back everything when fn throws", async () => {
    await expect(
      withContactLock(
        "c1",
        async (tx) => {
          await onTagAdded(tx, "c1");
          throw new Error("boom");
        },
        db,
      ),
    ).rejects.toThrow("boom");
    expect(await db.select().from(handoffCycles)).toHaveLength(0);
    expect(await db.select().from(handoffEvents)).toHaveLength(0);
  });
});
