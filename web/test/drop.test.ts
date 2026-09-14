/**
 * Dropping a file types its path in, so the escaping is the whole of it: a path
 * that comes out wrong is a command that runs against the wrong file, and the
 * paths people drag are exactly the ones with spaces and brackets in them —
 * "Screenshot 2026-09-14 at 11.02.33.png" is what a Mac calls a screenshot.
 */
import { describe, expect, it } from "bun:test";
import { escapePath, isFileDrag, pathsFrom, textForDrop } from "../src/drop";

/** Enough of a DataTransfer for the two things the code reads off one. */
function transfer(opts: { types?: string[]; uriList?: string } = {}): DataTransfer {
  return {
    types: opts.types ?? [],
    files: [],
    getData: (type: string) => (type === "text/uri-list" ? (opts.uriList ?? "") : ""),
  } as unknown as DataTransfer;
}

describe("escapePath", () => {
  it("leaves a plain path alone", () => {
    expect(escapePath("/Users/me/notes.md")).toBe("/Users/me/notes.md");
  });

  it("escapes the spaces a real screenshot has in it", () => {
    expect(escapePath("/Users/me/Screenshot 2026-09-14 at 11.02.33.png")).toBe(
      "/Users/me/Screenshot\\ 2026-09-14\\ at\\ 11.02.33.png",
    );
  });

  it("escapes every shell metacharacter, not just the ones people remember", () => {
    expect(escapePath("/tmp/a'b\"c$d`e(f)g[h]i;j&k|l<m>n*o?p#q!r")).toBe(
      "/tmp/a\\'b\\\"c\\$d\\`e\\(f\\)g\\[h\\]i\\;j\\&k\\|l\\<m\\>n\\*o\\?p\\#q\\!r",
    );
  });

  it("escapes a backslash rather than letting it escape what follows", () => {
    expect(escapePath("/tmp/a\\b")).toBe("/tmp/a\\\\b");
  });

  it("does not escape what never needs it, so ordinary paths stay readable", () => {
    expect(escapePath("/Users/me/my-project_v2/file.tar.gz")).toBe("/Users/me/my-project_v2/file.tar.gz");
  });
});

describe("isFileDrag", () => {
  it("is true only for a drag carrying files from outside the page", () => {
    expect(isFileDrag(transfer({ types: ["Files"] }))).toBe(true);
    expect(isFileDrag(transfer({ types: ["Files", "text/plain"] }))).toBe(true);
  });

  it("is false for kururu's own drags, which must reach their own drop zones", () => {
    expect(isFileDrag(transfer({ types: ["application/x-kururu-agent"] }))).toBe(false);
    expect(isFileDrag(transfer({ types: ["application/x-kururu-pane"] }))).toBe(false);
    expect(isFileDrag(transfer())).toBe(false);
    expect(isFileDrag(null)).toBe(false);
  });
});

describe("pathsFrom", () => {
  it("falls back to uri-list when there is no bridge to ask", () => {
    const list = "file:///Users/me/a.png\r\nfile:///Users/me/b%20c.png";
    expect(pathsFrom(transfer({ types: ["Files"], uriList: list }))).toEqual([
      "/Users/me/a.png",
      "/Users/me/b c.png",
    ]);
  });

  it("ignores anything in a uri-list that is not a file", () => {
    const list = "https://example.com/x.png\nfile:///Users/me/a.png\n# a comment";
    expect(pathsFrom(transfer({ types: ["Files"], uriList: list }))).toEqual(["/Users/me/a.png"]);
  });

  it("says nothing rather than something wrong when the runtime cannot answer", () => {
    expect(pathsFrom(transfer({ types: ["Files"] }))).toEqual([]);
    expect(pathsFrom(null)).toEqual([]);
  });
});

describe("textForDrop", () => {
  it("separates several paths and leaves a space to keep typing after", () => {
    const list = "file:///Users/me/a b.png\nfile:///Users/me/c.png";
    expect(textForDrop(transfer({ types: ["Files"], uriList: list }))).toBe(
      "/Users/me/a\\ b.png /Users/me/c.png ",
    );
  });

  it("types nothing at all when there is no path to type", () => {
    expect(textForDrop(transfer({ types: ["Files"] }))).toBe("");
  });
});
