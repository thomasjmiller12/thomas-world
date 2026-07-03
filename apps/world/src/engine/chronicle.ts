// The Town Chronicle (M2.1) — the full-screen hub that replaces the feed side
// panel. It renders ONE day of the town's emergent life as a curated, grouped
// list: room-talk threads, things agents made, bulletins, world effects, and
// presence beats. Progressive disclosure: the list shows headlines; threads
// carry their turns inline for expansion.
//
// `groupSpokeIntoThreads` is the pure, unit-testable core. `buildChronicle` does
// the single ts-range select, assembles every ChronicleItem variant, derives the
// day picker, and serves a small in-memory cache (today: 60s TTL; past days:
// immutable).

import { and, asc, gte, lt, inArray, desc, sql } from "drizzle-orm";
import type {
  WorldEvent,
  AgentId,
  LocationId,
  ChronicleItem,
  ChronicleResponse,
  ChronicleTurn,
  ArtifactSummary,
} from "@town/contract";
import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { renderLine } from "./feed.js";
import { anthropic, hasLlm } from "../runtime/client.js";
import { recordUsage } from "./usage.js";
import { estimateCostUsd, tokensFromUsage } from "../runtime/pricing.js";
import { attachIssue, regenerateIssue, loadCachedIssue } from "./chronicle-issue.js";

const { worldEvents, artifacts, threadSummaries } = schema;

// Threads split when consecutive lines at one location are more than this apart;
// also the "closed" threshold (a thread can no longer grow once its last line is
// older than this), which gates lazy summary generation.
export const THREAD_GAP_MS = 12 * 60_000;

// How far back the day picker looks (a portfolio's worth of history; the range
// select stays a single index scan per day regardless).
const DAY_LOOKBACK = 30;

// Event types the Chronicle reads (public/location only — privates are dropped
// in buildChronicle). `conversation.turn` is the historical paced-scene type,
// kept so pre-redesign rows still surface in the hub.
const CHRONICLE_EVENT_TYPES = [
  "agent.spoke",
  "conversation.turn",
  "artifact.created",
  "artifact.updated",
  "bulletin.posted",
  "world.effect",
  "chat.started",
  "chat.ended",
] as const;

// A grouped room-talk thread, in the contract's kind:'thread' shape plus an
// internal `endTs` (the ts of the LAST turn) so the endpoint can tell a closed
// thread (summarizable) from one that might still grow. `endTs` is stripped when
// the item is returned to the client.
export type ChronicleThread = Extract<ChronicleItem, { kind: "thread" }> & {
  endTs: string;
};

// --- pure thread grouping ---------------------------------------------------

