import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import pg from "pg";

// Opt in with an isolated LOCAL Postgres URL. Every object lives in a temporary
// schema; the suite never truncates existing tables or loads provider keys.
const testUrl = process.env.ROOM_CHAT_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("room lifecycle against Postgres", () => {
  const schemaName = `room_test_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let client: typeof import("../db/client.js");
  let chat: typeof import("./chat.js");
  let rooms: typeof import("./room-chat.js");
  let locks: typeof import("./room-lock.js");

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("ROOM_CHAT_TEST_DATABASE_URL must use a local isolated Postgres instance");
    }
    admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    url.searchParams.set("options", `-c search_path=${schemaName},public`);
    vi.stubEnv("DATABASE_URL", url.toString());
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "HINDSIGHT_URL", "RESEND_API_KEY", "VAULT_DIR", "LANGFUSE_SECRET_KEY", "LANGFUSE_PUBLIC_KEY"]) {
      vi.stubEnv(key, "");
    }
    vi.resetModules();
    client = await import("../db/client.js");
    const journal = JSON.parse(await readFile(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8"));
    for (const entry of journal.entries) {
      if (entry.tag.startsWith("0022_")) {
        await client.pool.query(`INSERT INTO agents (id, display_name, location_id, status) VALUES ('builder', 'Builder', 'workshop', 'with a visitor'), ('writer', 'Writer', 'workshop', 'with a visitor'), ('hobby', 'Hobby', 'workshop', 'awake')`);
        await client.pool.query(`INSERT INTO chat_sessions (id, agent_id, visitor_id, started_at) VALUES ('legacy-old', 'builder', 'legacy-visitor', now() - interval '2 hours'), ('legacy-new', 'writer', 'legacy-visitor', now() - interval '1 hour')`);
      }
      const migration = await readFile(new URL(`../../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        // Generated FKs name public explicitly. Retarget them along with the
        // search path so this suite never references another suite's tables.
        if (statement.trim()) await client.pool.query(statement.replaceAll('"public".', `"${schemaName}".`));
      }
    }
    chat = await import("./chat.js");
    rooms = await import("./room-chat.js");
    locks = await import("./room-lock.js");
    await import("./loop.js");
  });

  afterAll(async () => {
    if (client) await client.pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await admin.end();
    }
    vi.unstubAllEnvs();
  });

  async function openRoom() {
    const visitorId = randomUUID();
    await client.pool.query("INSERT INTO visitors (id, name, location_id) VALUES ($1, 'Room tester', 'workshop')", [visitorId]);
    const room = await chat.createSession("builder", visitorId);
    expect(room).not.toBeNull();
    return room!;
  }

  it("migrates duplicate legacy visitor sessions and vacates the old member", async () => {
    const { rows } = await client.pool.query("SELECT id, ended_at FROM chat_sessions ORDER BY id");
    expect(rows.find(r => r.id === "legacy-old").ended_at).not.toBeNull();
    expect(rows.find(r => r.id === "legacy-new").ended_at).toBeNull();
    expect(await chat.activeChatSessionForAgent("builder")).toBeNull();
    expect(await chat.activeChatSessionForAgent("writer")).toBe("legacy-new");
    await chat.endSession("legacy-new");
  });

  it("routes one private visitor line to the requested member and persists completion", async () => {
    const room = await openRoom();
    expect((await chat.createSession("builder", room.visitorId))?.sessionId).toBe(room.sessionId);
    expect(await chat.joinSession(room.sessionId, "writer")).toEqual(["builder", "writer"]);
    await expect(chat.joinSession(room.sessionId, "hobby")).rejects.toBeInstanceOf(chat.ChatRoomFullError);
    const frames: { type: string }[] = [];
    await rooms.runRoomResponse({ ...room, text: "Private request marker-9cf2", requestId: "route-1", to: "writer", handlers: { onFrame: frame => { frames.push(frame); } } });
    const transcript = await chat.getChatTranscript(room.sessionId);
    expect(transcript?.messages.map(m => m.sender)).toEqual(["visitor", "writer"]);
    expect(transcript?.responses).toEqual([{ requestId: "route-1", completed: true }]);
    expect(frames.filter(f => f.type === "response_done")).toHaveLength(1);
    const events = JSON.stringify((await client.pool.query("SELECT * FROM world_events WHERE visibility = 'public'")).rows);
    expect(events).not.toContain(room.sessionId);
    expect(events).not.toContain(room.sessionToken);
    expect(events).not.toContain("marker-9cf2");
    const leaves = await Promise.all([chat.leaveSession(room.sessionId, "builder"), chat.leaveSession(room.sessionId, "writer")]);
    expect(leaves.filter(l => l.ended)).toHaveLength(1);
    expect(await chat.getSession(room.sessionId)).toBeNull();
    expect(await chat.getChatTranscript(room.sessionId)).toMatchObject({ participants: [], endedAt: expect.any(String) });
  });

  it("finishes persistence after its response stream disappears", async () => {
    const room = await openRoom();
    await rooms.runRoomResponse({ ...room, text: "Answer after a transport failure", requestId: "drop-1", handlers: { onFrame: () => { throw new Error("transport disconnected"); } } });
    const transcript = await chat.getChatTranscript(room.sessionId);
    expect(transcript?.messages.map(m => m.sender)).toEqual(["visitor", "builder"]);
    expect(transcript?.responses).toEqual([{ requestId: "drop-1", completed: true }]);
    await chat.endSession(room.sessionId);
  });

  it("removes a departed body without closing the other member's room or rejoining it", async () => {
    const room = await openRoom();
    await chat.joinSession(room.sessionId, "writer");
    await client.pool.query("UPDATE agents SET location_id = 'cafe' WHERE id = 'writer'");
    await rooms.runRoomResponse({ ...room, text: "Who is still here?", requestId: "leave-1", handlers: { onFrame: () => undefined } });
    expect((await chat.getSession(room.sessionId))?.participants).toEqual(["builder"]);
    expect((await chat.getChatTranscript(room.sessionId))?.messages.map(m => m.sender)).toEqual(["visitor", "builder"]);
    await client.pool.query("UPDATE agents SET location_id = 'workshop' WHERE id = 'writer'");
    await expect(chat.joinSession(room.sessionId, "writer")).rejects.toBeInstanceOf(chat.ChatEngagedError);
    expect(await chat.activeChatSessionForAgent("writer")).toBeNull();
    await chat.endSession(room.sessionId);
  });

  it("keeps a room alive when fresh activity arrives while the sweep waits", async () => {
    const room = await openRoom();
    await client.pool.query("UPDATE chat_sessions SET started_at = now() - interval '10 minutes', last_ping_at = now() - interval '10 minutes' WHERE id = $1", [room.sessionId]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const enteredLock = new Promise<void>(resolve => { entered = resolve; });
    const holder = locks.withRoomLock(room.sessionId, async () => { entered(); await gate; });
    await enteredLock;
    const sweep = chat.sweepStaleChats();
    await pause(100);
    await chat.pingChat(room.sessionId);
    await chat.appendVisitorLine(room.sessionId, "Still here", "alive-1");
    release();
    await Promise.all([holder, sweep]);
    expect(await chat.getSession(room.sessionId)).not.toBeNull();
    await chat.endSession(room.sessionId);
  });

  it("does not expose another same-name visitor's transcript through history, context, or recall", async () => {
    const { registerVisitor } = await import("../engine/visitors.js");
    const { historyFor } = await import("../engine/visitor-history.js");
    const { createApp } = await import("../http/app.js");
    const { buildTools } = await import("./tools.js");
    const hindsight = await import("./hindsight.js");
    const name = `privacy-test-${randomUUID()}`;
    const first = await registerVisitor(name);
    const second = await registerVisitor(name.toUpperCase());
    await client.pool.query("UPDATE visitors SET location_id = 'workshop' WHERE id = ANY($1)", [[first.id, second.id]]);
    const firstRoom = (await chat.createSession("builder", first.id))!;
    await chat.appendVisitorLine(firstRoom.sessionId, "First visitor private marker", "first-private");
    await chat.endSession(firstRoom.sessionId);

    const app = createApp();
    const history = await app.request(`/visitors/${second.id}/chat-history?agent=builder`, { headers: { "x-visitor-token": second.visitorToken! } });
    expect(history.status).toBe(200);
    expect((await history.json() as { messages: unknown[] }).messages).toEqual([]);
    const unauthorized = await app.request(`/visitors/${first.id}/chat-history?agent=builder`, { headers: { "x-visitor-token": second.visitorToken! } });
    expect(unauthorized.status).toBe(401);
    expect((await historyFor("builder", second.id))?.priorSessions).toBe(0);
    expect(await chat.priorVisitorContext("builder", second.id, "not-a-session")).toBeUndefined();
    expect(await chat.priorVisitorContext("builder", first.id, "not-a-session")).toContain("First visitor private marker");

    const secondRoom = (await chat.createSession("builder", second.id))!;
    await chat.appendVisitorLine(secondRoom.sessionId, "Second visitor own context", "second-private");
    await chat.endSession(secondRoom.sessionId);
    const currentRoom = (await chat.createSession("builder", second.id))!;
    const broadRecall = vi.spyOn(hindsight, "recall").mockResolvedValue({ ok: true, text: "First visitor private marker" });
    try {
      const context = await chat.priorVisitorContext("builder", second.id, currentRoom.sessionId);
      expect(context).toContain("Second visitor own context");
      expect(context).not.toContain("First visitor private marker");
      const recall = buildTools({ agentId: "builder", location: "workshop", chatSessionId: currentRoom.sessionId }).find(tool => tool.name === "recall");
      if (recall?.kind !== "function") throw new Error("recall tool missing");
      const recalled = await recall.run({ query: `What did ${name} tell you in private?` });
      expect(recalled).toContain("Second visitor own context");
      expect(recalled).not.toContain("First visitor private marker");
      expect(broadRecall).not.toHaveBeenCalled();
    } finally {
      broadRecall.mockRestore();
      await chat.endSession(currentRoom.sessionId);
    }
  });

  it("excludes messages outside the facet's membership window from prior context", async () => {
    const room = await openRoom();
    await chat.appendVisitorLine(room.sessionId, "Before Writer joined", "before-writer");
    await chat.joinSession(room.sessionId, "writer");
    await chat.appendVisitorLine(room.sessionId, "Shared with Writer", "with-writer");
    await chat.leaveSession(room.sessionId, "writer");
    await chat.appendVisitorLine(room.sessionId, "After Writer left", "after-writer");
    await chat.endSession(room.sessionId);
    const context = await chat.priorVisitorContext("writer", room.visitorId, "not-a-session");
    expect(context).toContain("Shared with Writer");
    expect(context).not.toContain("Before Writer joined");
    expect(context).not.toContain("After Writer left");
  });

  it("uses the database clock when closing a room or leaving a membership", async () => {
    const hindsight = await import("./hindsight.js");
    const remember = vi.spyOn(hindsight, "remember").mockResolvedValue({ ok: true, text: "Stored." });
    const room = await openRoom();
    await chat.joinSession(room.sessionId, "writer");
    await chat.appendVisitorLine(room.sessionId, "Last message before leaving", "clock-leave");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2000-01-01T00:00:00Z"));
    try {
      await chat.leaveSession(room.sessionId, "writer");
      expect(await chat.priorVisitorContext("writer", room.visitorId, "other-room")).toContain("Last message before leaving");
      expect(remember).toHaveBeenCalledWith("writer", expect.stringContaining("Last message before leaving"), "visit");
      await chat.appendVisitorLine(room.sessionId, "Last message before closing", "clock-close");
      await chat.endSession(room.sessionId);
      expect(await chat.priorVisitorContext("builder", room.visitorId, "other-room")).toContain("Last message before closing");
      expect(remember).toHaveBeenCalledWith("builder", expect.stringContaining("Last message before closing"), "visit");
      const { rows } = await client.pool.query(`SELECT s.ended_at = p.left_at AS same_cutoff, p.left_at >= m.ts AS includes_last
        FROM chat_sessions s JOIN chat_session_participants p ON p.session_id = s.id AND p.agent_id = 'builder'
        JOIN chat_messages m ON m.session_id = s.id AND m.response_request_id = 'clock-close' WHERE s.id = $1`, [room.sessionId]);
      expect(rows).toEqual([{ same_cutoff: true, includes_last: true }]);
    } finally {
      remember.mockRestore();
      vi.useRealTimers();
      await chat.endSession(room.sessionId);
    }
  });

  it("starts membership after a queued join acquires the room lock", async () => {
    const room = await openRoom();
    const holder = await client.pool.connect();
    let joining: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM chat_sessions WHERE id = $1 FOR UPDATE", [room.sessionId]);
      joining = chat.joinSession(room.sessionId, "writer");
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i += 1) {
        const result = await client.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%chat_sessions%'");
        waiting = result.rowCount! > 0;
        if (!waiting) await pause(10);
      }
      expect(waiting).toBe(true);
      await chat.appendVisitorLine(room.sessionId, "Private while join was waiting", "join-wait");
      await holder.query("COMMIT");
      await joining;
      await chat.appendVisitorLine(room.sessionId, "Shared after actual join", "join-finished");
      await chat.endSession(room.sessionId);
      const context = await chat.priorVisitorContext("writer", room.visitorId, "other-room");
      expect(context).toContain("Shared after actual join");
      expect(context).not.toContain("Private while join was waiting");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await joining;
      await chat.endSession(room.sessionId);
    }
  });

  it("keeps exact microsecond membership boundaries in stored history and teardown digests", async () => {
    const { transcriptDigest } = await import("../engine/visitor-history.js");
    const room = await openRoom();
    await chat.joinSession(room.sessionId, "writer");
    await client.pool.query("UPDATE chat_session_participants SET joined_at = '2030-01-01T00:00:00.123100Z', left_at = '2030-01-01T00:00:00.123900Z' WHERE session_id = $1 AND agent_id = 'writer'", [room.sessionId]);
    await client.pool.query(`INSERT INTO chat_messages (session_id, sender, body, ts) VALUES
      ($1, 'visitor', 'Before exact join', '2030-01-01T00:00:00.123099Z'),
      ($1, 'visitor', 'Inside exact membership', '2030-01-01T00:00:00.123899Z'),
      ($1, 'visitor', 'After exact leave', '2030-01-01T00:00:00.123901Z')`, [room.sessionId]);
    const history = await chat.priorVisitorContext("writer", room.visitorId, "other-room");
    expect(history).toContain("Inside exact membership");
    expect(history).not.toContain("Before exact join");
    expect(history).not.toContain("After exact leave");
    const digest = await transcriptDigest(room.sessionId, "writer");
    expect(digest).toContain("Inside exact membership");
    expect(digest).not.toContain("Before exact join");
    expect(digest).not.toContain("After exact leave");
    await chat.endSession(room.sessionId);
  });
});
