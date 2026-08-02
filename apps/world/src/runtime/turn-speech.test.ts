import { describe, expect, it } from "vitest";
import { classifyRoundText, releaseHeld, summarizeEphemeralBlock } from "./turn.js";

// The narration guard decides, per round, whether the agent's plain text is
// SPEECH to the visitor or internal stage direction. Getting this wrong is not
// cosmetic: a suppressed round is deleted everywhere at once — it never streams,
// never reaches chat_messages, and never becomes the agent.spoke bubble — while
// staying in the agent's own thread, so the agent believes it said something the
// visitor never received. Both scenarios below are real conversations from
// 2026-08-02, replayed as tests.
describe("classifyRoundText (narration guard)", () => {
  const round = (o: Partial<Parameters<typeof classifyRoundText>[0]>) =>
    classifyRoundText({
      hasText: true,
      stopReason: "tool_use",
      terminal: false,
      closed: false,
      ...o,
    });

  it("emits the text of a round that cleanly ends the turn", () => {
    expect(round({ stopReason: "end_turn" })).toBe("emit");
  });

  it("holds stage direction written before an ordinary tool call", () => {
    // "let me check my memory first…" then a tool call — not speech.
    expect(round({ stopReason: "tool_use" })).toBe("hold");
  });

  it("emits text written alongside leave_chat — that IS the goodbye", () => {
    // REGRESSION (Researcher, 2026-08-02 18:37). protocol.ts instructs "say your
    // goodbye and call leave_chat in the same message", so this round carries the
    // real reply. It used to be classified as narration and thrown away; the
    // visitor received only the "Catch you later" that followed the tool result.
    expect(round({ stopReason: "tool_use", terminal: true })).toBe("emit");
  });

  it("drops the redundant second goodbye after a terminal round has spoken", () => {
    expect(round({ stopReason: "end_turn", closed: true })).toBe("drop");
  });

  it("drops post-goodbye housekeeping narration", () => {
    expect(round({ stopReason: "tool_use", closed: true })).toBe("drop");
  });

  it("drops rounds with no text at all", () => {
    expect(round({ hasText: false, stopReason: "end_turn" })).toBe("drop");
    expect(round({ hasText: false, terminal: true })).toBe("drop");
  });
});

describe("releaseHeld (max-rounds fallback)", () => {
  it("releases every held buffer oldest-first, not just the last one", () => {
    // REGRESSION (Builder, 2026-08-02 18:43). Six rounds, none ending cleanly:
    // round 1 was the real greeting, round 4 was housekeeping narration. The old
    // fallback kept only the LAST buffer, so the visitor got the housekeeping and
    // never saw the greeting. Order matters — the substantive line comes first.
    const greeting = "sup g! yo I saw what you dropped in the idea jar";
    const housekeeping = "Filed. Let me update memory and DM Researcher";
    expect(releaseHeld([greeting, housekeeping])).toBe(`${greeting}\n\n${housekeeping}`);
  });

  it("is empty when nothing was held", () => {
    expect(releaseHeld([])).toBe("");
  });
});

// Code-execution blocks can't be replayed (they reference a dead sandbox
// container), but DELETING them left agents unable to remember they'd ever run
// code — see the comment above summarizeEphemeralBlock. We keep a bounded,
// past-tense trace instead.
describe("summarizeEphemeralBlock (code-execution memory)", () => {
  it("records the code an agent ran", () => {
    const out = summarizeEphemeralBlock({
      type: "server_tool_use",
      name: "code_execution",
      input: { code: "print(sum(range(10)))" },
    });
    expect(out).toContain("you ran code_execution");
    expect(out).toContain("print(sum(range(10)))");
  });

  it("records what the run returned", () => {
    const out = summarizeEphemeralBlock({
      type: "code_execution_tool_result",
      content: { stdout: "45\n", stderr: "" },
    });
    expect(out).toContain("it returned");
    expect(out).toContain("45");
  });

  it("surfaces stderr and error codes rather than silently losing a failure", () => {
    expect(
      summarizeEphemeralBlock({
        type: "code_execution_tool_result",
        content: { stdout: "", stderr: "NameError: x" },
      }),
    ).toContain("NameError: x");
    expect(
      summarizeEphemeralBlock({
        type: "code_execution_tool_result",
        content: { error_code: "execution_time_exceeded" },
      }),
    ).toContain("execution_time_exceeded");
  });

  it("clamps a long trace so the thread can't bloat again", () => {
    const out = summarizeEphemeralBlock({
      type: "server_tool_use",
      name: "code_execution",
      input: { code: "x = 1\n".repeat(5_000) },
    });
    expect(out!.length).toBeLessThan(800);
    expect(out).toContain("truncated");
  });

  it("notes a dataset handoff without referencing the dead container", () => {
    const out = summarizeEphemeralBlock({ type: "container_upload", file_id: "file_abc" });
    expect(out).toContain("dataset");
    expect(out).not.toContain("file_abc");
  });

  it("returns undefined for block types with nothing worth remembering", () => {
    expect(summarizeEphemeralBlock({ type: "text", text: "hi" })).toBeUndefined();
  });
});
