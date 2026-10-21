import * as ghlAdapter from "../adapters/ghl";
import { GhlApiError } from "../adapters/ghl";
import { recordEvent } from "../audit";
import { flags } from "../config/flags";
import {
  EMC_FIELD_STATUS,
  EMC_FIELD_TIME,
  EMC_HANDOFF_TAG,
  REJECTED_NOTE,
} from "../config/intake";
import { getDb, type Database, type Tx } from "../db/client";
import {
  addRevision,
  createCycle,
  getActiveCycle,
  getLastClosedCycle,
  setGhlSyncPending,
  withContactLock,
} from "../db/repositories";
import { decideTagEvent, type TagDecision } from "../domain/cycle";
import { sendPreview, type PreviewDeps } from "./forward-preview";

// step 1: tag "emc-handoff-requested" added → record a cycle or revision → remove the tag → mirror status.
// nothing goes to EMC here (step 2), except the dry-run preview send (EMC_FORWARD_PREVIEW). the DB is the source of truth; GHL writes happen after commit and
// are flagged ghl_sync_pending when they fail, so a GHL outage never loses an intake.

export interface IntakeInput {
  ghlContactId: string;
  locationId: string;
  forwardId: string;
  hasIdentity: boolean; // phone or email present
  workflowId?: string;
}

export type IntakeGhl = Pick<
  typeof ghlAdapter,
  "removeContactTags" | "updateContactCustomFields" | "createContactNote" | "formatGhlDateTime"
>;

export interface IntakeDeps {
  db: Database;
  ghl: IntakeGhl;
  now: () => Date;
  // runs a task after the response is sent (next/server after() in the route)
  after: (task: () => Promise<void>) => void;
  preview: Partial<PreviewDeps>;
}

export type IntakeOutcome = "new_cycle" | "revision" | "rejected" | "disabled";

export interface IntakeResult {
  outcome: IntakeOutcome;
  handoffId?: string;
  revision?: number;
  previousHandoffId?: string;
  ghlSyncPending: boolean;
  dryRun: boolean;
  previewScheduled?: true; // dry run + EMC_FORWARD_PREVIEW: a preview send runs after the response
}

// resolved only when a preview is scheduled, so tests and non-request callers never touch next/server
async function nextAfter(task: () => Promise<void>): Promise<void> {
  const { after } = await import("next/server");
  after(task);
}

// what failed on the GHL side — op name and HTTP status only, never a body
interface GhlFailure {
  op: "remove_tag" | "set_status" | "create_note";
  status: number | null;
  error: string;
}

async function attempt(op: GhlFailure["op"], failures: GhlFailure[], fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    failures.push({
      op,
      status: err instanceof GhlApiError ? err.status : null,
      error: err instanceof Error ? err.name : "unknown",
    });
    return false;
  }
}

async function decide(tx: Tx, ghlContactId: string): Promise<TagDecision> {
  const activeCycle = await getActiveCycle(tx, ghlContactId);
  const lastClosedCycle = activeCycle ? null : await getLastClosedCycle(tx, ghlContactId);
  return decideTagEvent({ activeCycle, lastClosedCycle });
}

