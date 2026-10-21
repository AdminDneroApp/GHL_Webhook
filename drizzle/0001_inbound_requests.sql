CREATE TABLE "inbound_requests" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"body_hash" text NOT NULL,
	"state" text DEFAULT 'processing' NOT NULL,
	"response" jsonb,
	"handoff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_requests_state_check" CHECK (state in ('processing', 'completed'))
);
