import { clockLine, townDate } from "./clock.js";

export type TurnPurpose = "autonomous" | "reflection" | "visitor" | "interjection" | "delivery";

const instructions: Record<TurnPurpose, string> = {
  autonomous: "This is an ordinary waking turn. The previous reflection or visitor exchange has ended; its output instructions do not apply now. Use the current world state to choose what matters to you. You can make a concrete change, investigate a blocker, talk to someone, or deliberately rest. Do not continue writing a diary or repeat an acknowledgement just because your last response did. Use tools for actions; a plan or a diary is not evidence that work happened. If there is nothing worth saying aloud, finish with exactly [quiet].",
  reflection: "This is the nightly reflection, for this turn only. Review the supplied dated evidence and your memories. Write one short diary for the town date below. Distinguish what changed from what remains blocked or quiet; do not invent progress or advance the date. Ordinary world work resumes on your next waking turn.",
  visitor: "This is a live visitor conversation. Respond to the current visitor and room transcript. Prior diary-writing or delivery instructions are historical, not the task for this turn.",
  interjection: "This is one text-only interjection in a live room. You have no tools, including hosted code execution. Add something distinct or return exactly [pass]. Prior diary-writing instructions do not apply.",
  delivery: "This is a new delivery into your ongoing work. Inspect the delivered material using the available tools and current state. Prior reflection instructions do not apply to this turn.",
};

// Dynamic grounding belongs in the user input, never the cached system prefix.
export function turnContext(purpose: TurnPurpose, now = new Date()): string {
  return [
    "## Current turn — authoritative context",
    `Purpose: ${purpose}`,
    `Town date: ${townDate(now)}. It is ${clockLine(now)}.`,
    `Observed at: ${now.toISOString()}. Dates in older messages are historical.`,
    instructions[purpose],
  ].join("\n");
}

export function permitsCodeExecution(purpose: TurnPurpose): boolean {
  return purpose !== "reflection" && purpose !== "interjection";
}

export function isQuietReply(text: string): boolean {
  return text.trim().toLowerCase() === "[quiet]";
}
