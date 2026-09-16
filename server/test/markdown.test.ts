/**
 * That the reader cannot be talked into running something.
 *
 * `markdown.ts` argues at length that turning `html: false` on *is* the
 * sanitizer — the renderer is made incapable of emitting anything but its own
 * constructs, so there is no DOM in the server holding a document while it is
 * scrubbed. That argument is right and it was, until this file, a comment. The
 * property it describes is one line of configuration away from being silently
 * untrue: `html: true` typechecks, reads as an improvement to anybody who has
 * not read the paragraph above it, and produces a reader that renders a
 * `<script>` an agent wrote into a README.
 *
 * The URLs are the other half and they are not covered by that switch at all,
 * because a link is markdown's own construct and its target still lands in an
 * `href` the browser acts on. `javascript:` is the scheme everybody names and
 * `data:` is the one people forget; both are refused here rather than escaped,
 * because there is nothing to escape — the text is fine, it is the destination
 * that is not.
 *
 * The output is HTML, so these assert on substrings rather than parsing it. That
 * is deliberate: the thing being checked is what reaches the browser, and a
 * parser in the test would be a second renderer to disagree with the first.
 */
import { describe, expect, it } from "bun:test";
import { renderMarkdown } from "../src/markdown";

const render = (text: string, root = "/project", rel = "README.md") =>
  renderMarkdown(text, root, rel, "kururu").then((r) => r.html);

/**
 * Every `href` and `src` the output actually carries.
 *
 * The assertions go through this rather than searching the whole string, and the
 * difference is the entire point of the test. A refused scheme does not vanish
 * from the page — markdown-it declines to build a link at all, so `[a](data:…)`
 * comes back as the literal text somebody typed, escaped. Searching for the
 * substring would fail on output that is completely correct, and the version of
 * this test that did was how the distinction got noticed. What must be true is
 * narrower and is the thing that matters: no *attribute* the browser acts on
 * carries one.
 */
function targets(html: string): string[] {
  return [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1]!);
}

describe("raw HTML", () => {
  it("shows a script tag rather than emitting one", async () => {
    const html = await render("<script>alert(1)</script>\n");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes an inline event handler on a would-be element", async () => {
    const html = await render(`Look: <img src=x onerror="alert(1)">\n`);
    // The text survives, because that is what the file says; what must not
    // survive is an element for the handler to be attached to.
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(targets(html)).toEqual([]);
  });

  it("escapes HTML inside a fenced block too", async () => {
    const html = await render("```html\n<script>alert(1)</script>\n```\n");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("link and image targets", () => {
  it("carries no javascript: target", async () => {
    const html = await render("[click](javascript:alert(1))\n");
    expect(targets(html)).toEqual([]);
  });

  it("carries no data: target, which is the one people forget", async () => {
    const html = await render("[click](data:text/html,<script>alert(1)</script>)\n");
    expect(targets(html)).toEqual([]);
    expect(html).not.toContain("<script>");
  });

  it("carries no data: image source either", async () => {
    const html = await render("![x](data:text/html;base64,PHNjcmlwdD4=)\n");
    expect(targets(html)).toEqual([]);
  });

  it("carries no vbscript: target — the rule is a list, not two names", async () => {
    const html = await render("[click](vbscript:msgbox(1))\n");
    expect(targets(html)).toEqual([]);
  });

  it("keeps an ordinary http link and sends it out of the window", async () => {
    const html = await render("[docs](https://example.com/a)\n");
    expect(html).toContain(`href="https://example.com/a"`);
    expect(html).toContain(`target="_blank"`);
    expect(html).toContain("noreferrer");
  });
});

describe("relative paths", () => {
  it("rewrites an image beside the document into a fetch kururu answers", async () => {
    const html = await render("![d](./diagram.png)\n", "/project", "docs/guide.md");
    expect(html).toContain("/api/file-raw?");
    expect(html).toContain("path=docs%2Fdiagram.png");
    expect(html).toContain("root=%2Fproject");
  });

  it("resolves .. against the document, not the root", async () => {
    const html = await render("![d](../img/a.png)\n", "/project", "docs/guide.md");
    expect(html).toContain("path=img%2Fa.png");
  });

  /**
   * A traversal is *rewritten*, not refused, and that is correct rather than an
   * oversight: this function only has to produce the path the author meant, and
   * `files.ts` is the thing that decides whether it may be read. What matters
   * here is that it stays a `/api/file-raw` URL, so it meets that check at all,
   * instead of becoming something the browser resolves for itself.
   */
  it("leaves an escaping path for files.ts to refuse", async () => {
    const html = await render("![k](../../../../etc/passwd)\n");
    expect(html).toContain("/api/file-raw?");
    expect(html).not.toContain(`src="../../../../etc/passwd"`);
  });
});

describe("mermaid", () => {
  it("hands the fence over escaped rather than rendering it", async () => {
    const html = await render("```mermaid\ngraph TD; A-->B;\n```\n");
    expect(html).toContain(`<pre class="mermaid">`);
    expect(html).toContain("graph TD; A--&gt;B;");
  });

  it("escapes a script inside a mermaid fence", async () => {
    const html = await render("```mermaid\n<script>alert(1)</script>\n```\n");
    expect(html).not.toContain("<script>");
  });
});

describe("the title", () => {
  it("is the first heading, and the file name when there is none", async () => {
    expect((await renderMarkdown("# Hello\n\nbody", "/p", "a.md", "kururu")).title).toBe("Hello");
    expect((await renderMarkdown("no heading", "/p", "docs/a.md", "kururu")).title).toBe("a.md");
  });
});
