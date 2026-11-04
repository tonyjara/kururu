/**
 * Kuru's Markdown as the drawer's tree: what each construct becomes, that
 * the words in every one of them are leaves the drawer can put its doors
 * and marks into, that a half-written reply is still words and never a
 * broken block, that raw HTML is text and an executing scheme is not a
 * link, and what a folded line shows of a reply that begins with a mark.
 */
import { describe, expect, it } from "bun:test";
import { foldInline, inlineOf, linkTo, plainInline, plainText, replyTree, type MdBlock, type MdInline } from "../src/kurumd";

function leaves(nodes: readonly MdInline[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.kind === "text" || node.kind === "code") out.push(node.text);
    else if ("children" in node) out.push(...leaves(node.children));
  }
  return out;
}

function kinds(blocks: readonly MdBlock[]): string[] {
  return blocks.map((block) => block.kind);
}

describe("replyTree", () => {
  it("draws the whole of GFM that a reply uses", () => {
    const tree = replyTree(
      [
        "## Done",
        "",
        "Changed **two** files and _one_ test; ~~three~~.",
        "",
        "| agent | state |",
        "|---|--:|",
        "| a | working |",
        "",
        "1. first",
        "2. second",
        "   - nested",
        "",
        "> a quote",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "---",
        "",
        "[docs](https://example.com/docs)",
      ].join("\n"),
    );
    expect(kinds(tree)).toEqual(["heading", "paragraph", "table", "list", "quote", "fence", "rule", "paragraph"]);
    const [heading, paragraph, table, list, quote, fence, , link] = tree;
    expect(heading).toMatchObject({ kind: "heading", level: 2 });
    expect(paragraph!.kind === "paragraph" && paragraph.children.map((n) => n.kind)).toEqual(["text", "strong", "text", "em", "text", "strike", "text"]);
    expect(table).toMatchObject({ kind: "table", head: [{ align: null }, { align: "right" }] });
    expect(table!.kind === "table" && table.rows[0]![1]!.align).toBe("right");
    expect(list).toMatchObject({ kind: "list", ordered: true, start: 1 });
    expect(list!.kind === "list" && list.items[1]!.children.map((b) => b.kind)).toEqual(["paragraph", "list"]);
    expect(quote!.kind === "quote" && kinds(quote.children)).toEqual(["paragraph"]);
    expect(fence).toEqual({ kind: "fence", text: "const x = 1;", lang: "ts" });
    expect(link!.kind === "paragraph" && link.children[0]).toMatchObject({ kind: "link", href: "https://example.com/docs", to: "web" });
  });

  it("keeps a path a leaf wherever it stands, so the drawer's doors reach it", () => {
    const tree = replyTree("See **`docs/plan.md`**, the cell\n\n| file |\n|---|\n| `src/a.ts:12` |\n\n- in a list: src/b.ts\n\n```sh\ncat docs/plan.md\n```");
    const words = plainText(tree);
    expect(words).toContain("docs/plan.md");
    expect(words).toContain("src/a.ts:12");
    expect(words).toContain("src/b.ts");
    const table = tree[1];
    expect(table!.kind === "table" && table.rows[0]![0]!.children[0]).toEqual({ kind: "code", text: "src/a.ts:12" });
    const fence = tree[3];
    expect(fence).toEqual({ kind: "fence", text: "cat docs/plan.md", lang: "sh" });
  });

  it("makes a link's path target the drawer's to resolve", () => {
    const [p] = replyTree("[the plan](docs/plan.md:40) and [a note](~/notes/x.md) and [section](#here)");
    expect(p!.kind === "paragraph" && p.children.filter((n) => n.kind === "link").map((n) => n.kind === "link" && [n.href, n.to])).toEqual([
      ["docs/plan.md:40", "path"],
      ["~/notes/x.md", "path"],
      ["#here", "none"],
    ]);
  });

  it("is words on one line per line, as the bubble was", () => {
    const [p] = replyTree("one\ntwo");
    expect(p!.kind === "paragraph" && p.children.map((n) => n.kind)).toEqual(["text", "break", "text"]);
  });

  it("links a URL with its scheme and not a bare domain, which .md would make Moldovan", () => {
    const [p] = replyTree("read https://example.com/x then plan.md and example.com");
    const nodes = p!.kind === "paragraph" ? p.children : [];
    expect(nodes.filter((n) => n.kind === "link").map((n) => n.kind === "link" && n.href)).toEqual(["https://example.com/x"]);
    expect(plainInline(nodes)).toBe("read https://example.com/x then plan.md and example.com");
  });

  it("reads a task list's boxes", () => {
    const [list] = replyTree("- [ ] open\n- [x] done\n- plain");
    expect(list!.kind === "list" && list.items.map((item) => item.checked)).toEqual([false, true, null]);
    expect(list!.kind === "list" && plainText(list.items[0]!.children)).toBe("open");
  });

  it("keeps a half-written reply as words, never a broken block", () => {
    expect(plainText(replyTree("half **bold"))).toBe("half **bold");
    expect(plainText(replyTree("a `code"))).toBe("a `code");
    expect(kinds(replyTree("| a | b |\n| 1 |"))).toEqual(["paragraph"]);
    expect(kinds(replyTree("```ts\nconst x"))).toEqual(["fence"]);
    expect(replyTree("")).toEqual([]);
  });

  it("is text and never markup: raw HTML stays the characters, an executing scheme is not a link", () => {
    const tree = replyTree('<script>alert(1)</script> <img src=x onerror=alert(1)> [j](javascript:alert(1)) [d](data:text/html,x) <a href="x">y</a>');
    expect(kinds(tree)).toEqual(["paragraph"]);
    const nodes = tree[0]!.kind === "paragraph" ? tree[0].children : [];
    expect(nodes.some((n) => n.kind === "link")).toBe(false);
    expect(plainInline(nodes)).toBe('<script>alert(1)</script> <img src=x onerror=alert(1)> [j](javascript:alert(1)) [d](data:text/html,x) <a href="x">y</a>');
    expect(plainText(replyTree("<div>\nblock\n</div>"))).toBe("<div>\nblock\n</div>");
  });

  it("names every other scheme nowhere", () => {
    expect(linkTo("https://x")).toBe("web");
    expect(linkTo("HTTP://x")).toBe("web");
    expect(linkTo("mailto:a@b")).toBe("mail");
    expect(linkTo("docs/x.md")).toBe("path");
    expect(linkTo("/abs/x.md")).toBe("path");
    expect(linkTo("ftp://x")).toBe("none");
    expect(linkTo("vscode://x")).toBe("none");
    expect(linkTo("")).toBe("none");
  });

  it("merges the words markdown-it cuts at an escape, so a door finds a whole path", () => {
    const [p] = replyTree("src/a\\_b.md");
    expect(p!.kind === "paragraph" && p.children).toEqual([{ kind: "text", text: "src/a_b.md" }]);
  });

  it("shows an image from the web only, and the alt words otherwise", () => {
    const [p] = replyTree("![shot](https://example.com/a.png) ![local](./a.png)");
    const nodes = p!.kind === "paragraph" ? p.children : [];
    expect(nodes.filter((n) => n.kind === "image")).toEqual([
      { kind: "image", src: "https://example.com/a.png", alt: "shot" },
      { kind: "image", src: "./a.png", alt: "local" },
    ]);
  });
});

