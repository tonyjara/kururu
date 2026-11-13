/**
 * Which workspaces a line of Kuru's conversation is about, as tags the drawer
 * draws on it and filters by.
 *
 * The owner, 2026-11-12: "sometimes it's a bit hard for me to keep track in
 * our Kuru chat of what project we're talking about." One conversation holds
 * every project at once — a question about Holapy, a notice from a Pasapy
 * agent, a mark on kururu's own window — and the row that narrowed it could
 * only say which node a line came from. So every line wears the workspaces it
 * is about, and pressing one shows that project's thread, both sides of it.
 *
 * **Read off the line, not written down.** A line's tags are worked out from
 * what is already in it, every time it is drawn: a card's code (HOL-81 is
 * Holapy's board), a card's reference or a quote of one, a file under a
 * workspace's root, a workspace's name in the words — which is how a mark on a
 * window titled "WhatsApp · Holapy" counts — and, for kururu's notices, the
 * workspace the agent is in. Read and not stored, so the whole history had its
 * tags the moment this shipped, and a better rule later is better backwards
 * too. A rule is one that is plainly right when it fires; a line nothing in
 * it names is left for the next step rather than guessed at.
 *
 * **Then the exchange.** A message of yours that names nothing — "yes", "do
 * the second one" — is about what it answers: the line its reply arrow quoted,
 * or else the reply Kuru gave it. A reply of Kuru's that names nothing ("Done.")
 * is about the message it answered. One step each way, from what the other
 * line says itself, so nothing spreads down the conversation.
 *
 * **Kuru may say what its reply is about.** The rules above see only what is
 * written, and Kuru knows which project it was talking about when it never
 * said the name. So the role asks it to end a reply with a line of its own,
 * `[tags: Holapy, Pasapy]`, and the server takes that line off before the
 * reply is spoken, sent to a channel or written down (`splitReplyTags`), and
 * keeps the workspaces beside the turn. A line at the end, rather than a tool
 * call: it costs a dozen tokens and no round trip, it is in the same breath as
 * the reply it describes — a tool called before the reply exists would have to
 * be held for a turn that might not come — and there is one door it comes
 * through, the Stop report, so one place takes it off for every reader. When
 * Kuru says, that is the line's tags, and what the rules read is set aside.
 *
 * **And the owner may correct any of it** — a tag added or taken off from the
 * line's tag button, kept beside the turn as Kuru's are (`turn_tags`), and
 * applied last, over whatever Kuru or the rules said.
 *
 * Tags name a workspace by its `key`, which never changes, and are drawn with
 * its name as it is now; a key nobody has any more is dropped. Another node's
 * lines are that node's workspaces' business, and wear only their node.
 *
 * **A workspace may hold projects** (`shared/subprojects.ts`): Shared
 * Landings is Yetapá, Parque Guasú, Agua Lomas and tonyjara.com, and a line
 * about one of them is tagged with it — `<workspace key>/<slug>` — by the same
 * rules: a path under its folder (`apps/yetapa`, from the root or written
 * relative), one of its names in the words, with or without the accent and
 * with a possessive "s", a card whose title (or else whose body) names it,
 * whether the workspace's or the profile's own, an agent whose name does, and
 * Kuru's line, as `Shared Landings/Yetapá` or plain `Yetapá` when no other
 * workspace has a project by that name. A project's tag counts for its
 * workspace too: the workspace picked in the filter is everything in it. And
 * when Kuru's line names only the workspace, the projects the words name are
 * kept beside it, since Kuru said where and the words say which.
 *
 * Names are compared with their accents taken off on both sides, so "Yetapa"
 * finds "Yetapá" and the other way round; a workspace's name gets the same.
 */
import { cardCode } from "./board";
import { chipsIn } from "./chips";
import type { KuruItem, NoticeItem } from "./kuru";
import { splitReply } from "./reply";
import { namesOf, plain, spaceOfKey, unaccent, visibleProjects, type Subprojects } from "./subprojects";

/** What Kuru and the owner said about a line's tags, kept beside its turn. Workspace keys, and project keys (`<workspace>/<slug>`). */
export interface TurnTags {
  /** The workspaces Kuru named on its reply's tag line. When present, the line's tags start from these instead of the rules. */
  kuru?: string[];
  /** Added by the owner. */
  add?: string[];
  /** Taken off by the owner, whoever put them there. */
  drop?: string[];
}

