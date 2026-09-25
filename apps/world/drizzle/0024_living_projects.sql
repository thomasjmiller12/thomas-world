CREATE TABLE "artifact_contributions" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"visitor_id" text NOT NULL,
	"request_id" text NOT NULL,
	"contributor_name" text NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"version" integer NOT NULL,
	"agent_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"published" boolean NOT NULL,
	"contribution_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contribution_responses" (
	"id" text PRIMARY KEY NOT NULL,
	"contribution_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"status" text NOT NULL,
	"response" text NOT NULL,
	"revision_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_contributions" ADD CONSTRAINT "artifact_contributions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_contributions" ADD CONSTRAINT "artifact_contributions_visitor_id_visitors_id_fk" FOREIGN KEY ("visitor_id") REFERENCES "public"."visitors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_revisions" ADD CONSTRAINT "artifact_revisions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_revisions" ADD CONSTRAINT "artifact_revisions_contribution_id_artifact_contributions_id_fk" FOREIGN KEY ("contribution_id") REFERENCES "public"."artifact_contributions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_responses" ADD CONSTRAINT "contribution_responses_contribution_id_artifact_contributions_id_fk" FOREIGN KEY ("contribution_id") REFERENCES "public"."artifact_contributions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_responses" ADD CONSTRAINT "contribution_responses_revision_id_artifact_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."artifact_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_contributions_request_idx" ON "artifact_contributions" USING btree ("visitor_id","request_id");--> statement-breakpoint
CREATE INDEX "artifact_contributions_artifact_idx" ON "artifact_contributions" USING btree ("artifact_id","created_at");--> statement-breakpoint
CREATE INDEX "artifact_contributions_pending_idx" ON "artifact_contributions" USING btree ("agent_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_revisions_version_idx" ON "artifact_revisions" USING btree ("artifact_id","version");--> statement-breakpoint
CREATE INDEX "contribution_responses_contribution_idx" ON "contribution_responses" USING btree ("contribution_id","created_at");