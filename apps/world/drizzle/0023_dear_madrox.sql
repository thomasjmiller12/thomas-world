ALTER TABLE "chat_messages" ADD COLUMN "response_request_id" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "response_completed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_session_response_request_idx" ON "chat_messages" USING btree ("session_id","response_request_id") WHERE "chat_messages"."response_request_id" is not null;