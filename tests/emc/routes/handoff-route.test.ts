import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { Database } from "@lib/emc/db/client";
import { handoffEvents, inboundRequests } from "@lib/emc/db/schema";
import { hashBody } from "@lib/emc/idempotency";
import { createTestDb } from "../helpers/pglite";

// lib/env.ts reads these at import time, so they're set before the route module loads
const h = vi.hoisted(() => {
  process.env.EMC_API_KEYS = "test-api-key";
  process.env.EMC_SIGNING_SECRET = "test-signing-secret";
  process.env.EMC_ALLOWED_IPS = "";
  // failOnCall: getDb() throws on that call number (1 = idempotency claim, 2 = handoff processing)
  return { db: undefined as unknown, calls: 0, failOnCall: 0 };
});

vi.mock("@lib/emc/db/client", () => ({
  getDb: () => {
    if (++h.calls === h.failOnCall) throw new Error("Missing required env var: DATABASE_URL");
    return h.db;
  },
}));

const { POST } = await import("../../../app/api/emc/handoff/route");

let db: Database;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  h.db = db;
});

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  h.calls = 0;
  h.failOnCall = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const BODY = {
  handoffId: "3f6c2b1e-8a4d-4c2b-9e1f-0a1b2c3d4e5f",
  revision: 1,
  externalId: "EMC-1",
  pipelineStage: "Collecting Docs",
};

let n = 0;
function request(opts: { body?: unknown; raw?: string; key?: string; secret?: string; timestamp?: number; apiKey?: string } = {}) {
  const raw = opts.raw ?? JSON.stringify(opts.body ?? BODY);
  const key = opts.key ?? `route-key-${++n}-${Date.now()}`;
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", opts.secret ?? "test-signing-secret").update(`${ts}.${key}.${raw}`).digest("hex");
  return new Request("https://example.test/api/emc/handoff", {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.apiKey ?? "test-api-key"}`,
      "content-type": "application/json",
      "idempotency-key": key,
      "x-emc-timestamp": ts,
      "x-emc-signature": `sha256=${sig}`,
    },
    body: raw,
  });
}

describe("POST /api/emc/handoff", () => {
  it("accepts a signed handoff with 202 and records it", async () => {
    const res = await POST(request({ key: "route-accept-0001" }));
    const json = await res.json();
    expect(res.status).toBe(202);
    expect(json).toEqual({ received: true, status: "accepted", handoffId: expect.any(String) });
    expect(res.headers.get("x-handoff-id")).toBe(json.handoffId);

    const events = await db.select().from(handoffEvents).where(eq(handoffEvents.handoffId, BODY.handoffId));
    expect(events.some((e) => (e.meta as Record<string, unknown>)?.idempotencyKey === "route-accept-0001")).toBe(true);
  });

  it("rejects a bad signature, a wrong secret and a stale timestamp with 401", async () => {
    const tampered = request();
    const bad = new Request(tampered, { body: JSON.stringify({ ...BODY, revision: 9 }) });
    expect((await POST(bad)).status).toBe(401);
    expect((await POST(request({ secret: "wrong" }))).status).toBe(401);
    expect((await POST(request({ timestamp: Math.floor(Date.now() / 1000) - 600 }))).status).toBe(401);
    expect((await POST(request({ apiKey: "wrong" }))).status).toBe(401);
  });

  it("returns 400 with paths but no values for an invalid body", async () => {
    const res = await POST(request({ body: { handoffId: "not-a-uuid", revision: 0, externalId: "SECRET-VALUE" } }));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.issues.map((i: { path: string }) => i.path)).toEqual(["handoffId", "revision"]);
    expect(JSON.stringify(json)).not.toContain("not-a-uuid");
  });

  it("replays the same key + body with Idempotent-Replayed, and 422s a different body", async () => {
    const key = "route-replay-0001";
    const first = await POST(request({ key }));
    const firstJson = await first.json();
    const again = await POST(request({ key }));
    expect(again.status).toBe(202);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await again.json()).toEqual(firstJson);

    const conflict = await POST(request({ key, body: { ...BODY, revision: 2 } }));
    expect(conflict.status).toBe(422);
  });

  it("returns 409 while the same key is still processing", async () => {
    const key = "route-inflight-0001";
    await db.insert(inboundRequests).values({
      idempotencyKey: key,
      bodyHash: hashBody(JSON.stringify(BODY)),
      handoffId: "11111111-1111-4111-8111-111111111111",
    });
    expect((await POST(request({ key }))).status).toBe(409);
  });

  it("returns 503 when the database is unreachable", async () => {
    h.failOnCall = 1;
    const res = await POST(request());
    expect(res.status).toBe(503);
    expect(console.error).toHaveBeenCalledWith("EMC_IDEMPOTENCY_STORE_ERROR", expect.any(String));
  });

  it("releases the key when processing fails, so EMC's retry is processed", async () => {
    const key = "route-release-0001";
    h.failOnCall = 2;
    expect((await POST(request({ key }))).status).toBe(500);
    expect(await db.select().from(inboundRequests).where(eq(inboundRequests.idempotencyKey, key))).toEqual([]);

    const retry = await POST(request({ key }));
    expect(retry.status).toBe(202);
    expect(retry.headers.get("Idempotent-Replayed")).toBeNull();
  });
});
