import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  journal: {
    id: "action-1",
    status: "completed",
    semanticEvent: null as Record<string, unknown> | null,
    semanticEventId: null as number | null,
    semanticEmittedAt: null as Date | null,
  },
  events: [] as Array<Record<string, unknown> & { id: number; ts: Date }>,
  published: [] as unknown[],
}));

vi.mock("../db/client.js", () => {
  const agentActionJournal = {
    id: {},
    status: {},
    semanticEvent: {},
    semanticEventId: {},
    completedAt: {},
  };
  const worldEvents = {};
  const tx = {
    execute: vi.fn().mockResolvedValue(undefined),
    select: () => ({
      from: () => ({
        where: async () => [
          {
            semanticEvent: state.journal.semanticEvent,
            semanticEventId: state.journal.semanticEventId,
          },
        ],
      }),
    }),
    insert: () => ({
      values: (value: Record<string, unknown>) => ({
        returning: async () => {
          const row = { ...value, id: state.events.length + 1, ts: new Date() };
          state.events.push(row);
          return [row];
        },
      }),
    }),
    update: () => ({
      set: (patch: Partial<typeof state.journal>) => ({
        where: async () => Object.assign(state.journal, patch),
      }),
    }),
  };
  const db = {
    transaction: async (run: (transaction: typeof tx) => unknown) => run(tx),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            state.journal.semanticEvent && state.journal.semanticEventId === null
              ? [{ id: state.journal.id }]
              : [],
        }),
      }),
    }),
  };
  return { db, schema: { agentActionJournal, worldEvents } };
});

vi.mock("../engine/events.js", () => ({
  materializeEventRow: (row: unknown) => row,
  publishCommittedEvent: (event: unknown) => state.published.push(event),
}));

vi.mock("./action-event.js", () => ({
  buildAgentActedEvent: vi.fn(),
}));

const { actionIdentity, flushPendingSemanticActions, publishPendingSemanticAction } =
  await import("./action-journal.js");

beforeEach(() => {
  state.journal.semanticEvent = null;
  state.journal.semanticEventId = null;
  state.journal.semanticEmittedAt = null;
  state.events.length = 0;
  state.published.length = 0;
});

describe("actionIdentity", () => {
  it("is stable across object key order and provider call ids", () => {
    const a = actionIdentity({
      turnId: "chat-s1-message-9",
      agentId: "builder",
      toolName: "send_dm",
      args: { text: "hi", agent: "writer" },
    });
    const b = actionIdentity({
      turnId: "chat-s1-message-9",
      agentId: "builder",
      toolName: "send_dm",
      args: { agent: "writer", text: "hi" },
    });
    expect(a).toEqual(b);
  });

  it("changes between logical visitor turns", () => {
    const args = { subject: "One", body: "Body" };
    expect(
      actionIdentity({ turnId: "message-1", agentId: "career", toolName: "email_thomas", args }).id,
    ).not.toBe(
      actionIdentity({ turnId: "message-2", agentId: "career", toolName: "email_thomas", args }).id,
    );
  });
});

describe("semantic action outbox", () => {
  it("atomically marks and publishes a pending event only once", async () => {
    state.journal.semanticEvent = {
      type: "agent.acted",
      agentId: "builder",
      locationId: "workshop",
      visibility: "public",
      payload: { actionId: "action-1", summary: "built an interactive" },
    };

    await expect(publishPendingSemanticAction("action-1")).resolves.toBe(1);
    await expect(publishPendingSemanticAction("action-1")).resolves.toBeNull();
    expect(state.events).toHaveLength(1);
    expect(state.journal.semanticEventId).toBe(1);
    expect(state.journal.semanticEmittedAt).toBeInstanceOf(Date);
    expect(state.published).toHaveLength(1);
  });

  it("repairs a completed action whose semantic event was left pending", async () => {
    state.journal.semanticEvent = {
      type: "agent.acted",
      agentId: "writer",
      visibility: "public",
      payload: { actionId: "action-1", summary: "published a blog post" },
    };

    await expect(flushPendingSemanticActions()).resolves.toEqual({
      found: 1,
      published: 1,
      failed: 0,
    });
    await expect(flushPendingSemanticActions()).resolves.toEqual({
      found: 0,
      published: 0,
      failed: 0,
    });
  });
});
