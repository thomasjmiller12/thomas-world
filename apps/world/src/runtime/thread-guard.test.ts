// The poisoned-thread guard in stripForPersist.
//
// Regression test for the Researcher Thomas incident (2026-07-03 → 07-30): the
// persisted thread contained an assistant message with TWO consecutive `thinking`
// blocks. The API produces that happily but REJECTS it on replay:
//
//   400 messages.305.content.16: `thinking` or `redacted_thinking` blocks in the
//   latest assistant message cannot be modified.
//
// Because the whole thread is replayed on every turn, that one message made every
// subsequent turn fail deterministically — 27 days, zero LLM calls. The real
// blocks both had EMPTY thinking text and only carried signatures, and dropping
// either one was verified against the live API to restore the thread to 200 OK.

import { describe, it, expect } from "vitest";
import { stripForPersist } from "./turn.js";
import type { ThreadMessage } from "../engine/thread.js";

// Shaped exactly like the real msgs[1066] that killed Researcher.
const poisoned: ThreadMessage[] = [
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "sig-a" },
      { type: "thinking", thinking: "", signature: "sig-b" },
      { type: "tool_use", id: "toolu_1", name: "memory", input: {} },
    ],
  } as unknown as ThreadMessage,
];

describe("stripForPersist — thinking-block collapse", () => {
  it("collapses two consecutive thinking blocks to one", () => {
    const [msg] = stripForPersist(poisoned);
    const types = (msg.content as { type: string }[]).map((b) => b.type);
    expect(types).toEqual(["thinking", "tool_use"]);
  });

  it("keeps the FIRST thinking block, signature intact", () => {
    const [msg] = stripForPersist(poisoned);
    const thinking = (msg.content as { type: string; signature?: string }[]).find(
      (b) => b.type === "thinking",
    );
    expect(thinking?.signature).toBe("sig-a");
  });

  it("preserves the tool_use so the thread stays well-formed", () => {
    const [msg] = stripForPersist(poisoned);
    const tool = (msg.content as { type: string; id?: string }[]).find((b) => b.type === "tool_use");
    expect(tool?.id).toBe("toolu_1");
  });

  it("leaves a single thinking block completely alone", () => {
    const healthy: ThreadMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig-a" },
          { type: "text", text: "hello" },
        ],
      } as unknown as ThreadMessage,
    ];
    const [msg] = stripForPersist(healthy);
    expect((msg.content as { type: string }[]).map((b) => b.type)).toEqual(["thinking", "text"]);
  });

  it("also collapses redacted_thinking mixed with thinking", () => {
    const mixed: ThreadMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "sig-a" },
          { type: "redacted_thinking", data: "opaque" },
          { type: "text", text: "ok" },
        ],
      } as unknown as ThreadMessage,
    ];
    const [msg] = stripForPersist(mixed);
    expect((msg.content as { type: string }[]).map((b) => b.type)).toEqual(["thinking", "text"]);
  });

  it("does not merge thinking blocks across separate messages", () => {
    // Two assistant turns each legitimately carrying one thinking block must both
    // survive — the constraint is per-message, not per-thread.
    const twoTurns: ThreadMessage[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "a", signature: "s1" }],
      } as unknown as ThreadMessage,
      { role: "user", content: [{ type: "text", text: "hi" }] } as unknown as ThreadMessage,
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "b", signature: "s2" }],
      } as unknown as ThreadMessage,
    ];
    const out = stripForPersist(twoTurns);
    expect(out).toHaveLength(3);
    expect((out[0].content as { signature?: string }[])[0].signature).toBe("s1");
    expect((out[2].content as { signature?: string }[])[0].signature).toBe("s2");
  });

  it("still strips cache_control and ephemeral code-exec blocks", () => {
    const msgs: ThreadMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } },
          { type: "container_upload", file_id: "f1" },
        ],
      } as unknown as ThreadMessage,
    ];
    const [msg] = stripForPersist(msgs);
    const blocks = msg.content as { type: string; cache_control?: unknown }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].cache_control).toBeUndefined();
  });
});