// deps are resolved lazily, so a disabled intake never needs DATABASE_URL
export async function runIntake(input: IntakeInput, deps: Partial<IntakeDeps> = {}): Promise<IntakeResult> {
  if (!flags.EMC_INTAKE_ENABLED) return { outcome: "disabled", ghlSyncPending: false, dryRun: false };

  const dryRun = flags.EMC_INTAKE_DRY_RUN;
  const db = deps.db ?? getDb();
  const ghl = deps.ghl ?? ghlAdapter;
  const now = deps.now ?? (() => new Date());
  const { ghlContactId, forwardId, workflowId } = input;
  const meta = { forwardId, ...(workflowId ? { workflowId } : {}) };

  // --- missing identity: no cycle, but the tag still goes (or it gets stuck) and the agent gets a note
  if (!input.hasIdentity) {
    if (dryRun) return { outcome: "rejected", ghlSyncPending: false, dryRun: true };

    const failures: GhlFailure[] = [];
    const tagRemoved = await attempt("remove_tag", failures, () =>
      ghl.removeContactTags(ghlContactId, [EMC_HANDOFF_TAG]),
    );
    const noted = await attempt("create_note", failures, () => ghl.createContactNote(ghlContactId, REJECTED_NOTE));

    await db.transaction(async (tx) => {
      await recordEvent(tx, {
        ghlContactId,
        event: "rejected",
        direction: "agent_to_dnero",
        meta: { ...meta, reason: "missing_identity" },
      });
      if (tagRemoved) await recordEvent(tx, { ghlContactId, event: "tag_removed", direction: "dnero_to_ghl", meta });
      if (noted) await recordEvent(tx, { ghlContactId, event: "note_created", direction: "dnero_to_ghl", meta });
      if (failures.length) {
        await recordEvent(tx, {
          ghlContactId,
          event: "ghl_sync_failed",
          direction: "dnero_to_ghl",
          httpStatus: failures[0].status,
          meta: { ...meta, failures },
        });
      }
    });
    // no cycle to flag for the cron: a stuck tag here is left to the stuck-tag safety net
    return { outcome: "rejected", ghlSyncPending: false, dryRun: false };
  }

  // --- dry run: decide only (reads under the lock), no writes, no GHL
  if (dryRun) {
    const decision = await withContactLock(ghlContactId, (tx) => decide(tx, ghlContactId), db);
    const result: IntakeResult =
      decision.kind === "new_cycle"
        ? { outcome: "new_cycle", revision: 1, previousHandoffId: decision.previousHandoffId, ghlSyncPending: false, dryRun: true }
        : { outcome: "revision", handoffId: decision.handoffId, revision: decision.revision, ghlSyncPending: false, dryRun: true };

    // preview send: after the response, so GHL gets its 200 right away. reads GHL, writes nothing
    if (flags.EMC_FORWARD_PREVIEW) {
      const task = () =>
        sendPreview(
          {
            ghlContactId,
            forwardId,
            revision: result.revision!,
            type: decision.kind === "new_cycle" ? "create" : "update",
            ...(decision.kind === "new_cycle" && decision.previousHandoffId
              ? { previousHandoffId: decision.previousHandoffId }
              : {}),
          },
          deps.preview,
        );
      if (deps.after) deps.after(task);
      else await nextAfter(task);
      result.previewScheduled = true;
    }
    return result;
  }

  // --- record the cycle / revision. short transaction: no GHL calls while the lock is held
  const recorded = await withContactLock(
    ghlContactId,
    async (tx) => {
      const decision = await decide(tx, ghlContactId);

      if (decision.kind === "new_cycle") {
        const { cycle } = await createCycle(tx, {
          ghlContactId,
          locationId: input.locationId,
          previousHandoffId: decision.previousHandoffId,
        });
        await recordEvent(tx, {
          handoffId: cycle.id,
          revision: 1,
          ghlContactId,
          event: "requested",
          direction: "agent_to_dnero",
          statusAfter: "requested",
          meta: { ...meta, ...(decision.previousHandoffId ? { previousHandoffId: decision.previousHandoffId } : {}) },
        });
        return { outcome: "new_cycle" as const, handoffId: cycle.id, revision: 1, previousHandoffId: decision.previousHandoffId };
      }

      const { cycle, revision, superseded } = await addRevision(tx, decision.handoffId);
      await recordEvent(tx, {
        handoffId: cycle.id,
        revision: revision.revision,
        ghlContactId,
        event: "revision_created",
        direction: "agent_to_dnero",
        statusBefore: cycle.status,
        statusAfter: cycle.status,
        meta,
      });
      for (const old of superseded) {
        await recordEvent(tx, {
          handoffId: cycle.id,
          revision: old,
          ghlContactId,
          event: "superseded",
          meta: { ...meta, supersededBy: revision.revision },
        });
      }
      return { outcome: "revision" as const, handoffId: cycle.id, revision: revision.revision, previousHandoffId: undefined };
    },
    db,
  );

  // --- GHL side effects, after commit. a revision doesn't change status, so it writes no fields.
  // the external id is a permanent per-contact id (created at send time), so it is never cleared here
  const failures: GhlFailure[] = [];
  const tagRemoved = await attempt("remove_tag", failures, () =>
    ghl.removeContactTags(ghlContactId, [EMC_HANDOFF_TAG]),
  );
  if (recorded.outcome === "new_cycle") {
    await attempt("set_status", failures, () =>
      ghl.updateContactCustomFields(ghlContactId, {
        [EMC_FIELD_STATUS]: "requested",
        [EMC_FIELD_TIME]: ghl.formatGhlDateTime(now()),
      }),
    );
  }

  const ghlSyncPending = failures.length > 0;
  // the cycle/revision is already committed and the tag may be gone: a failure here must not turn into
  // a 500, or GHL retries and records a spurious extra revision. the audit rows are lost in that case;
  // a ghl_sync_pending flag that didn't stick is left to the stuck-tag / status safety net.
  try {
    await db.transaction(async (tx) => {
      const base = { handoffId: recorded.handoffId, revision: recorded.revision, ghlContactId, direction: "dnero_to_ghl" as const };
      if (tagRemoved) await recordEvent(tx, { ...base, event: "tag_removed", meta });
      if (ghlSyncPending) {
        await setGhlSyncPending(tx, recorded.handoffId, true);
        await recordEvent(tx, { ...base, event: "ghl_sync_failed", httpStatus: failures[0].status, meta: { ...meta, failures } });
      }
    });
  } catch (err) {
    // names only — never values
    console.error("EMC_INTAKE_POST_COMMIT_ERROR", JSON.stringify({
      forwardId,
      handoffId: recorded.handoffId,
      revision: recorded.revision,
      error: err instanceof Error ? err.name : "unknown",
      tagRemoved,
      ghlFailures: failures.map((f) => f.op),
    }));
  }

  return {
    outcome: recorded.outcome,
    handoffId: recorded.handoffId,
    revision: recorded.revision,
    ...(recorded.previousHandoffId ? { previousHandoffId: recorded.previousHandoffId } : {}),
    ghlSyncPending,
    dryRun: false,
  };
}
