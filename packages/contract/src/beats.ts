import { z } from "zod";

// The Director/Effect protocol catalog (Phase A, collapsed in Phase B.5). A
// **beat** is a named, versioned, parameterized, client-renderable effect the
// agent invokes BY NAME and parameterizes — drawn from this curated catalog.
// The agent can never inject arbitrary markup; it can only sequence catalog
// beats. Adding a new MECHANIC = adding a DATA row here (+ a frontend render
// branch for screen beats) — but the catalog stays deliberately SMALL and
// general (an `effect`/`style` enum param, not a beat-per-occasion), because a
// fixed, recognizable kit is what makes a bit read as intentional rather than
// a checklist (Hobby's framing, live in-chat 2026-06-30 — see the vault build
// log). Personality/variety lives in PRESETS (engine/presets.ts: a named,
// saved set of params for one of these beats — "customization within bounds",
// never a new mechanic), not in catalog growth.

export type BeatSurface = "object" | "screen";
export type BeatAudience = "room" | "visitor";

export interface BeatDef {
  id: string;
  label: string;              // short human/agent-facing name
  surface: BeatSurface;
  audience: BeatAudience;     // "room" = everyone co-located; "visitor" = directed at the answering/chatting visitor
  description: string;        // agent-facing: when/why to use it (rendered into the tool description)
  params: z.ZodTypeAny;       // validated server-side against the agent's params
}

export const BEATS = {
  // surface:"object" — one beat, the effect keyword IS the param (not the beat
  // id), so the catalog doesn't grow with every fixture in town. The keyword is
  // still a closed, validated enum reused by the frontend playEffect vocab —
  // never free text.
  "fixture-effect": {
    id: "fixture-effect", label: "Trigger a fixture effect", surface: "object", audience: "room",
    params: z.object({ effect: z.enum(["ring", "flicker", "hiss", "rustle"]) }),
    description:
      "Make a fixture here do its thing: ring a phone, flicker a lamp (flicker also works as a generic spotlight — \"look at this\" — on any object), hiss the espresso machine, rustle the notice board. Omit `object` and a sensible one here is picked automatically by what it can do.",
  },
  // surface:"screen" — one directed beat with a `style`, covering everything
  // that lands as a floating UI element on the visitor's screen.
  "screen-flourish": {
    id: "screen-flourish", label: "Flourish on the visitor's screen", surface: "screen", audience: "visitor",
    params: z.object({
      style: z.enum(["card", "confetti", "tag"]).default("card"),
      title: z.string().max(60).optional(),
      body: z.string().max(280).optional(),
      text: z.string().max(80).optional(),
      cta: z.string().max(30).optional(),
      tone: z.enum(["gag", "info", "warm"]).default("info"),
    }),
    description:
      "Cross the glass onto the visitor's screen, in one of three shapes — `card` (a titled note with optional `body`/`cta`, the most direct way to land a moment), `confetti` (a celebratory burst, `text` optional — save it for a real win), `tag` (a small floating label, e.g. introducing yourself when it's genuinely unclear who's talking — `text` defaults to your own name). Use it for a moment that lands, not as a tic.",
  },
  // surface:"screen", audience:"room" — a body-language gesture, structurally
  // different from screen-flourish (over-the-head, room-wide, not directed) so
  // it stays its own beat rather than folding in.
  "emote": {
    id: "emote", label: "Emote / gesture", surface: "screen", audience: "room",
    params: z.object({ emoji: z.string().min(1).max(8), text: z.string().max(80).optional() }),
    description: "A quick visible gesture over your head — a wave, a dap-up, a 🤝. Body language, not speech.",
  },
} satisfies Record<string, BeatDef>;

export type BeatId = keyof typeof BEATS;
export function getBeat(id: string): BeatDef | undefined { return (BEATS as Record<string, BeatDef>)[id]; }
export function listBeats(): BeatDef[] { return Object.values(BEATS); }
