// Read bounds belong to one result, not to the resource. Explicit continuation
// lets a resident finish a large file without pretending the omitted text was
// already delivered or requiring Thomas to split the source for them.
export const READ_PAGE_DEFAULT = 8_000;
export const READ_PAGE_MAX = 12_000;

export interface ReadPageOptions {
  offset?: number;
  maxChars?: number;
}

export function renderReadPage(
  text: string,
  options: ReadPageOptions,
  tool: string,
  args: Record<string, unknown>,
): string {
  const offset = options.offset ?? 0;
  const maxChars = options.maxChars ?? READ_PAGE_DEFAULT;
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > READ_PAGE_MAX) {
    return `Use a nonnegative integer offset and max_chars between 1 and ${READ_PAGE_MAX}.`;
  }
  if (offset > text.length) return `Offset ${offset} is past the end (${text.length} characters). Start at offset 0 to inspect the current content.`;
  const end = Math.min(offset + maxChars, text.length);
  const continuation = end < text.length
    ? `Continue with ${tool}(${JSON.stringify({ ...args, offset: end, max_chars: maxChars })}).`
    : "End of content.";
  return `Characters ${offset}–${end} of ${text.length} (zero-based, end exclusive).\n\n${text.slice(offset, end)}\n\n${continuation}`;
}
