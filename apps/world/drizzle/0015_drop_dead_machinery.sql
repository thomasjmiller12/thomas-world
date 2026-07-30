-- 0015: drop machinery measured to have zero production usage (2026-07-30).
--
-- Verified against the live production DB and by counting every tool_use block
-- across all five agents' persisted conversation threads:
--   - agent_presets: 0 rows in production; save_preset and list_my_presets
--     were never called by any agent, ever. Built (Beats Phase B.5) on a
--     reasonable theory ("customization within bounds") that never
--     materialized. Safe to drop outright — the table is empty.
--   - chat_sessions.participant_agent_ids: written at session-creation time
--     (always [agentId]) but never read anywhere — leftover from a group-chat
--     design that was never built out past the write.
--   - chat_sessions.pending_operator_note: declared for a director/operator-note
--     routing path that was retired in the M3 continuity rewrite; no read or
--     write path remains.
--
-- NOT touched here, intentionally: `conversations` / `conversation_turns` hold
-- 9 and 73 rows of the town's genuine early (pre-M2.1) history. The code paths
-- that wrote them are gone, but the tables and their rows are irreplaceable
-- historical data and are kept as an inert archive — see db/schema.ts.
ALTER TABLE "chat_sessions" DROP COLUMN IF EXISTS "participant_agent_ids";
ALTER TABLE "chat_sessions" DROP COLUMN IF EXISTS "pending_operator_note";
DROP TABLE IF EXISTS "agent_presets";