/** A project inside a workspace, as the tags need it. */
export interface TagProject {
  /** `<workspace key>/<slug>`. */
  key: string;
  name: string;
  /** Every name the words may call it by, its own first. */
  names: readonly string[];
  /** Its folder relative to the workspace's root, or null. */
  dir: string | null;
}

/** A card's words, for a card that names a project. */
export interface CardWords {
  id: string;
  number: number;
  title: string;
  body: string;
}

/** A workspace as the tags need it: what to call it, and everything a line could name it by. */
export interface TagSpace {
  key: string;
  name: string;
  /** Its board's card numbers, so a code shared by two workspaces' prefixes goes to the one that has the card. */
  cards: ReadonlySet<number>;
  /** Its cards by id, for a reference, which names the card by id. */
  cardIds: ReadonlySet<string>;
  /** Its root folder, or null. */
  root: string | null;
  /** Its projects that are shown (`visibleProjects`); none for most. */
  projects?: readonly TagProject[];
  /** Its cards' words, read only when it has projects. */
  cardWords?: readonly CardWords[];
}

/** A workspace's shown projects as the tags take them. */
export function tagProjects(workspaceKey: string, state: Subprojects | null | undefined): TagProject[] {
  return visibleProjects(workspaceKey, state).map((p) => ({ key: p.key, name: p.name, names: namesOf(p), dir: p.dir }));
}

/** The most tags Kuru's line may give a reply: a reply about more than this is about everything, and says nothing. */
export const KURU_TAGS_MAX = 6;

/**
 * Kuru's tag line, on its own at the very end of a reply: `[tags: Holapy, Pasapy]`.
 * Anywhere else it is words, so a reply that explains the convention is not cut.
 */
const TAG_LINE = /\n?[ \t]*\[tags?:[ \t]*([^\]\n]{0,300})\][ \t]*$/i;

