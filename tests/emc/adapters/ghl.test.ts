import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// lib/env.ts reads process.env at import time, so env is stubbed and the module re-imported per test
// (that also gives each test a fresh custom-field cache)
async function load() {
  vi.resetModules();
  return import("@lib/emc/adapters/ghl");
}

const PII = { email: "jane.doe@example.com", phone: "+15555550123", name: "Jane Doe" };

const FIELDS = {
  customFields: [
    { id: "cf_status", name: "emc_handoff_status", fieldKey: "contact.emc_handoff_status", dataType: "SINGLE_OPTIONS", model: "contact" },
    { id: "cf_time", name: "emc_handoff_time", fieldKey: "emc_handoff_time", dataType: "TEXT", model: "contact" },
  ],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("LC_ACCESS_TOKEN", "test-token");
  vi.stubEnv("GHL_C2_LOCATION_ID", "loc_1");
  vi.stubEnv("GHL_C2_PIPELINE_NAME", "Test Pipeline");
  vi.stubEnv("GHL_BASE_URL", "https://ghl.test");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("updateContactCustomFields", () => {
  it("resolves keys to ids with and without the contact. prefix", async () => {
    fetchMock.mockResolvedValueOnce(json(FIELDS)).mockResolvedValueOnce(json({ contact: {} }));
    const ghl = await load();

    await ghl.updateContactCustomFields("c_1", {
      emc_handoff_status: "requested", // field returned as "contact.emc_handoff_status"
      "contact.emc_handoff_time": "2026-10-16", // field returned without prefix
    });

    const [listUrl] = fetchMock.mock.calls[0];
    expect(listUrl).toBe("https://ghl.test/locations/loc_1/customFields?model=contact");

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://ghl.test/contacts/c_1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({
      customFields: [
        { id: "cf_status", field_value: "requested" },
        { id: "cf_time", field_value: "2026-10-16" },
      ],
    });
  });

  it("caches the field list across calls", async () => {
    fetchMock.mockImplementation(async (url: string) => (url.includes("customFields") ? json(FIELDS) : json({})));
    const ghl = await load();

    await ghl.updateContactCustomFields("c_1", { emc_handoff_status: "sent" });
    await ghl.updateContactCustomFields("c_2", { emc_handoff_status: "completed" });

    const listCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("customFields"));
    expect(listCalls).toHaveLength(1);
  });

  it("throws on an unknown key and does not write", async () => {
    fetchMock.mockResolvedValueOnce(json(FIELDS));
    const ghl = await load();

    await expect(
      ghl.updateContactCustomFields("c_1", { emc_handoff_status: "sent", emc_nope: "x" }),
    ).rejects.toThrow(/emc_nope/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the field list
  });
});

describe("removeContactTags", () => {
  it("sends DELETE /contacts/{id}/tags with { tags }", async () => {
    fetchMock.mockResolvedValueOnce(json({ tags: [] }));
    const ghl = await load();

    await ghl.removeContactTags("c 1", ["emc-handoff-requested"]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ghl.test/contacts/c%201/tags");
    expect(init.method).toBe("DELETE");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-token",
      Version: "2021-07-28",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({ tags: ["emc-handoff-requested"] });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("errors", () => {
  it("throws GhlApiError with status and path and no PII from request or response", async () => {
    // the error response echoes the contact back, like GHL validation errors can
    fetchMock.mockResolvedValueOnce(json({ message: `invalid ${PII.email} ${PII.phone}`, contact: PII }, 422));
    const ghl = await load();

    const err = await ghl
      .createContactNote("c_1", { title: "Rejected", body: `missing data for ${PII.name} ${PII.email}` })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ghl.GhlApiError);
    const e = err as InstanceType<typeof ghl.GhlApiError>;
    expect(e.status).toBe(422);
    expect(e.path).toBe("/contacts/c_1/notes");

    const dump = `${e.message} ${e.stack ?? ""} ${JSON.stringify(e)} ${String(e.cause ?? "")}`;
    for (const v of Object.values(PII)) expect(dump).not.toContain(v);
  });

  it("maps a timeout to status 0 without the request body", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error(`aborted ${PII.email}`), { name: "TimeoutError" }));
    const ghl = await load();

    const err = (await ghl.getContact("c_1").catch((e: unknown) => e)) as InstanceType<typeof ghl.GhlApiError>;
    expect(err.status).toBe(0);
    expect(err.message).toContain("timeout");
    expect(err.message).not.toContain(PII.email);
  });
});

describe("createContactNote / formatGhlDateTime", () => {
  it("returns the note id", async () => {
    fetchMock.mockResolvedValueOnce(json({ note: { id: "n_1", body: "x" } }, 201));
    const ghl = await load();
    await expect(ghl.createContactNote("c_1", { title: "t", body: "b" })).resolves.toBe("n_1");
  });

  it("formats as a sortable UTC date and time", async () => {
    const ghl = await load();
    expect(ghl.formatGhlDateTime(new Date("2026-10-16T23:30:05.123-05:00"))).toBe("2026-10-17 04:30:05 UTC");
    expect(ghl.formatGhlDateTime(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02 03:04:05 UTC");
    expect(() => ghl.formatGhlDateTime(new Date("nope"))).toThrow();
  });
});