// Group spoken lines into threads (pure; no DB). Two sources fold into ONE thread
// shape:
//
//  1. `agent.spoke` events — emergent room talk. Scanned chronologically; a
//     thread is a maximal run of agent.spoke at ONE location whose consecutive
//     gaps are <= gapMs. A location change or a gap > gapMs starts a new thread.
//     Single-speaker runs are allowed (they render as a musing). Thread id is
//     deterministic: thr-<locationId>-<firstEventId>.
//
//  2. `conversation.turn` events — historical paced scenes (pre-M2.1). Grouped
//     by their `conversationId` into the same shape (id conv-<conversationId>),
//     so pre-redesign history still shows in the hub. These have no location on
//     the payload's `location` field path we rely on; the thread location is
//     taken from the event's `locationId` (the first turn that carries one).
//
// `participants` is the distinct set of speakers ordered by FIRST line. `turns`
// inline each line (agent/to/text/ts). Output is sorted by the thread's first ts.
export function groupSpokeIntoThreads(
  events: WorldEvent[],
  gapMs: number = THREAD_GAP_MS,
): ChronicleThread[] {
  const out: ChronicleThread[] = [];

  // --- 1. emergent agent.spoke runs ---
  // A run is broken by a location change or a too-large gap. We track the open
  // run's location + last ts as we scan in chronological order.
  let run: {
    firstId: string;
    locationId: LocationId;
    lastTsMs: number;
    turns: ChronicleTurn[];
    participants: AgentId[];
  } | null = null;

  const flushRun = () => {
    if (!run) return;
    out.push(threadFromRun(run.firstId, run.locationId, run.turns, run.participants));
    run = null;
  };

  const spoke = events
    .filter((e) => e.type === "agent.spoke")
    .slice()
    .sort((a, b) => tsMs(a.ts) - tsMs(b.ts));

  for (const e of spoke) {
    const p = e.payload as { agent: AgentId; location: LocationId; text: string; to?: AgentId };
    const tsMsVal = tsMs(e.ts);
    const sameRun =
      run !== null && run.locationId === p.location && tsMsVal - run.lastTsMs <= gapMs;
    if (!sameRun) {
      flushRun();
      run = {
        firstId: e.id,
        locationId: p.location,
        lastTsMs: tsMsVal,
        turns: [],
        participants: [],
      };
    }
    run!.lastTsMs = tsMsVal;
    run!.turns.push({ agent: p.agent, ...(p.to ? { to: p.to } : {}), text: p.text, ts: e.ts });
    if (!run!.participants.includes(p.agent)) run!.participants.push(p.agent);
  }
  flushRun();

  // --- 2. historical conversation.turn groups ---
  // Group by conversationId; preserve first-seen order within each group. The
  // location comes from the first turn that carries a locationId (the scene was
  // always at one location), defaulting to "town" if none did.
  const byConv = new Map<
    string,
    { firstId: string; locationId: LocationId | null; turns: ChronicleTurn[]; participants: AgentId[] }
  >();
  const convTurns = events
    .filter((e) => e.type === "conversation.turn")
    .slice()
    .sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
  for (const e of convTurns) {
    const p = e.payload as { conversationId: string; agent: AgentId; text: string };
    let g = byConv.get(p.conversationId);
    if (!g) {
      g = { firstId: e.id, locationId: (e.locationId ?? null) as LocationId | null, turns: [], participants: [] };
      byConv.set(p.conversationId, g);
    }
    if (g.locationId === null && e.locationId) g.locationId = e.locationId as LocationId;
    g.turns.push({ agent: p.agent, text: p.text, ts: e.ts });
    if (!g.participants.includes(p.agent)) g.participants.push(p.agent);
  }
  for (const [conversationId, g] of byConv) {
    out.push(
      threadFromRun(
        g.firstId,
        g.locationId ?? "town",
        g.turns,
        g.participants,
        `conv-${conversationId}`,
      ),
    );
  }

  // Sort all threads by their first turn's ts (the thread `ts`).
  out.sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
  return out;
}

// Build a ChronicleThread from a grouped run. `id` defaults to the deterministic
// thr-<location>-<firstEventId>; conversation groups pass an explicit conv-<id>.
function threadFromRun(
  firstEventId: string,
  locationId: LocationId,
  turns: ChronicleTurn[],
  participants: AgentId[],
  id?: string,
): ChronicleThread {
  return {
    kind: "thread",
    id: id ?? `thr-${locationId}-${firstEventId}`,
    ts: turns[0].ts,
    locationId,
    participants,
    summary: null, // filled lazily by the endpoint for closed threads
    turns,
    endTs: turns[turns.length - 1].ts,
  };
}

function tsMs(iso: string): number {
  return new Date(iso).getTime();
}

// --- presence pairing -------------------------------------------------------

// Derive presence beats from chat.started / chat.ended (pure). Each (agent,
// visitor) chat.started becomes one "A visitor chatted with <Agent>" beat; the
// matching chat.ended (same agent + visitor) is consumed so a closed chat yields
// exactly one beat. A chat.started with no matching end still yields a beat (the
// chat is/was live). Ordered by the start ts. Pure so the pairing is testable
// without a DB.
export function pairPresence(events: WorldEvent[], displayName: (id: AgentId) => string): ChronicleItem[] {
  const starts = events
    .filter((e) => e.type === "chat.started")
    .slice()
    .sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
  const ends = events.filter((e) => e.type === "chat.ended");
  // Consume one matching end per start (FIFO per agent+visitor key) so we don't
  // double-count; we don't actually need the end for the beat copy, only to
  // avoid emitting a second beat from it.
  const items: ChronicleItem[] = [];
  for (const e of starts) {
    const p = e.payload as { agent: AgentId; visitorId: string };
    items.push({
      kind: "presence",
      id: `pres-${e.id}`,
      ts: e.ts,
      agent: p.agent,
      line: `A visitor chatted with ${displayName(p.agent)}.`,
    });
  }
  void ends; // ends carry no extra beat — they only close the pairing conceptually
  return items;
}

