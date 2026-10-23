import { randomUUID } from "crypto";
import * as ghlAdapter from "../adapters/ghl";
import { GhlApiError } from "../adapters/ghl";
import { EmcConfigError, sendToEmc, type EmcSendResult } from "../adapters/emc";
import { recordEvent } from "../audit";
import { flags } from "../config/flags";
import { EMC_FIELD_EXTERNAL_ID, EMC_FIELD_STATUS, EMC_FIELD_TIME } from "../config/intake";
import { getDb, type Database } from "../db/client";
import {
  getActiveCycle,
  markRevisionSending,
  setGhlSyncPending,
  setRevisionSendResult,
  updateActiveCycle,
  withContactLock,
} from "../db/repositories";
import type { HandoffStatus } from "../domain/cycle";
import { buildSnapshot, countFilled, type Webhook2Type } from "./snapshot";

// step 2: the live send. runs after the intake response (next/server after()), POSTs the revision to EMC
// (webhook 2) and records the result. a 2xx sets the cycle to "sent" and mirrors status + emc_handoff_time
// to GHL. retryable failures (timeout, network, 429, 5xx, GHL read errors) are retried inline a few times;
// there is no cron yet, so once those run out the cycle fails and the agent re-tags to start a new one.
// rule: bodies hold contact PII — only names, counts and statuses are logged.

export interface ForwardInput {
  handoffId: string;
  revision: number;
  type: Webhook2Type;
  ghlContactId: string;
  forwardId: string;
  previousHandoffId?: string;
}

export type ForwardGhl = Pick<typeof ghlAdapter, "updateContactCustomFields" | "formatGhlDateTime">;

export interface ForwardDeps {
  db: Database;
  ghl: ForwardGhl;
  buildSnapshot: typeof buildSnapshot;
  sendToEmc: typeof sendToEmc;
  newExternalId: () => string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  // waits before attempts 2, 3… — its length + 1 is the attempt count
  retryDelaysMs: number[];
}

const DEFAULT_RETRY_DELAYS_MS = [2_000, 5_000];

export type ForwardOutcome = "sent" | "failed" | "closed" | "skipped";

// one attempt's result: EMC's answer, or an error before / instead of a response
type Attempt =
  | { kind: "response"; result: EmcSendResult; externalId: string | null; externalIdCreated: boolean; filledCount: number; warnings: string[] }
  | { kind: "error"; retryable: boolean; error: string; status: number | null };

async function attemptSend(input: ForwardInput, deps: ForwardDeps): Promise<Attempt> {
  try {
    const { body, warnings } = await deps.buildSnapshot(input.ghlContactId, {
      handoffId: input.handoffId,
      revision: input.revision,
      type: input.type,
      changedFields: [],
      ...(input.previousHandoffId ? { previousHandoffId: input.previousHandoffId } : {}),
      sentAt: deps.now().toISOString(),
    });

    // the contact's permanent external id: saved on the contact BEFORE sending, so EMC never gets an id
    // the contact doesn't keep
    let externalIdCreated = false;
    if (!body.externalId) {
      const externalId = deps.newExternalId();
      await deps.ghl.updateContactCustomFields(input.ghlContactId, { [EMC_FIELD_EXTERNAL_ID]: externalId });
      body.externalId = externalId;
      externalIdCreated = true;
    }

    if (flags.EMC_GHL_DEBUG_BODY) {
      // TESTING ONLY — contains contact PII. EMC_GHL_DEBUG_BODY must be off in normal operation
      console.warn("EMC_FORWARD_DEBUG_BODY", JSON.stringify({ forwardId: input.forwardId, handoffId: input.handoffId, body }));
    }

    const result = await deps.sendToEmc(body, `${input.handoffId}:r${input.revision}`);
    return { kind: "response", result, externalId: body.externalId, externalIdCreated, filledCount: countFilled(body), warnings };
  } catch (err) {
    // GHL read/write errors are retryable; a missing EMC config (or anything unexpected) is not
    if (err instanceof GhlApiError) return { kind: "error", retryable: true, error: err.name, status: err.status };
    return { kind: "error", retryable: false, error: err instanceof Error ? err.name : "unknown", status: null };
  }
}

const isRetryable = (a: Attempt) => (a.kind === "error" ? a.retryable : a.result.classification === "retry");

