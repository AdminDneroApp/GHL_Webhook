// pure cycle logic for the EMC handoff — no I/O. the DB is the source of truth; GHL fields only mirror it.

export const HANDOFF_STATUSES = ["requested", "sent", "pending", "failed", "completed"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

// at most one active cycle per contact (enforced by a partial unique index too)
export const ACTIVE_STATUSES: ReadonlySet<HandoffStatus> = new Set<HandoffStatus>(["requested", "pending", "sent"]);
export const FINAL_STATUSES: ReadonlySet<HandoffStatus> = new Set<HandoffStatus>(["completed", "failed"]);

export function isActive(status: HandoffStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function isFinal(status: HandoffStatus): boolean {
  return FINAL_STATUSES.has(status);
}

// the minimum the decision needs from a cycle row
export interface CycleRef {
  id: string;
  status: HandoffStatus;
  latestRevision: number;
}

export type TagDecision =
  | { kind: "new_cycle"; previousHandoffId?: string }
  | { kind: "revision"; handoffId: string; revision: number };

// tag "emc-handoff-requested" added:
// - active cycle → next revision of it
// - otherwise → new cycle; previousHandoffId only when the last closed cycle completed (not failed)
export function decideTagEvent(input: {
  activeCycle: CycleRef | null;
  lastClosedCycle: CycleRef | null;
}): TagDecision {
  const { activeCycle, lastClosedCycle } = input;

  if (activeCycle) {
    if (!isActive(activeCycle.status)) {
      throw new Error(`activeCycle ${activeCycle.id} has non-active status "${activeCycle.status}"`);
    }
    return { kind: "revision", handoffId: activeCycle.id, revision: activeCycle.latestRevision + 1 };
  }

  if (lastClosedCycle?.status === "completed") {
    return { kind: "new_cycle", previousHandoffId: lastClosedCycle.id };
  }
  return { kind: "new_cycle" };
}
