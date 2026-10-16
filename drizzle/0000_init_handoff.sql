CREATE TABLE "handoff_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ghl_contact_id" text NOT NULL,
	"location_id" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"latest_revision" integer DEFAULT 1 NOT NULL,
	"processed_revision" integer,
	"external_id" text,
	"previous_handoff_id" uuid,
	"ghl_sync_pending" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "handoff_cycles_status_check" CHECK (status in ('requested', 'sent', 'pending', 'failed', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "handoff_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "handoff_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handoff_id" uuid,
	"revision" integer,
	"ghl_contact_id" text,
	"event" text NOT NULL,
	"direction" text,
	"status_before" text,
	"status_after" text,
	"changed_fields" jsonb,
	"before" jsonb,
	"after" jsonb,
	"actor" text,
	"http_status" integer,
	"external_id" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "handoff_revisions" (
	"handoff_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"type" text NOT NULL,
	"changed_fields" jsonb,
	"send_state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_http_status" integer,
	"superseded_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handoff_revisions_handoff_id_revision_pk" PRIMARY KEY("handoff_id","revision"),
	CONSTRAINT "handoff_revisions_type_check" CHECK (type in ('create', 'update')),
	CONSTRAINT "handoff_revisions_send_state_check" CHECK (send_state in ('queued', 'pending', 'sent', 'failed', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "handoff_cycles" ADD CONSTRAINT "handoff_cycles_previous_handoff_id_handoff_cycles_id_fk" FOREIGN KEY ("previous_handoff_id") REFERENCES "public"."handoff_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_revisions" ADD CONSTRAINT "handoff_revisions_handoff_id_handoff_cycles_id_fk" FOREIGN KEY ("handoff_id") REFERENCES "public"."handoff_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "handoff_cycles_one_active_per_contact" ON "handoff_cycles" USING btree ("ghl_contact_id") WHERE status in ('requested', 'pending', 'sent');--> statement-breakpoint
CREATE INDEX "handoff_cycles_contact_idx" ON "handoff_cycles" USING btree ("ghl_contact_id","created_at");--> statement-breakpoint
CREATE INDEX "handoff_cycles_sync_pending_idx" ON "handoff_cycles" USING btree ("ghl_sync_pending") WHERE ghl_sync_pending;--> statement-breakpoint
CREATE INDEX "handoff_events_handoff_idx" ON "handoff_events" USING btree ("handoff_id","created_at");--> statement-breakpoint
CREATE INDEX "handoff_events_contact_idx" ON "handoff_events" USING btree ("ghl_contact_id","created_at");--> statement-breakpoint
CREATE INDEX "handoff_revisions_due_idx" ON "handoff_revisions" USING btree ("send_state","next_attempt_at");