// never throws: it runs inside after(), where an error would only surface as an unhandled rejection
export async function forwardRevision(input: ForwardInput, deps: Partial<ForwardDeps> = {}): Promise<ForwardOutcome> {
  const { handoffId, revision, ghlContactId, forwardId } = input;
  try {
    const d: ForwardDeps = {
      db: deps.db ?? getDb(),
      ghl: deps.ghl ?? ghlAdapter,
      buildSnapshot: deps.buildSnapshot ?? buildSnapshot,
      sendToEmc: deps.sendToEmc ?? sendToEmc,
      newExternalId: deps.newExternalId ?? randomUUID,
      now: deps.now ?? (() => new Date()),
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      retryDelaysMs: deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
    };
    const base = { handoffId, revision, ghlContactId };
    const meta = { forwardId };

    // --- send, with inline retries
    let attempt: Attempt | undefined;
    for (let i = 0; i <= d.retryDelaysMs.length; i++) {
      if (i > 0) await d.sleep(d.retryDelaysMs[i - 1]);
      await markRevisionSending(d.db, handoffId, revision);
      attempt = await attemptSend(input, d);
      if (!isRetryable(attempt) || i === d.retryDelaysMs.length) break;
      await recordEvent(d.db, {
        ...base,
        event: "retry_scheduled",
        direction: "dnero_to_emc",
        httpStatus: attempt.kind === "response" ? attempt.result.status : attempt.status,
        meta: { ...meta, attempt: i + 1, ...(attempt.kind === "error" ? { error: attempt.error } : { reason: attempt.result.reason }) },
      });
    }
    const a = attempt!;
    const httpStatus = a.kind === "response" ? a.result.status : (a.status ?? 0);
    const outcome: Exclude<ForwardOutcome, "skipped"> =
      a.kind === "response" && a.result.classification === "sent"
        ? "sent"
        : a.kind === "response" && a.result.classification === "closed"
          ? "closed"
          : "failed";

    // --- record the result under the contact lock (an intake may be adding a revision right now)
    const mirror = await withContactLock(
      ghlContactId,
      async (tx) => {
        await setRevisionSendResult(tx, handoffId, revision, { sendState: outcome === "sent" ? "sent" : "failed", httpStatus });

        const cycle = await getActiveCycle(tx, ghlContactId);
        const active = cycle?.id === handoffId ? cycle : null;
        // a failure of an older revision doesn't close the cycle: a newer one is on its way
        const isLatest = !!active && active.latestRevision === revision;
        const externalId = a.kind === "response" ? a.externalId : null;

        let statusAfter: HandoffStatus | null = null;
        if (active && outcome === "sent") statusAfter = "sent";
        else if (isLatest && outcome === "closed") statusAfter = "completed"; // 409: EMC closed the lead
        else if (isLatest) statusAfter = "failed";

        if (statusAfter) await updateActiveCycle(tx, handoffId, { status: statusAfter as "sent" | "failed" | "completed", externalId });

        await recordEvent(tx, {
          ...base,
          event: outcome === "sent" ? "sent" : outcome === "closed" ? "conflict" : "failed",
          direction: "dnero_to_emc",
          statusBefore: active?.status ?? null,
          statusAfter: statusAfter ?? active?.status ?? null,
          httpStatus,
          externalId,
          meta: {
            ...meta,
            ...(a.kind === "response"
              ? {
                  classification: a.result.classification,
                  ...(a.result.reason ? { reason: a.result.reason } : {}),
                  ...(a.result.externalId ? { emcReturnedExternalId: true } : {}),
                  externalIdCreated: a.externalIdCreated,
                  filledCount: a.filledCount,
                  warnings: a.warnings,
                }
              : { error: a.error }),
          },
        });
        return statusAfter;
      },
      d.db,
    );

    // --- mirror status + time to GHL, after commit. every successful send refreshes emc_handoff_time
    if (mirror) {
      try {
        await d.ghl.updateContactCustomFields(ghlContactId, {
          [EMC_FIELD_STATUS]: mirror,
          [EMC_FIELD_TIME]: d.ghl.formatGhlDateTime(d.now()),
        });
      } catch (err) {
        const status = err instanceof GhlApiError ? err.status : null;
        await setGhlSyncPending(d.db, handoffId, true);
        await recordEvent(d.db, {
          ...base,
          event: "ghl_sync_failed",
          direction: "dnero_to_ghl",
          httpStatus: status,
          meta: { ...meta, failures: [{ op: "set_status", status, error: err instanceof Error ? err.name : "unknown" }] },
        });
      }
    }

    // names and counts only — never values
    console.log("EMC_FORWARD", JSON.stringify({ forwardId, handoffId, revision, outcome, httpStatus, statusAfter: mirror }));
    return outcome;
  } catch (err) {
    // GhlApiError / EmcConfigError messages carry method, path, status or the env var name, never a body
    const safe = err instanceof GhlApiError || err instanceof EmcConfigError;
    console.error("EMC_FORWARD_ERROR", JSON.stringify({
      forwardId,
      handoffId,
      revision,
      error: err instanceof Error ? err.name : "unknown",
      ...(safe ? { message: err.message } : {}),
    }));
    return "skipped";
  }
}
