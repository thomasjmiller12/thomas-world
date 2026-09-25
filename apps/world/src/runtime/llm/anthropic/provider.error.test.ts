import { describe, expect, it } from "vitest";
import { classifyAnthropicError } from "./provider.js";

function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("Anthropic provider error normalization", () => {
  it("recognizes the production thinking-block and tool-result corruption signatures", () => {
    expect(
      classifyAnthropicError(
        apiError(
          400,
          "messages.305.content.16: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified",
        ),
      ),
    ).toMatchObject({ kind: "thread_corrupt", retryable: false, threadCorrupt: true });
    expect(
      classifyAnthropicError(
        apiError(400, "messages.1006: `tool_use` ids were found without `tool_result` blocks"),
      ),
    ).toMatchObject({ kind: "thread_corrupt", threadCorrupt: true });
  });

  it.each([
    [401, "authentication_error", "authentication", false],
    [429, "rate_limit_error", "rate_limit", true],
    [500, "internal", "provider", true],
    [529, "overloaded_error", "provider", true],
    [404, "model not found", "model_access", false],
  ] as const)("normalizes HTTP %i", (status, message, kind, retryable) => {
    expect(classifyAnthropicError(apiError(status, message))).toMatchObject({
      kind,
      retryable,
      threadCorrupt: false,
      status,
    });
  });

  it("distinguishes timeouts, credits, and refusals without marking thread corruption", () => {
    expect(classifyAnthropicError(Object.assign(new Error("request timed out"), { name: "APIConnectionTimeoutError" }))).toMatchObject({ kind: "timeout", retryable: true, threadCorrupt: false });
    expect(classifyAnthropicError(apiError(400, "Your credit balance is too low"))).toMatchObject({ kind: "credits", retryable: false, threadCorrupt: false });
    expect(classifyAnthropicError(apiError(400, "request was refused"))).toMatchObject({ kind: "refusal", retryable: false, threadCorrupt: false });
  });
});