describe("foldInline", () => {
  it("is the first line with words, its block mark taken off, drawn inline", () => {
    expect(leaves(foldInline("## Done\n\nmore").children)).toEqual(["Done"]);
    expect(foldInline("## Done\n\nmore").more).toBe(true);
    expect(leaves(foldInline("- [x] **first** item").children)).toEqual(["first", " item"]);
    expect(foldInline("- [x] **first** item").children[0]!.kind).toBe("strong");
    expect(leaves(foldInline("> 1. quoted item\n").children)).toEqual(["quoted item"]);
    expect(foldInline("> 1. quoted item\n").more).toBe(false);
  });

  it("skips a fence's opening, a rule and a table's delimiter for the first words after them", () => {
    expect(leaves(foldInline("```ts\nconst x = 1;\n```").children)).toEqual(["const x = 1;"]);
    expect(leaves(foldInline("---\n\nafter the rule").children)).toEqual(["after the rule"]);
    expect(leaves(foldInline("| a | b |\n|---|---|\n| 1 | 2 |").children)).toEqual(["a · b"]);
  });

  it("is nothing for a reply with no words", () => {
    expect(foldInline("")).toEqual({ children: [], more: false });
    expect(foldInline("\n\n---\n")).toEqual({ children: [], more: false });
  });
});

describe("inlineOf", () => {
  it("is one line's runs, with a code span its own leaf", () => {
    expect(inlineOf("a `b` c")).toEqual([
      { kind: "text", text: "a " },
      { kind: "code", text: "b" },
      { kind: "text", text: " c" },
    ]);
  });
});
