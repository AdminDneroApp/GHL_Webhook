import { randomUUID } from "crypto";
import { GhlApiError } from "../adapters/ghl";
import { EmcConfigError, sendToEmc } from "../adapters/emc";
import { flags } from "../config/flags";
import { buildSnapshot, countFilled, type Webhook2Type } from "./snapshot";

// preview send (EMC_FORWARD_PREVIEW + intake dry run): the real webhook 2 body, built from GHL and POSTed
// to EMC so they can build against real examples. a fresh preview handoffId every time; nothing is
// written to the DB or GHL and nothing is retried. the live send with retries is step 2 (forward.ts).

export interface PreviewInput {
  ghlContactId: string;
  forwardId: string;
  revision: number;
  type: Webhook2Type;
  previousHandoffId?: string;
}

export interface PreviewDeps {
  buildSnapshot: typeof buildSnapshot;
  sendToEmc: typeof sendToEmc;
  newId: () => string;
  now: () => Date;
}

// never throws: it runs inside after(), where an error would only surface as an unhandled rejection
export async function sendPreview(input: PreviewInput, deps: Partial<PreviewDeps> = {}): Promise<void> {
  const build = deps.buildSnapshot ?? buildSnapshot;
  const send = deps.sendToEmc ?? sendToEmc;
  const handoffId = (deps.newId ?? randomUUID)();
  const now = deps.now ?? (() => new Date());
  const { forwardId, revision } = input;

  try {
    const { body, warnings } = await build(input.ghlContactId, {
      handoffId,
      revision,
      type: input.type,
      changedFields: [],
      ...(input.previousHandoffId ? { previousHandoffId: input.previousHandoffId } : {}),
      sentAt: now().toISOString(),
    });

    if (flags.EMC_GHL_DEBUG_BODY) {
      // TESTING ONLY — contains contact PII. EMC_GHL_DEBUG_BODY must be off in normal operation
      console.warn("EMC_FORWARD_DEBUG_BODY", JSON.stringify({ forwardId, handoffId, body }));
    }

    const debug = flags.EMC_GHL_DEBUG_BODY;
    const result = await send(body, `${handoffId}:r${revision}`, { captureErrorBody: debug });

    // names and counts only — never values
    console.log("EMC_FORWARD_PREVIEW", JSON.stringify({
      forwardId,
      handoffId,
      revision,
      type: body.type,
      status: result.status,
      classification: result.classification,
      ...(result.reason ? { reason: result.reason } : {}),
      externalIdPresent: !!result.externalId,
      fieldCount: Object.keys(body.contact).length + Object.keys(body.fields).length + 1,
      filledCount: countFilled(body),
      notesCount: body.notes.length,
      warnings,
      // header names, target and token fingerprint only — never the token
      request: result.request,
    }));

    if (debug && result.errorBody !== undefined) {
      // TESTING ONLY — EMC's error response (e.g. n8n's auth message); could echo data, so behind the debug flag
      console.warn("EMC_FORWARD_DEBUG_RESPONSE", JSON.stringify({ forwardId, handoffId, status: result.status, body: result.errorBody }));
    }
  } catch (err) {
    // GhlApiError / EmcConfigError messages carry method, path, status or the env var name, never a body
    const safe = err instanceof GhlApiError || err instanceof EmcConfigError;
    console.error("EMC_FORWARD_PREVIEW_ERROR", JSON.stringify({
      forwardId,
      handoffId,
      revision,
      error: err instanceof Error ? err.name : "unknown",
      ...(err instanceof GhlApiError ? { status: err.status } : {}),
      ...(safe ? { message: err.message } : {}),
    }));
  }
}
