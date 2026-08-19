import { describe, expect, it } from "vitest";
import { parseProviderAttachment } from "./delivery.js";

describe("provider-owned delivery attachments", () => {
  it.each(["anthropic", "openai"] as const)(
    "accepts a %s file for the matching active provider",
    (provider) => {
      expect(
        parseProviderAttachment(
          { provider, fileId: `file-${provider}`, filename: "data.csv" },
          provider,
        ),
      ).toEqual({
        ok: true,
        attachment: { provider, fileId: `file-${provider}`, filename: "data.csv" },
      });
    },
  );

  it("rejects a provider mismatch with an upload-again remediation", () => {
    expect(
      parseProviderAttachment({ provider: "anthropic", fileId: "file-a" }, "openai"),
    ).toEqual({
      ok: false,
      status: 409,
      error:
        "attachment belongs to anthropic, but the active LLM provider is openai; upload the file with openai and retry",
    });
  });

  it("rejects a missing file id", () => {
    expect(parseProviderAttachment({ provider: "openai" }, "openai")).toEqual({
      ok: false,
      status: 400,
      error: "attachment.fileId required",
    });
  });
});
