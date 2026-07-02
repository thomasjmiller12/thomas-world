import { describe, it, expect } from "vitest";
import { urlGuard, extractReadable } from "./webread.js";

describe("urlGuard — SSRF fence", () => {
  it("allows ordinary public https URLs", () => {
    expect(urlGuard("https://example.com/post/1").ok).toBe(true);
    expect(urlGuard("http://blog.example.co.uk/a?b=c").ok).toBe(true);
  });

  it("refuses non-http schemes", () => {
    expect(urlGuard("ftp://example.com/x").ok).toBe(false);
    expect(urlGuard("file:///etc/passwd").ok).toBe(false);
    expect(urlGuard("not a url").ok).toBe(false);
  });

  it("refuses IP literals, localhost, and internal names", () => {
    expect(urlGuard("http://127.0.0.1/admin").ok).toBe(false);
    expect(urlGuard("http://10.0.0.4:8787/debug").ok).toBe(false);
    expect(urlGuard("http://[::1]/x").ok).toBe(false);
    expect(urlGuard("http://localhost:8787/health").ok).toBe(false);
    expect(urlGuard("http://postgres.railway.internal:5432").ok).toBe(false);
    expect(urlGuard("http://hindsight/x").ok).toBe(false); // single-label
    expect(urlGuard("http://printer.local/jobs").ok).toBe(false);
  });

  it("refuses embedded credentials", () => {
    expect(urlGuard("https://user:pass@example.com/").ok).toBe(false);
  });
});

describe("extractReadable — crude readability", () => {
  it("pulls title + prose, drops scripts/styles/nav", () => {
    const html = `
      <html><head><title>My Post &amp; Notes</title><style>.x{color:red}</style></head>
      <body>
        <nav><a href="/">home</a><a href="/about">about</a></nav>
        <script>alert("nope")</script>
        <article>
          <h1>My Post</h1>
          <p>First paragraph of real content.</p>
          <p>Second paragraph, with <a href="x">a link</a> inline.</p>
          <ul><li>point one</li><li>point two</li></ul>
        </article>
        <footer>© nobody</footer>
      </body></html>`;
    const { title, text } = extractReadable(html);
    expect(title).toBe("My Post & Notes");
    expect(text).toContain("First paragraph of real content.");
    expect(text).toContain("- point one");
    expect(text).not.toContain("alert(");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("about");
  });

  it("decodes common entities", () => {
    const { text } = extractReadable("<p>Fish &amp; chips &mdash;ish &#8212; &quot;yes&quot; &#x27;s</p>".replace("&mdash;ish &#8212;", "&#8212;"));
    expect(text).toContain('Fish & chips — "yes"');
  });
});
