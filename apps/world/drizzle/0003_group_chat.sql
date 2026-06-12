-- M2 C: group chat = a chat session with up to 2 agents (design doc §3.3).
-- chat_sessions gains participant_agent_ids: the full agent roster for the
-- session. Defaults to [] at the DB level; the runtime seeds it with [agentId]
-- on open and appends a second agent on invite_to_chat / scene→chat conversion.
-- chat_messages.sender already widened to free-form text in 0000 (no enum), so a
-- group chat can persist lines under an explicit AgentId with no schema change.
ALTER TABLE "chat_sessions" ADD COLUMN "participant_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
