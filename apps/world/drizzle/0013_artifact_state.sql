CREATE TABLE "artifact_state" (
	"artifact_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_state_artifact_id_key_pk" PRIMARY KEY("artifact_id","key")
);
