import type { Executor } from "../client";
import { handoffEvents, type HandoffEvent, type NewHandoffEvent } from "../schema";

// append-only: there is no update/delete here on purpose
export type AppendEventInput = Omit<NewHandoffEvent, "id" | "createdAt">;

export async function appendEvent(db: Executor, event: AppendEventInput): Promise<HandoffEvent> {
  const [row] = await db.insert(handoffEvents).values(event).returning();
  return row;
}
