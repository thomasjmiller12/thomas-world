// The LLM Town Crier (M2.2 — Part 1). Turns a day of the town's life into a
// newspaper issue: editorial prose written by the model from a BOUNDED source
// packet the server builds, with every concrete claim tied to a validated
// citation. The model writes the voice; the SERVER owns source selection,
// citation validation, persistence, and the deterministic fallback (design
// "prose by LLM, sources by server").
//
// Flow (per /chronicle read):
//   1. buildSourcePacket(day, items, artifactBodies) → bounded sources w/ S-ids.
//   2. load chronicle_issues[day]; if fresh, return it.
//   3. else generate (LLM) → validate citations (retry once) → persist; on any
//      failure, persist+return a deterministic fallback. No LLM at all → fallback.
//   4. empty day → an honest "quiet day" issue, pointing at the latest real one.

import * as z from "zod/v4";
import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type {
  AgentId,
  LocationId,
  ChronicleItem,
  ChronicleIssue,
  ChronicleCitation,
  ChronicleCitationKind,
  ChronicleIssueSection,
} from "@town/contract";
import type Anthropic from "@anthropic-ai/sdk";
import { db, schema } from "../db/client.js";
import { anthropic, hasLlm } from "../runtime/client.js";
import { recordUsage } from "./usage.js";
import { estimateCostUsd, tokensFromUsage } from "../runtime/pricing.js";

const { chronicleIssues, artifacts } = schema;

// The model the Town Crier writes on. Sonnet for voice quality — generation is
// lazy/nightly, so latency isn't the constraint (plan §"Target model").
const CRIER_MODEL = "claude-sonnet-4-6";
// Bump when the prompt/schema changes so stale cached issues can be told apart.
export const PROMPT_VERSION = "crier-2026-06-20";

// How long today's issue is considered fresh before a regenerate is allowed (it
// keeps developing through the day). Past days are immutable once printed.
const TODAY_TTL_MS = 30 * 60_000;
// Cap on sources handed to the model (the LLM sees summaries + short excerpts,
// never unbounded logs).
const MAX_SOURCES = 24;

const AGENT_LABELS: Record<AgentId, string> = {
  career: "Career",
  researcher: "Researcher",
  builder: "Builder",
  writer: "Writer",
  hobby: "Hobby",
};
const LOCATION_LABELS: Record<LocationId, string> = {
  town: "the town square",
  office: "the office",
  library: "the library",
  workshop: "the workshop",
  cafe: "the cafe",
  park: "the park",
};

// --- source packet ----------------------------------------------------------

export interface ChronicleSource {
  id: string; // "S1", "S2", ...
  kind: "thread" | "artifact" | "bulletin" | "presence" | "effect" | "message" | "external_reference";
  targetId: string;
  ts: string;
  title: string;
  summary: string;
  excerpt?: string;
  agentIds: AgentId[];
  locationId?: LocationId | null;
}

export interface ChronicleSourcePacket {
  day: string;
  sources: ChronicleSource[];
  sourceIds: string[];
  counts: { threads: number; artifacts: number; bulletins: number; visitors: number; effects: number };
}

