import type { EmcHandoff } from "./schema";

export interface HandoffContext {
  handoffId: string;
  receivedAt: string;
  keyIndex: number;
  idempotencyKey: string;
}

export interface HandoffResult {
  status: "accepted";
}

// the processing flow with EMC is still being defined — for now a handoff is only acknowledged and
// its shape recorded (key names, never values). the GHL work (contact upsert, pipeline, workflow) plugs in here.
export async function processEmcHandoff(data: EmcHandoff, ctx: HandoffContext): Promise<HandoffResult> {
  console.log("EMC_HANDOFF_ACCEPTED", JSON.stringify({
    ...ctx,
    keys: Object.keys(data),
    hasEmail: !!data.email,
    hasPhone: !!data.phone,
    tags: data.tags,
  }));
  return { status: "accepted" };
}
