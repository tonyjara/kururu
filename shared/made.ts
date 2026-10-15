/**
 * What an agent made, as a link: the one or two files at the end of a turn
 * worth reading, picked out of what the agent said when the turn ended.
 *
 * The question this answers is "where is the thing I asked for", and the
 * honest place to look for the answer is the agent's own last reply. An
 * agent that wrote a plan says so — "written to `docs/plan.md`" — and an
 * agent that changed twelve files lists twelve files. So the reply is read
 * for paths, every path is checked against the disk (the server's half,
 * `server/src/made.ts`), and the rule here decides which of the ones that
 * exist are *the deliverable* rather than the work. Two other designs were
 * weighed and lost:
 *
 * - **Every file the turn touched**, from mtimes or the transcript's tool
 *   calls. Exact, and exactly the wrong list: a feature is eleven files of
 *   code and one of docs, and the row would carry all twelve or an arbitrary
 *   two. What the user wants a link to is what the agent *presented*, and only
 *   the reply says that.
 * - **A tool every agent calls** to say "here is what I made". Precise when it
 *   is called, which is the catch: an agent calls a tool when its context
 *   tells it to, so every agent would be carrying the tool's description in
 *   every turn of every session for the few turns that end in a document, and
 *   the ones that forgot would have no link at all. The reply is there whether
 *   or not anybody remembered. Kuru does get the tool (`show_file`), because
 *   Kuru is one session, already carries kururu's verbs, and is the one asked
 *   "put that on its row".
 *
 * The rule, which is the part worth testing and the part to read when a link
 * is missing or should not be there:
 *
 * - A file is only ever one the reply **names**, and only once it has been
 *   found inside a project root the server already allows (`files.ts`).
 * - A **document** — Markdown, plain text, a CSV — gets a link when the reply
 *   presents it as the result ("written to", "saved in", "is in", "Plan:",
 *   "(new)", and the Spanish for each), or when the turn changed it and
 *   changed no code the reply also names. That second half is what lets a
 *   research turn's document through on "Updated `docs/research/x.md`" while
 *   keeping the `docs/layout.md` a feature turn touched on the way past off
 *   the row.
 * - **Code** gets a link only when it is presented as the result *and* the
 *   reply names at most two code files: "the script is in `tools/fix.ts`" is
 *   a deliverable, "created `a.ts`, `b.ts` and `c.ts`" is a change.
 * - At most `MADE_MAX`, presented ones first, then in the order they were
 *   named. A turn that picks nothing and changed nothing it names leaves
 *   the last turn's links where they were (`nextMade`): "thanks, looks
 *   good" should not take the document away.
 *
 * Pure, and in `shared/` because the drawer finds the same paths in Kuru's
 * replies with `splitMentions` to make them links: one regex on both sides of
 * the wire, so the words the server resolved are the words the window draws.
 */

/** The most links one agent's row, or one card, carries. "A couple", and a third would start being the list. */
export const MADE_MAX = 2;

/** Candidates read out of one reply. A reply that names forty paths is a changelog, not a deliverable. */
export const MENTIONS_MAX = 32;

/**
 * A file worth a link. Rooted the way everything `files.ts` serves is: a root
 * the server allowed, and a path under it with forward slashes, so the reader
 * opens it as the same document the tree would.
 */
export interface MadeFile {
  root: string;
  path: string;
  /** A line the reply named (`index.ts:120`), for nvim to open at. Null for none. */
  line: number | null;
}

/** One path as a reply wrote it. */
export interface Mention {
  /** The words exactly as they stand in the text, line and all: what the drawer finds again to draw as a link. */
  text: string;
  /** The path alone, without its line or anchor. Still as written: relative, `~/`, or absolute. */
  path: string;
  line: number | null;
  /** Whether the reply presented it as the result. See `CUE_BEFORE`. */
  cue: boolean;
  /** Where `text` starts in the reply. */
  at: number;
}

/**
 * What the window's reader draws. Everything else opens in nvim. The server's
 * `EDITABLE` and the file tree's `MARKDOWN` say the same.
 */
const READER = /\.(?:md|markdown|mdx)$/i;

/** Text meant to be read rather than run. A plan, a report, notes, a table. */
const DOCUMENT = /\.(?:md|markdown|mdx|txt|text|rst|adoc|org|csv|tsv)$/i;

/**
 * Never a link: nvim cannot show it and the reader cannot draw it. An image
 * or a PDF an agent made is real, and it is the operating system's to open —
 * a door kururu does not have yet.
 */
