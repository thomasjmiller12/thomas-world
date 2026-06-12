import { describe, it, expect } from "vitest";
import { ChatStreamFrame } from "@town/contract";
import type { ChatStreamFrame as Frame } from "@town/contract";

// runChatTurn emits these frame shapes (design doc §5). They are LLM/DB-bound to
// produce end-to-end, but the SHAPES must conform to the contract's
// discriminated union — that's the conformance this step guarantees. We build
// each variant exactly as the runtime does and assert it parses.

describe("chat stream frame conformance (design doc §5)", () => {
  it("turn_started carries the speaking agent", () => {
    const f: Frame = { type: "turn_started", agent: "hobby" };
    expect(ChatStreamFrame.parse(f)).toEqual(f);
  });

  it("text delta carries text + attribution", () => {
    const f: Frame = { type: "text", text: "hello", agent: "hobby" };
    expect(ChatStreamFrame.parse(f)).toEqual(f);
  });

  it("memory_recalled carries a recency label + agent", () => {
    const f: Frame = { type: "memory_recalled", label: "recalled from earlier", agent: "hobby" };
    expect(ChatStreamFrame.parse(f)).toEqual(f);
  });

  it("done carries the real persisted messageId", () => {
    const f: Frame = { type: "done", messageId: "42", agent: "hobby" };
    expect(ChatStreamFrame.parse(f)).toEqual(f);
  });

  it("suggested_replies is a post-done annotation (no agent attribution)", () => {
    const f: Frame = { type: "suggested_replies", replies: ["yes", "tell me more"] };
    expect(ChatStreamFrame.parse(f)).toEqual(f);
  });

  it("action carries the mid-chat tool + a human-readable detail (M2.1)", () => {
    const f: Frame = { type: "action", agent: "builder", tool: "move_to", detail: "walks to the cafe" };
    expect(ChatStreamFrame.parse(f)).toEqual(f);
  });

  it("chat_ended carries the agent who left + an optional reason (M2.1)", () => {
    const withReason: Frame = { type: "chat_ended", agent: "builder", reason: "wound down" };
    expect(ChatStreamFrame.parse(withReason)).toEqual(withReason);
    const noReason: Frame = { type: "chat_ended", agent: "builder" };
    expect(ChatStreamFrame.parse(noReason)).toEqual(noReason);
  });

  it("the discriminator is the `type` field — a bad type is rejected", () => {
    expect(ChatStreamFrame.safeParse({ type: "delta", text: "x", agent: "hobby" }).success).toBe(
      false,
    );
  });

  it("rejects a frame missing the discriminator", () => {
    expect(ChatStreamFrame.safeParse({ text: "x", agent: "hobby" }).success).toBe(false);
  });
});
