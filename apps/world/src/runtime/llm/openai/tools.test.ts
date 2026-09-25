import { describe, expect, it, vi } from "vitest";
import * as z from "zod/v4";
import { defineTownMemoryTool, defineTownTool } from "../tool.js";
import { buildTools } from "../../tools.js";
import { toOpenAITool, toOpenAITools } from "./tools.js";

function nullMemoryFields() {
  return {
    path: null,
    view_range: null,
    file_text: null,
    old_str: null,
    new_str: null,
    insert_line: null,
    insert_text: null,
    old_path: null,
    new_path: null,
  };
}

function expectNoTupleItems(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) expectNoTupleItems(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "items") expect(Array.isArray(child)).toBe(false);
    expectNoTupleItems(child);
  }
}

describe("OpenAI strict tool adapter", () => {
  it("emits a strict object schema with no additional properties", () => {
    const run = vi.fn(() => "ok");
    const townTool = defineTownTool({
      name: "sample",
      description: "A strict sample tool",
      inputSchema: z.object({ required: z.string(), optional: z.string().optional() }).strict(),
      run,
    });

    const converted = toOpenAITool(townTool);

    expect(converted.strict).toBe(true);
    expect(converted.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect((converted.parameters as { required?: string[] }).required).toEqual([
      "required",
      "optional",
    ]);
  });

  it("converts the complete production tool surface to OpenAI strict schemas", () => {
    const townTools = buildTools({ agentId: "builder", location: "workshop" });
    const converted = toOpenAITools(townTools);
    const playBeat = converted.find((item) => item.name === "play_beat");

    expect(converted).toHaveLength(townTools.length);
    for (const item of converted) expectNoTupleItems(item.parameters);
    expect(playBeat).toBeDefined();
    expect(playBeat?.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["beat", "object", "params"],
      properties: {
        params: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["effect", "style", "title", "body", "text", "cta", "tone", "emoji"],
            },
            { type: "null" },
          ],
        },
      },
    });
  });

  it("preserves every memory command's semantics through one strict function tool", async () => {
    const handlers = {
      view: vi.fn(() => "viewed"),
      create: vi.fn(() => "created"),
      str_replace: vi.fn(() => "replaced"),
      insert: vi.fn(() => "inserted"),
      delete: vi.fn(() => "deleted"),
      rename: vi.fn(() => "renamed"),
    };
    const memory = toOpenAITool(defineTownMemoryTool(handlers));
    const invoke = (input: object) => memory.invoke({} as never, JSON.stringify(input));

    expect(memory.parameters).toMatchObject({
      properties: {
        view_range: {
          anyOf: [
            { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 },
            { type: "null" },
          ],
        },
      },
    });

    await expect(
      invoke({ ...nullMemoryFields(), command: "view", path: "/core.md", view_range: [1, 5] }),
    ).resolves.toBe("viewed");
    await expect(
      invoke({ ...nullMemoryFields(), command: "create", path: "/new.md", file_text: "hello" }),
    ).resolves.toBe("created");
    await expect(
      invoke({
        ...nullMemoryFields(),
        command: "str_replace",
        path: "/core.md",
        old_str: "old",
        new_str: "new",
      }),
    ).resolves.toBe("replaced");
    await expect(
      invoke({
        ...nullMemoryFields(),
        command: "insert",
        path: "/core.md",
        insert_line: 3,
        insert_text: "line",
      }),
    ).resolves.toBe("inserted");
    await expect(
      invoke({ ...nullMemoryFields(), command: "delete", path: "/old.md" }),
    ).resolves.toBe("deleted");
    await expect(
      invoke({ ...nullMemoryFields(), command: "rename", old_path: "/a.md", new_path: "/b.md" }),
    ).resolves.toBe("renamed");

    expect(handlers.view).toHaveBeenCalledWith({
      command: "view",
      path: "/core.md",
      view_range: [1, 5],
    });
    expect(handlers.rename).toHaveBeenCalledWith({
      command: "rename",
      old_path: "/a.md",
      new_path: "/b.md",
    });
  });

  it("rejects a memory command that omits its required semantic field", async () => {
    const memory = toOpenAITool(
      defineTownMemoryTool({
        view: vi.fn(),
        create: vi.fn(),
        str_replace: vi.fn(),
        insert: vi.fn(),
        delete: vi.fn(),
        rename: vi.fn(),
      }),
    );

    await expect(
      memory.invoke(
        {} as never,
        JSON.stringify({ ...nullMemoryFields(), command: "delete" }),
      ),
    ).resolves.toContain("memory.delete requires path");
  });
});
