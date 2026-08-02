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

  it("strips cache_control, and replaces ephemeral blocks with a text trace", () => {
    // The ephemeral block must not survive as itself (it references a sandbox
    // container that is gone by the next turn) — but it does leave a plain-text
    // memory behind, so the agent remembers the action. See the code-execution
    // amnesia note above summarizeEphemeralBlock in turn.ts.
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
    const blocks = msg.content as { type: string; text?: string; cache_control?: unknown }[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "text"]);
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].text).toContain("dataset");
    // Nothing that could be replayed against the dead container survives.
    expect(JSON.stringify(blocks)).not.toContain("f1");
  });
});

// Replacing (rather than deleting) the ephemeral blocks changes which messages
// survive, so the shape of the persisted thread needs its own guarantees.
describe("stripForPersist — code-execution traces", () => {
  it("keeps a code run and its output in the thread as plain text", () => {
    const msgs: ThreadMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", name: "code_execution", input: { code: "print(6*7)" } },
          { type: "code_execution_tool_result", content: { stdout: "42\n" } },
          { type: "text", text: "42, as expected." },
        ],
      } as unknown as ThreadMessage,
    ];
    const [msg] = stripForPersist(msgs);
    const text = (msg.content as { text?: string }[]).map((b) => b.text).join("\n");
    expect(text).toContain("print(6*7)");
    expect(text).toContain("42");
    expect((msg.content as { type: string }[]).every((b) => b.type === "text")).toBe(true);
  });

  it("folds a trace-only message into the previous same-role message", () => {
    // Such a message used to be dropped entirely. Appending it to the preceding
    // assistant message keeps the trace without introducing two consecutive
    // assistant messages where the thread previously had one.
    const msgs: ThreadMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "let me compute that" }],
      } as unknown as ThreadMessage,
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", name: "code_execution", input: { code: "1+1" } },
        ],
      } as unknown as ThreadMessage,
    ];
    const out = stripForPersist(msgs);
    expect(out).toHaveLength(1);
    expect((out[0].content as { text?: string }[]).map((b) => b.text).join("\n")).toContain("1+1");
  });

  it("folding into a thinking-bearing message can't reconstruct the poisoned shape", () => {
    // collapseThinking runs AFTER the fold precisely so a merge can never
    // rebuild the two-consecutive-thinking shape that bricked Researcher for 27
    // days. (A trace-only message carries no thinking block of its own, so this
    // is belt-and-braces — but the ordering is load-bearing if that ever
    // changes, and the invariant is cheap to pin.)
    const msgs: ThreadMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "a", signature: "s1" },
          { type: "text", text: "one moment" },
        ],
      } as unknown as ThreadMessage,
      {
        role: "assistant",
        content: [{ type: "code_execution_tool_result", content: { stdout: "ok" } }],
      } as unknown as ThreadMessage,
    ];
    const out = stripForPersist(msgs);
    expect(out).toHaveLength(1);
    const blocks = out[0].content as { type: string; text?: string }[];
    expect(blocks.filter((b) => b.type === "thinking")).toHaveLength(1);
    expect(blocks.map((b) => b.text).join("\n")).toContain("ok");
  });

  it("leaves two real consecutive assistant messages unmerged", () => {
    // The fold is scoped to messages that would otherwise have VANISHED. It must
    // not start rewriting the shape of threads that have real content.
    const msgs: ThreadMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "one" }] } as unknown as ThreadMessage,
      { role: "assistant", content: [{ type: "text", text: "two" }] } as unknown as ThreadMessage,
    ];
    expect(stripForPersist(msgs)).toHaveLength(2);
  });
});
