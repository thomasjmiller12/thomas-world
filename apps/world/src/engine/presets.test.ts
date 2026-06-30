import { describe, it, expect, beforeEach, vi } from "vitest";

// engine/presets.ts tests — an in-memory mock of the one table this module
// touches (agent_presets), mirroring objects.test.ts's db-mock approach. Uses
// the REAL @town/contract BEATS catalog (pure, no DB) so validation against a
// beat's actual zod schema runs end to end, not just a stub.

interface PresetRow {
  id: string;
  agentId: string;
  name: string;
  beat: string;
  params: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const rows: PresetRow[] = [];
let nextId = 1;

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ __eq: [col, val] }),
  and: (...conds: unknown[]) => ({ __and: conds }),
}));

function matches(row: PresetRow, conds: unknown): boolean {
  const c = conds as { __and?: unknown[]; __eq?: [unknown, unknown] };
  if (c.__and) return c.__and.every((x) => matches(row, x));
  if (c.__eq) {
    const [col, val] = c.__eq;
    if (col === agentPresetsCols.agentId) return row.agentId === val;
    if (col === agentPresetsCols.name) return row.name === val;
  }
  return true;
}

const agentPresetsCols = { agentId: "agentId", name: "name" };

vi.mock("../db/client.js", () => {
  const agentPresets = agentPresetsCols;
  const db = {
    insert() {
      return {
        values(v: { agentId: string; name: string; beat: string; params: unknown }) {
          return {
            onConflictDoUpdate({ set }: { set: { beat: string; params: unknown; updatedAt: Date } }) {
              return {
                returning() {
                  const existing = rows.find((r) => r.agentId === v.agentId && r.name === v.name);
                  if (existing) {
                    existing.beat = set.beat;
                    existing.params = set.params as Record<string, unknown>;
                    existing.updatedAt = set.updatedAt;
                    return [existing];
                  }
                  const row: PresetRow = {
                    id: `preset-${nextId++}`,
                    agentId: v.agentId,
                    name: v.name,
                    beat: v.beat,
                    params: v.params as Record<string, unknown>,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  };
                  rows.push(row);
                  return [row];
                },
              };
            },
          };
        },
      };
    },
    select() {
      return {
        from() {
          return { where: (conds: unknown) => rows.filter((r) => matches(r, conds)) };
        },
      };
    },
    delete() {
      return {
        where(conds: unknown) {
          return {
            returning() {
              const hit = rows.filter((r) => matches(r, conds));
              for (const r of hit) rows.splice(rows.indexOf(r), 1);
              return hit.map((r) => ({ id: r.id }));
            },
          };
        },
      };
    },
  };
  return { db, schema: { agentPresets } };
});

const { savePreset, getPreset, listPresetsFor, deletePreset } = await import("./presets.js");

beforeEach(() => {
  rows.length = 0;
  nextId = 1;
});

describe("savePreset — validation", () => {
  it("rejects an unknown beat", async () => {
    const res = await savePreset("hobby", "my-thing", "not-a-real-beat", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/no bit called/i);
    expect(rows).toHaveLength(0);
  });

  it("rejects params that don't satisfy the beat's own schema", async () => {
    const res = await savePreset("hobby", "broken", "screen-flourish", { style: "not-a-real-style" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/won't save/i);
    expect(rows).toHaveLength(0);
  });

  it("saves a valid preset, storing the PARSED (defaulted) params", async () => {
    const res = await savePreset("hobby", "hobby-wave", "emote", { emoji: "🤙" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.preset.beat).toBe("emote");
      expect(res.preset.params).toMatchObject({ emoji: "🤙" });
    }
    expect(rows).toHaveLength(1);
  });
});

describe("savePreset — one name per agent (overwrite, not duplicate)", () => {
  it("re-saving the same name updates in place rather than creating a second row", async () => {
    await savePreset("hobby", "hobby-wave", "emote", { emoji: "🤙" });
    await savePreset("hobby", "hobby-wave", "emote", { emoji: "👋", text: "yo" });
    expect(rows).toHaveLength(1);
    expect(rows[0].params).toMatchObject({ emoji: "👋", text: "yo" });
  });

  it("the same name is independent across agents", async () => {
    await savePreset("hobby", "wave", "emote", { emoji: "🤙" });
    await savePreset("writer", "wave", "emote", { emoji: "✍️" });
    expect(rows).toHaveLength(2);
  });
});

describe("getPreset / listPresetsFor / deletePreset", () => {
  it("getPreset finds a saved preset by (agent, name); returns undefined otherwise", async () => {
    await savePreset("hobby", "hobby-wave", "emote", { emoji: "🤙" });
    expect(await getPreset("hobby", "hobby-wave")).toBeTruthy();
    expect(await getPreset("hobby", "no-such-name")).toBeUndefined();
    // Scoped to the agent — another agent's same-named preset isn't visible.
    expect(await getPreset("writer", "hobby-wave")).toBeUndefined();
  });

  it("listPresetsFor returns only that agent's presets", async () => {
    await savePreset("hobby", "wave", "emote", { emoji: "🤙" });
    await savePreset("hobby", "card", "screen-flourish", { title: "hi" });
    await savePreset("writer", "wave", "emote", { emoji: "✍️" });
    const hobbyPresets = await listPresetsFor("hobby");
    expect(hobbyPresets).toHaveLength(2);
    expect(hobbyPresets.map((p) => p.name).sort()).toEqual(["card", "wave"]);
  });

  it("deletePreset removes it and reports whether anything was deleted", async () => {
    await savePreset("hobby", "wave", "emote", { emoji: "🤙" });
    expect(await deletePreset("hobby", "wave")).toBe(true);
    expect(await getPreset("hobby", "wave")).toBeUndefined();
    expect(await deletePreset("hobby", "wave")).toBe(false);
  });
});
