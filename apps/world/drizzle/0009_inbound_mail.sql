-- Inbound email bridge: P-Thomas replies land in an agent-addressed mailbox.
CREATE TABLE IF NOT EXISTS "inbound_mail" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"to_agent" text,
	"subject" text DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"html" text,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_mail_provider_id_unique" UNIQUE("provider_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_mail_agent_unread_idx" ON "inbound_mail" USING btree ("to_agent","read_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_mail_provider_idx" ON "inbound_mail" USING btree ("provider_id");
