import { describe, expect, it, vi } from "vitest";
import { assessBehavior, recordRest, type BehaviorEvent } from "./behavior.js";
import { appendEvent } from "./events.js";
vi.mock("./events.js", () => ({ appendEvent: vi.fn(), recentEventsForAgent: vi.fn() }));

const now = new Date("2026-09-22T23:00:00Z");
function event(hour: number, type: string, payload: Record<string, unknown>): BehaviorEvent {
  return { ts: `2026-09-22T${String(hour).padStart(2, "0")}:00:00Z`, type, payload, visibility: "public" };
}

describe("behavior quality, separate from liveness", () => {
  it("detects the recorded Noted loop despite successful completions", () => {
    const assessment = assessBehavior([19, 20, 21, 22].map((hour) => event(hour, "agent.thought", { text: "Noted." })), now);
    expect(assessment.status).toBe("stalled");
    expect(assessment.repeatedUtterances).toBe(4);
    expect(assessment.lastMeaningfulAt).toBeNull();
  });

  it("recognizes date-changing diary boilerplate as repetition and flags false future dates", () => {
    const events = [19, 20, 21].map((hour, i) => event(hour, "agent.spoke", {
      text: `Diary — 2026-12-0${i + 3}\nAnother quiet park day. Nothing needed to get bigger than it was.`,
    }));
    const result = assessBehavior(events, now);
    expect(result.status).toBe("stalled");
    expect(result.futureDiaryDates).toBe(3);
    expect(result.repeatedUtterances).toBe(3);
  });

  it("does not mistake repeating an acknowledgement between actual changes for stalled work", () => {
    const result = assessBehavior([
      event(18, "agent.thought", { text: "Done." }),
      event(19, "artifact.updated", { artifactId: "game" }),
      event(20, "agent.thought", { text: "Done." }),
      event(21, "artifact.updated", { artifactId: "game" }),
      event(22, "agent.thought", { text: "Done." }),
    ], now);
    expect(result.status).toBe("active");
  });

  it("does not count diaries or status-label churn as progress or punish legitimate quiet", () => {
    const result = assessBehavior([
      event(18, "artifact.created", { kind: "diary_entry" }),
      event(19, "agent.activity", { activity: "resting" }),
      event(20, "agent.thought", { text: "I am taking the evening off." }),
    ], now);
    expect(result.status).toBe("quiet");
    expect(result.lastMeaningfulAt).toBeNull();
  });

  it("does not let diary or digest edits conceal a repeated acknowledgement loop", () => {
    const result = assessBehavior([
      event(18, "agent.thought", { text: "Noted." }),
      event(19, "artifact.updated", { kind: "diary_entry" }),
      event(20, "agent.thought", { text: "Noted." }),
      event(21, "artifact.updated", { kind: "daily_digest" }),
      event(22, "agent.thought", { text: "Noted." }),
    ], now);
    expect(result.status).toBe("stalled");
    expect(result.lastMeaningfulAt).toBeNull();
  });

  it("ignores private and old evidence and quotes mentioning a future event", () => {
    const result = assessBehavior([
      { ...event(20, "agent.thought", { text: "Diary — 2026-12-04" }), visibility: "private" },
      { ...event(20, "agent.moved", {}), ts: "2026-08-23T20:00:00Z" },
      event(21, "agent.spoke", { text: "We might meet on 2026-12-04." }),
    ], now);
    expect(result.sampledEvents).toBe(1);
    expect(result.futureDiaryDates).toBe(0);
    expect(result.status).toBe("quiet");
    expect(assessBehavior([], now).status).toBe("unknown");
  });

  it("records intentional quiet so the prior repetition episode can recover", async () => {
    const repeated = [18, 19, 20].map((hour) => event(hour, "agent.thought", { text: "Noted." }));
    expect(assessBehavior(repeated, now).status).toBe("stalled");
    await recordRest("builder");
    const saved = vi.mocked(appendEvent).mock.calls.at(-1)![0];
    expect(saved.type).toBe("agent.rested");
    expect(assessBehavior([...repeated, { ...saved, ts: event(21, "", {}).ts }], now).status).toBe("quiet");
    expect(assessBehavior([...repeated, { ...saved, ts: event(21, "", {}).ts },
      event(22, "agent.thought", { text: "Noted." })], now).repeatedUtterances).toBe(1);
  });

  it("does not treat old false diary dates as a continuing failure after real work", () => {
    const result = assessBehavior([
      ...[18, 19].map((hour) => event(hour, "agent.spoke", { text: "Diary — 2026-12-04" })),
      event(20, "artifact.updated", { kind: "app" }),
    ], now);
    expect(result.status).toBe("active");
    expect(result.futureDiaryDates).toBe(0);
  });
});
