-- M2 D: world effects (design doc §4). chat_sessions gains a one-shot
-- pending_operator_note: when a visitor.interacted event routes to a live
-- session with that visitor, the note ("The visitor just answered the phone.")
-- is stashed here and injected on the NEXT runChatTurn, then cleared. Nullable;
-- no default — absence means "no pending note".
ALTER TABLE "chat_sessions" ADD COLUMN "pending_operator_note" text;