// --- day window helpers -----------------------------------------------------

// The [start, end) UTC instants for a YYYY-MM-DD day. Throws on a malformed day
// so the endpoint can 400.
export function dayBounds(dayUtc: string): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayUtc)) throw new Error(`bad day: ${dayUtc}`);
  const start = new Date(`${dayUtc}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new Error(`bad day: ${dayUtc}`);
  const end = new Date(start.getTime() + 24 * 60 * 60_000);
  return { start, end };
}

// Today's YYYY-MM-DD in UTC.
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// The day a ts (ISO) falls on, in UTC.
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

// --- in-memory cache --------------------------------------------------------

const TODAY_TTL_MS = 60_000;
interface CacheEntry {
  builtAt: number;
  payload: ChronicleResponse;
  // The threads WITH their internal endTs, kept alongside the payload so the
  // endpoint can decide which threads are closed (summarizable) without
  // re-deriving them. Not part of the contract response.
  threads: ChronicleThread[];
}
const cache = new Map<string, CacheEntry>();

// The model thread summaries run on (cheap, one-line). Literal so the usage row
// records the model actually billed (mirrors chat.ts's suggested-replies model).
const SUMMARY_MODEL = "claude-haiku-4-5";

// Cap the number of summary generations per /chronicle request so a day with a
// large backlog of un-summarized threads doesn't fan out an unbounded batch of
// Haiku calls. The rest return summary: null and fill on later requests.
const SUMMARY_GEN_CAP = 5;

// --- display-name resolution ------------------------------------------------

// Static display labels (byte-stable, no DB read) — matches the chat layer's
// labels. Used for presence copy.
const AGENT_LABELS: Record<AgentId, string> = {
  career: "Career",
  researcher: "Researcher",
  builder: "Builder",
  writer: "Writer",
  hobby: "Hobby",
};

// --- buildChronicle ---------------------------------------------------------

// Assemble (or serve from cache) one day's Chronicle. `dayUtc` is YYYY-MM-DD;
// throws (→ 400 upstream) on a malformed day. Reads ONE ts-range slice of
// world_events, builds every item variant, derives the day picker, then caches:
// today for 60s, any past day forever (its events are immutable). Summaries are
// NOT generated here — `getChronicle` attaches them lazily (see chat.ts pattern).
// Returns the contract payload AND the threads-with-endTs (so the summary pass
// can tell which threads are closed without re-deriving them).
async function buildChronicle(dayUtc: string): Promise<CacheEntry> {
  const { start, end } = dayBounds(dayUtc); // throws on bad day
  const today = todayUtc();
  const isToday = dayUtc === today;

  const cached = cache.get(dayUtc);
  if (cached) {
    if (!isToday) return cached; // past days are immutable
    if (Date.now() - cached.builtAt < TODAY_TTL_MS) return cached;
  }

  // One ts-range select for the day's chronicle-relevant, non-private events.
  const rows = await db
    .select()
    .from(worldEvents)
    .where(
      and(
        gte(worldEvents.ts, start),
        lt(worldEvents.ts, end),
        inArray(worldEvents.type, [...CHRONICLE_EVENT_TYPES]),
        sql`${worldEvents.visibility} <> 'private'`,
      ),
    )
    .orderBy(asc(worldEvents.id));

  const events: WorldEvent[] = rows.map(rowToEvent);

  const displayName = (id: AgentId) => AGENT_LABELS[id] ?? id;

  // Threads (emergent + historical). Strip the internal endTs for the contract.
  const threads = groupSpokeIntoThreads(events);
  const threadItems: ChronicleItem[] = threads.map(({ endTs: _endTs, ...t }) => t);

  // Artifact items — join the artifacts table for title/kind/etc. We collect the
  // ids first, fetch them in one query, then map each created/updated event to an
  // item carrying the artifact summary. An artifact row that no longer exists is
  // skipped (the event is stale).
  const artifactEvents = events.filter(
    (e) => e.type === "artifact.created" || e.type === "artifact.updated",
  );
  const artifactSummaries = await loadArtifactSummaries(
    artifactEvents.map((e) => (e.payload as { artifactId: string }).artifactId),
  );
  const artifactItems: ChronicleItem[] = [];
  for (const e of artifactEvents) {
    const id = (e.payload as { artifactId: string }).artifactId;
    const summary = artifactSummaries.get(id);
    if (!summary) continue;
    artifactItems.push({
      kind: "artifact",
      id: `art-${e.id}`,
      ts: e.ts,
      action: e.type === "artifact.created" ? "created" : "updated",
      artifact: summary,
    });
  }

  // Bulletins.
  const bulletinItems: ChronicleItem[] = events
    .filter((e) => e.type === "bulletin.posted")
    .map((e) => {
      const p = e.payload as { artifactId: string; agent: AgentId; title: string };
      return {
        kind: "bulletin" as const,
        id: `bul-${e.id}`,
        ts: e.ts,
        agent: p.agent,
        title: p.title,
        artifactId: p.artifactId,
      };
    });

  // World effects — reuse feed.ts renderLine phrasing for the flavor line.
  const effectEvents = events.filter((e) => e.type === "world.effect");
  const effectItems: ChronicleItem[] = await Promise.all(
    effectEvents.map(async (e) => ({
      kind: "effect" as const,
      id: `eff-${e.id}`,
      ts: e.ts,
      locationId: (e.locationId ?? null) as LocationId | null,
      line: await renderLine(e),
    })),
  );

  // Presence beats from chat.started/.ended pairing.
  const presenceItems = pairPresence(events, displayName);

  const items = [
    ...threadItems,
    ...artifactItems,
    ...bulletinItems,
    ...effectItems,
    ...presenceItems,
  ].sort((a, b) => tsMs(a.ts) - tsMs(b.ts));

  const days = await availableDays();

  // `issue` is filled by getChronicle (cheap cached attach / lazy generation);
  // buildChronicle (and its cache) carry the timeline only.
  const payload: ChronicleResponse = { day: dayUtc, days, items, issue: null };
  const entry: CacheEntry = { builtAt: Date.now(), payload, threads };
  cache.set(dayUtc, entry);
  return entry;
}

// The public Chronicle read (the GET /chronicle handler). This is a PURE DB read
// on the critical path — no LLM generation blocks the response:
//
//   1. Build (or serve cached) the day's timeline.
//   2. Attach thread summaries + the Town Crier issue that are ALREADY persisted.
//   3. Fire any needed generation (closed-thread summaries + the issue) in the
//      BACKGROUND; the next fetch (the frontend live-refreshes / does a one-shot
//      follow-up) picks up the filled-in content.
//
// This is the fix for the "Chronicle takes forever / can't switch days / doesn't
// update live" symptoms: those all came from up to SUMMARY_GEN_CAP sequential
// Haiku calls PLUS a Sonnet Town-Crier generation running synchronously on every
// uncached read. Background generation is self-guarded against duplicate work
// (summaryGenInflight here; attachIssue's own in-flight + freshness + backoff),
// so a quiet day costs nothing extra. Throws on a malformed day.
export async function getChronicle(dayUtc: string): Promise<ChronicleResponse> {
  const { payload, threads } = await buildChronicle(dayUtc);

  // Attach already-persisted thread summaries (one query, no generation).
  const existing = await db
    .select({ threadId: threadSummaries.threadId, summary: threadSummaries.summary })
    .from(threadSummaries)
    .where(eq(threadSummaries.day, dayUtc));
  const summaryById = new Map(existing.map((r) => [r.threadId, r.summary]));
  for (const item of payload.items) {
    if (item.kind === "thread") item.summary = summaryById.get(item.id) ?? null;
  }

  // Attach the already-printed Town Crier issue if any (no generation here).
  let issue: ChronicleResponse["issue"] = null;
  try {
    issue = await loadCachedIssue(dayUtc);
  } catch (err) {
    console.warn(`[chronicle] issue load failed for ${dayUtc}:`, (err as Error).message);
  }

  // Kick off whatever still needs generating, off the response path.
  scheduleChronicleGeneration(dayUtc, payload.items, threads, new Set(summaryById.keys()));

  return { ...payload, issue };
}

// Per-day guard so overlapping reads don't fan out duplicate summary batches.
const summaryGenInflight = new Set<string>();

// Fire background generation for a day: closed-thread summaries (capped) and the
// Town Crier issue. Fire-and-forget — the world server is a long-lived process,
// so this keeps running after the response is sent, and its results land in
// thread_summaries / chronicle_issues for the next read. Never throws into the
// caller.
function scheduleChronicleGeneration(
  dayUtc: string,
  items: ChronicleItem[],
  threads: ChronicleThread[],
  summarizedIds: Set<string>,
): void {
  if (!hasLlm()) return;

  const candidates = closedThreadsNeedingSummary(threads, summarizedIds, Date.now()).slice(
    0,
    SUMMARY_GEN_CAP,
  );
  if (candidates.length > 0 && !summaryGenInflight.has(dayUtc)) {
    summaryGenInflight.add(dayUtc);
    void (async () => {
      try {
        for (const thread of candidates) {
          try {
            await summarizeThread(thread, dayUtc);
          } catch (err) {
            console.warn(`[chronicle] summary failed for ${thread.id}:`, (err as Error).message);
          }
        }
      } finally {
        summaryGenInflight.delete(dayUtc);
      }
    })();
  }

  // attachIssue self-guards (freshness TTL, in-flight de-dupe, failure backoff),
  // so calling it every read is cheap when the issue is already fresh.
  void attachIssue(dayUtc, items, todayUtc()).catch((err) =>
    console.warn(`[chronicle] background issue gen failed for ${dayUtc}:`, (err as Error).message),
  );
}

// Admin: force-regenerate the Town Crier issue for a day (POST /admin/chronicle/
// :day/regenerate). Builds the day's items fresh and forces a new LLM pass.
export async function regenerateDayIssue(dayUtc: string): Promise<ChronicleResponse["issue"]> {
  const { payload } = await buildChronicle(dayUtc);
  invalidateChronicleCache(dayUtc);
  return regenerateIssue(dayUtc, payload.items, todayUtc());
}

// Summarize ONE closed thread with a single Haiku call, persist it to
// thread_summaries, and return the phrase. Records usage against the daily budget
// (tickId 'chronicle-<day>', agentId = first participant — mirrors how the
// suggested-replies call attributes spend). Returns null on an empty result.
async function summarizeThread(thread: ChronicleThread, dayUtc: string): Promise<string | null> {
  const transcript = threadTranscript(thread);
  const res = await anthropic.beta.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content:
          "In at most 12 words, what was this conversation about? Reply with just the phrase.\n\n" +
          transcript,
      },
    ],
  });
  const attribution = thread.participants[0] ?? null;
  await recordChronicleUsage(attribution, dayUtc, res.usage);
  const summary = res.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!summary) return null;
  // Persist (the row is keyed on threadId; a concurrent request could race to
  // insert the same id, so we tolerate a conflict by doing nothing).
  await db
    .insert(threadSummaries)
    .values({
      threadId: thread.id,
      day: dayUtc,
      locationId: thread.locationId,
      participants: thread.participants,
      summary,
    })
    .onConflictDoNothing({ target: threadSummaries.threadId });
  // A fresh summary on TODAY would otherwise be hidden until the 60s TTL expires
  // (the cached payload is reused); evict so the next read reflects it.
  invalidateChronicleCache(dayUtc);
  return summary;
}

// Record one chronicle summary call against the daily budget (mirrors chat.ts's
// recordChatUsage). Best-effort — a recording failure never breaks the read.
async function recordChronicleUsage(
  agentId: AgentId | null,
  dayUtc: string,
  usage: Parameters<typeof tokensFromUsage>[0],
): Promise<void> {
  try {
    const t = tokensFromUsage(usage);
    await recordUsage({
      agentId,
      model: SUMMARY_MODEL,
      tickId: `chronicle-${dayUtc}`,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      estCostUsd: estimateCostUsd(SUMMARY_MODEL, t),
    });
  } catch (err) {
    console.warn(`[chronicle] usage record failed (${dayUtc}):`, (err as Error).message);
  }
}

// Distinct days (UTC, desc) that have ANY chronicle-relevant event, capped at the
// lookback window. Powers the day picker. One grouped select.
async function availableDays(): Promise<string[]> {
  const since = new Date(Date.now() - DAY_LOOKBACK * 24 * 60 * 60_000);
  const rows = await db
    .select({ day: sql<string>`to_char(${worldEvents.ts} at time zone 'UTC', 'YYYY-MM-DD')` })
    .from(worldEvents)
    .where(
      and(
        gte(worldEvents.ts, since),
        inArray(worldEvents.type, [...CHRONICLE_EVENT_TYPES]),
        sql`${worldEvents.visibility} <> 'private'`,
      ),
    )
    .groupBy(sql`to_char(${worldEvents.ts} at time zone 'UTC', 'YYYY-MM-DD')`)
    .orderBy(desc(sql`to_char(${worldEvents.ts} at time zone 'UTC', 'YYYY-MM-DD')`));
  return rows.map((r) => r.day);
}

// Fetch ArtifactSummary rows (body omitted) for a set of ids, keyed by id.
async function loadArtifactSummaries(ids: string[]): Promise<Map<string, ArtifactSummary>> {
  const map = new Map<string, ArtifactSummary>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return map;
  const rows = await db.select().from(artifacts).where(inArray(artifacts.id, unique));
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      agentId: r.agentId as ArtifactSummary["agentId"],
      kind: r.kind as ArtifactSummary["kind"],
      title: r.title,
      locationId: (r.locationId ?? null) as ArtifactSummary["locationId"],
      fixture: r.fixture ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      published: r.published,
    });
  }
  return map;
}

// Map a world_events row to the contract WorldEvent shape (mirrors events.ts;
// kept local so chronicle owns its read path).
function rowToEvent(row: typeof worldEvents.$inferSelect): WorldEvent {
  return {
    id: String(row.id),
    ts: row.ts.toISOString(),
    type: row.type as WorldEvent["type"],
    agentId: (row.agentId ?? null) as AgentId | null,
    locationId: (row.locationId ?? null) as LocationId | null,
    visitorId: row.visitorId ?? null,
    visibility: row.visibility as never,
    payload: row.payload as never,
  } as WorldEvent;
}

// Invalidate today's cache (used after a summary is written so the next read
// reflects it without waiting out the TTL). Past days are immutable; we only ever
// evict `dayUtc`.
export function invalidateChronicleCache(dayUtc: string): void {
  cache.delete(dayUtc);
}

// --- lazy thread summaries --------------------------------------------------

// Which threads in a built payload are CLOSED (can no longer grow) and lack a
// cached summary — the candidates for one Haiku summary call each. A thread is
// closed iff its last turn (endTs) is older than `gapMs` relative to `now`.
// Returns the threads (with their endTs) needing a summary, given the set of
// thread ids already summarized. Pure so the candidate selection is testable.
export function closedThreadsNeedingSummary(
  threads: ChronicleThread[],
  summarizedIds: Set<string>,
  now: number,
  gapMs: number = THREAD_GAP_MS,
): ChronicleThread[] {
  return threads.filter(
    (t) => !summarizedIds.has(t.id) && now - tsMs(t.endTs) >= gapMs,
  );
}

// A flat one-line transcript of a thread for the summary prompt.
export function threadTranscript(thread: ChronicleThread): string {
  return thread.turns
    .map((t) => `${AGENT_LABELS[t.agent] ?? t.agent}: ${t.text}`)
    .join("\n");
}
