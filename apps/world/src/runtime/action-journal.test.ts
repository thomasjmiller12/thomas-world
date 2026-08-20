import { describe, expect, it } from "vitest";
import { actionIdentity } from "./action-journal.js";

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
