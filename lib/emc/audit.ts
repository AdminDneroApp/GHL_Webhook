import type { Executor } from "./db/client";
import { appendEvent, type AppendEventInput } from "./db/repositories/events";
import type { HandoffEvent } from "./db/schema";

// audit writer. pass the intake transaction so the event commits (or rolls back) with the state change.
// before/after are stored as-is for now — encryption (crypto.ts) wraps them here later.
export async function recordEvent(tx: Executor, event: AppendEventInput): Promise<HandoffEvent> {
  return appendEvent(tx, event);
}
