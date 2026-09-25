import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamFrame } from "@town/contract";

const fake = vi.hoisted(() => ({
  appendVisitorLine: vi.fn(),
  completeVisitorResponse: vi.fn(),
  coLocated: vi.fn(),
  endSession: vi.fn(),
  getSession: vi.fn(),
  lastSpeaker: vi.fn(),
  leaveSession: vi.fn(),
  getVisitor: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("../engine/visitors.js", () => ({ getVisitor: fake.getVisitor }));
vi.mock("./chat.js", () => ({
  appendVisitorLine: fake.appendVisitorLine,
  chatParticipantsCoLocated: fake.coLocated,
  completeVisitorResponse: fake.completeVisitorResponse,
  endSession: fake.endSession,
  getSession: fake.getSession,
  lastActiveAgentSpeaker: fake.lastSpeaker,
  leaveSession: fake.leaveSession,
  sanitizeVisitorText: (text: string) => text.trim(),
}));
vi.mock("./queue.js", () => ({ enqueue: fake.enqueue }));

import {
  chooseRoomSpeaker,
  isSilentInterjection,
  runRoomResponse,
} from "./room-chat.js";

beforeEach(() => {
  vi.clearAllMocks();
  fake.getSession.mockResolvedValue({
    agentId: "builder",
    visitorId: "visitor-1",
    participants: ["builder", "writer"],
  });
  fake.getVisitor.mockResolvedValue({ id: "visitor-1", name: "Thomas" });
  fake.coLocated.mockResolvedValue(true);
  fake.appendVisitorLine.mockResolvedValue("42");
  fake.completeVisitorResponse.mockResolvedValue(undefined);
  fake.lastSpeaker.mockResolvedValue(undefined);
});

describe("chooseRoomSpeaker", () => {
  const participants = ["builder", "writer"] as const;

  it("honors an explicit active addressee first", () => {
    expect(chooseRoomSpeaker([...participants], "writer", "builder", "what do you think?")).toBe(
      "writer",
    );
  });

  it("recognizes a facet named in the visitor's text", () => {
    expect(chooseRoomSpeaker([...participants], undefined, "builder", "Writer Thomas, your take?")).toBe(
      "writer",
    );
  });

  it("falls back to the last active speaker, then room order", () => {
    expect(chooseRoomSpeaker([...participants], undefined, "writer", "and then?")).toBe("writer");
    expect(chooseRoomSpeaker([...participants], undefined, "career", "hello room")).toBe("builder");
  });
});

describe("isSilentInterjection", () => {
  it("recognizes a chunked pass and not ordinary speech", () => {
    expect(
      isSilentInterjection([
        { type: "text", text: "[pa", agent: "writer" },
        { type: "text", text: "ss].", agent: "writer" },
      ]),
    ).toBe(true);
    expect(
      isSilentInterjection([{ type: "text", text: "One more thing.", agent: "writer" }]),
    ).toBe(false);
  });
});

describe("runRoomResponse", () => {
  it("finishes both durable turns after the client transport disconnects", async () => {
    const persisted: string[] = [];
    fake.enqueue.mockImplementation(async (agent, input) => {
      await input.handlers.onFrame({ type: "turn_started", agent });
      await input.handlers.onFrame({ type: "text", text: "Still persisted", agent });
      persisted.push(agent);
      await input.handlers.onFrame({ type: "done", messageId: agent, agent });
      return { ran: true, reason: "ok" };
    });
    const disconnected = vi.fn(() => { throw new Error("connection closed"); });

    await runRoomResponse({
      sessionId: "session-1", visitorId: "visitor-1", text: "hi room",
      requestId: "disconnected-1", handlers: { onFrame: disconnected },
    });

    expect(persisted).toEqual(["builder", "writer"]);
    expect(disconnected).toHaveBeenCalledOnce();
    expect(fake.completeVisitorResponse).toHaveBeenCalledWith("session-1", "disconnected-1");
  });

  it("persists the visitor once, suppresses [pass], and closes the response", async () => {
    fake.enqueue
      .mockImplementationOnce(async (_agent, input) => {
        await input.handlers.onFrame({ type: "turn_started", agent: "builder" });
        await input.handlers.onFrame({ type: "text", text: "Hello", agent: "builder" });
        await input.handlers.onFrame({ type: "done", messageId: "43", agent: "builder" });
        return { ran: true, reason: "ok" };
      })
      .mockImplementationOnce(async (_agent, input) => {
        await input.handlers.onFrame({ type: "turn_started", agent: "writer" });
        await input.handlers.onFrame({ type: "text", text: "[pass]", agent: "writer" });
        await input.handlers.onFrame({ type: "done", messageId: "empty", agent: "writer" });
        return { ran: true, reason: "ok" };
      });
    const frames: ChatStreamFrame[] = [];

    await runRoomResponse({
      sessionId: "session-1",
      visitorId: "visitor-1",
      text: "hi room",
      requestId: "request-1",
      handlers: { onFrame: (frame) => void frames.push(frame) },
    });

    expect(fake.appendVisitorLine).toHaveBeenCalledOnce();
    expect(frames.filter((frame) => frame.type === "text")).toEqual([
      { type: "text", text: "Hello", agent: "builder" },
    ]);
    expect(fake.completeVisitorResponse).toHaveBeenCalledWith("session-1", "request-1");
    expect(frames.at(-1)).toEqual({ type: "response_done" });
  });

  it("still persists and emits response_done when the second turn rejects", async () => {
    fake.enqueue
      .mockResolvedValueOnce({ ran: true, reason: "ok" })
      .mockRejectedValueOnce(new Error("queue failed"));
    const frames: ChatStreamFrame[] = [];

    await expect(
      runRoomResponse({
        sessionId: "session-1",
        visitorId: "visitor-1",
        text: "hi room",
        requestId: "request-2",
        handlers: { onFrame: (frame) => void frames.push(frame) },
      }),
    ).rejects.toThrow("queue failed");

    expect(fake.completeVisitorResponse).toHaveBeenCalledWith("session-1", "request-2");
    expect(frames.at(-1)).toEqual({ type: "response_done" });
  });
});