const BINARY =
  /\.(?:png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|heic|pdf|zip|gz|tgz|bz2|xz|7z|rar|dmg|pkg|iso|mp3|mp4|m4a|mov|wav|ogg|webm|woff2?|ttf|otf|eot|sqlite3?|db|lockb|wasm|so|dylib|exe|bin|o|a|class|jar|pyc)$/i;

export function readsInReader(path: string): boolean {
  return READER.test(path);
}

export function isDocument(path: string): boolean {
  return DOCUMENT.test(path);
}

export function isBinary(path: string): boolean {
  return BINARY.test(path);
}

/** The last segment, which is what a link says; the rest is its tooltip. */
export function madeName(file: Pick<MadeFile, "path">): string {
  const slash = file.path.lastIndexOf("/");
  return slash < 0 ? file.path : file.path.slice(slash + 1);
}

/** The same files in the same order. Every field, since a line moving is a link changing. */
export function sameMade(a: readonly MadeFile[] | undefined, b: readonly MadeFile[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((file, i) => file.root === y[i]!.root && file.path === y[i]!.path && file.line === y[i]!.line);
}

/** Read off the wire or a file: a list of files or nothing, never a half-shaped one. */
export function adoptMade(value: unknown): MadeFile[] {
  if (!Array.isArray(value)) return [];
  const out: MadeFile[] = [];
  for (const item of value.slice(0, MADE_MAX)) {
    const raw = (item ?? {}) as Record<string, unknown>;
    if (typeof raw.root !== "string" || !raw.root.startsWith("/") || typeof raw.path !== "string" || !raw.path) continue;
    const line = typeof raw.line === "number" && Number.isInteger(raw.line) && raw.line > 0 ? raw.line : null;
    out.push({ root: raw.root, path: raw.path, line });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Finding paths in a reply
// ---------------------------------------------------------------------------

/**
 * A path in prose: segments of word characters joined by `/` or `.`, ending
 * in an extension, optionally rooted at `~/`, `./`, `../` or `/`. The
 * look-behind is what keeps it out of a URL — every place inside
 * `https://host/x.md` a match could start is behind a `/`, a `.` or a `:` —
 * and out of the middle of a longer word. A path with a space in it is only
 * found between backticks, which is where an agent puts one.
 *
 * The extension is what makes this cheap to be wrong about. `e.g` and
 * `api.firecrawl.dev` match, and neither is a file, so the disk throws them
 * out; what the pattern must not do is miss `docs/research/soportes-tablet.md`,
 * and anything whose last segment has a dot and a letter after it is in. The
 * letter is what keeps `3.5` and `v0.3.0` from costing a `stat` each.
 */
const BARE =
  /(?<![\p{L}\p{N}_@+~./\\:-])((?:~\/|\.{1,2}\/|\/)?[\p{L}\p{N}_@+-]+(?:[./][\p{L}\p{N}_@+-]+)*\.(?=\p{N}*\p{L})[\p{L}\p{N}]{1,10})((?::\d{1,7}(?:[:-]\d{1,7})?)|(?:#L\d{1,7}(?:-L?\d{1,7})?))?(?![\p{L}\p{N}_])/gu;

/** Whatever an agent put between backticks. Read as a path only if it looks like one — see `asPath`. */
const TICKS = /`([^`\n]{1,300})`/g;

/** A Markdown link's target: `[the plan](docs/plan.md)`. */
const LINK = /\[[^\]\n]{0,200}\]\(([^)\s]{1,300})\)/g;

/**
 * A line on the end of a path: `:120`, `:120:5`, `:120-140`, `#L120`,
 * `#L120-L140`. The first number is the one nvim opens at.
 */
const LINE_SUFFIX = /(?::(\d{1,7})(?:[:-]\d{1,7})?|#L(\d{1,7})(?:-L?\d{1,7})?)$/;

/** A heading anchor, `docs/layout.md#worktrees`: the file is the file. */
const ANCHOR = /#[\p{L}\p{N}_-]*$/u;

/**
 * The words that present a file as the result, in English and in Spanish
 * (the languages the user's agents answer in), found anywhere between the
 * start of the sentence and the path. Verbs of making, and the phrases that
 * say where something is now. Matched as whole words with `(?<!…)…(?!…)`
 * rather than `\b`, which in JavaScript knows nothing past ASCII and so
 * would never find the end of "escribí".
 */
const CUE_BEFORE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[
    "(?:re)?wr(?:ote|itten)",
    "writing (?:it|this|that|them)? ?(?:to|in|up)",
    "saved?",
    "saving",
    "created?",
    "creating",
    "drafted",
    "generated",
    "exported",
    "produced",
    "put (?:it|them|this|that|everything) (?:in|at|into|under)",
    "new (?:file|doc|document|note|notes|page|report|plan|script)",
    "(?:is|are|lives?|landed|sits?|now) (?:now )?(?:in|at|under)",
    "here(?:'s| is| are)",
    "you(?:'ll| will| can) find",
    "escrib[íi]",
    "escrit[oa]s?",
    "guard[ée]",
    "guardad[oa]s?",
    "cre[ée]",
    "cread[oa]s?",
    "gener[ée]",
    "generad[oa]s?",
    "nuev[oa] (?:archivo|documento|informe|plan)",
    "est[áa]n? (?:ahora )?en",
    "qued[óo] en",
    "lo dej[ée] en",
    "aqu[íi] est[áa]n?",
  ].join("|")})(?![\\p{L}\\p{N}])`,
  "iu",
);

/**
 * A label just before the path: "Plan: `docs/plan.md`", "**Report** →
 * docs/x.md". Only at the very end of the run-up, unlike the verbs: "the
 * plan in `docs/plan.md`" is a reference to a plan, not a presentation of one.
 */
const CUE_LABEL =
  /(?<![\p{L}\p{N}])(?:report|plan|summary|research|write-?up|findings|notes|doc(?:ument)?|deliverable|output|results?|informe|resumen|investigaci[óo]n|documento|notas|resultados?)[*_]*\s*(?::|→|->|=>|—|–)[\s*_`]*$/iu;

/** Just after the path: "`docs/x.md` (new)", "docs/x.md — nuevo". */
const CUE_AFTER = /^[`*_)\]]*\s*(?:\((?:new|nuev[oa])(?: file| archivo)?\)|[—–-]{1,2}\s*(?:new|nuev[oa])(?![\p{L}\p{N}]))/iu;

/** How far back a cue may be. A sentence, near enough; the start of the line or of the sentence comes first. */
const CUE_REACH = 100;

function presented(text: string, at: number, end: number): boolean {
  let before = text.slice(Math.max(0, at - CUE_REACH), at);
  // The run-up starts at this sentence: a full stop, a semicolon or a new
  // line ends the one before, and its verbs are not this path's.
  const cut = Math.max(before.lastIndexOf("\n"), ...[". ", "; ", "! ", "? "].map((stop) => before.lastIndexOf(stop)));
  if (cut >= 0) before = before.slice(cut + 1);
  return CUE_BEFORE.test(before) || CUE_LABEL.test(before) || CUE_AFTER.test(text.slice(end, end + 30));
}

/**
 * The text inside backticks as a path, or null. It has to look like one —
 * no spaces unless it also has a slash and an extension, no scheme, not a
 * flag — and it has to say something a word would not: a slash, or an
 * extension. `bun run dev` and `true` are left alone.
 */
function asPath(inner: string): { path: string; line: number | null } | null {
  const trimmed = inner.trim();
  if (!trimmed || trimmed.includes("://") || trimmed.startsWith("-") || /[<>|*?"'`$(){}\[\]]/.test(trimmed)) return null;
  const suffix = LINE_SUFFIX.exec(trimmed);
  let path = suffix ? trimmed.slice(0, suffix.index) : trimmed;
  path = path.replace(ANCHOR, "");
  const line = suffix ? Number(suffix[1] ?? suffix[2]) : null;
  if (!path || /^\.+$/.test(path)) return null;
  const extension = /\.(?=\p{N}*\p{L})[\p{L}\p{N}]{1,10}$/u.test(path);
  if (/\s/.test(path) && !(path.includes("/") && extension)) return null;
  if (!path.includes("/") && !extension) return null;
  return { path, line: line && line > 0 ? line : null };
}

