import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendPreview, type PreviewDeps } from "@lib/emc/services/forward-preview";

const NOW = new Date("2026-10-21T12:00:00Z");

function harness(existingExternalId: string | null) {
  const buildSnapshot = vi.fn<PreviewDeps["buildSnapshot"]>(async (contactId, envelope) => ({
    body: { ...envelope, ghlContactId: contactId, externalId: existingExternalId, contact: {}, fields: {}, notes: [] },
    warnings: [],
  }));
  const sendToEmc = vi.fn<PreviewDeps["sendToEmc"]>(async () => ({ classification: "sent", status: 200 }));
  const saveExternalId = vi.fn<PreviewDeps["saveExternalId"]>(async () => {});
  const deps = { buildSnapshot, sendToEmc, saveExternalId, newId: () => "h-1", newExternalId: () => "ext-new", now: () => NOW };
  const run = () => sendPreview({ ghlContactId: "c1", forwardId: "f1", revision: 1, type: "create" }, deps);
  return { run, sendToEmc, saveExternalId };
}

const sentBody = (send: ReturnType<typeof harness>["sendToEmc"]) => send.mock.calls[0][0] as { externalId: string };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("sendPreview external id", () => {
  it("contact without one → creates it, saves it on the contact, then sends it", async () => {
    const h = harness(null);
    await h.run();
    expect(h.saveExternalId).toHaveBeenCalledWith("c1", "ext-new");
    expect(sentBody(h.sendToEmc).externalId).toBe("ext-new");
    expect(h.saveExternalId.mock.invocationCallOrder[0]).toBeLessThan(h.sendToEmc.mock.invocationCallOrder[0]);
  });

  it("contact that already has one → reuses it, saves nothing", async () => {
    const h = harness("ext-0001");
    await h.run();
    expect(h.saveExternalId).not.toHaveBeenCalled();
    expect(sentBody(h.sendToEmc).externalId).toBe("ext-0001");
  });

  it("saving fails → nothing is sent to EMC", async () => {
    const h = harness(null);
    h.saveExternalId.mockRejectedValueOnce(new Error("GHL down"));
    await h.run();
    expect(h.sendToEmc).not.toHaveBeenCalled();
  });
});
