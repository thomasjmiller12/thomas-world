// Pure SSE wire-format helpers shared by WorldClient. Kept free of DOM/network
// so they unit-test cleanly. The chat stream is POST-SSE (consumed via fetch +
// ReadableStream, design doc §5 transport note): each `data:` line is one
// serialized ChatStreamFrame, the `type` field is the discriminator, and
// per-type SSE `event:` names are NOT used on the chat stream.

// One parsed SSE block: the event name (named events only used on the GET
// /events/stream firehose), the joined data payload, and the id (for
// Last-Event-ID resume).
export interface SseMessage {
  event: string | null;
  data: string;
  id: string | null;
}

// Incremental SSE parser. Feed it decoded text chunks; it returns the complete
// messages found so far and buffers the partial tail for the next feed. A
// message is terminated by a blank line (\n\n). Comment lines (":") — used for
// heartbeats — yield a message with empty data so callers can skip them.
export class SseParser {
  private buffer = '';

  feed(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];
    let sepIndex: number;
    // Split on a blank line. Normalize CRLF to LF first.
    this.buffer = this.buffer.replace(/\r\n/g, '\n');
    while ((sepIndex = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, sepIndex);
      this.buffer = this.buffer.slice(sepIndex + 2);
      const parsed = parseSseBlock(block);
      if (parsed) messages.push(parsed);
    }
    return messages;
  }
}

// Parse a single SSE block (the text between blank-line separators). Returns
// null for an all-comment/empty block. Data lines are joined with '\n' per spec.
export function parseSseBlock(block: string): SseMessage | null {
  let event: string | null = null;
  let id: string | null = null;
  const dataLines: string[] = [];
  let sawField = false;

  for (const rawLine of block.split('\n')) {
    if (rawLine === '' || rawLine.startsWith(':')) continue; // comment/heartbeat
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    // Spec: a single leading space after the colon is stripped.
    let value = colon === -1 ? '' : rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        event = value;
        sawField = true;
        break;
      case 'data':
        dataLines.push(value);
        sawField = true;
        break;
      case 'id':
        id = value;
        sawField = true;
        break;
      default:
        // ignore unknown fields (e.g. retry)
        break;
    }
  }

  if (!sawField) return null;
  return { event, data: dataLines.join('\n'), id };
}

// A heartbeat is an SSE comment (no fields) — callers skip it without parsing.
// After the incremental parser strips comments, a heartbeat surfaces as an
// empty-data message; this predicate lets callers skip those too.
export function isHeartbeat(msg: SseMessage): boolean {
  return msg.event === null && msg.data === '';
}