// Build the bounded source packet from the day's already-assembled ChronicleItems
// plus a map of artifact bodies (for excerpts). Selection (design §"Source
// selection rules"): all artifacts + bulletins; multi-turn threads first, single-
// agent musings only if the day is otherwise sparse; presence beats and a few
// effects; private events are already excluded upstream. Capped at MAX_SOURCES.
export function buildSourcePacket(
  day: string,
  items: ChronicleItem[],
  artifactBodies: Map<string, string>,
): ChronicleSourcePacket {
  const counts = { threads: 0, artifacts: 0, bulletins: 0, visitors: 0, effects: 0 };
  const threads = items.filter((i): i is Extract<ChronicleItem, { kind: "thread" }> => i.kind === "thread");
  const multi = threads.filter((t) => t.participants.length > 1 || t.turns.length > 2);
  const solo = threads.filter((t) => !(t.participants.length > 1 || t.turns.length > 2));
  const artifactItems = items.filter((i): i is Extract<ChronicleItem, { kind: "artifact" }> => i.kind === "artifact");
  const bulletinItems = items.filter((i): i is Extract<ChronicleItem, { kind: "bulletin" }> => i.kind === "bulletin");
  const effectItems = items.filter((i): i is Extract<ChronicleItem, { kind: "effect" }> => i.kind === "effect");
  const presenceItems = items.filter((i): i is Extract<ChronicleItem, { kind: "presence" }> => i.kind === "presence");

  const sources: ChronicleSource[] = [];

  const pushThread = (t: Extract<ChronicleItem, { kind: "thread" }>) => {
    counts.threads++;
    const names = t.participants.map((p) => AGENT_LABELS[p] ?? p);
    const where = LOCATION_LABELS[t.locationId] ?? t.locationId;
    const excerpt = t.turns
      .slice(0, 4)
      .map((tn) => `${AGENT_LABELS[tn.agent] ?? tn.agent}: ${tn.text}`)
      .join("\n");
    sources.push({
      id: "",
      kind: "thread",
      targetId: t.id,
      ts: t.ts,
      title: `${names.join(" & ") || "Someone"} at ${where}`,
      summary: t.summary ?? `${t.turns.length} turns of room talk at ${where}.`,
      excerpt,
      agentIds: t.participants,
      locationId: t.locationId,
    });
  };

  for (const a of artifactItems) {
    counts.artifacts++;
    const body = artifactBodies.get(a.artifact.id) ?? "";
    sources.push({
      id: "",
      kind: "artifact",
      targetId: a.artifact.id,
      ts: a.ts,
      title: a.artifact.title,
      summary: `${a.action === "updated" ? "Revised" : "Made"} a ${a.artifact.kind.replace(/_/g, " ")} by ${AGENT_LABELS[a.artifact.agentId as AgentId] ?? a.artifact.agentId}.`,
      excerpt: snippet(body, 240),
      agentIds: [a.artifact.agentId as AgentId],
      locationId: a.artifact.locationId,
    });
  }
  for (const b of bulletinItems) {
    counts.bulletins++;
    sources.push({
      id: "",
      kind: "bulletin",
      targetId: b.artifactId,
      ts: b.ts,
      title: b.title,
      summary: `Bulletin pinned to the town board by ${AGENT_LABELS[b.agent] ?? b.agent}.`,
      excerpt: snippet(artifactBodies.get(b.artifactId) ?? "", 240),
      agentIds: [b.agent],
      locationId: "town",
    });
  }
  for (const t of multi) pushThread(t);
  for (const p of presenceItems) {
    counts.visitors++;
    sources.push({
      id: "",
      kind: "presence",
      targetId: p.id,
      ts: p.ts,
      title: p.line,
      summary: p.line,
      agentIds: [p.agent],
    });
  }
  // Solo musings only if the day is otherwise sparse.
  if (sources.length < 8) for (const t of solo) pushThread(t);
  for (const e of effectItems.slice(0, 4)) {
    counts.effects++;
    sources.push({
      id: "",
      kind: "effect",
      targetId: e.id,
      ts: e.ts,
      title: e.line,
      summary: e.line,
      agentIds: [],
      locationId: e.locationId,
    });
  }

  // Stamp stable ids in ts order, cap.
  sources.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const capped = sources.slice(0, MAX_SOURCES);
  capped.forEach((s, i) => (s.id = `S${i + 1}`));
  return { day, sources: capped, sourceIds: capped.map((s) => s.id), counts };
}

function snippet(md: string, max = 200): string {
  const plain = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~]/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + "…" : plain;
}

// --- citation resolution ----------------------------------------------------

function citationKindFor(kind: ChronicleSource["kind"]): ChronicleCitationKind {
  switch (kind) {
    case "artifact":
    case "bulletin":
      return "artifact";
    case "thread":
      return "thread";
    case "message":
      return "message";
    case "external_reference":
      return "external_reference";
    default:
      return "event";
  }
}

function hrefFor(source: ChronicleSource): string | undefined {
  if (source.kind === "artifact" || source.kind === "bulletin") return `artifact:${source.targetId}`;
  if (source.kind === "thread") return `thread:${source.targetId}`;
  if (source.kind === "external_reference") return `reference:${source.targetId}`;
  return undefined;
}

function citationFromSource(source: ChronicleSource): ChronicleCitation {
  return {
    id: source.id,
    kind: citationKindFor(source.kind),
    targetId: source.targetId,
    label: source.title,
    excerpt: source.excerpt ?? source.summary,
    href: hrefFor(source),
  };
}

// Every [Sn] marker appearing anywhere in the issue prose.
function markersIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\[(S\d+)\]/g)) out.add(m[1]);
  return [...out];
}

// --- LLM generation ---------------------------------------------------------

