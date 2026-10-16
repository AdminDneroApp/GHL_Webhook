import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATUSES,
  decideTagEvent,
  FINAL_STATUSES,
  HANDOFF_STATUSES,
  isActive,
  isFinal,
  type CycleRef,
  type HandoffStatus,
} from "@lib/emc/domain/cycle";

const cycle = (status: HandoffStatus, latestRevision = 1, id = "h-1"): CycleRef => ({ id, status, latestRevision });

describe("status sets", () => {
  it("splits every status into exactly one of active / final", () => {
    for (const s of HANDOFF_STATUSES) {
      expect(isActive(s) !== isFinal(s)).toBe(true);
    }
    expect([...ACTIVE_STATUSES].sort()).toEqual(["pending", "requested", "sent"]);
    expect([...FINAL_STATUSES].sort()).toEqual(["completed", "failed"]);
  });
});

describe("decideTagEvent", () => {
  it("no cycles at all → new cycle without previousHandoffId", () => {
    const d = decideTagEvent({ activeCycle: null, lastClosedCycle: null });
    expect(d).toEqual({ kind: "new_cycle" });
    expect("previousHandoffId" in d).toBe(false);
  });

  it.each(["requested", "pending", "sent"] as const)("active cycle (%s) → next revision", (status) => {
    expect(decideTagEvent({ activeCycle: cycle(status, 3, "h-active"), lastClosedCycle: null })).toEqual({
      kind: "revision",
      handoffId: "h-active",
      revision: 4,
    });
  });

  it("active cycle wins over a completed closed cycle", () => {
    const d = decideTagEvent({
      activeCycle: cycle("sent", 1, "h-active"),
      lastClosedCycle: cycle("completed", 2, "h-old"),
    });
    expect(d).toEqual({ kind: "revision", handoffId: "h-active", revision: 2 });
  });

  it("last closed cycle completed → new cycle carrying previousHandoffId", () => {
    expect(decideTagEvent({ activeCycle: null, lastClosedCycle: cycle("completed", 2, "h-old") })).toEqual({
      kind: "new_cycle",
      previousHandoffId: "h-old",
    });
  });

  it("last closed cycle failed → new cycle without previousHandoffId", () => {
    const d = decideTagEvent({ activeCycle: null, lastClosedCycle: cycle("failed", 1, "h-old") });
    expect(d).toEqual({ kind: "new_cycle" });
    expect("previousHandoffId" in d).toBe(false);
  });

  it.each(["completed", "failed"] as const)("rejects an activeCycle whose status is %s", (status) => {
    expect(() => decideTagEvent({ activeCycle: cycle(status), lastClosedCycle: null })).toThrow(/non-active/);
  });
});
