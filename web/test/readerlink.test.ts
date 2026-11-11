/**
 * That no link in a rendered document is left for the browser to follow into
 * the app's own window, which is what made a link to a sibling `.md` read as
 * kururu crashing (2026-11-11).
 *
 * The hrefs are the ones `server/src/markdown.ts` writes, so these are the two
 * halves of one contract: a relative path arrives as `/api/file-raw?root&path`,
 * already resolved against the document, with its fragment kept apart.
 */
import { describe, expect, test } from "bun:test";
import { readerLink } from "../src/readerlink";

const raw = (path: string, hash = "") => `/api/file-raw?${new URLSearchParams({ root: "/p", path })}${hash}`;
const HERE = "docs/legal/README.md";

describe("readerLink", () => {
  test("a sibling markdown file is a document for the reader", () => {
    expect(readerLink(raw("docs/legal/bancard.md"), HERE)).toEqual({ kind: "doc", path: "docs/legal/bancard.md", fragment: null });
  });

  test("a parent's markdown file too, by the path the server resolved", () => {
    expect(readerLink(raw("docs/ticketing.md"), HERE)).toEqual({ kind: "doc", path: "docs/ticketing.md", fragment: null });
  });

  test("a heading in another document is that document and the heading", () => {
    expect(readerLink(raw("docs/legal/contador.md", "#preguntas%20finales"), HERE)).toEqual({
      kind: "doc",
      path: "docs/legal/contador.md",
      fragment: "preguntas finales",
    });
  });

  test("a fragment an older server left inside the path is split off", () => {
    expect(readerLink(raw("docs/legal/contador.md#preguntas"), HERE)).toEqual({
      kind: "doc",
      path: "docs/legal/contador.md",
      fragment: "preguntas",
    });
  });

  test("a heading in this document is a scroll, by either spelling", () => {
    expect(readerLink("#the-order", HERE)).toEqual({ kind: "anchor", fragment: "the-order" });
    expect(readerLink(raw(HERE, "#the-order"), HERE)).toEqual({ kind: "anchor", fragment: "the-order" });
  });

  test("this document with no heading named does nothing", () => {
    expect(readerLink(raw(HERE), HERE)).toEqual({ kind: "none" });
    expect(readerLink("#", HERE)).toEqual({ kind: "none" });
  });

  test("a markdown file on another node's disk is a document all the same", () => {
    const href = `/api/node/omarchy/file-raw?${new URLSearchParams({ root: "/p", path: "docs/b.md" })}`;
    expect(readerLink(href, HERE)).toEqual({ kind: "doc", path: "docs/b.md", fragment: null });
  });

  test("any other file of the project is opened outside the window, without its fragment", () => {
    expect(readerLink(raw("docs/legal/scan.pdf"), HERE)).toEqual({ kind: "file", href: raw("docs/legal/scan.pdf") });
    expect(readerLink(raw("src/index.ts", "#L4"), HERE)).toEqual({ kind: "file", href: raw("src/index.ts") });
  });

  test("the web and mail leave kururu", () => {
    expect(readerLink("https://example.com/a", HERE)).toEqual({ kind: "out", href: "https://example.com/a" });
    expect(readerLink("mailto:a@b.c", HERE)).toEqual({ kind: "out", href: "mailto:a@b.c" });
  });

  test("an emptied scheme, a bare path, or nothing does nothing", () => {
    for (const href of [null, "", "/", "/api/markdown?root=%2Fp&path=a.md", "bancard.md", "file:///etc/passwd", raw("")]) {
      expect(readerLink(href, HERE)).toEqual({ kind: "none" });
    }
  });
});
