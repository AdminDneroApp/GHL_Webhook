import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { Database } from "@lib/emc/db/client";
import { inboundRequests } from "@lib/emc/db/schema";
import { claimIdempotencyKey, hashBody, isValidIdempotencyKey } from "@lib/emc/idempotency";
import { createTestDb } from "./helpers/pglite";

let db: Database;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await createTestDb());
});

afterAll(async () => {
  await client.close();
});

const REQ_A = "11111111-1111-4111-8111-111111111111";
const REQ_B = "22222222-2222-4222-8222-222222222222";
const RESPONSE = { status: 202, body: { received: true, status: "accepted" } };
let n = 0;
const newKey = () => `test-key-${++n}-${Date.now()}`;

async function row(key: string) {
  const [r] = await db.select().from(inboundRequests).where(eq(inboundRequests.idempotencyKey, key));
  return r;
}

async function age(key: string, seconds: number) {
  await db
    .update(inboundRequests)
    .set({ updatedAt: sql`now() - make_interval(secs => ${seconds})` })
    .where(eq(inboundRequests.idempotencyKey, key));
}

describe("idempotency key format", () => {
  it("accepts uuids and rejects short or odd keys", () => {
    expect(isValidIdempotencyKey(REQ_A)).toBe(true);
    expect(isValidIdempotencyKey("short")).toBe(false);
    expect(isValidIdempotencyKey("has spaces in it")).toBe(false);
  });
});

describe("claimIdempotencyKey (neon)", () => {
  it("first claim is new and stores a processing row", async () => {
    const key = newKey();
    const claim = await claimIdempotencyKey(key, hashBody("{}"), REQ_A, db);
    expect(claim.kind).toBe("new");
    const r = await row(key);
    expect(r).toMatchObject({ state: "processing", handoffId: REQ_A, bodyHash: hashBody("{}"), response: null });
  });

  it("same key + same body after completion replays the stored response and original id", async () => {
    const key = newKey();
    const first = await claimIdempotencyKey(key, hashBody("{}"), REQ_A, db);
    if (first.kind !== "new") throw new Error("expected new");
    await first.complete(RESPONSE);
    expect(await row(key)).toMatchObject({ state: "completed", response: RESPONSE });

    const again = await claimIdempotencyKey(key, hashBody("{}"), REQ_B, db);
    expect(again).toEqual({ kind: "replay", handoffId: REQ_A, response: RESPONSE });
  });

  it("same key + same body while still processing is in_progress", async () => {
    const key = newKey();
    await claimIdempotencyKey(key, hashBody("{}"), REQ_A, db);
    expect((await claimIdempotencyKey(key, hashBody("{}"), REQ_B, db)).kind).toBe("in_progress");
  });

  it("same key + different body is a conflict, while processing or completed", async () => {
    const key = newKey();
    const first = await claimIdempotencyKey(key, hashBody("{}"), REQ_A, db);
    expect((await claimIdempotencyKey(key, hashBody('{"a":1}'), REQ_B, db)).kind).toBe("conflict");
    if (first.kind !== "new") throw new Error("expected new");
    await first.complete(RESPONSE);
    expect((await claimIdempotencyKey(key, hashBody('{"a":1}'), REQ_B, db)).kind).toBe("conflict");
  });

  it("a processing row older than 60 s is reclaimed; the old attempt can no longer complete or release it", async () => {
    const key = newKey();
    const stale = await claimIdempotencyKey(key, hashBody("{}"), REQ_A, db);
    await age(key, 30);
    expect((await claimIdempotencyKey(key, hashBody("{}"), REQ_B, db)).kind).toBe("in_progress");

    await age(key, 61);
    const reclaimed = await claimIdempotencyKey(key, hashBody("{}"), REQ_B, db);
    expect(reclaimed.kind).toBe("new");
    expect(await row(key)).toMatchObject({ state: "processing", handoffId: REQ_B });

    if (stale.kind !== "new" || reclaimed.kind !== "new") throw new Error("expected new");
    await stale.release();
    await stale.complete({ status: 500, body: {} });
    expect(await row(key)).toMatchObject({ state: "processing", handoffId: REQ_B });

    await reclaimed.complete(RESPONSE);
    expect(await row(key)).toMatchObject({ state: "completed", handoffId: REQ_B, response: RESPONSE });
  });

  it("a stale row with a different body is still a conflict", async () => {
    const key = newKey();
    await claimIdempotencyKey(key, hashBody("{}"), REQ_A, db);
    await age(key, 120);
    expect((await claimIdempotencyKey(key, hashBody('{"a":1}'), REQ_B, db)).kind).toBe("conflict");
  });

  it("release frees the key so a retry is processed", async () => {
    const key = newKey();
    const first = await claimIdempotencyKey(key, hashBody("{}"), REQ_A, db);
    if (first.kind !== "new") throw new Error("expected new");
    await first.release();
    expect(await row(key)).toBeUndefined();
    expect((await claimIdempotencyKey(key, hashBody("{}"), REQ_B, db)).kind).toBe("new");
  });

  it("concurrent claims of one key: exactly one wins", async () => {
    const key = newKey();
    const results = await Promise.all(
      [REQ_A, REQ_B].map((id) => claimIdempotencyKey(key, hashBody("{}"), id, db)),
    );
    expect(results.map((r) => r.kind).sort()).toEqual(["in_progress", "new"]);
  });
});
