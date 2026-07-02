// read_web_page (programmable world, D4): fetch a public web page and reduce it
// to readable text an agent can actually use — title + main prose — without
// adding a readability dependency (HARD RULE elsewhere in this repo: no new
// deps for infrastructure). Regex-based extraction is crude but fine for the
// use case (reading an article together, pulling a reference).
//
// Guards (this runs inside the Railway private network, so SSRF is the real
// risk, not politeness):
//   - http/https only, no credentials in the URL
//   - hostname must be a real public name: no IP literals, no localhost, no
//     .internal/.local/.railway.internal, no single-label names
//   - 15s timeout, ~2MB read cap, text/* and application/*+xml content only

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000;

export function urlGuard(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "That doesn't parse as a URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Only http(s) pages can be read." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URLs with embedded credentials can't be read." };
  }
  const host = url.hostname.toLowerCase();
  const isIpV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const isIpV6 = host.includes(":") || host.startsWith("[");
  const isLocalName =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".railway.internal") ||
    !host.includes(".");
  if (isIpV4 || isIpV6 || isLocalName) {
    return { ok: false, reason: "That address points inside the walls — only public sites can be read." };
  }
  return { ok: true, url };
}

// Strip an HTML document down to readable text. Order matters: kill script/
// style/nav-ish blocks first, then convert structure to line breaks, then
// strip remaining tags and decode the common entities.
export function extractReadable(html: string): { title: string | null; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()).slice(0, 300) : null;

  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // Prefer the <article>/<main> block when one exists — the readability core.
  const main = /<(article|main)[^>]*>([\s\S]*?)<\/\1>/i.exec(s);
  if (main && main[2].replace(/<[^>]+>/g, "").trim().length > 400) s = main[2];

  s = s
    .replace(/<(h[1-6])[^>]*>/gi, "\n\n## ")
    .replace(/<\/(p|div|section|li|tr|blockquote|h[1-6])>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ");

  const text = decodeEntities(s)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, text };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export async function readWebPage(
  raw: string,
): Promise<{ ok: boolean; title?: string | null; text?: string; url?: string; reason?: string }> {
  const guard = urlGuard(raw);
  if (!guard.ok) return { ok: false, reason: guard.reason };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(guard.url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "ThomasTown/1.0 (+https://thomastown.dev; an agent reading a page a visitor asked about)",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
    });
    if (!res.ok) return { ok: false, reason: `The page answered ${res.status} — nothing readable came back.` };
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/|xml|json/.test(type)) {
      return { ok: false, reason: `That's ${type || "an unknown format"}, not a readable page.` };
    }

    // Read up to the byte cap, then stop — a huge page's head is enough.
    const reader = res.body?.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          bytes += value.byteLength;
          if (bytes >= MAX_BYTES) {
            await reader.cancel().catch(() => {});
            break;
          }
        }
      }
    }
    const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    if (/json/.test(type)) return { ok: true, title: null, text: html.slice(0, 40_000), url: res.url };
    const { title, text } = extractReadable(html);
    if (!text) return { ok: false, reason: "The page loaded but nothing readable could be pulled out of it." };
    return { ok: true, title, text, url: res.url };
  } catch (err) {
    const msg = (err as Error).name === "AbortError" ? "it took too long to answer" : (err as Error).message;
    return { ok: false, reason: `Couldn't reach that page (${msg}).` };
  } finally {
    clearTimeout(timer);
  }
}
