import { recordEvent } from "./audit";
import { flags } from "./config/flags";
import { getDb, type Database } from "./db/client";
import { getCycle } from "./db/repositories/cycles";
import type { EmcHandoff } from "./schema";

export interface HandoffContext {
  handoffId: string; // request id, returned to EMC on every response
  receivedAt: string;
  keyIndex: number;
  idempotencyKey: string;
}

export interface HandoffResult {
  status: "accepted";
}

// step 3 only: record EMC's reply in the audit log. nothing is applied to GHL and the cycle status is
// not changed — step 4 (apply + `completed`) plugs in here once its overwrite/merge rules are decided.
export async function processEmcHandoff(
  data: EmcHandoff,
  ctx: HandoffContext,
  db: Database = getDb(),
): Promise<HandoffResult> {
  if (flags.EMC_GHL_DEBUG_BODY) {
    // TESTING ONLY — may contain contact PII. EMC_GHL_DEBUG_BODY must be off in normal operation
    console.warn("EMC_HANDOFF_DEBUG_BODY", JSON.stringify({ handoffId: ctx.handoffId, body: data }));
  }

  // dry-run previews create no cycles, so an unknown handoffId is expected while EMC tests
  const cycle = await getCycle(db, data.handoffId);

  // key names and counts only — values stay out of the log until payload encryption lands
  const meta: Record<string, unknown> = {
    requestId: ctx.handoffId,
    idempotencyKey: ctx.idempotencyKey,
    keys: Object.keys(data),
    fieldKeys: data.fields ? Object.keys(data.fields) : [],
    notesCount: data.notes?.length ?? 0,
    pipelineStagePresent: !!data.pipelineStage,
  };
  if (!cycle) meta.unknownCycle = true;

  await recordEvent(db, {
    handoffId: data.handoffId,
    revision: data.revision,
    ghlContactId: cycle?.ghlContactId ?? null,
    event: "emc_returned",
    direction: "emc_to_dnero",
    statusBefore: cycle?.status ?? null,
    statusAfter: cycle?.status ?? null,
    externalId: data.externalId,
    actor: "emc",
    meta,
  });

  console.log("EMC_HANDOFF_ACCEPTED", JSON.stringify({
    ...ctx,
    cycleHandoffId: data.handoffId,
    revision: data.revision,
    unknownCycle: !cycle,
    keys: meta.keys,
    fieldKeys: meta.fieldKeys,
    notesCount: meta.notesCount,
    pipelineStagePresent: meta.pipelineStagePresent,
  }));
  return { status: "accepted" };
}
