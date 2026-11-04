import { describe, expect, test } from "bun:test";
import { fileRefOf, fileReference, joinPath, tildePath } from "../src/filequote";
import { chipsIn } from "../../shared/chips";
import { quoteReference } from "../../shared/kuru";
import { qualify } from "../../shared/remote";
import { rolePrompt } from "../../shared/harness";

const PROJECT = "/Users/me/Desktop/Nyto/kururu";
const none = () => null;

describe("a file's reference", () => {
  test("a file in a project is the project's path, with the project from ~", () => {
    const ref = fileRefOf(PROJECT, "docs/terminals.md", [PROJECT, "/Users/me"], none);
    expect(ref).toEqual({ path: "docs/terminals.md", project: "~/Desktop/Nyto/kururu" });
    expect(fileReference(ref)).toBe("[file docs/terminals.md (~/Desktop/Nyto/kururu)]");
  });

  test("a reader rooted below the project is still spelt from the project, the deepest one holding it", () => {
    const ref = fileRefOf(`${PROJECT}/docs`, "research/x.md", ["/Users/me/Desktop", PROJECT], none);
    expect(ref).toEqual({ path: "docs/research/x.md", project: "~/Desktop/Nyto/kururu" });
  });

  test("a file in no project is written whole, and a home directory is no project", () => {
    const ref = fileRefOf("/Users/me/Documents/Kururu/reports", "a/b.md", [PROJECT, "/Users/me"], none);
    expect(fileReference(ref)).toBe("[file ~/Documents/Kururu/reports/a/b.md]");
    expect(fileReference(fileRefOf("/opt/notes", "x.md", [], none))).toBe("[file /opt/notes/x.md]");
  });

  test("another node's file says the node", () => {
    const root = qualify("n0123456789ab", "/home/omarchy/proj");
    expect(fileReference(fileRefOf(root, "README.md", [], () => "omarchy"))).toBe("[file README.md (omarchy:~/proj)]");
  });

  test("a quote's place: the lines, one or a range, and the heading cut and kept inside its quotes", () => {
    const ref = { path: "docs/terminals.md", project: "~/kururu" };
    expect(fileReference(ref, { line: { from: 40, to: 40 }, heading: "The pool" })).toBe('[file docs/terminals.md:40 (~/kururu) under "The pool"]');
    expect(fileReference(ref, { line: { from: 40, to: 52 }, heading: 'Say "hi" [now]' })).toBe(`[file docs/terminals.md:40-52 (~/kururu) under "Say 'hi' now"]`);
    expect(fileReference(ref, { line: null, heading: null })).toBe("[file docs/terminals.md (~/kururu)]");
  });

  test("paths", () => {
    expect(tildePath("/Users/me/x")).toBe("~/x");
    expect(tildePath("/home/omarchy")).toBe("~");
    expect(tildePath("/Users2/me/x")).toBe("/Users2/me/x");
    expect(joinPath("/a/b", "./c/../d.md")).toBe("/a/b/d.md");
    expect(joinPath("/a/b", "/x/y.md")).toBe("/x/y.md");
  });
});

describe("a file's chips", () => {
  const ref = { path: "docs/research/socios.md", project: "~/Desktop/Nyto/kururu" };

  test("a reference alone is a file chip by its name", () => {
    const draft = `${fileReference(ref)} what is this`;
    const [chip] = chipsIn(draft);
    expect(chip).toMatchObject({ kind: "file", from: 0, to: fileReference(ref).length, label: "socios.md" });
    expect(chip!.full).toBe("docs/research/socios.md in ~/Desktop/Nyto/kururu");
  });

  test("a quote of a file is one quote chip with the file's name, and several stack up", () => {
    const a = quoteReference(fileReference(ref, { line: { from: 12, to: 18 }, heading: "Who pays" }), { part: "body", text: 'the "partner" share is 40%', comment: "why 40?" });
    const b = quoteReference(fileReference({ path: "~/Documents/x.md", project: null }, { line: { from: 3, to: 3 }, heading: null }), { part: "body", text: "second bit", comment: "" });
    const draft = `${a}\n${b}`;
    const chips = chipsIn(draft);
    expect(chips.map((c) => [c.kind, c.source, c.label])).toEqual([
      ["quote", "socios.md", "the 'partner' share is 40%"],
      ["quote", "x.md", "second bit"],
    ]);
    expect(draft.slice(chips[0]!.to)).toStartWith(" why 40?\n");
    expect(chips[0]!.full).toBe(`"the 'partner' share is 40%" — from docs/research/socios.md, lines 12–18 in ~/Desktop/Nyto/kururu under "Who pays"`);
  });

  test("another node's file is named without the node", () => {
    const [chip] = chipsIn("[file omarchy:~/notes/plan.md]");
    expect(chip).toMatchObject({ kind: "file", label: "plan.md" });
  });

  test("a near miss stays words", () => {
    expect(chipsIn("[file ]")).toEqual([]);
    expect(chipsIn("[file a\nb.md]")).toEqual([]);
  });
});

describe("Kuru's role", () => {
  test("explains a file's reference and quote with examples the box draws as chips", () => {
    const role = rolePrompt({ profile: "main", workspaces: [], launchers: [] });
    expect(role).toContain("## Files the user points at");
    const quoted = /\[file [^\]]* under "[^"]*"\] \[quote "[^"]*"\]/.exec(role)?.[0] ?? "";
    expect(chipsIn(quoted).map((c) => [c.kind, c.source])).toEqual([["quote", "terminals.md"]]);
    const bare = /\[file docs\/terminals\.md \([^)]*\)\]/.exec(role)?.[0] ?? "";
    expect(chipsIn(bare).map((c) => c.kind)).toEqual(["file"]);
  });
});
