/**
 * What Kuru's box draws in place of the words written for Kuru.
 *
 * A card's reference, a quote and a dropped file each go into the draft as
 * text Kuru can act on — `[card MV-69 "Test the new…" (profile/c4f0d4bbf152d)]
 * [quote "the gap under the box"]`, an escaped path — and that text is what is
 * sent, to the character, because what Kuru reads is what was typed into its
 * terminal. But it is written for Kuru: the ids in brackets are noise to the
 * person rereading what they wrote, and three quotes from one note are three
 * lines that begin with the same seventy characters, which is how three
 * different quotes came to look like one. So the box keeps that text as its
 * value and draws each such run as a chip — the card's code and a short title,
 * a quote's opening words and the card it is from, a file's name — and only
 * the drawing changes.
 *
 * This is the reading of a draft into words and chips, and nothing else: pure,
 * so the tests can hold it to the formats `cardReference`, `quoteReference`,
 * `replyReference`, `fileReference` and `escapePath` write. The patterns are this file's own
 * copies rather than imports, because a draft is anything the user typed or
 * pasted and a near miss here costs only a chip not drawn — the words stay
 * words — while a loose pattern would swallow words into a chip.
 *
 * A path is a chip only when the box put it there itself — a drop or a paste,
 * remembered beside the draft (`files`) — and never because it looks like a
 * path: a path being typed would turn into a chip under the fingers, and a
 * path someone writes out to Kuru is words.
 */

export type ChipKind = "card" | "quote" | "image" | "file";

export interface Chip {
  kind: ChipKind;
  /** Where the chip's text is in the draft: `draft.slice(from, to)` is what is sent. */
  from: number;
  to: number;
  /** The short words drawn in the chip: a card's title, a quote's opening, a file's name. */
  label: string;
  /** What a card or a quote is of: a card's code, or the line a quote of the conversation answers (`Kuru 18:42`). Empty when there is none. */
  source: string;
  /** Everything there is to show, for the hover and for a chip opened by a tap. */
  full: string;
}

export type Piece = { text: string } | { chip: Chip };

/**
 * A card's reference, and the quote that follows it when it is one —
 * `cardReference` then `quoteReference`'s ` [quote "…"]`.
 */
const CARD = String.raw`\[card (?<code>\S+) "(?<title>[^"\n]*)" \((?<place>[^\s()/]+)\/(?<cardId>c[0-9a-f]{12})\)\](?: \[quote(?<cpart> title)? "(?<cquote>[^"\n]*)"\])?`;
/** A line of the conversation quoted: the reference its reply arrow writes, then the quote. A reply reference alone is the reply bar's, never the draft's, and is left as words. */
const REPLY = String.raw`\[reply to (?<who>[^"[\]\n]{1,40}?) (?<when>(?:[A-Z][a-z]{2} \d{1,2} )?\d{1,2}:\d{2}) "(?<rwords>[^"\n]*)"(?: \((?<rid>[\w:.-]{1,96})\))?\] \[quote(?<rpart> title)? "(?<rquote>[^"\n]*)"\]`;
/**
 * A file's reference, as a reader's tab menu writes it, and the quote that
 * follows it when it is one (`fileReference` in `filequote.ts`): the path,
 * the lines on it, the project in parentheses, the heading. The path is lazy
 * so that the pieces after it are tried at each step; it holds no bracket.
 */
const FILE = String.raw`\[file (?<fpath>[^\n[\]]+?)(?::(?<fline>\d+(?:-\d+)?))?(?: \((?<fproject>[^()\n[\]]+)\))?(?: under "(?<fhead>[^"\n]*)")?\](?: \[quote "(?<fquote>[^"\n]*)"\])?`;
/** A quote with nothing in front of it — pasted, or its reference deleted — is still a quote. */
const LONE = String.raw`\[quote(?<lpart> title)? "(?<lquote>[^"\n]*)"\]`;
const TOKEN = new RegExp(`${CARD}|${REPLY}|${FILE}|${LONE}`, "gu");

const IMAGE = /\.(?:png|jpe?g|gif|webp|heic|heif|avif|bmp|tiff?|svg)$/i;

/** How many of a quote's words its chip shows, and how many characters at most. */
const HINT_WORDS = 5;
const HINT_MAX = 30;

/**
 * A quote's opening, as its chip shows it: its first few words, with `…` when
 * there is more. The opening and not the end, because the opening is where
 * the selection began, and that is how two quotes of one card tell apart.
 */