/** A reply with its tag line taken off, and the names on it. A reply with none comes back as it was, `found` false. */
export function splitReplyTags(reply: string): { text: string; names: string[]; found: boolean } {
  const trimmed = reply.replace(/\s+$/, "");
  const match = TAG_LINE.exec(trimmed);
  if (!match) return { text: reply, names: [], found: false };
  const names = (match[1] ?? "")
    .split(",")
    .map((name) => name.replace(/^[\s#"'`]+|[\s"'`]+$/g, ""))
    .filter((name) => name.length > 0 && name.length <= 80)
    .slice(0, KURU_TAGS_MAX);
  return { text: trimmed.slice(0, match.index).replace(/\s+$/, ""), names, found: true };
}

/** A name as two spellings of it are compared: case, accents, spaces, dashes and dots aside. */
function folded(name: string): string {
  return plain(name.normalize("NFKC")).replace(/[\s_.\-·]+/g, "");
}

/**
 * The workspaces and projects Kuru's names are, by key, each once. A name is
 * a workspace's, else `Workspace/Project`, else a project's own name or one of
 * its others when exactly one workspace has a project by it — two would be a
 * guess. A name that is none of these is left out.
 */
export function keysOfNames(names: readonly string[], spaces: readonly (Pick<TagSpace, "key" | "name"> & { projects?: readonly TagProject[] })[]): string[] {
  const keys: string[] = [];
  const add = (key: string | undefined) => {
    if (key && !keys.includes(key)) keys.push(key);
  };
  const answers = (project: TagProject, want: string) => project.names.some((n) => folded(n) === want);
  for (const name of names) {
    const want = folded(name);
    const space = spaces.find((s) => folded(s.name) === want);
    if (space) {
      add(space.key);
      continue;
    }
    const slash = name.indexOf("/");
    if (slash > 0) {
      const owner = spaces.find((s) => folded(s.name) === folded(name.slice(0, slash)));
      const inner = folded(name.slice(slash + 1));
      add(owner?.projects?.find((p) => answers(p, inner))?.key ?? (inner ? undefined : owner?.key));
      continue;
    }
    const hits = spaces.flatMap((s) => (s.projects ?? []).filter((p) => answers(p, want)));
    if (hits.length === 1) add(hits[0]!.key);
  }
  return keys;
}

/**
 * Names that are also everyday words, which count only when written as the
 * workspace spells them — "Research", not "research". Everything else counts
 * in any case, since a voice message or a quick line writes "holapy" and
 * "kururu" small.
 */
const EVERYDAY = new Set([
  "api", "app", "apps", "archive", "blog", "config", "configs", "design", "docs", "home", "infra", "landing", "landings", "misc", "notes",
  "personal", "playground", "research", "scratch", "server", "shared", "site", "skills", "test", "tests", "tools", "web", "website", "work",
]);

/**
 * A name as a pattern over words with their accents off (`unaccent`): a word
 * of its own and not a folder in a path, any case unless it is an everyday
 * word, spaces in it any run of spaces. A project's may end in a possessive
 * — "yetapa's logo", and "yetapas logo" as a voice message writes it.
 */
function namePattern(name: string, possessive = false): RegExp | null {
  const bare = unaccent(name).trim();
  const words = bare.split(/\s+/).filter(Boolean);
  if (!words.length || bare.length < 3) return null;
  const body = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\-_]+");
  const everyday = words.length === 1 && EVERYDAY.has(bare.toLowerCase());
  const tail = possessive ? "(?:['’]?s)?" : "";
  // Not a folder in a path either: `~/Documents/Kururu/backups` is about
  // where kururu keeps things, and a real project path is the roots' to read.
  return new RegExp(`(?<![\\p{L}\\p{N}_/])${body}${tail}(?![\\p{L}\\p{N}_]|/)`, everyday ? "u" : "iu");
}

/** A card code's candidates, as the drawer's links find them (`CARD_CODE` in `shared/kuru.ts`). */
const CODE = /(?<![\p{L}\p{N}_-])([\p{Lu}\p{N}]{1,3})-(\d{1,6})(?![\p{L}\p{N}_-])/gu;

/** A project as the book reads for it. */
interface BookProject {
  key: string;
  space: string;
  patterns: readonly RegExp[];
  /** Its folder from the root, as an absolute path and from `~`. */
  paths: readonly string[];
  /** Its folder relative to the root, when no other shown project's is the same. */
  rel: string | null;
  /** The root's own folder name, which a relative path may still carry in front: `shared_landings/apps/yetapa`. */
  rootName: string | null;
}

/** What a profile's workspaces are named by, made once per change of them rather than once per line. */
export interface TagBook {
  spaces: readonly TagSpace[];
  /** Each space's name pattern, in `spaces` order; null for a name too short to look for. */
  names: readonly (RegExp | null)[];
  /** Each space's card code prefix, `HOL`. */
  prefixes: readonly string[];
  /** The roots, longest first, so a folder inside another workspace's goes to the inner one. */
  roots: readonly { root: string; key: string }[];
  /** Every shown project of every workspace. */
  projects: readonly BookProject[];
  /** The projects each card names, by `<workspace key>#<number>` and by card id; a card that names none is absent. */
  cardProjects: ReadonlyMap<string, readonly string[]>;
  /** The profile board's code prefix (`MV`), whose cards are nobody's workspace's but may name a project; null for none. */
  profilePrefix: string | null;
}

/** The projects some words name, by name, among some projects. */
function projectsNamed(words: string, among: readonly BookProject[]): string[] {
  const text = unaccent(words);
  return among.filter((p) => p.patterns.some((re) => re.test(text))).map((p) => p.key);
}

/**
 * The book. `profile` is the profile board — its name, which its codes are
 * made from, and its cards — since a card there ("MV-94 Yetapa") is about a
 * project as much as one on the workspace's own board.
 */
export function tagBook(spaces: readonly TagSpace[], profile?: { name: string; cards: readonly CardWords[] }): TagBook {
  const roots: { root: string; key: string }[] = [];
  const projects: BookProject[] = [];
  const homeForm = (path: string) => {
    const home = /^(\/(?:Users|home)\/[^/]+)(\/.+)$/.exec(path);
    return home ? `~${home[2]}` : null;
  };
  for (const space of spaces) {
    const root = space.root && space.root !== "/" ? space.root.replace(/\/+$/, "") : null;
    if (root) {
      roots.push({ root, key: space.key });
      // The same folder as a person writes it, from their home.
      const tilde = homeForm(root);
      if (tilde) roots.push({ root: tilde, key: space.key });
    }
    for (const project of space.projects ?? []) {
      const at = root && project.dir ? `${root}/${project.dir}` : null;
      projects.push({
        key: project.key,
        space: space.key,
        patterns: project.names.map((name) => namePattern(name, true)).filter((re): re is RegExp => re !== null),
        paths: at ? [at, homeForm(at)].filter((p): p is string => p !== null) : [],
        rel: project.dir,
        rootName: root ? root.slice(root.lastIndexOf("/") + 1) : null,
      });
    }
  }
  // A relative folder two shown projects share says neither.
  for (const project of projects) if (project.rel && projects.some((p) => p !== project && p.rel === project.rel)) project.rel = null;
  roots.sort((a, b) => b.root.length - a.root.length);
  const cardProjects = new Map<string, string[]>();
  const readCard = (card: CardWords, among: readonly BookProject[], at: string) => {
    if (!among.length) return;
    // The title says what a card is about; the body only when the title names none, since a body lists its neighbours.
    const named = projectsNamed(card.title, among);
    const keys = named.length ? named : projectsNamed(card.body.slice(0, 4000), among);
    if (keys.length) {
      cardProjects.set(at, keys);
      cardProjects.set(card.id, keys);
    }
  };
  for (const space of spaces) {
    const own = projects.filter((p) => p.space === space.key);
    for (const card of space.cardWords ?? []) readCard(card, own, `${space.key}#${card.number}`);
  }
  for (const card of profile?.cards ?? []) readCard(card, projects, `#${card.number}`);
  return {
    spaces,
    names: spaces.map((space) => namePattern(space.name)),
    prefixes: spaces.map((space) => cardCode(space.name, 0).slice(0, -2)),
    roots,
    projects,
    cardProjects,
    profilePrefix: profile ? cardCode(profile.name, 0).slice(0, -2) : null,
  };
}

/** The workspace a card code is, or null: the one with that prefix that has the card, or the only one with that prefix. */
function spaceOfCode(book: TagBook, prefix: string, number: number): string | null {
  const candidates = book.spaces.filter((_, i) => book.prefixes[i] === prefix);
  if (!candidates.length) return null;
  const holder = candidates.find((space) => space.cards.has(number));
  if (holder) return holder.key;
  return candidates.length === 1 ? candidates[0]!.key : null;
}

/** A card code's workspace and the projects its card names. The profile's own codes name no workspace, only projects. */
function keysOfCode(book: TagBook, prefix: string, number: number, add: (key: string | null) => void): void {
  const space = spaceOfCode(book, prefix, number);
  if (space) {
    add(space);
    for (const key of book.cardProjects.get(`${space}#${number}`) ?? []) add(key);
  } else if (prefix === book.profilePrefix) {
    for (const key of book.cardProjects.get(`#${number}`) ?? []) add(key);
  }
}

/** Whether a root stands in the text as a folder: followed by a slash, a space, punctuation, or the end. */
function rootIn(text: string, root: string): boolean {
  let at = text.indexOf(root);
  while (at >= 0) {
    const next = text[at + root.length];
    const before = at === 0 ? undefined : text[at - 1];
    if ((next === undefined || /[/\s"'`)\]:,.;]/.test(next)) && (before === undefined || /[\s"'`(\[:=]/.test(before))) return true;
    at = text.indexOf(root, at + 1);
  }
  return false;
}

/**
 * Whether a project's folder stands in the text written from its root —
 * `apps/yetapa/src/app/page.tsx`, or `shared_landings/apps/yetapa` — and not
 * as the tail of some other path, which could be any repository's `apps/`.
 */
function relIn(text: string, rel: string, rootName: string | null): boolean {
  let at = text.indexOf(rel);
  while (at >= 0) {
    const next = text[at + rel.length];
    const before = at === 0 ? undefined : text[at - 1];
    const ends = next === undefined || /[/\s"'`)\]:,.;]/.test(next);
    const starts = before === undefined || /[\s"'`(\[:=]/.test(before) || (before === "/" && rootName !== null && text.slice(0, at - 1).endsWith(rootName) && !/[\p{L}\p{N}_.-]/u.test(text[at - 2 - rootName.length] ?? " "));
    if (ends && starts) return true;
    at = text.indexOf(rel, at + 1);
  }
  return false;
}

/** The workspaces and projects some words name, in the order the rules are listed: codes, card references, roots and folders, names. */
function keysInWords(text: string, book: TagBook, add: (key: string | null) => void): void {
  for (const chip of chipsIn(text)) {
    if (!chip.card) continue;
    const id = chip.card.cardId;
    const byId = book.spaces.find((space) => space.cardIds.has(id));
    if (byId) add(byId.key);
    for (const key of book.cardProjects.get(id) ?? []) add(key);
  }
  for (const match of text.matchAll(CODE)) keysOfCode(book, match[1]!, Number(match[2]), add);
  for (const project of book.projects) {
    if (project.paths.some((path) => rootIn(text, path)) || (project.rel && relIn(text, project.rel, project.rootName))) add(project.key);
  }
  for (const { root, key } of book.roots) if (rootIn(text, root)) add(key);
  const bare = unaccent(text);
  book.names.forEach((pattern, i) => {
    if (pattern?.test(bare)) add(book.spaces[i]!.key);
  });
  for (const project of book.projects) if (project.patterns.some((re) => re.test(bare))) add(project.key);
}

/**
 * The workspaces a line names by itself, by the rules at the top. A notice is
 * about its agent's workspace and its card when it names them, and read for
 * names only when it names no agent: the agent's reply quoted in it talks about
 * whatever that agent touched, which is not what the notice is about.
 */
export function ownTags(item: KuruItem & { files?: readonly { root: string; path?: string }[] }, book: TagBook): string[] {
  const keys: string[] = [];
  const add = (key: string | null) => {
    if (key && !keys.includes(key)) keys.push(key);
  };
  if (item.kind === "session") return keys;
  if (item.kind === "notice") return noticeTags(item, book, add, keys);
  if (item.kind === "you") {
    if (item.text === null) return keys;
    // The reference a reply carries in front is the line it answers, and that
    // line's tags are the message's when it names nothing itself: its quoted
    // opening is not read as the message's own words.
    keysInWords(splitReply(item.text)?.text ?? item.text, book, add);
    return keys;
  }
  for (const file of item.files ?? []) {
    const root = file.root.replace(/\/+$/, "");
    add(book.roots.find((r) => r.root === root || root.startsWith(`${r.root}/`))?.key ?? null);
    const full = file.path ? `${root}/${file.path.replace(/^\/+/, "")}` : root;
    for (const project of book.projects) if (project.paths.some((path) => full === path || full.startsWith(`${path}/`))) add(project.key);
  }
  keysInWords(item.text, book, add);
  return keys;
}

function noticeTags(item: NoticeItem, book: TagBook, add: (key: string | null) => void, keys: string[]): string[] {
  const agent = item.agent;
  const space = agent?.workspace ? (keysOfNames([agent.workspace], book.spaces)[0] ?? null) : null;
  add(space);
  if (agent?.card) {
    const code = /^([\p{Lu}\p{N}]{1,3})-(\d{1,6})$/u.exec(agent.card);
    if (code) keysOfCode(book, code[1]!, Number(code[2]), add);
  }
  // The agent's own name — its card's title, or what it said it was doing —
  // says which of its workspace's projects it works on.
  if (space && agent?.name) for (const key of projectsNamed(agent.name, book.projects.filter((p) => p.space === space))) add(key);
  if (!agent) keysInWords(`${item.what}\n${item.text}`, book, add);
  return keys;
}

/** A line as the tagging reads it: the drawer's items, with whose node they are. */
export type TaggedLine = KuruItem & { node?: string | null; tags?: TurnTags; files?: readonly { root: string; path?: string }[] };

/**
 * Every line's tags, by id: Kuru's line or the rules, then the exchange for a
 * line that has none, then the owner's corrections. Lines of another node's
 * have none here. `ownId` is the id a reply's reference names a line by, which
 * is the line's own on this node.
 */
export function tagLines(items: readonly TaggedLine[], book: TagBook): Map<string, string[]> {
  const known = new Set([...book.spaces.map((space) => space.key), ...book.projects.map((project) => project.key)]);
  const own = new Map<string, string[]>();
  for (const item of items) {
    if (item.kind === "session" || item.node) continue;
    const said = (item.tags?.kuru ?? []).filter((key) => known.has(key));
    if (!said.length) {
      own.set(item.id, ownTags(item, book));
      continue;
    }
    // Kuru named a workspace and none of its projects: the projects of it the
    // line names itself say which, beside what Kuru said.
    const bare = said.filter((key) => key === spaceOfKey(key) && !said.some((other) => other !== key && spaceOfKey(other) === key));
    const refine = bare.length ? ownTags(item, book).filter((key) => key !== spaceOfKey(key) && bare.includes(spaceOfKey(key))) : [];
    own.set(item.id, [...said, ...refine.filter((key) => !said.includes(key))]);
  }
  const base = new Map(own);
  // A message of yours that names nothing: the line its reply arrow quoted,
  // or else the first reply of Kuru's after it, before your next message.
  items.forEach((item, i) => {
    if (item.kind !== "you" || item.node || own.get(item.id)?.length) return;
    const quoted = item.text ? splitReply(item.text)?.ref.id : null;
    let from = quoted ? own.get(quoted) : undefined;
    if (!from?.length) {
      for (const next of items.slice(i + 1)) {
        if (next.node) continue;
        if (next.kind === "you") break;
        if (next.kind === "kuru") {
          from = own.get(next.id);
          break;
        }
      }
    }
    if (from?.length) base.set(item.id, from);
  });
  // A reply of Kuru's that names nothing: the message of yours it answered.
  let asked: string[] = [];
  for (const item of items) {
    if (item.node || item.kind === "session") continue;
    if (item.kind === "you") asked = base.get(item.id) ?? [];
    else if (item.kind === "kuru" && !own.get(item.id)?.length && asked.length) base.set(item.id, asked);
  }
  const out = new Map<string, string[]>();
  for (const item of items) {
    if (item.kind === "session" || item.node) continue;
    const drop = new Set(item.tags?.drop ?? []);
    const keys = [...(base.get(item.id) ?? []), ...(item.tags?.add ?? [])].filter((key, i, all) => known.has(key) && !drop.has(key) && all.indexOf(key) === i);
    out.set(item.id, keys);
  }
  return out;
}

/**
 * A line's tags as its chips draw them: a workspace is left off when one of
 * its projects is there, since "Yetapá" already says Shared Landings and two
 * chips for one thing is one too many.
 */
export function chipTags(keys: readonly string[]): string[] {
  return keys.filter((key) => key !== spaceOfKey(key) || !keys.some((other) => other !== key && spaceOfKey(other) === key));
}

/** The tags present among some lines, the most recently used first: what the filter row offers. */
export function recentTags(items: readonly { id: string }[], tags: ReadonlyMap<string, readonly string[]>): string[] {
  const seen: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) for (const key of chipTags(tags.get(items[i]!.id) ?? [])) if (!seen.includes(key)) seen.push(key);
  return seen;
}

/** A filter of the drawer's: workspace and project keys and node names, picked on the row. */
export interface TagFilter {
  spaces: readonly string[];
  nodes: readonly string[];
}

/** Whether a tag is one a picked key covers: itself, or a project of a picked workspace. */
export function covers(picked: string, tag: string): boolean {
  return tag === picked || (picked === spaceOfKey(picked) && spaceOfKey(tag) === picked);
}

/**
 * Whether a line passes: any of the picked workspaces or projects — a
 * workspace being everything in it — and any of the picked nodes, or of each
 * kind, everything when none is picked. A new conversation's mark passes only
 * an empty filter, since it is about nothing.
 */
export function passes(filter: TagFilter, tags: readonly string[], node: string, session: boolean): boolean {
  if (!filter.spaces.length && !filter.nodes.length) return true;
  if (session) return false;
  if (filter.nodes.length && !filter.nodes.includes(node)) return false;
  return !filter.spaces.length || tags.some((key) => filter.spaces.some((picked) => covers(picked, key)));
}

/** A filter read back from where a device kept it: anything else is no filter. */
export function adoptTagFilter(value: unknown): TagFilter {
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length < 200).slice(0, 40) : []);
  if (!value || typeof value !== "object") return { spaces: [], nodes: [] };
  const record = value as Record<string, unknown>;
  return { spaces: strings(record.spaces), nodes: strings(record.nodes) };
}

/** A list of keys off the wire or the database, kept to what a key can be: a workspace's, or a project's after a slash. */
export function adoptKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((key): key is string => typeof key === "string" && /^[\w.:-]{1,80}(?:\/[\w.-]{1,40})?$/.test(key)).slice(0, 40);
}