const GeneratedIssue = z.object({
  title: z.string().min(1).max(90),
  subtitle: z.string().max(180).nullable(),
  lead: z.object({ bodyMd: z.string().min(1), citationIds: z.array(z.string()) }),
  sections: z
    .array(z.object({ id: z.string(), title: z.string(), bodyMd: z.string(), citationIds: z.array(z.string()) }))
    .max(6),
});
type GeneratedIssue = z.infer<typeof GeneratedIssue>;

const SYSTEM = `You are The Town Crier for Thomas's Town — a small, slightly whimsical AI village where five facets of one person (Career, Researcher, Builder, Writer, Hobby) live, work, talk, and make things on their own.

Write a compact newspaper issue for the given day in the Town Crier's voice: specific, warm, a little literary, never marketing-y. Every concrete claim about something that happened must cite one or more source ids inline as markers like [S3]. Use only the sources provided. Do NOT invent URLs, projects, artifacts, visitors, messages, or agent actions. If the day is sparse, write an honest quiet-day issue. Markers go inline in the prose right after the claim they support.

Return ONLY a JSON object, no prose around it, matching:
{
  "title": string (<=90 chars, a real headline for the day),
  "subtitle": string|null (a dek, <=180 chars),
  "lead": { "bodyMd": string (1-3 short paragraphs, the lead story, markdown, with [Sn] markers), "citationIds": string[] (the S-ids used in the lead) },
  "sections": [ { "id": string (slug like "around-town"), "title": string (e.g. "Around Town", "Made Today", "Overheard", "From the Workbench"), "bodyMd": string (markdown with [Sn] markers), "citationIds": string[] } ]  // up to 6, omit if nothing fits
}`;

function renderPacket(packet: ChronicleSourcePacket): string {
  const lines = packet.sources.map((s) => {
    const who = s.agentIds.map((a) => AGENT_LABELS[a] ?? a).join(", ");
    const ex = s.excerpt ? `\n   excerpt: ${s.excerpt}` : "";
    return `${s.id} [${s.kind}${who ? ` · ${who}` : ""}] ${s.title}\n   ${s.summary}${ex}`;
  });
  const c = packet.counts;
  return (
    `Day: ${packet.day}\n` +
    `Counts: ${c.threads} conversations, ${c.artifacts} things made, ${c.bulletins} bulletins, ${c.visitors} visitor beats, ${c.effects} world effects.\n\n` +
    `Sources:\n${lines.join("\n\n")}`
  );
}

// One generation attempt. Returns the parsed+citation-validated issue, or throws
// with feedback describing the invalid citation ids (so the retry can fix them).
async function generateOnce(
  packet: ChronicleSourcePacket,
  feedback: string | null,
): Promise<GeneratedIssue> {
  const valid = new Set(packet.sourceIds);
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: renderPacket(packet) },
  ];
  if (feedback) messages.push({ role: "user", content: feedback });

  const res = await anthropic.messages.create({
    model: CRIER_MODEL,
    max_tokens: 1600,
    system: SYSTEM,
    messages,
  });
  await recordCrierUsage(packet.day, res.usage);

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  const json = extractJson(text);
  const parsed = GeneratedIssue.parse(json);

  // Validate every marker (in prose) AND declared citationId resolves to a real
  // source. An unknown id is a hard error → caller retries / falls back.
  const allText = [parsed.lead.bodyMd, ...parsed.sections.map((s) => s.bodyMd)].join("\n");
  const allIds = new Set([
    ...markersIn(allText),
    ...parsed.lead.citationIds,
    ...parsed.sections.flatMap((s) => s.citationIds),
  ]);
  const bad = [...allIds].filter((id) => !valid.has(id));
  if (bad.length) throw new Error(`unknown citation ids: ${bad.join(", ")}`);
  return parsed;
}

function extractJson(text: string): unknown {
  // Tolerate a code fence or stray prose around the object.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(raw.slice(start, end + 1));
}

// Compose the contract ChronicleIssue from a generated issue + the packet (only
// the cited sources become citations).
function composeIssue(
  day: string,
  gen: GeneratedIssue,
  packet: ChronicleSourcePacket,
): ChronicleIssue {
  const byId = new Map(packet.sources.map((s) => [s.id, s]));
  const allText = [gen.lead.bodyMd, ...gen.sections.map((s) => s.bodyMd)].join("\n");
  const citedIds = new Set([
    ...markersIn(allText),
    ...gen.lead.citationIds,
    ...gen.sections.flatMap((s) => s.citationIds),
  ]);
  const citations: ChronicleCitation[] = [...citedIds]
    .map((id) => byId.get(id))
    .filter((s): s is ChronicleSource => Boolean(s))
    .map(citationFromSource);
  const sections: ChronicleIssueSection[] = gen.sections.map((s) => ({
    id: s.id,
    title: s.title,
    bodyMd: s.bodyMd,
    citationIds: s.citationIds.filter((id) => citedIds.has(id)),
  }));
  return {
    day,
    status: "ready",
    title: gen.title,
    subtitle: gen.subtitle,
    byline: "The Town Crier",
    bodyMd: gen.lead.bodyMd,
    sections,
    citations,
    generatedAt: new Date().toISOString(),
  };
}

