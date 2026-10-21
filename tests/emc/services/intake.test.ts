import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { formatGhlDateTime, GhlApiError } from "@lib/emc/adapters/ghl";
import { EMC_HANDOFF_TAG, REJECTED_NOTE } from "@lib/emc/config/intake";
import type { Database } from "@lib/emc/db/client";
import { getCycle, getRevisions } from "@lib/emc/db/repositories";
import { handoffCycles, handoffEvents } from "@lib/emc/db/schema";
import { runIntake, type IntakeGhl, type IntakeInput } from "@lib/emc/services/intake";
import type { PreviewDeps } from "@lib/emc/services/forward-preview";
import { createTestDb } from "../helpers/pglite";

let db: Database;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await createTestDb());
});

afterAll(async () => {
  await client.close();
});

const NOW = new Date("2026-10-16T12:00:00Z");

function mockGhl() {
  return {
    removeContactTags: vi.fn<IntakeGhl["removeContactTags"]>(async () => {}),
    updateContactCustomFields: vi.fn<IntakeGhl["updateContactCustomFields"]>(async () => {}),
    createContactNote: vi.fn<IntakeGhl["createContactNote"]>(async () => "note-1"),
    formatGhlDateTime: vi.fn<IntakeGhl["formatGhlDateTime"]>(formatGhlDateTime),
  } satisfies IntakeGhl;
}

let ghl: ReturnType<typeof mockGhl>;

const input = (over: Partial<IntakeInput> = {}): IntakeInput => ({
  ghlContactId: "c1",
  locationId: "loc-1",
  forwardId: "fwd-1",
  hasIdentity: true,
  workflowId: "wf-1",
  ...over,
});

const run = (over: Partial<IntakeInput> = {}) => runIntake(input(over), { db, ghl, now: () => NOW });

const events = () => db.select().from(handoffEvents).orderBy(handoffEvents.id);

async function closeCycle(handoffId: string, status: "completed" | "failed") {
  await db.update(handoffCycles).set({ status, closedAt: new Date() }).where(eq(handoffCycles.id, handoffId));
}

