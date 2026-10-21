import { createHash } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "./db/client";
import { inboundRequests } from "./db/schema";

// required format for the Idempotency-Key header — a UUID is the recommended value
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

// a crashed attempt only blocks retries this long; after that the same body may reclaim the key
const STALE_PROCESSING_S = 60;

export interface StoredResponse {
  status: number;
  body: Record<string, unknown>;
}

export type IdempotencyClaim =
  // first time this key is seen (or a stale attempt was reclaimed) — caller processes, then calls complete() or release()
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

// complete/release only touch the row while this attempt still owns it (a stale reclaim changes handoff_id)
function ownedClaim(db: Database, key: string, handoffId: string): IdempotencyClaim {
  const owned = and(
    eq(inboundRequests.idempotencyKey, key),
    eq(inboundRequests.handoffId, handoffId),
    eq(inboundRequests.state, "processing"),
  );
  return {
    kind: "new",
    complete: async (response) => {
      await db
        .update(inboundRequests)
        .set({ state: "completed", response, updatedAt: sql`now()` })
        .where(owned);
    },
    release: async () => {
      await db.delete(inboundRequests).where(owned);
    },
  };
}

export async function claimIdempotencyKey(
  key: string,
  bodyHash: string,
  handoffId: string,
  db: Database = getDb(),
): Promise<IdempotencyClaim> {
  // atomic: the primary key lets only one concurrent request insert
  const inserted = await db
    .insert(inboundRequests)
    .values({ idempotencyKey: key, bodyHash, handoffId, state: "processing" })
    .onConflictDoNothing({ target: inboundRequests.idempotencyKey })
    .returning({ key: inboundRequests.idempotencyKey });
  if (inserted.length) return ownedClaim(db, key, handoffId);

  const [existing] = await db
    .select()
    .from(inboundRequests)
    .where(eq(inboundRequests.idempotencyKey, key))
    .limit(1);
  // released between INSERT and SELECT — tell the caller to retry rather than racing
  if (!existing) return { kind: "in_progress" };

  if (existing.bodyHash !== bodyHash) return { kind: "conflict" };
  if (existing.state === "completed" && existing.response) {
    return { kind: "replay", handoffId: existing.handoffId ?? handoffId, response: existing.response };
  }

  // a processing row older than the lock window is a crashed attempt: take it over atomically
  const reclaimed = await db
    .update(inboundRequests)
    .set({ handoffId, updatedAt: sql`now()` })
    .where(
      and(
        eq(inboundRequests.idempotencyKey, key),
        eq(inboundRequests.state, "processing"),
        sql`${inboundRequests.updatedAt} < now() - make_interval(secs => ${STALE_PROCESSING_S})`,
      ),
    )
    .returning({ key: inboundRequests.idempotencyKey });
  if (reclaimed.length) return ownedClaim(db, key, handoffId);

  return { kind: "in_progress" };
}