// --- fallback + empty -------------------------------------------------------

// A deterministic issue from the packet (no LLM) — keeps the UI shaped when the
// model is unavailable or generation fails. Bullets from source summaries, all
// validly cited.
export function fallbackIssue(day: string, packet: ChronicleSourcePacket): ChronicleIssue {
  if (packet.sources.length === 0) return emptyIssue(day, null);
  const top = packet.sources[0];
  const c = packet.counts;
  const bullets = packet.sources
    .slice(0, 10)
    .map((s) => `- ${s.title} [${s.id}]`)
    .join("\n");
  const subtitleBits = [
    c.artifacts ? `${c.artifacts} made` : null,
    c.threads ? `${c.threads} ${c.threads === 1 ? "conversation" : "conversations"}` : null,
    c.bulletins ? `${c.bulletins} bulletin${c.bulletins === 1 ? "" : "s"}` : null,
    c.visitors ? `${c.visitors} visitor${c.visitors === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return {
    day,
    status: "fallback",
    title: top.title,
    subtitle: subtitleBits.length ? subtitleBits.join(" · ") : null,
    byline: "The Town Crier",
    bodyMd: `The presses ran light today. Here's what happened around town:\n\n${bullets}`,
    sections: [],
    citations: packet.sources.slice(0, 10).map(citationFromSource),
    generatedAt: new Date().toISOString(),
  };
}

function emptyIssue(day: string, latestMeaningfulDay: string | null): ChronicleIssue {
  return {
    day,
    status: "empty",
    title: "The presses are waiting on today's story",
    subtitle: null,
    byline: "The Town Crier",
    bodyMd: "It's quiet around town so far today. Check back once the residents get going — or read the latest issue.",
    sections: [],
    citations: [],
    generatedAt: null,
    latestMeaningfulDay,
  };
}

// --- persistence ------------------------------------------------------------

function rowToIssue(r: typeof chronicleIssues.$inferSelect): ChronicleIssue {
  return {
    day: r.day,
    status: r.status as ChronicleIssue["status"],
    title: r.title,
    subtitle: r.subtitle ?? null,
    byline: r.byline,
    bodyMd: r.bodyMd,
    sections: (r.sections ?? []) as ChronicleIssueSection[],
    citations: (r.citations ?? []) as ChronicleCitation[],
    generatedAt: r.generatedAt ? r.generatedAt.toISOString() : null,
  };
}

async function loadIssueRow(day: string) {
  const [r] = await db.select().from(chronicleIssues).where(eq(chronicleIssues.day, day));
  return r ?? null;
}

async function persistIssue(
  issue: ChronicleIssue,
  packet: ChronicleSourcePacket,
  model: string | null,
): Promise<void> {
  const values = {
    day: issue.day,
    status: issue.status,
    title: issue.title,
    subtitle: issue.subtitle,
    byline: issue.byline,
    bodyMd: issue.bodyMd,
    sections: issue.sections,
    citations: issue.citations,
    sourceEventIds: packet.sources.filter((s) => s.kind === "effect" || s.kind === "presence").map((s) => s.targetId),
    sourceArtifactIds: packet.sources.filter((s) => s.kind === "artifact" || s.kind === "bulletin").map((s) => s.targetId),
    sourceThreadIds: packet.sources.filter((s) => s.kind === "thread").map((s) => s.targetId),
    sourceReferenceIds: packet.sources.filter((s) => s.kind === "external_reference").map((s) => s.targetId),
    model,
    promptVersion: PROMPT_VERSION,
    generatedAt: new Date(),
    updatedAt: new Date(),
  };
  await db
    .insert(chronicleIssues)
    .values(values)
    .onConflictDoUpdate({ target: chronicleIssues.day, set: { ...values } });
}

// Most recent day (< `day`) that has a non-empty issue — for the quiet-day link.
async function latestMeaningfulDay(day: string): Promise<string | null> {
  const [r] = await db
    .select({ day: chronicleIssues.day })
    .from(chronicleIssues)
    .where(and(lt(chronicleIssues.day, day), ne(chronicleIssues.status, "empty")))
    .orderBy(desc(chronicleIssues.day))
    .limit(1);
  return r?.day ?? null;
}

