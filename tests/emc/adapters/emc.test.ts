import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmcConfigError, sendToEmc } from "@lib/emc/adapters/emc";

const URL_ = "https://emc.test/webhook/abc";
const BODY = { handoffId: "h1", contact: { email: "jane.doe@example.com", phone: "+15555550123" } };
const KEY = "h1:r1";

let fetchMock: ReturnType<typeof vi.fn>;

const res = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers });

beforeEach(() => {
  vi.stubEnv("EMC_WEBHOOK_URL", URL_);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sendToEmc", () => {
  it("POSTs JSON with Idempotency-Key, a timeout and redirect: manual", async () => {
    fetchMock.mockResolvedValueOnce(res(200, { externalId: "EMC-1" }));
    await sendToEmc(BODY, KEY);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(URL_);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json", "Idempotency-Key": KEY });
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual(BODY);
  });

  it("sends Authorization: Bearer from EMC_BEARER, with or without the prefix", async () => {
    for (const value of ["tok-123", "Bearer tok-123", "  tok-123  "]) {
      vi.stubEnv("EMC_BEARER", value);
      fetchMock.mockResolvedValueOnce(res(200));
      await sendToEmc(BODY, KEY);
      expect(fetchMock.mock.lastCall![1].headers.Authorization).toBe("Bearer tok-123");
    }
  });

  it("sends no Authorization header when EMC_BEARER is not set", async () => {
    vi.stubEnv("EMC_BEARER", "");
    fetchMock.mockResolvedValueOnce(res(200));
    await sendToEmc(BODY, KEY);
    expect(fetchMock.mock.lastCall![1].headers).not.toHaveProperty("Authorization");
  });

  it("200 with externalId → sent + externalId", async () => {
    fetchMock.mockResolvedValueOnce(res(200, { externalId: "EMC-998" }));
    expect(await sendToEmc(BODY, KEY)).toEqual({ classification: "sent", status: 200, externalId: "EMC-998" });
  });

  it("200 with externalId inside an n8n array → sent + externalId", async () => {
    fetchMock.mockResolvedValueOnce(res(200, [{ externalId: 42 }]));
    expect(await sendToEmc(BODY, KEY)).toEqual({ classification: "sent", status: 200, externalId: "42" });
  });

  it("200 without externalId (or not JSON, or empty) → still sent", async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, { message: "Workflow was started" }))
      .mockResolvedValueOnce(res(200, "ok"))
      .mockResolvedValueOnce(res(204));
    for (let i = 0; i < 3; i++) {
      const r = await sendToEmc(BODY, KEY);
      expect(r.classification).toBe("sent");
      expect(r.externalId).toBeUndefined();
    }
  });

  it("a response body over 16 KB is cut: still sent, no externalId", async () => {
    fetchMock.mockResolvedValueOnce(res(200, { pad: "x".repeat(20_000), externalId: "late" }));
    expect(await sendToEmc(BODY, KEY)).toEqual({ classification: "sent", status: 200 });
  });

  it.each([
    [500, "retry"],
    [502, "retry"],
    [503, "retry"],
    [429, "retry"],
    [400, "failed"],
    [401, "failed"],
    [404, "failed"],
    [422, "failed"],
    [409, "closed"],
  ] as const)("HTTP %i → %s", async (status, classification) => {
    fetchMock.mockResolvedValueOnce(res(status, { error: "x", echo: BODY }));
    expect(await sendToEmc(BODY, KEY)).toEqual({ classification, status });
  });

  it("timeout → retry, status 0", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    expect(await sendToEmc(BODY, KEY)).toEqual({ classification: "retry", status: 0, reason: "timeout" });
  });

  it("network error → retry, the cause (which may echo the request) is dropped", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed ${JSON.stringify(BODY)}`));
    const r = await sendToEmc(BODY, KEY);
    expect(r).toEqual({ classification: "retry", status: 0, reason: "network_error" });
    expect(JSON.stringify(r)).not.toContain("jane.doe");
  });

  it("a redirect is not followed → failed", async () => {
    fetchMock.mockResolvedValueOnce(res(302, undefined, { Location: "https://elsewhere.test/" }));
    expect(await sendToEmc(BODY, KEY)).toEqual({ classification: "failed", status: 302, reason: "redirect" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("results never carry the request or response body", async () => {
    fetchMock.mockResolvedValueOnce(res(400, { error: "bad", echo: BODY }));
    expect(JSON.stringify(await sendToEmc(BODY, KEY))).not.toMatch(/jane|5555550123|bad/);
  });

  it("EMC_WEBHOOK_URL missing or invalid → clear EmcConfigError, no fetch, no URL or body in the message", async () => {
    vi.stubEnv("EMC_WEBHOOK_URL", "");
    await expect(sendToEmc(BODY, KEY)).rejects.toThrow(new EmcConfigError("EMC_WEBHOOK_URL is not set"));
    vi.stubEnv("EMC_WEBHOOK_URL", "not a url secret-path");
    const err = await sendToEmc(BODY, KEY).catch((e: Error) => e);
    expect(err).toBeInstanceOf(EmcConfigError);
    expect((err as Error).message).toBe("EMC_WEBHOOK_URL is not a valid URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
