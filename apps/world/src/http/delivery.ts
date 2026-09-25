import {
  llmProviderNames,
  type LlmProviderName,
  type ProviderAttachment,
} from "../runtime/llm/types.js";

export type ParsedProviderAttachment =
  | { ok: true; attachment: ProviderAttachment }
  | { ok: false; status: 400 | 409; error: string };

export function parseProviderAttachment(
  value: unknown,
  activeProvider: LlmProviderName,
): ParsedProviderAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      status: 400,
      error: "attachment must be an object with provider and fileId",
    };
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.provider !== "string" ||
    !(llmProviderNames as readonly string[]).includes(input.provider)
  ) {
    return {
      ok: false,
      status: 400,
      error: `attachment.provider must be one of: ${llmProviderNames.join(", ")}`,
    };
  }
  if (typeof input.fileId !== "string" || input.fileId.trim() === "") {
    return { ok: false, status: 400, error: "attachment.fileId required" };
  }
  if (input.filename != null && typeof input.filename !== "string") {
    return { ok: false, status: 400, error: "attachment.filename must be a string" };
  }
  const provider = input.provider as LlmProviderName;
  if (provider !== activeProvider) {
    return {
      ok: false,
      status: 409,
      error:
        `attachment belongs to ${provider}, but the active LLM provider is ${activeProvider}; ` +
        `upload the file with ${activeProvider} and retry`,
    };
  }
  return {
    ok: true,
    attachment: {
      provider,
      fileId: input.fileId,
      ...(input.filename ? { filename: input.filename } : {}),
    },
  };
}
