import { z } from "zod";
import { AgentId } from "./ids.js";

// Shareable cards (M2.2 — Part 4). A ShareCard is the one card UI both the chat
// stream and the portfolio surfaces render: a concrete, visitor-safe object an
// agent can drop into a conversation (its own artifact, another agent's
// artifact, a curated external project/reference, or a portfolio proof). The
// SERVER builds and validates every card from real records — agents reference
// things by id, never by raw URL, so a visitor can never coax an arbitrary link
// out of the share tool (design "prose by LLM, sources by server").

export const ShareCardKind = z.enum([
  "artifact",
  "chronicle_thread",
  "portfolio_proof",
  "external_reference",
  "agent_profile",
]);
export type ShareCardKind = z.infer<typeof ShareCardKind>;

// One action button on a card. `kind` distinguishes an internal overlay route
// (open the artifact reader / about panel) from an external link (open in a new
// tab). `href` for internal actions is an app-relative token the frontend
// resolves (e.g. "artifact:<id>", "proof:<id>", "reference:<id>"); for external
// actions it's the validated public URL.
export const ShareCardAction = z.object({
  label: z.string(),
  href: z.string(),
  kind: z.enum(["internal", "external"]),
});
export type ShareCardAction = z.infer<typeof ShareCardAction>;

export const ShareCard = z.object({
  id: z.string(),
  kind: ShareCardKind,
  title: z.string(),
  subtitle: z.string().nullable(),
  summary: z.string(),
  // The agent who shared it (drives the card's color accent). Null for a card
  // not attributed to one facet.
  agentId: AgentId.nullable(),
  color: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  // A short human label for the source ("Project", "Research Note", "Proof").
  sourceLabel: z.string(),
  actions: z.array(ShareCardAction),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ShareCard = z.infer<typeof ShareCard>;
