import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  classifyError: vi.fn(),
  markTurnFailed: vi.fn(),
  clearFailures: vi.fn(),
  setStatus: vi.fn(),
  reseedThread: vi.fn(),
}));

vi.mock("../config.js", () => ({ config: { llmProvider: "openai" } }));
vi.mock("../engine/agents.js", () => ({
  markTurnFailed: mocks.markTurnFailed,
  clearFailures: mocks.clearFailures,
  setStatus: mocks.setStatus,
}));
vi.mock("../engine/thread.js", () => ({ reseedThread: mocks.reseedThread }));
vi.mock("./llm/provider.js", () => ({
  getLlmProvider: () => ({ classifyError: mocks.classifyError }),
}));

import { recordTurnFailure } from "./failure-handler.js";

describe("recordTurnFailure provider-scoped recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.markTurnFailed.mockResolvedValue(1);
    mocks.clearFailures.mockResolvedValue(undefined);
    mocks.reseedThread.mockResolvedValue(undefined);
    mocks.setStatus.mockResolvedValue(undefined);
  });

  it("reseeds only the active provider thread after an explicit corruption signal", async () => {
    mocks.classifyError.mockReturnValue({
      provider: "openai",
      kind: "thread_corrupt",
      retryable: false,
      threadCorrupt: true,
      status: 400,
      message: "malformed native history",
    });

    await recordTurnFailure("builder", new Error("raw SDK error"), "tick");

    expect(mocks.reseedThread).toHaveBeenCalledWith("builder", "openai");
    expect(mocks.clearFailures).toHaveBeenCalledWith("builder");
  });

  it.each([
    ["authentication", 401],
    ["credits", 400],
    ["rate_limit", 429],
    ["provider", 503],
    ["model_access", 404],
    ["timeout", undefined],
    ["refusal", 400],
  ])("does not erase history for %s failures", async (kind, status) => {
    mocks.classifyError.mockReturnValue({
      provider: "openai",
      kind,
      retryable: kind === "rate_limit" || kind === "provider" || kind === "timeout",
      threadCorrupt: false,
      status,
      message: String(kind),
    });

    await recordTurnFailure("builder", new Error("raw SDK error"), "visitor");

    expect(mocks.reseedThread).not.toHaveBeenCalled();
    expect(mocks.clearFailures).not.toHaveBeenCalled();
  });
});
