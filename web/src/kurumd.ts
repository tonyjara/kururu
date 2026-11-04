/**
 * Kuru's words as a tree, parsed from the Markdown it writes them in.
 *
 * Kuru answers in GitHub-flavoured Markdown — a table of what each agent is
 * doing, a list of what changed, `code` for a name, **bold** for the one
 * thing to read — and until 2026-11-04 the drawer drew the characters: pipes
 * and asterisks in a bubble, a table as a column of `|`. The reader already
 * renders Markdown, and the first question was whether its renderer could be
 * borrowed. It cannot, and the reason is worth keeping: the reader is sent
 * *markup* by the server (`server/src/markdown.ts`), for the phone's sake,
 * and markup is a string the drawer could only drop into the page whole.
 * Everything the drawer does to a reply is done to its words as React
 * nodes — a path is a door onto the file the server found (`MadeInline`),
 * a card code a door onto the board, a search's words a `<mark>` inside
 * either — and none of that can be done to a string of HTML without
 * parsing the HTML, which is a second parser to keep the first one honest.
 *
 * So the drawer parses on the client, with the same library the server
 * renders with (markdown-it, CommonMark plus GFM tables and strikethrough,
 * raw HTML off), and this module turns its token stream into a small tree
 * of blocks and inline runs that `KuruMarkdown.tsx` draws, handing every
 * run of words back to the drawer to do what it did before. The tree is
 * the part worth testing, and it is pure: what a half-written `**` becomes,
 * that `<script>` is text, that a `javascript:` link is not a link, where a
 * path in a link's target goes.
 *
 * **Raw HTML is off, and that is the sanitizer** — the server's argument,
 * made again here: `html: false` means a `<img onerror>` in a reply arrives
 * as the characters, and the tree has no node a string of markup could ride
 * in on. What is still checked is a link's target, since that is Markdown's
 * own construct and ends up in an `href`: only `http(s)` and `mailto` are
 * links the browser follows; a relative target is a path, which is the
 * drawer's to turn into a file door or leave as words; any other scheme is
 * words with the target in a tooltip.
 *
 * A single newline is a line break, as it was when the bubble was
 * `pre-wrap`: Kuru writes a chat message, not a document, and "one line per
 * agent" is meant to stay one line per agent. Bare URLs are links; bare
 * domains are not, because linkify's guess at a domain takes `plan.md` for
 * Moldova.
 */
import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";

export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "break" }
  | { kind: "strong" | "em" | "strike"; children: MdInline[] }
  | { kind: "link"; href: string; to: LinkTo; children: MdInline[] }
  | { kind: "image"; src: string; alt: string };

/**
 * Where a link goes: out to the web, to a mail client, to a path on this
 * disk — the drawer's to resolve against the files the server found — or
 * nowhere, for a scheme the drawer will not carry (`javascript:`, `data:`,
 * an anchor into a document that is not here).
 */
export type LinkTo = "web" | "mail" | "path" | "none";

export type MdAlign = "left" | "center" | "right" | null;

export interface MdCell {
  align: MdAlign;
  children: MdInline[];
}

export interface MdItem {
  /** A GFM task — `- [ ]`, `- [x]` — with its box; null for an ordinary item. */
  checked: boolean | null;
  children: MdBlock[];
}

export type MdBlock =
  | { kind: "paragraph"; children: MdInline[] }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdInline[] }
  | { kind: "fence"; text: string; lang: string | null }
  | { kind: "quote"; children: MdBlock[] }
  | { kind: "list"; ordered: boolean; start: number; items: MdItem[] }
  | { kind: "rule" }
  | { kind: "table"; head: MdCell[]; rows: MdCell[][] };

/**
 * One parser for the page. Building one costs more than parsing a reply,
 * and nothing about it changes between replies.
 */
type Parser = ReturnType<typeof MarkdownIt>;

let parser: Parser | null = null;

function md(): Parser {
  if (parser) return parser;
  parser = MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
  // Only a URL with its scheme is a link. A bare domain is a guess, and the
  // guess takes `docs/plan.md` for a page in Moldova.
  parser.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
  return parser;
}

/** A reply's blocks. Never throws: markdown-it has an answer for every string, including half of one. */
export function replyTree(text: string): MdBlock[] {
  const tokens = md().parse(text, {});
  const at = { i: 0 };
  return blocks(tokens, at, null);
}

/**
 * What a folded line shows of a reply: its first line that says something,
 * as inline runs, with the block mark that began it — a heading's `#`, a
 * list's `-`, a quote's `>`, a table row's pipes — taken off, since one row
 * has no room to draw a block and the mark alone is noise. A fence's
 * opening line or a rule is skipped for the line after it.
 */