beforeEach(async () => {
  await db.execute(sql`truncate handoff_events, handoff_revisions, handoff_cycles`);
  vi.stubEnv("EMC_INTAKE_ENABLED", "true");
  vi.stubEnv("EMC_INTAKE_DRY_RUN", "false");
  ghl = mockGhl();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runIntake", () => {
  it("new cycle → requested, tag removed and status mirrored to GHL", async () => {
    const r = await run();
    expect(r).toMatchObject({ outcome: "new_cycle", revision: 1, ghlSyncPending: false, dryRun: false });
    expect(r.previousHandoffId).toBeUndefined();

    const cycle = await getCycle(db, r.handoffId!);
    expect(cycle).toMatchObject({ status: "requested", latestRevision: 1, ghlSyncPending: false, locationId: "loc-1" });

    expect(ghl.removeContactTags).toHaveBeenCalledWith("c1", [EMC_HANDOFF_TAG]);
    expect(ghl.updateContactCustomFields).toHaveBeenCalledWith("c1", {
      emc_handoff_status: "requested",
      emc_handoff_time: "2026-10-16 12:00:00 UTC",
    });
    expect((await events()).map((e) => [e.event, e.direction, e.revision])).toEqual([
      ["requested", "agent_to_dnero", 1],
      ["tag_removed", "dnero_to_ghl", 1],
    ]);
  });

  it("re-tag during an active cycle → r2, r1 superseded, no status write", async () => {
    const first = await run();
    ghl = mockGhl();
    const second = await run({ forwardId: "fwd-2" });

    expect(second).toMatchObject({ outcome: "revision", handoffId: first.handoffId, revision: 2, ghlSyncPending: false });
    expect(ghl.removeContactTags).toHaveBeenCalledTimes(1);
    expect(ghl.updateContactCustomFields).not.toHaveBeenCalled();

    expect((await getRevisions(db, first.handoffId!)).map((r) => [r.revision, r.type, r.sendState, r.supersededBy])).toEqual([
      [1, "create", "superseded", 2],
      [2, "update", "queued", null],
    ]);
    expect((await events()).map((e) => [e.event, e.revision])).toEqual([
      ["requested", 1],
      ["tag_removed", 1],
      ["revision_created", 2],
      ["superseded", 1],
      ["tag_removed", 2],
    ]);
  });

  it("after a completed cycle → new cycle with previousHandoffId", async () => {
    const first = await run();
    await closeCycle(first.handoffId!, "completed");
    const second = await run();
    expect(second).toMatchObject({ outcome: "new_cycle", revision: 1, previousHandoffId: first.handoffId });
    expect((await getCycle(db, second.handoffId!))?.previousHandoffId).toBe(first.handoffId);
  });

  it("a new cycle never touches emc_handoff_external_id (permanent per-contact id)", async () => {
    const first = await run();
    await closeCycle(first.handoffId!, "completed");
    ghl = mockGhl();
    await run();
    expect(ghl.updateContactCustomFields).toHaveBeenCalledTimes(1);
    expect(ghl.updateContactCustomFields.mock.calls[0][1]).not.toHaveProperty("emc_handoff_external_id");
  });

  it("after a failed cycle → new cycle without previousHandoffId", async () => {
    const first = await run();
    await closeCycle(first.handoffId!, "failed");
    const second = await run();
    expect(second.outcome).toBe("new_cycle");
    expect(second.handoffId).not.toBe(first.handoffId);
    expect(second.previousHandoffId).toBeUndefined();
    expect((await getCycle(db, second.handoffId!))?.previousHandoffId).toBeNull();
  });

  it("missing identity → rejected: no cycle, tag removed, note created", async () => {
    const r = await run({ hasIdentity: false });
    expect(r).toEqual({ outcome: "rejected", ghlSyncPending: false, dryRun: false });

    expect(await db.select().from(handoffCycles)).toHaveLength(0);
    expect(ghl.removeContactTags).toHaveBeenCalledWith("c1", [EMC_HANDOFF_TAG]);
    expect(ghl.createContactNote).toHaveBeenCalledWith("c1", REJECTED_NOTE);
    expect(ghl.updateContactCustomFields).not.toHaveBeenCalled();

    const ev = await events();
    expect(ev.map((e) => [e.event, e.handoffId])).toEqual([
      ["rejected", null],
      ["tag_removed", null],
      ["note_created", null],
    ]);
    expect(ev[0].meta).toMatchObject({ reason: "missing_identity", forwardId: "fwd-1" });
  });

  it("missing identity + GHL failure → still rejected, failure recorded", async () => {
    ghl.createContactNote.mockRejectedValueOnce(new GhlApiError("POST", "/contacts/c1/notes", 500));
    const r = await run({ hasIdentity: false });
    expect(r.outcome).toBe("rejected");
    const failed = (await events()).find((e) => e.event === "ghl_sync_failed");
    expect(failed).toMatchObject({ httpStatus: 500, handoffId: null });
  });

  it("GHL failure → ghl_sync_pending true, still success", async () => {
    ghl.removeContactTags.mockRejectedValueOnce(new GhlApiError("DELETE", "/contacts/c1/tags", 502));
    ghl.updateContactCustomFields.mockRejectedValueOnce(new GhlApiError("PUT", "/contacts/c1", 0, "timeout"));

    const r = await run();
    expect(r).toMatchObject({ outcome: "new_cycle", revision: 1, ghlSyncPending: true, dryRun: false });
    expect((await getCycle(db, r.handoffId!))?.ghlSyncPending).toBe(true);

    const ev = await events();
    expect(ev.map((e) => e.event)).toEqual(["requested", "ghl_sync_failed"]);
    expect(ev[1]).toMatchObject({ httpStatus: 502, handoffId: r.handoffId });
    expect(ev[1].meta).toMatchObject({
      failures: [
        { op: "remove_tag", status: 502, error: "GhlApiError" },
        { op: "set_status", status: 0, error: "GhlApiError" },
      ],
    });
  });

  it("post-commit DB failure → still returns the recorded result (no 500, so no GHL retry)", async () => {
    let calls = 0;
    const flaky = Object.create(db) as Database;
    // 1st transaction = the locked intake, 2nd = post-commit events / ghl_sync_pending
    flaky.transaction = ((fn, cfg) =>
      ++calls === 2 ? Promise.reject(new Error("db down")) : db.transaction(fn, cfg)) as Database["transaction"];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    ghl.updateContactCustomFields.mockRejectedValueOnce(new GhlApiError("PUT", "/contacts/c1", 503));

    const r = await runIntake(input(), { db: flaky, ghl, now: () => NOW });
    expect(r).toMatchObject({ outcome: "new_cycle", revision: 1, ghlSyncPending: true, dryRun: false });
    expect(await getCycle(db, r.handoffId!)).toMatchObject({ status: "requested", latestRevision: 1 });
    expect((await events()).map((e) => e.event)).toEqual(["requested"]);

    expect(errSpy).toHaveBeenCalledTimes(1);
    const [tag, json] = errSpy.mock.calls[0] as [string, string];
    expect(tag).toBe("EMC_INTAKE_POST_COMMIT_ERROR");
    expect(JSON.parse(json)).toEqual({
      forwardId: "fwd-1",
      handoffId: r.handoffId,
      revision: 1,
      error: "Error",
      tagRemoved: true,
      ghlFailures: ["set_status"],
    });
    errSpy.mockRestore();
  });

  it("dry run → decision only: no rows, no GHL calls", async () => {
    vi.stubEnv("EMC_INTAKE_DRY_RUN", "true");
    expect(await run()).toMatchObject({ outcome: "new_cycle", revision: 1, dryRun: true });
    expect(await run({ hasIdentity: false })).toEqual({ outcome: "rejected", ghlSyncPending: false, dryRun: true });

    expect(await db.select().from(handoffCycles)).toHaveLength(0);
    expect(await events()).toHaveLength(0);
    for (const fn of Object.values(ghl)) expect(fn).not.toHaveBeenCalled();
  });

  it("dry run with an active cycle → reports the next revision without writing it", async () => {
    const first = await run();
    vi.stubEnv("EMC_INTAKE_DRY_RUN", "true");
    ghl = mockGhl();
    expect(await run()).toMatchObject({ outcome: "revision", handoffId: first.handoffId, revision: 2, dryRun: true });
    expect((await getCycle(db, first.handoffId!))?.latestRevision).toBe(1);
    expect(ghl.removeContactTags).not.toHaveBeenCalled();
  });

  it("disabled → nothing at all (default when the flag is unset)", async () => {
    vi.stubEnv("EMC_INTAKE_ENABLED", "");
    // no db passed: a disabled intake must not need one
    const r = await runIntake(input(), { ghl });
    expect(r).toEqual({ outcome: "disabled", ghlSyncPending: false, dryRun: false });
    expect(await db.select().from(handoffCycles)).toHaveLength(0);
    for (const fn of Object.values(ghl)) expect(fn).not.toHaveBeenCalled();
  });

  it("two concurrent intakes → r1 + r2 of one cycle", async () => {
    const [a, b] = await Promise.all([run({ forwardId: "fwd-a" }), run({ forwardId: "fwd-b" })]);
    expect(a.handoffId).toBe(b.handoffId);
    expect([a.revision, b.revision].sort()).toEqual([1, 2]);
    expect([a.outcome, b.outcome].sort()).toEqual(["new_cycle", "revision"]);
    expect(await db.select().from(handoffCycles)).toHaveLength(1);
    expect(ghl.updateContactCustomFields).toHaveBeenCalledTimes(1);
  });
});

