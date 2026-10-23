import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { ACTIVE_STATUSES, FINAL_STATUSES } from "../../domain/cycle";
import type { Executor, Tx } from "../client";
import { handoffCycles, handoffRevisions, type HandoffCycle, type HandoffRevision } from "../schema";

const ACTIVE = [...ACTIVE_STATUSES];
const FINAL = [...FINAL_STATUSES];

// the contact's active cycle, row-locked. call inside withContactLock.
export async function getActiveCycle(tx: Tx, ghlContactId: string): Promise<HandoffCycle | null> {
  const rows = await tx
    .select()
    .from(handoffCycles)
    .where(and(eq(handoffCycles.ghlContactId, ghlContactId), inArray(handoffCycles.status, ACTIVE)))
    .limit(1)
    .for("update");
  return rows[0] ?? null;
}

// the contact's most recent completed/failed cycle
export async function getLastClosedCycle(db: Executor, ghlContactId: string): Promise<HandoffCycle | null> {
  const rows = await db
    .select()
    .from(handoffCycles)
    .where(and(eq(handoffCycles.ghlContactId, ghlContactId), inArray(handoffCycles.status, FINAL)))
    .orderBy(sql`${handoffCycles.closedAt} desc nulls last`, desc(handoffCycles.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getCycle(db: Executor, handoffId: string): Promise<HandoffCycle | null> {
  const rows = await db.select().from(handoffCycles).where(eq(handoffCycles.id, handoffId)).limit(1);
  return rows[0] ?? null;
}

export interface CreateCycleInput {
  ghlContactId: string;
  locationId: string;
  previousHandoffId?: string;
}

// new cycle (status requested) with revision 1, type create
export async function createCycle(
  tx: Tx,
  input: CreateCycleInput,
): Promise<{ cycle: HandoffCycle; revision: HandoffRevision }> {
  const [cycle] = await tx
    .insert(handoffCycles)
    .values({
      ghlContactId: input.ghlContactId,
      locationId: input.locationId,
      previousHandoffId: input.previousHandoffId ?? null,
      status: "requested",
      latestRevision: 1,
    })
    .returning();
  const [revision] = await tx
    .insert(handoffRevisions)
    .values({ handoffId: cycle.id, revision: 1, type: "create" })
    .returning();
  return { cycle, revision };
}

export interface AddRevisionInput {
  changedFields?: string[] | null;
}

// next revision (type update) of a cycle. bumps latest_revision and supersedes older queued/pending revisions —
// each revision carries the full lead, so nothing is lost. status is not changed.
export async function addRevision(
  tx: Tx,
  handoffId: string,
  input: AddRevisionInput = {},
): Promise<{ cycle: HandoffCycle; revision: HandoffRevision; superseded: number[] }> {
  const [cycle] = await tx
    .update(handoffCycles)
    .set({ latestRevision: sql`${handoffCycles.latestRevision} + 1` })
    .where(eq(handoffCycles.id, handoffId))
    .returning();
  if (!cycle) throw new Error(`handoff cycle ${handoffId} not found`);

  const next = cycle.latestRevision;
  const [revision] = await tx
    .insert(handoffRevisions)
    .values({ handoffId, revision: next, type: "update", changedFields: input.changedFields ?? null })
    .returning();

  const superseded = await tx
    .update(handoffRevisions)
    .set({ sendState: "superseded", supersededBy: next })
    .where(
      and(
        eq(handoffRevisions.handoffId, handoffId),
        lt(handoffRevisions.revision, next),
        inArray(handoffRevisions.sendState, ["queued", "pending"]),
      ),
    )
    .returning({ revision: handoffRevisions.revision });

  return { cycle, revision, superseded: superseded.map((r) => r.revision).sort((a, b) => a - b) };
}

// flags a failed GHL side effect (tag removal / status mirror) for the cron to retry
export async function setGhlSyncPending(db: Executor, handoffId: string, pending: boolean): Promise<void> {
  await db.update(handoffCycles).set({ ghlSyncPending: pending }).where(eq(handoffCycles.id, handoffId));
}

export async function getRevisions(db: Executor, handoffId: string): Promise<HandoffRevision[]> {
  return db
    .select()
    .from(handoffRevisions)
    .where(eq(handoffRevisions.handoffId, handoffId))
    .orderBy(handoffRevisions.revision);
}

// step 2: a send attempt starts — revision pending, attempts + 1
export async function markRevisionSending(db: Executor, handoffId: string, revision: number): Promise<void> {
  await db
    .update(handoffRevisions)
    .set({ sendState: sql`case when ${handoffRevisions.sendState} = 'superseded' then 'superseded' else 'pending' end`, attempts: sql`${handoffRevisions.attempts} + 1` })
    .where(and(eq(handoffRevisions.handoffId, handoffId), eq(handoffRevisions.revision, revision)));
}

// step 2: the final result of a revision's send. a superseded revision that still reached EMC is recorded
// as sent (EMC has it); a superseded one that failed stays superseded
export async function setRevisionSendResult(
  db: Executor,
  handoffId: string,
  revision: number,
  result: { sendState: "sent" | "failed"; httpStatus: number },
): Promise<void> {
  const sendState =
    result.sendState === "sent"
      ? sql`'sent'`
      : sql`case when ${handoffRevisions.sendState} = 'superseded' then 'superseded' else 'failed' end`;
  await db
    .update(handoffRevisions)
    .set({ sendState, lastHttpStatus: result.httpStatus, nextAttemptAt: null })
    .where(and(eq(handoffRevisions.handoffId, handoffId), eq(handoffRevisions.revision, revision)));
}

// step 2: cycle status after a send. returns the updated row, or null when the cycle is no longer active
// (a closed cycle is never reopened by a late send result)
export async function updateActiveCycle(
  tx: Tx,
  handoffId: string,
  set: { status: "sent" | "failed" | "completed"; externalId?: string | null },
): Promise<HandoffCycle | null> {
  const [row] = await tx
    .update(handoffCycles)
    .set({
      status: set.status,
      ...(set.externalId ? { externalId: set.externalId } : {}),
      ...(set.status === "sent" ? {} : { closedAt: new Date() }),
    })
    .where(and(eq(handoffCycles.id, handoffId), inArray(handoffCycles.status, ACTIVE)))
    .returning();
  return row ?? null;
}
