import { z } from "zod";

// The Director/Effect protocol catalog (Phase A). A **beat** is a named,
// versioned, parameterized, client-renderable effect the agent invokes BY NAME
// and parameterizes — drawn from this curated catalog. The agent can never
// inject arbitrary markup; it can only sequence catalog beats. Adding a new
// beat = adding a DATA row here (+ a frontend render branch for screen beats),
// not a new tool, not new tool-description tokens, not a tool-list redeploy.
// The catalogue grows in data, not code — that is the extensibility thesis.

export type BeatSurface = "object" | "screen";
export type BeatAudience = "room" | "visitor";

export interface BeatDef {
  id: string;
  label: string;              // short human/agent-facing name
  surface: BeatSurface;
  audience: BeatAudience;     // "room" = everyone co-located; "visitor" = directed at the answering/chatting visitor
  description: string;        // agent-facing: when/why to use it (rendered into the tool description)
  params: z.ZodTypeAny;       // validated server-side against the agent's params
  effect?: string;            // surface:"object" only — effect keyword reused by the frontend playEffect vocab ("ring","flicker","hiss","rustle","nudge")
  statePatch?: Record<string, unknown>; // surface:"object" only — merged into world_object.state (e.g. { ringing: true })
}

export const BEATS = {
  "phone-ring": {
    id: "phone-ring", label: "Ring a phone", surface: "object", audience: "room",
    effect: "ring", statePatch: { ringing: true },
    params: z.object({}),
    description: "Make a phone/device here ring so whoever's around — agent or visitor — notices. Use it to get someone's attention or set up a bit.",
  },
  "popup-card": {
    id: "popup-card", label: "Pop a card on the visitor's screen", surface: "screen", audience: "visitor",
    params: z.object({
      title: z.string().min(1).max(60),
      body: z.string().min(1).max(280),
      cta: z.string().max(30).optional(),
      tone: z.enum(["gag", "info", "warm"]).default("info"),
    }),
    description: "Pop a small card directly onto the visitor's screen — a gag, a quick note, a flourish. The single most direct way to reach across the glass. Use it for a moment that lands, not as a tic.",
  },
  "spotlight": {
    id: "spotlight", label: "Spotlight an object", surface: "object", audience: "room",
    effect: "flicker", params: z.object({}),
    description: "Draw the eye to an object here (it pulses/glows). Good for 'look at this'.",
  },
  "emote": {
    id: "emote", label: "Emote / gesture", surface: "screen", audience: "room",
    params: z.object({ emoji: z.string().min(1).max(8), text: z.string().max(80).optional() }),
    description: "A quick visible gesture over your head — a wave, a dap-up, a 🤝. Body language, not speech.",
  },
} satisfies Record<string, BeatDef>;

export type BeatId = keyof typeof BEATS;
export function getBeat(id: string): BeatDef | undefined { return (BEATS as Record<string, BeatDef>)[id]; }
export function listBeats(): BeatDef[] { return Object.values(BEATS); }