/**
 * Every path a reply names, in the order it names them, with the line each
 * points at and whether it was presented as the result. Backticks first,
 * then Markdown links, then bare paths in the prose around them; a bare
 * match inside a span already taken is the same path seen twice. Capped at
 * `MENTIONS_MAX`, since each one is a `stat`.
 */
export function mentionsIn(text: string, max = MENTIONS_MAX): Mention[] {
  const found: Mention[] = [];
  const taken: [number, number][] = [];
  const free = (at: number, end: number) => !taken.some(([a, b]) => at < b && end > a);
  const add = (raw: string, at: number, parsed: { path: string; line: number | null }) => {
    const end = at + raw.length;
    taken.push([at, end]);
    found.push({ text: raw, path: parsed.path, line: parsed.line, cue: presented(text, at, end), at });
  };
  for (const match of text.matchAll(TICKS)) {
    const inner = match[1]!;
    const parsed = asPath(inner);
    // The span is taken even when it is not a path: a command line in
    // backticks is not prose to find bare paths in.
    const start = match.index! + 1;
    if (!parsed) {
      taken.push([match.index!, match.index! + match[0].length]);
      continue;
    }
    const lead = inner.length - inner.trimStart().length;
    add(inner.trim(), start + lead, parsed);
  }
  for (const match of text.matchAll(LINK)) {
    const target = match[1]!;
    const at = match.index! + match[0].length - 1 - target.length;
    if (!free(at, at + target.length)) continue;
    const parsed = asPath(decodeLink(target));
    if (parsed) add(target, at, parsed);
  }
  for (const match of text.matchAll(BARE)) {
    const at = match.index!;
    if (!free(at, at + match[0].length)) continue;
    const parsed = asPath(match[0]);
    if (parsed) add(match[0], at, parsed);
  }
  return found.sort((a, b) => a.at - b.at).slice(0, max);
}