export function foldInline(text: string): { children: MdInline[]; more: boolean } {
  const lines = text.split("\n").map((line) => line.trim());
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i] ? stripBlockMarks(lines[i]!) : "";
    if (!stripped) continue;
    return { children: inlineOf(stripped), more: lines.slice(i + 1).some(Boolean) };
  }
  return { children: [], more: false };
}

/** The inline runs of one line of Markdown, for the fold and for tests. */
export function inlineOf(line: string): MdInline[] {
  const tokens = md().parseInline(line, {});
  const inline = tokens[0];
  if (!inline?.children) return line ? [{ kind: "text", text: line }] : [];
  return inlines(inline.children, { i: 0 }, null);
}

const FENCE_OR_RULE = /^(?:`{3,}|~{3,}|[-*_]{3,}\s*$|\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$)/;
const BLOCK_MARK = /^(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+)/;

function stripBlockMarks(line: string): string {
  if (FENCE_OR_RULE.test(line)) return "";
  let out = line;
  for (let guard = 0; guard < 6; guard++) {
    const next = out.replace(BLOCK_MARK, "");
    if (next === out) break;
    out = next;
  }
  if (out.startsWith("|")) {
    out = out
      .replace(/^\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(" · ");
  }
  return out.trim();
}

/** A cursor into the flat token list, shared down the recursion so each level reads on from where the last stopped. */
interface At {
  i: number;
}

function blocks(tokens: Token[], at: At, until: string | null): MdBlock[] {
  const out: MdBlock[] = [];
  while (at.i < tokens.length) {
    const token = tokens[at.i++]!;
    if (until !== null && token.type === until) return out;
    switch (token.type) {
      case "paragraph_open":
        out.push({ kind: "paragraph", children: inlineAt(tokens, at) });
        skipTo(tokens, at, "paragraph_close");
        break;
      case "heading_open": {
        const level = Number(token.tag.slice(1));
        out.push({ kind: "heading", level: (level >= 1 && level <= 6 ? level : 6) as 1 | 2 | 3 | 4 | 5 | 6, children: inlineAt(tokens, at) });
        skipTo(tokens, at, "heading_close");
        break;
      }
      case "fence": {
        const lang = token.info.trim().split(/\s+/)[0] ?? "";
        out.push({ kind: "fence", text: trimFence(token.content), lang: lang || null });
        break;
      }
      case "code_block":
        out.push({ kind: "fence", text: trimFence(token.content), lang: null });
        break;
      case "hr":
        out.push({ kind: "rule" });
        break;
      case "blockquote_open":
        out.push({ kind: "quote", children: blocks(tokens, at, "blockquote_close") });
        break;
      case "bullet_list_open":
      case "ordered_list_open": {
        const start = Number(token.attrGet("start") ?? 1);
        out.push({
          kind: "list",
          ordered: token.type === "ordered_list_open",
          start: Number.isFinite(start) && start >= 0 ? start : 1,
          items: items(tokens, at, token.type === "ordered_list_open" ? "ordered_list_close" : "bullet_list_close"),
        });
        break;
      }
      case "table_open":
        out.push(table(tokens, at));
        break;
      default:
        // `html_block` cannot occur with html off; anything else unknown is
        // a plugin's, and there are no plugins. An unknown opener is walked
        // past with its contents, so a nesting level is never lost.
        if (token.nesting === 1) skipTo(tokens, at, token.type.replace(/_open$/, "_close"));
        break;
    }
  }
  return out;
}

/** A fence's content ends in the newline before its closing line; the block draws without it. */
function trimFence(content: string): string {
  return content.replace(/\n$/, "");
}

function skipTo(tokens: Token[], at: At, type: string): void {
  while (at.i < tokens.length && tokens[at.i]!.type !== type) at.i++;
  if (at.i < tokens.length) at.i++;
}

/** The inline runs of the `inline` token at the cursor, or none when the block has no words. */
function inlineAt(tokens: Token[], at: At): MdInline[] {
  const token = tokens[at.i];
  if (!token || token.type !== "inline") return [];
  at.i++;
  return inlines(token.children ?? [], { i: 0 }, null);
}

const TASK = /^\[([ xX])\]\s+/;

function items(tokens: Token[], at: At, until: string): MdItem[] {
  const out: MdItem[] = [];
  while (at.i < tokens.length) {
    const token = tokens[at.i++]!;
    if (token.type === until) return out;
    if (token.type !== "list_item_open") continue;
    const children = blocks(tokens, at, "list_item_close");
    out.push({ checked: taskBox(children), children });
  }
  return out;
}

/**
 * A GFM task item: `[ ]` or `[x]` opening the item's first words. markdown-it
 * has no rule for it, so the bracket arrives as text, and the drawer's box
 * is worth the one check — Kuru writes a plan as tasks.
 */
function taskBox(children: MdBlock[]): boolean | null {
  const first = children[0];
  if (!first || first.kind !== "paragraph") return null;
  const lead = first.children[0];
  if (!lead || lead.kind !== "text") return null;
  const match = TASK.exec(lead.text);
  if (!match) return null;
  lead.text = lead.text.slice(match[0].length);
  if (!lead.text) first.children.shift();
  return match[1] !== " ";
}

function table(tokens: Token[], at: At): MdBlock {
  const head: MdCell[] = [];
  const rows: MdCell[][] = [];
  let inHead = false;
  while (at.i < tokens.length) {
    const token = tokens[at.i++]!;
    if (token.type === "table_close") break;
    if (token.type === "thead_open") inHead = true;
    else if (token.type === "thead_close") inHead = false;
    else if (token.type === "tr_open") {
      const cells = row(tokens, at);
      if (inHead) head.push(...cells);
      else rows.push(cells);
    }
  }
  return { kind: "table", head, rows };
}

function row(tokens: Token[], at: At): MdCell[] {
  const cells: MdCell[] = [];
  while (at.i < tokens.length) {
    const token = tokens[at.i++]!;
    if (token.type === "tr_close") break;
    if (token.type === "th_open" || token.type === "td_open") {
      cells.push({ align: alignOf(token), children: inlineAt(tokens, at) });
      skipTo(tokens, at, token.type === "th_open" ? "th_close" : "td_close");
    }
  }
  return cells;
}

/** markdown-it writes a column's alignment as `style="text-align:right"`; the tree keeps the word. */
function alignOf(token: Token): MdAlign {
  const style = token.attrGet("style");
  const match = typeof style === "string" ? /text-align:\s*(left|center|right)/.exec(style) : null;
  return (match?.[1] as MdAlign) ?? null;
}

function inlines(tokens: Token[], at: At, until: string | null): MdInline[] {
  const out: MdInline[] = [];
  const text = (piece: string) => {
    if (!piece) return;
    const last = out[out.length - 1];
    if (last && last.kind === "text") last.text += piece;
    else out.push({ kind: "text", text: piece });
  };
  while (at.i < tokens.length) {
    const token = tokens[at.i++]!;
    if (until !== null && token.type === until) return out;
    switch (token.type) {
      case "text":
        text(token.content);
        break;
      case "code_inline":
        out.push({ kind: "code", text: token.content });
        break;
      case "softbreak":
      case "hardbreak":
        out.push({ kind: "break" });
        break;
      case "strong_open":
        out.push({ kind: "strong", children: inlines(tokens, at, "strong_close") });
        break;
      case "em_open":
        out.push({ kind: "em", children: inlines(tokens, at, "em_close") });
        break;
      case "s_open":
        out.push({ kind: "strike", children: inlines(tokens, at, "s_close") });
        break;
      case "link_open": {
        const href = String(token.attrGet("href") ?? "");
        out.push({ kind: "link", href, to: linkTo(href), children: inlines(tokens, at, "link_close") });
        break;
      }
      case "image":
        out.push({ kind: "image", src: String(token.attrGet("src") ?? ""), alt: token.content });
        break;
      default:
        // `html_inline` cannot occur with html off. An unknown opener's words
        // are still words: they are kept, and only the mark is dropped.
        if (token.nesting === 1) out.push(...inlines(tokens, at, token.type.replace(/_open$/, "_close")));
        else if (token.content) text(token.content);
        break;
    }
  }
  return out;
}

export function linkTo(href: string): LinkTo {
  if (/^https?:\/\//i.test(href)) return "web";
  if (/^mailto:/i.test(href)) return "mail";
  if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return "none";
  return "path";
}

/**
 * The words of a tree as one string, blocks on their own lines, for a test
 * to say what a reply became and for nothing else: the drawer's words are
 * its leaves, drawn in place.
 */
export function plainText(blocks: readonly MdBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "rule":
          return "";
        case "fence":
          return block.text;
        case "quote":
          return plainText(block.children);
        case "list":
          return block.items.map((item) => plainText(item.children)).join("\n");
        case "table":
          return [block.head, ...block.rows].map((cells) => cells.map((cell) => plainInline(cell.children)).join("\t")).join("\n");
        default:
          return plainInline(block.children);
      }
    })
    .join("\n");
}

export function plainInline(nodes: readonly MdInline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
        case "code":
          return node.text;
        case "break":
          return "\n";
        case "image":
          return node.alt;
        default:
          return plainInline(node.children);
      }
    })
    .join("");
}
