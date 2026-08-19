// Shared structural fixtures for the provider contract suite. These deliberately
// model only what the turn coordinator consumes, so the same behavioral tests
// can be reused by the OpenAI adapter without teaching them Anthropic's SDK
// classes.

interface StructuralMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: unknown[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

export function anthropicMessage(opts: {
  text?: string;
  stopReason: string;
  toolName?: string;
}): StructuralMessage {
  const content: unknown[] = [];
  if (opts.text) content.push({ type: "text", text: opts.text });
  if (opts.toolName) {
    content.push({ type: "tool_use", id: `tool-${opts.toolName}`, name: opts.toolName, input: {} });
  }
  return {
    id: crypto.randomUUID(),
    type: "message",
    role: "assistant",
    model: "contract-test-model",
    content,
    stop_reason: opts.stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
    },
  };
}

function assistantParam(message: StructuralMessage): { role: "assistant"; content: unknown[] } {
  return { role: "assistant", content: message.content };
}

export function nonStreamingRunner(
  params: { messages: unknown[] } & Record<string, unknown>,
  rounds: StructuralMessage[],
  opts: { failAfter?: number } = {},
) {
  const accumulated = [...params.messages];
  const runnerParams = { ...params, messages: accumulated };
  return {
    params: runnerParams,
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < rounds.length; i++) {
        if (opts.failAfter === i) throw new Error("provider exploded");
        const message = rounds[i];
        accumulated.push(assistantParam(message));
        yield message;
      }
      if (opts.failAfter === rounds.length) throw new Error("provider exploded");
    },
  };
}

export function streamingRunner(
  params: { messages: unknown[] } & Record<string, unknown>,
  rounds: { text: string; message: StructuralMessage }[],
) {
  const accumulated = [...params.messages];
  const runnerParams = { ...params, messages: accumulated };
  return {
    params: runnerParams,
    async *[Symbol.asyncIterator]() {
      for (const round of rounds) {
        let onText: ((text: string) => void) | undefined;
        yield {
          on(event: string, callback: (text: string) => void) {
            if (event === "text") onText = callback;
            return this;
          },
          async finalMessage() {
            onText?.(round.text);
            accumulated.push(assistantParam(round.message));
            return round.message;
          },
        };
      }
    },
  };
}

export function traceStub() {
  return {
    traceId: "provider-contract-trace",
    event() {},
    end() {},
    update() {},
  };
}
