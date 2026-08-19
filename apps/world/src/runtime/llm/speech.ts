// Provider-neutral narration policy. Each adapter identifies its round's text,
// stop reason, and terminal tool calls, then applies these shared rules.
export type RoundDisposition = "emit" | "hold" | "drop";

export function classifyRoundText(opts: {
  hasText: boolean;
  stopReason: string | null;
  terminal: boolean;
  closed: boolean;
}): RoundDisposition {
  if (!opts.hasText) return "drop";
  if (opts.closed) return "drop";
  if (opts.terminal) return "emit";
  return opts.stopReason === "tool_use" ? "hold" : "emit";
}

export function releaseHeld(held: string[]): string {
  return held.join("\n\n");
}
