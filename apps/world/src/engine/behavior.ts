// Behavior quality is separate from successful API calls and process liveness.
// This bounded public-event assessment is diagnostic, never an automatic reset.
import type { AgentId } from "@town/contract";
import { recentEventsForAgent } from "./events.js";
import { townDate } from "../runtime/clock.js";

export interface BehaviorEvent {
  ts: string;
  type: string;
  visibility?: string;
  payload: Record<string, unknown>;
}

export interface BehaviorAssessment {
  status: "active" | "quiet" | "stalled" | "unknown";
  reasons: string[];
  sampledEvents: number;
  since: string | null;
  lastMeaningfulAt: string | null;
  repeatedUtterances: number;
  futureDiaryDates: number;
}

const changes = new Set([
  "agent.moved", "message.sent", "artifact.updated", "artifact.state_changed",
  "object.created", "object.removed", "object.moved", "object.state_changed",
  "object.attached", "object.noted", "bulletin.posted", "capability.requested",
  "capability.resolved", "conversation.started",
]);

function meaningful(event: BehaviorEvent): boolean {
  return changes.has(event.type) || (event.type === "artifact.created" &&
    event.payload.kind !== "diary_entry" && event.payload.kind !== "daily_digest");
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean));
}

function similar(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  const common = [...x].filter((word) => y.has(word)).length;
  return common / new Set([...x, ...y]).size >= 0.85;
}

export function assessBehavior(events: BehaviorEvent[], now = new Date()): BehaviorAssessment {
  const recent = events.filter((e) => e.visibility !== "private" &&
    Date.parse(e.ts) >= now.getTime() - 7 * 86_400_000 && Date.parse(e.ts) <= now.getTime())
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const progress = recent.filter(meaningful).at(-1);
  const speech = recent.filter((e) => (e.type === "agent.spoke" || e.type === "agent.thought") &&
    typeof e.payload.text === "string").slice(-6);
  const last = speech.at(-1);
  const repeated = last ? speech.filter((e) => similar(String(e.payload.text), String(last.payload.text))) : [];
  const noProgressDuringRepeat = !progress || Date.parse(progress.ts) < Date.parse(repeated[0]?.ts ?? last?.ts ?? "");
  const futureDates = speech.filter((e) => {
    const date = /^\s*Diary\s*[—–:-]\s*(\d{4}-\d{2}-\d{2})/i.exec(String(e.payload.text))?.[1];
    return date != null && date > townDate(new Date(e.ts));
  }).length;
  const reasons: string[] = [];
  if (repeated.length >= 3 && noProgressDuringRepeat) {
    reasons.push(`${repeated.length} of the last ${speech.length} utterances repeat without a meaningful world change between them.`);
  }
  if (futureDates) reasons.push(`${futureDates} recent diary utterance(s) claim a date later than the actual town date.`);
  const activity = recent.filter((e) => e.type === "agent.activity").at(-1);
  if (activity && now.getTime() - Date.parse(activity.ts) > 86_400_000) {
    reasons.push("The activity label has not changed for more than a day in this sample.");
  }
  const stalled = (repeated.length >= 3 && noProgressDuringRepeat) || futureDates >= 2;
  if (recent.length && !progress) reasons.push("No meaningful world change in the sampled public events; diaries and activity labels do not count as progress.");
  return {
    status: stalled ? "stalled" : progress ? "active" : recent.length ? "quiet" : "unknown",
    reasons, sampledEvents: recent.length, since: recent[0]?.ts ?? null,
    lastMeaningfulAt: progress?.ts ?? null,
    repeatedUtterances: repeated.length, futureDiaryDates: futureDates,
  };
}

export async function behaviorForAgent(agentId: AgentId, now = new Date()): Promise<BehaviorAssessment> {
  return assessBehavior(await recentEventsForAgent(agentId, 100), now);
}

export function behaviorContext(assessment: BehaviorAssessment): string {
  return [
    "## Recent behavior — observed evidence, not an instruction to perform",
    `Assessment: ${assessment.status}. Last meaningful change in the sample: ${assessment.lastMeaningfulAt ?? "none observed"}.`,
    ...assessment.reasons,
    "If blocked, check whether the blocker still exists, ask the relevant person a specific question, or choose another thing you care about. Do not invent accomplishments, move just to satisfy a metric, or repeat a diary. Quiet is allowed.",
  ].join("\n");
}