/** `docs/my%20plan.md`, as a link has to spell it, back to the name on disk. */
function decodeLink(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

export type MentionPart = { text: string } | { mention: Mention };

/**
 * A reply as words and the paths among them, in order, for the drawer to
 * draw each path the server resolved as a link and leave the rest as text.
 * The same finder as `mentionsIn`, uncapped: the cap is about `stat`s, and
 * drawing costs none.
 */
export function splitMentions(text: string): MentionPart[] {
  const parts: MentionPart[] = [];
  let last = 0;
  for (const mention of mentionsIn(text, Infinity)) {
    if (mention.at < last) continue;
    if (mention.at > last) parts.push({ text: text.slice(last, mention.at) });
    parts.push({ mention });
    last = mention.at + mention.text.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

// ---------------------------------------------------------------------------
// Which of them are the deliverable
// ---------------------------------------------------------------------------

/** A mention the server found on disk: where it is, and whether this turn changed it. */
export interface Located {
  mention: Mention;
  file: MadeFile;
  /** Modified since the turn began — see `server/src/made.ts` for when that is. */
  changed: boolean;
}

/**
 * The deliverable among the files a reply named, by the rule at the top of
 * this file. Each file counts once — by its first mention, presented if any
 * mention of it was, at the first line any of them gave.
 */
export function pickMade(found: readonly Located[]): MadeFile[] {
  const files = new Map<string, { file: MadeFile; cue: boolean; changed: boolean; at: number }>();
  for (const { mention, file, changed } of found) {
    if (isBinary(file.path)) continue;
    const key = `${file.root}\0${file.path}`;
    const had = files.get(key);
    if (had) {
      had.cue ||= mention.cue;
      had.changed ||= changed;
      if (had.file.line === null && file.line !== null) had.file = { ...had.file, line: file.line };
      continue;
    }
    files.set(key, { file: { ...file }, cue: mention.cue, changed, at: mention.at });
  }
  const all = [...files.values()];
  const code = all.filter((entry) => !isDocument(entry.file.path));
  const codeChanged = code.some((entry) => entry.changed);
  const kept = all.filter((entry) =>
    isDocument(entry.file.path) ? entry.cue || (entry.changed && !codeChanged) : entry.cue && code.length <= 2,
  );
  return kept
    .sort((a, b) => Number(b.cue) - Number(a.cue) || a.at - b.at)
    .slice(0, MADE_MAX)
    .map((entry) => entry.file);
}

/**
 * What an agent's row carries after a turn: this turn's pick when it has
 * one. When it has none, the turn either worked on something else — it
 * changed a file it names, and the row moves on with it, to nothing — or it
 * did not: "thanks, looks good", or an answer that mentions `CLAUDE.md` in
 * passing, leaves the last turn's links where they were, since the document
 * is still the thing to read.
 */
export function nextMade(previous: readonly MadeFile[], found: readonly Located[]): MadeFile[] {
  const picked = pickMade(found);
  if (picked.length > 0) return picked;
  return found.some((entry) => entry.changed) ? [] : [...previous];
}

/**
 * A file put on a row on purpose — Kuru's `show_file` — goes first, and the
 * rest keep their order behind it, the same file never twice.
 */
export function withPinned(current: readonly MadeFile[], pinned: MadeFile): MadeFile[] {
  const rest = current.filter((file) => file.root !== pinned.root || file.path !== pinned.path);
  return [pinned, ...rest].slice(0, MADE_MAX);
}
