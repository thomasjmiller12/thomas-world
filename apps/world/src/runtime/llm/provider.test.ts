import { describe, expect, it } from "vitest";
import { parseLlmProvider } from "./types.js";
import { providerConfiguration } from "./provider.js";
import { resolveSystemModel } from "./models.js";

describe("LLM provider configuration", () => {
  it("defaults to Anthropic when LLM_PROVIDER is absent", () => {
    expect(parseLlmProvider(undefined)).toBe("anthropic");
  });

  it("rejects an invalid provider with an actionable message", () => {
    expect(() => parseLlmProvider("openrouter")).toThrow(
      "LLM_PROVIDER must be one of: anthropic, openai",
    );
  });

  it("requires the selected provider's key even when the other key exists", () => {
    expect(
      providerConfiguration("openai", {
        anthropicApiKey: "anthropic-key",
        openaiApiKey: undefined,
      }),
    ).toEqual({ configured: false, missingEnv: "OPENAI_API_KEY" });
  });

  it("does not require an unselected provider's key", () => {
    expect(
      providerConfiguration("anthropic", {
        anthropicApiKey: "anthropic-key",
        openaiApiKey: undefined,
      }),
    ).toEqual({ configured: true });
  });

  it("uses the user-selected gpt-5.4 model for both system workloads", () => {
    expect(resolveSystemModel("chronicle", "openai")).toEqual({
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(resolveSystemModel("townCrier", "openai")).toEqual({
      provider: "openai",
      model: "gpt-5.4",
    });
  });
});
