// Agent-saved beat presets — "customization within bounds, not raw authoring
// power" (Hobby's framing, live in-chat 2026-06-30). A preset is a NAMED set of
// params for one EXISTING catalog beat; it can never define a new mechanic or
// surface — both save and play re-validate the params against that beat's own
// zod schema, so a preset is exactly as safe as calling the beat directly. One
// name per agent (re-saving overwrites, enforced by a DB unique index).

import { and, eq } from "drizzle-orm";
import type { AgentId } from "@town/contract";
import { getBeat } from "@town/contract";
import { db, schema } from "../db/client.js";

const { agentPresets } = schema;

export type PresetRow = typeof agentPresets.$inferSelect;

export type SavePresetResult =
  | { ok: true; preset: PresetRow }
  | { ok: false; reason: string };

// Validates `beat` exists and `params` satisfies its schema BEFORE writing —
// the same check play_beat itself does, so a saved preset can never go stale
// into something invalid (a beat whose schema later tightens still rejects an
// old preset at PLAY time too — see resolvePreset below).
export async function savePreset(
  agentId: AgentId,
  name: string,
  beat: string,
  params: Record<string, unknown>,
): Promise<SavePresetResult> {
  const beatDef = getBeat(beat);
  if (!beatDef) return { ok: false, reason: `There's no bit called "${beat}" to save a preset of.` };
  const parsed = beatDef.params.safeParse(params ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.length ? `"${issue.path.join(".")}": ` : "";
    return { ok: false, reason: `That preset won't save — ${where}${issue?.message ?? "the details don't fit"}.` };
  }
  const [row] = await db
    .insert(agentPresets)
    .values({ agentId, name, beat, params: parsed.data })
    .onConflictDoUpdate({
      target: [agentPresets.agentId, agentPresets.name],
      set: { beat, params: parsed.data, updatedAt: new Date() },
    })
    .returning();
  return { ok: true, preset: row };
}

export async function getPreset(agentId: AgentId, name: string): Promise<PresetRow | undefined> {
  const [row] = await db
    .select()
    .from(agentPresets)
    .where(and(eq(agentPresets.agentId, agentId), eq(agentPresets.name, name)));
  return row;
}

export async function listPresetsFor(agentId: AgentId): Promise<PresetRow[]> {
  return db.select().from(agentPresets).where(eq(agentPresets.agentId, agentId));
}

export async function deletePreset(agentId: AgentId, name: string): Promise<boolean> {
  const res = await db
    .delete(agentPresets)
    .where(and(eq(agentPresets.agentId, agentId), eq(agentPresets.name, name)))
    .returning({ id: agentPresets.id });
  return res.length > 0;
}