// Fetch artifact bodies for the artifact/bulletin sources in the items.
async function artifactBodiesFor(items: ChronicleItem[]): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const i of items) {
    if (i.kind === "artifact") ids.add(i.artifact.id);
    else if (i.kind === "bulletin") ids.add(i.artifactId);
  }
  const map = new Map<string, string>();
  if (ids.size === 0) return map;
  const rows = await db.select({ id: artifacts.id, body: artifacts.body }).from(artifacts).where(inArray(artifacts.id, [...ids]));
  for (const r of rows) map.set(r.id, r.body);
  return map;
}

// In-flight de-dupe: concurrent /chronicle reads for the same day share one
// generation (the SSE-era thundering herd).
const inflight = new Map<string, Promise<ChronicleIssue>>();
// Per-day backoff after a failed attempt so a broken day doesn't re-spend on
// every request.
const lastAttempt = new Map<string, number>();

// The public entry the chronicle endpoint calls: return the day's issue, building
// it if needed. `todayUtc` lets the caller mark which day is "today" (mutable).
export async function attachIssue(
  day: string,
  items: ChronicleItem[],
  todayUtc: string,
  opts: { force?: boolean } = {},
): Promise<ChronicleIssue> {
  const isToday = day === todayUtc;
  const existing = await loadIssueRow(day);

  if (existing && !opts.force) {
    if (!isToday) return rowToIssue(existing); // past days are immutable once printed
    const fresh = Date.now() - existing.generatedAt.getTime() < TODAY_TTL_MS;
    const samePrompt = existing.promptVersion === PROMPT_VERSION;
    if (fresh && samePrompt) return rowToIssue(existing);
  }

  // Backoff: don't reattempt a day more than once per TTL on repeated failure
  // (unless forced by admin regenerate).
  if (!opts.force) {
    const last = lastAttempt.get(day) ?? 0;
    if (Date.now() - last < TODAY_TTL_MS && existing) return rowToIssue(existing);
  }

  if (inflight.has(day) && !opts.force) return inflight.get(day)!;

  const run = (async (): Promise<ChronicleIssue> => {
    lastAttempt.set(day, Date.now());
    const bodies = await artifactBodiesFor(items);
    const packet = buildSourcePacket(day, items, bodies);

    if (packet.sources.length === 0) {
      const issue = emptyIssue(day, await latestMeaningfulDay(day));
      await persistIssue(issue, packet, null);
      return issue;
    }

    if (!hasLlm()) {
      const issue = existing ? rowToIssue(existing) : fallbackIssue(day, packet);
      if (!existing) await persistIssue(issue, packet, null);
      return issue;
    }

    try {
      let gen: GeneratedIssue;
      try {
        gen = await generateOnce(packet, null);
      } catch (firstErr) {
        gen = await generateOnce(
          packet,
          `Your previous attempt had a problem: ${(firstErr as Error).message}. Only cite source ids that appear in the Sources list. Return corrected JSON.`,
        );
      }
      const issue = composeIssue(day, gen, packet);
      await persistIssue(issue, packet, CRIER_MODEL);
      return issue;
    } catch (err) {
      console.warn(`[crier] generation failed for ${day}:`, (err as Error).message);
      const issue = existing ? rowToIssue(existing) : fallbackIssue(day, packet);
      await persistIssue(issue, packet, null);
      return issue;
    }
  })();

  inflight.set(day, run);
  try {
    return await run;
  } finally {
    inflight.delete(day);
  }
}

// Admin regenerate (POST /admin/chronicle/:day/regenerate). Forces a fresh build.
export async function regenerateIssue(day: string, items: ChronicleItem[], todayUtc: string): Promise<ChronicleIssue> {
  return attachIssue(day, items, todayUtc, { force: true });
}

async function recordCrierUsage(
  day: string,
  usage: Parameters<typeof tokensFromUsage>[0],
): Promise<void> {
  try {
    const t = tokensFromUsage(usage);
    await recordUsage({
      agentId: null,
      model: CRIER_MODEL,
      tickId: `crier-${day}`,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      estCostUsd: estimateCostUsd(CRIER_MODEL, t),
    });
  } catch (err) {
    console.warn(`[crier] usage record failed (${day}):`, (err as Error).message);
  }
}

// Test seam.
export function _resetCrierCachesForTest(): void {
  inflight.clear();
  lastAttempt.clear();
}
