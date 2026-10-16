import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { HANDOFF_STATUSES } from "../domain/cycle";

// step 1 tables only. snapshots, encryption, inbound_requests and applied_notes come later.

export const REVISION_TYPES = ["create", "update"] as const;
export type RevisionType = (typeof REVISION_TYPES)[number];

export const SEND_STATES = ["queued", "pending", "sent", "failed", "superseded"] as const;
export type SendState = (typeof SEND_STATES)[number];

export const EVENT_DIRECTIONS = ["agent_to_dnero", "dnero_to_emc", "emc_to_dnero", "dnero_to_ghl"] as const;
export type EventDirection = (typeof EVENT_DIRECTIONS)[number];

export const HANDOFF_EVENTS = [
  "requested",
  "revision_created",
  "sent",
  "retry_scheduled",
  "superseded",
  "failed",
  "emc_returned",
  "completed",
  "ignored_stale",
  "conflict",
  "note_created",
  "tag_removed",
  "rejected",
  "ghl_sync_failed", // a GHL side effect (tag removal / field mirror) failed; the cron retries it
] as const;
export type HandoffEventName = (typeof HANDOFF_EVENTS)[number];

const tsz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const handoffCycles = pgTable(
  "handoff_cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(), // = handoffId
    ghlContactId: text("ghl_contact_id").notNull(),
    locationId: text("location_id").notNull(),
    status: text("status", { enum: HANDOFF_STATUSES }).notNull().default("requested"),
    latestRevision: integer("latest_revision").notNull().default(1),
    processedRevision: integer("processed_revision"),
    externalId: text("external_id"),
    previousHandoffId: uuid("previous_handoff_id").references((): AnyPgColumn => handoffCycles.id),
    ghlSyncPending: boolean("ghl_sync_pending").notNull().default(false),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow().$onUpdate(() => new Date()), // drizzle sets it on every update query
    closedAt: tsz("closed_at"),
  },
  (t) => [
    // one active cycle per contact
    uniqueIndex("handoff_cycles_one_active_per_contact")
      .on(t.ghlContactId)
      .where(sql`status in ('requested', 'pending', 'sent')`),
    index("handoff_cycles_contact_idx").on(t.ghlContactId, t.createdAt),
    index("handoff_cycles_sync_pending_idx").on(t.ghlSyncPending).where(sql`ghl_sync_pending`),
    check("handoff_cycles_status_check", sql`status in ('requested', 'sent', 'pending', 'failed', 'completed')`),
  ],
);

export const handoffRevisions = pgTable(
  "handoff_revisions",
  {
    handoffId: uuid("handoff_id")
      .notNull()
      .references(() => handoffCycles.id),
    revision: integer("revision").notNull(),
    type: text("type", { enum: REVISION_TYPES }).notNull(),
    changedFields: jsonb("changed_fields").$type<string[]>(),
    sendState: text("send_state", { enum: SEND_STATES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tsz("next_attempt_at"),
    lastHttpStatus: integer("last_http_status"),
    supersededBy: integer("superseded_by"),
    createdAt: tsz("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.handoffId, t.revision] }),
    // cron: due resends
    index("handoff_revisions_due_idx").on(t.sendState, t.nextAttemptAt),
    check("handoff_revisions_type_check", sql`type in ('create', 'update')`),
    check(
      "handoff_revisions_send_state_check",
      sql`send_state in ('queued', 'pending', 'sent', 'failed', 'superseded')`,
    ),
  ],
);

// append-only audit log. before/after hold plain jsonb for now; encryption comes later.
export const handoffEvents = pgTable(
  "handoff_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    createdAt: tsz("created_at").notNull().defaultNow(),
    handoffId: uuid("handoff_id"),
    revision: integer("revision"),
    ghlContactId: text("ghl_contact_id"),
    event: text("event", { enum: HANDOFF_EVENTS }).notNull(),
    direction: text("direction", { enum: EVENT_DIRECTIONS }),
    statusBefore: text("status_before", { enum: HANDOFF_STATUSES }),
    statusAfter: text("status_after", { enum: HANDOFF_STATUSES }),
    changedFields: jsonb("changed_fields").$type<string[]>(),
    before: jsonb("before"),
    after: jsonb("after"),
    actor: text("actor"),
    httpStatus: integer("http_status"),
    externalId: text("external_id"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("handoff_events_handoff_idx").on(t.handoffId, t.createdAt),
    index("handoff_events_contact_idx").on(t.ghlContactId, t.createdAt),
  ],
);

export type HandoffCycle = typeof handoffCycles.$inferSelect;
export type NewHandoffCycle = typeof handoffCycles.$inferInsert;
export type HandoffRevision = typeof handoffRevisions.$inferSelect;
export type NewHandoffRevision = typeof handoffRevisions.$inferInsert;
export type HandoffEvent = typeof handoffEvents.$inferSelect;
export type NewHandoffEvent = typeof handoffEvents.$inferInsert;
