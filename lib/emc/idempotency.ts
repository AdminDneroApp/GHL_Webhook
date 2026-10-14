import { createHash } from "crypto";
import { kvDel, kvGet, kvSet, kvSetIfAbsent } from "@lib/kv";

// required format for the Idempotency-Key header — a UUID is the recommended value
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

// a crashed attempt only blocks retries this long; finished results are kept for a day
const LOCK_TTL_S = 60;
const RECORD_TTL_S = 24 * 60 * 60;

export interface StoredResponse {
  status: number;
  body: Record<string, unknown>;
}

interface IdempotencyRecord {
  state: "processing" | "completed";
  bodyHash: string;
  handoffId: string;
  response?: StoredResponse;
}

export type IdempotencyClaim =
  // first time this key is seen — caller processes, then calls complete() or release()
  | { kind: "new"; complete(response: StoredResponse): Promise<void>; release(): Promise<void> }
  // same key + same body already processed — return the original result, don't process again
  | { kind: "replay"; handoffId: string; response: StoredResponse }
  // same key + same body still being processed by another request
  | { kind: "in_progress" }
  // same key reused with a different body
  | { kind: "conflict" };

export function isValidIdempotencyKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

// hash of the exact raw bytes — a retry must resend the identical body
export function hashBody(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function claimIdempotencyKey(
  key: string,
  bodyHash: string,
  handoffId: string,
): Promise<IdempotencyClaim> {
  const kvKey = `emc:idem:${key}`;
  const record: IdempotencyRecord = { state: "processing", bodyHash, handoffId };

  // atomic: only one concurrent request can win the lock
  if (await kvSetIfAbsent(kvKey, JSON.stringify(record), LOCK_TTL_S)) {
    return {
      kind: "new",
      complete: (response) =>
        kvSet(kvKey, JSON.stringify({ ...record, state: "completed", response }), RECORD_TTL_S),
      release: () => kvDel(kvKey),
    };
  }

  const existingRaw = await kvGet(kvKey);
  // expired between SET NX and GET — tell the caller to retry rather than racing
  if (!existingRaw) return { kind: "in_progress" };

  const existing = JSON.parse(existingRaw) as IdempotencyRecord;
  if (existing.bodyHash !== bodyHash) return { kind: "conflict" };
  if (existing.state === "completed" && existing.response) {
    return { kind: "replay", handoffId: existing.handoffId, response: existing.response };
  }
  return { kind: "in_progress" };
}