export function quoteHint(quote: string): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  const words = flat.split(" ");
  let hint = words.slice(0, HINT_WORDS).join(" ");
  if (hint.length > HINT_MAX) {
    const cut = hint.slice(0, HINT_MAX);
    const space = cut.lastIndexOf(" ");
    hint = space > HINT_MAX / 2 ? cut.slice(0, space) : cut;
  }
  hint = hint.replace(/[\s,.;:…]+$/, "");
  return hint.length < flat.length ? `${hint}…` : hint;
}

/** A path as `escapePath` wrote it, back to the path it is. */
export function unescapePath(escaped: string): string {
  return escaped.replace(/\\(.)/g, "$1");
}

/** The last part of a path: what its chip calls it. */
export function fileName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

/** The chips in a draft, in order and never overlapping. `files` are the escaped paths the box put in itself. */
export function chipsIn(draft: string, files: readonly string[] = []): Chip[] {
  const chips: Chip[] = [];
  for (const match of draft.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    const g = match.groups ?? {};
    const to = at + match[0].length;
    if (g.code !== undefined) {
      const title = g.title ?? "";
      if (g.cquote !== undefined) {
        const what = g.cpart ? "the title" : `"${g.cquote}"`;
        chips.push({ kind: "quote", from: at, to, label: g.cpart ? `title: ${quoteHint(g.cquote)}` : quoteHint(g.cquote), source: g.code, full: `${what} — from ${g.code} "${title}"` });
      } else {
        chips.push({ kind: "card", from: at, to, label: title, source: g.code, full: `${g.code} "${title}"` });
      }
    } else if (g.rquote !== undefined) {
      const source = `${g.who} ${g.when}`;
      chips.push({ kind: "quote", from: at, to, label: quoteHint(g.rquote), source, full: `"${g.rquote}" — from ${source}: "${g.rwords}"` });
    } else if (g.fpath !== undefined) {
      const where = [`${g.fpath}${g.fline ? `, ${g.fline.includes("-") ? "lines" : "line"} ${g.fline.replace("-", "–")}` : ""}`, g.fproject ? `in ${g.fproject}` : "", g.fhead ? `under "${g.fhead}"` : ""].filter(Boolean).join(" ");
      const name = fileName(g.fpath.replace(/^[^/:]+:(?=[~/])/, ""));
      if (g.fquote !== undefined) chips.push({ kind: "quote", from: at, to, label: quoteHint(g.fquote), source: name, full: `"${g.fquote}" — from ${where}` });
      else chips.push({ kind: "file", from: at, to, label: name, source: "", full: where });
    } else if (g.lquote !== undefined) {
      chips.push({ kind: "quote", from: at, to, label: quoteHint(g.lquote), source: "", full: `"${g.lquote}"` });
    }
  }
  // Each path the box put in, wherever it stands as a word of its own and
  // outside every chip already found. Longest first, so a path that is the
  // start of a longer one does not take the longer one's place.
  const taken = (from: number, to: number) => chips.some((chip) => from < chip.to && to > chip.from);
  for (const escaped of [...new Set(files)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    let at = draft.indexOf(escaped);
    while (at >= 0) {
      const to = at + escaped.length;
      if (isSpace(draft[at - 1]) && isSpace(draft[to]) && draft[at - 1] !== "\\" && !taken(at, to)) {
        const path = unescapePath(escaped);
        chips.push({ kind: IMAGE.test(path) ? "image" : "file", from: at, to, label: fileName(path), source: "", full: path });
      }
      at = draft.indexOf(escaped, at + 1);
    }
  }
  return chips.sort((a, b) => a.from - b.from);
}

/** A draft as the box draws it: the words, and a chip for each run written for Kuru. */
export function piecesOf(draft: string, files: readonly string[] = []): Piece[] {
  const pieces: Piece[] = [];
  let last = 0;
  for (const chip of chipsIn(draft, files)) {
    if (chip.from > last) pieces.push({ text: draft.slice(last, chip.from) });
    pieces.push({ chip });
    last = chip.to;
  }
  if (last < draft.length) pieces.push({ text: draft.slice(last) });
  return pieces;
}

/**
 * The chip a deletion at the cursor takes whole: the one ending at the cursor
 * for a Backspace, the one starting at it for a Delete. A chip is one thing
 * in the box, so one key takes it, and what goes from the draft is all of its
 * text — never the last bracket of a reference, which would leave Kuru a
 * reference that no longer reads as one.
 */
export function chipAt(draft: string, files: readonly string[], caret: number, back: boolean): Chip | null {
  return chipsIn(draft, files).find((chip) => (back ? chip.to === caret : chip.from === caret)) ?? null;
}

/**
 * The files the box remembers for a draft, kept to the ones still in it — a
 * path deleted from the draft is forgotten, so typing it out again later is
 * words, as any typed path is.
 */
export function filesStillIn(draft: string, files: readonly string[]): string[] {
  return files.filter((path) => path && draft.includes(path));
}
