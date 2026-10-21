import { randomUUID } from "crypto";
import { GhlApiError } from "../adapters/ghl";
import { EmcConfigError, sendToEmc } from "../adapters/emc";
import { flags } from "../config/flags";
import { buildSnapshot, countFilled, type Webhook2Type } from "./snapshot";
import { updateContactCustomFields } from "../adapters/ghl";
import { EMC_FIELD_EXTERNAL_ID } from "../config/intake";

async function saveExternalIdOnContact(contactId: string, externalId: string): Promise<void> {
  await updateContactCustomFields(contactId, { [EMC_FIELD_EXTERNAL_ID]: externalId });
}

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
  newExternalId: () => string;
  now: () => Date;
  // saves a newly created external id on the contact (emc_handoff_external_id)
  saveExternalId: (contactId: string, externalId: string) => Promise<void>;
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

    // the contact's permanent external id: created once, saved on the contact BEFORE sending, so EMC never
    // gets an id the contact doesn't keep. if saving fails, nothing is sent (the catch below logs it)
    let externalIdCreated = false;
    if (!body.externalId) {
      const externalId = (deps.newExternalId ?? randomUUID)();
      await (deps.saveExternalId ?? saveExternalIdOnContact)(input.ghlContactId, externalId);
      body.externalId = externalId;
      externalIdCreated = true;
    }

    if (flags.EMC_GHL_DEBUG_BODY) {
      // TESTING ONLY — contains contact PII. EMC_GHL_DEBUG_BODY must be off in normal operation
      console.warn("EMC_FORWARD_DEBUG_BODY", JSON.stringify({ forwardId, handoffId, body }));
    }

    const debug = flags.EMC_GHL_DEBUG_BODY;
    const result = await send(body, `${handoffId}:r${revision}`, { captureResponse: debug });

    // names and counts only — never values
    console.log("EMC_FORWARD_PREVIEW", JSON.stringify({
      forwardId,
      handoffId,
      revision,
      type: body.type,
      status: result.status,
      classification: result.classification,
      ...(result.reason ? { reason: result.reason } : {}),
      externalIdCreated,
      // EMC's response: size and type only (the text is in EMC_FORWARD_DEBUG_RESPONSE with the debug flag)
      responseBytes: result.responseBytes ?? 0,
      ...(result.responseContentType ? { responseContentType: result.responseContentType } : {}),
      ...(result.externalId ? { emcReturnedExternalId: true } : {}),
      fieldCount: Object.keys(body.contact).length + Object.keys(body.fields).length + 1,
      filledCount: countFilled(body),
      notesCount: body.notes.length,
      warnings,
    }));
    if (debug && result.responseText !== undefined) {
      // TESTING ONLY — EMC's response as received; may echo data, so behind the debug flag
      console.warn("EMC_FORWARD_DEBUG_RESPONSE", JSON.stringify({ forwardId, handoffId, status: result.status, body: result.responseText }));
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
