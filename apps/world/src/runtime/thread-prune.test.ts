// Pruning history the API has already compacted away.
//
// Grounded in a live measurement (2026-07-30): Builder's real 2,183-message
// thread and a 17-message suffix starting at the most recent compaction block
// both reported input_tokens = 15,021 — exactly equal. The API discards
// everything before the newest compaction block, so persisting and uploading the
// full history every turn was pure waste.

import { describe, it, expect } from "vitest";
import { pruneCompactedHistory } from "./turn.js";
import type { ThreadMessage } from "../engine/thread.js";

const user = (t: string) => ({ role: "user", content: [{ type: "text", text: t }] }) as unknown as ThreadMessage;
const assistant = (t: string) =>
  ({ role: "assistant", content: [{ type: "text", text: t }] }) as unknown as ThreadMessage;
const compaction = (summary: string) =>
  ({
    role: "assistant",
    content: [
      { type: "compaction", content: summary, encrypted_content: "opaque" },
      { type: "text", text: "carrying on" },
    ],
  }) as unknown as ThreadMessage;

describe("pruneCompactedHistory", () => {
  it("leaves a thread with no compaction blocks completely alone", () => {
    const msgs = [user("a"), assistant("b"), user("c")];
    expect(pruneCompactedHistory(msgs)).toEqual(msgs);
  });

  it("leaves a thread with only ONE checkpoint alone at the default keep=2", () => {
    // Nothing to spare yet — a young thread must not be touched.
    const msgs = [user("a"), compaction("c1"), user("b")];
    expect(pruneCompactedHistory(msgs)).toEqual(msgs);
  });

  it("keeps from the second-to-last checkpoint by default", () => {
    const msgs = [
      user("old-1"),
      assistant("old-2"),
      compaction("c1"),
      user("mid-1"),
      compaction("c2"),
      user("recent-1"),
      compaction("c3"),
      user("newest"),
    ];
    const kept = pruneCompactedHistory(msgs);
    // c2 is the second-to-last checkpoint (index 4) — retain from there.
    expect(kept).toHaveLength(4);
    expect(kept[0]).toBe(msgs[4]);
    expect(kept[kept.length - 1]).toBe(msgs[7]);
  });

  it("keeps only from the LAST checkpoint when asked for one", () => {
    const msgs = [
      user("old"),
      compaction("c1"),
      user("mid"),
      compaction("c2"),
      user("newest"),
    ];
    const kept = pruneCompactedHistory(msgs, 1);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toBe(msgs[3]); // the c2 checkpoint
  });

  it("retains the compaction block itself — dropping it would lose compaction state", () => {
    const msgs = [user("old"), compaction("c1"), user("x"), compaction("c2"), user("y")];
    const kept = pruneCompactedHistory(msgs, 2);
    const firstBlockTypes = (kept[0].content as { type: string }[]).map((b) => b.type);
    expect(firstBlockTypes).toContain("compaction");
  });

  it("is a no-op when the earliest kept checkpoint is already at the head", () => {
    // from === 0 means there is nothing before it to drop; return the original
    // array rather than an equal copy.
    const msgs = [compaction("c1"), user("a"), compaction("c2"), user("b")];
    expect(pruneCompactedHistory(msgs, 2)).toBe(msgs);
  });

  it("collapses a long thread to a small tail (the real-world shape)", () => {
    // Mimic Builder: ~2000 messages of pre-compaction history, checkpoints near
    // the end. The result should be tiny.
    const msgs: ThreadMessage[] = [];
    for (let i = 0; i < 2000; i++) msgs.push(i % 2 ? assistant(`a${i}`) : user(`u${i}`));
    msgs.push(compaction("c-old"));
    for (let i = 0; i < 20; i++) msgs.push(user(`t${i}`));
    msgs.push(compaction("c-new"));
    msgs.push(user("latest"));

    const kept = pruneCompactedHistory(msgs);
    expect(kept.length).toBe(23); // c-old + 20 tail + c-new + latest
    expect(msgs.length - kept.length).toBe(2000);
  });
});