describe("runIntake preview send (EMC_FORWARD_PREVIEW)", () => {
  const SNAPSHOT_BODY = {
    externalId: null,
    contact: { firstName: null, lastName: null, email: null, phone: null },
    fields: {},
    notes: [],
  };

  function previewHarness() {
    const tasks: (() => Promise<void>)[] = [];
    const sendToEmc = vi.fn<PreviewDeps["sendToEmc"]>(async () => ({
      classification: "sent",
      status: 200,
      externalId: "EMC-1",
    }));
    const saveExternalId = vi.fn<PreviewDeps["saveExternalId"]>(async () => {});
    const buildSnapshot = vi.fn<PreviewDeps["buildSnapshot"]>(async (contactId, envelope) => ({
      body: { ...envelope, ghlContactId: contactId, ...SNAPSHOT_BODY },
      warnings: [],
    }));
    const deps = {
      db,
      ghl,
      now: () => NOW,
      after: (t: () => Promise<void>) => void tasks.push(t),
      preview: { sendToEmc, buildSnapshot, saveExternalId, newId: () => "preview-1", newExternalId: () => "ext-new", now: () => NOW },
    };
    const flush = () => Promise.all(tasks.splice(0).map((t) => t()));
    return { deps, tasks, flush, sendToEmc, buildSnapshot };
  }

  beforeEach(() => {
    vi.stubEnv("EMC_FORWARD_PREVIEW", "true");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dry run + preview → one send after the response, Idempotency-Key <handoffId>:r1, nothing written", async () => {
    vi.stubEnv("EMC_INTAKE_DRY_RUN", "true");
    const h = previewHarness();

    const r = await runIntake(input(), h.deps);
    expect(r).toMatchObject({ outcome: "new_cycle", revision: 1, dryRun: true, previewScheduled: true });
    // scheduled, not run yet: GHL gets its 200 first
    expect(h.tasks).toHaveLength(1);
    expect(h.sendToEmc).not.toHaveBeenCalled();

    await h.flush();
    expect(h.buildSnapshot).toHaveBeenCalledTimes(1);
    expect(h.buildSnapshot.mock.calls[0][0]).toBe("c1");
    expect(h.buildSnapshot.mock.calls[0][1]).toEqual({
      handoffId: "preview-1",
      revision: 1,
      type: "create",
      changedFields: [],
      sentAt: NOW.toISOString(),
    });
    expect(h.sendToEmc).toHaveBeenCalledTimes(1);
    expect(h.sendToEmc.mock.calls[0][1]).toBe("preview-1:r1");

    const logged = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([tag]) => tag === "EMC_FORWARD_PREVIEW");
    expect(JSON.parse(logged![1] as string)).toEqual({
      forwardId: "fwd-1",
      handoffId: "preview-1",
      revision: 1,
      type: "create",
      status: 200,
      classification: "sent",
      externalIdCreated: true,
      fieldCount: 5, // the stub body: 4 contact keys + notes
      filledCount: 0,
      notesCount: 0,
      warnings: [],
    });

    expect(await db.select().from(handoffCycles)).toHaveLength(0);
    expect(await events()).toHaveLength(0);
    for (const fn of Object.values(ghl)) expect(fn).not.toHaveBeenCalled();
  });

  it("dry run + preview with an active cycle → update, r2, fresh preview handoffId", async () => {
    await run(); // a real r1 (not dry run)
    vi.stubEnv("EMC_INTAKE_DRY_RUN", "true");
    const h = previewHarness();

    expect(await runIntake(input(), h.deps)).toMatchObject({ outcome: "revision", revision: 2, previewScheduled: true });
    await h.flush();
    expect(h.buildSnapshot.mock.calls[0][1]).toMatchObject({ handoffId: "preview-1", revision: 2, type: "update", changedFields: [] });
    expect(h.sendToEmc.mock.calls[0][1]).toBe("preview-1:r2");
  });

  it("debug flag also logs the outgoing body", async () => {
    vi.stubEnv("EMC_INTAKE_DRY_RUN", "true");
    vi.stubEnv("EMC_GHL_DEBUG_BODY", "true");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = previewHarness();
    await runIntake(input(), h.deps);
    await h.flush();
    expect(warn.mock.calls.map(([tag]) => tag)).toEqual(["EMC_FORWARD_DEBUG_BODY"]);
  });

  it("a failing preview never throws and logs no values", async () => {
    vi.stubEnv("EMC_INTAKE_DRY_RUN", "true");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = previewHarness();
    h.buildSnapshot.mockRejectedValueOnce(new GhlApiError("GET", "/contacts/c1", 404));
    await runIntake(input(), h.deps);
    await expect(h.flush()).resolves.toBeDefined();
    expect(h.sendToEmc).not.toHaveBeenCalled();
    const [tag, json] = err.mock.calls[0] as [string, string];
    expect(tag).toBe("EMC_FORWARD_PREVIEW_ERROR");
    expect(JSON.parse(json)).toMatchObject({ forwardId: "fwd-1", handoffId: "preview-1", error: "GhlApiError", status: 404 });
  });

  it("preview flag off → no send", async () => {
    vi.stubEnv("EMC_INTAKE_DRY_RUN", "true");
    vi.stubEnv("EMC_FORWARD_PREVIEW", "false");
    const h = previewHarness();
    const r = await runIntake(input(), h.deps);
    expect(r.previewScheduled).toBeUndefined();
    expect(h.tasks).toHaveLength(0);
  });

  it("not dry run → no preview send (live forwarding comes later)", async () => {
    const h = previewHarness();
    const r = await runIntake(input(), h.deps);
    expect(r).toMatchObject({ outcome: "new_cycle", dryRun: false });
    expect(r.previewScheduled).toBeUndefined();
    expect(h.tasks).toHaveLength(0);
  });

  it("dry run, missing identity → no preview send", async () => {
    vi.stubEnv("EMC_INTAKE_DRY_RUN", "true");
    const h = previewHarness();
    await runIntake(input({ hasIdentity: false }), h.deps);
    expect(h.tasks).toHaveLength(0);
  });
});
