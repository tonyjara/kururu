/**
 * The conversation with Kuru, assembled for the drawer.
 *
 * Why this is a module and not a few lines in `index.ts`: the conversation is
 * read from three places that each change on their own clock — the turns the
 * database keeps (a prompt hook, a Stop report), the outbox (a clip arriving,
 * being heard, being typed, being confirmed) and the missed list (a reply
 * heard out, let go, seen) — and each of those used to be its own broadcast
 * with its own shape, drawn by three corners of one button. One message with
 * one shape, made in one place from the same inputs every time, is what lets
 * the drawer be a dumb reading of it and the chip's two counts never disagree
 * with the list behind them.
 *
 * Nothing is kept here. The turns are the store's, the messages are the
 * outbox's, the fates are the voice's; this asks each for a profile's share
 * and hands the three to `mergeConversation` (`shared/kuru.ts`), which is
 * where the rules live and are tested. The broadcast is coalesced by a few
 * milliseconds because the three inputs move together — a Stop report writes
 * a turn, starts an utterance and so puts a reply on the missed list, all
 * within one call — and three identical broadcasts for one event is noise on
 * a phone's socket.
 *
 * The other nodes' Kurus ride on the same message (`peers`), each already
 * as this node's drawer should draw it (`peerkuru.ts`); the drawer merges
 * them with this node's own (`mergeNodes`). And this node's own items are
 * what it tells the others about its conversation, so a change here is
 * also theirs to hear of (`moved`).
 *
 * On the restartable side, like everything that reads the database.
 */
import { KURU_PAGE, KURU_RECENT, kuruCounts, mergeConversation, type KuruConversation, type KuruFile, type KuruItem, type KuruPage, type PeerKuru } from "../../shared/kuru";
import { matchItem, parseKuruQuery, pickHits, type HitTier, type KuruAround, type KuruSearchAnswer } from "../../shared/kurusearch";
import type { Turn } from "../../shared/store";
import type { StoredMissed, StoredOutboxEntry } from "../../shared/voice";
import type { ServerMessage } from "../../shared/wire";
import type { Store } from "./store";

/** How long a burst of changes settles before one broadcast says all of it. */
const COALESCE_MS = 25;
/** How many lines a search compares before it lets the terminals have the event loop back. */
const SEARCH_BATCH = 200;
/**
 * How many turns a search reads at a time. It used to read the whole history
 * in one query and merge it before comparing a word: 20 ms of held event loop
 * now and ~1 s and ~50 MB at a year of turns, in the process that relays every
 * terminal. A page is a seek on `turns_at` and a few hundred KB.
 */
const SEARCH_PAGE = 500;

export interface KuruDeps {
  store: Store;
  /** Every profile this session knows, by id and key. The conversation is assembled for each. */
  profiles: () => readonly { id: string; key: string }[];
  /** A profile's messages as the outbox holds them. */
  outbox: (profileKey: string) => readonly StoredOutboxEntry[];
  /** A profile's missed replies, the pending ones included. */
  missed: (profileKey: string) => readonly StoredMissed[];
  broadcast: (msg: ServerMessage) => void;
  /**
   * The files a reply of Kuru's names, as links for the drawer. The disk is
   * index.ts's to look at — which projects a relative path is tried in is a
   * question about every terminal in the profile — so it is asked for here.
   */
  files?: (profileKey: string, reply: { id: string; text: string }) => KuruFile[];
  /** The other nodes' Kurus, for every drawer. */
  peers?: () => PeerKuru[];
  /** Something moved: the other nodes may want this node's conversation again. */
  moved?: () => void;
}

export class Kuru {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: KuruDeps) {}

  /** What every client is told, on connect and after every change. */
  message(): ServerMessage {
    return { type: "kuru", kuru: this.deps.profiles().map(({ id, key }) => this.conversation(id, key)), peers: this.deps.peers?.() ?? [] };
  }

  /** One profile's newest items, as the drawer's window has them: what another node is told this node's Kuru said. */
  items(profileKey: string): KuruItem[] {
    const profile = this.deps.profiles().find((p) => p.key === profileKey);
    return profile ? this.conversation(profile.id, profileKey).items : [];
  }

  /** Something the conversation is made of moved. Said once for a burst. */
  changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deps.broadcast(this.message());
      this.deps.moved?.();
    }, COALESCE_MS).unref();
  }

  /** The chip's two numbers for one profile, for `/api/health` and the menu bar behind it. */
  counts(profileKey: string): { unheard: number; undelivered: number } {
    return kuruCounts(this.deps.outbox(profileKey), this.deps.missed(profileKey));
  }

  /**
   * Items from before a moment, for the drawer's "Show earlier". The turns
   * are paged out of the database; the two lists are small and capped, so
   * the share of each that falls in the page's span is merged in whole.
   */
  page(profileKey: string, before: number | null, limit = KURU_PAGE): KuruPage {
    const { turns, more } = this.deps.store.harnessTurns(profileKey, before, limit);
    // A page that reaches the beginning sweeps up whatever is older than the
    // first turn ever recorded: a reply missed before the conversation was
    // being written down has no turn to stand beside, and must not fall off
    // the front of a list that has no earlier page to be on.
    const since = more ? (turns[0]?.at ?? -Infinity) : -Infinity;
    const until = before ?? Infinity;
    const linked = linkedBy(turns);
    const inSpan = (at: number) => at >= since && at < until;
    const items = mergeConversation({
      turns,
      outbox: this.deps.outbox(profileKey).filter((entry) => inSpan(entry.at) || linked.has(entry.id)),
      missed: this.deps.missed(profileKey).filter((entry) => inSpan(entry.at) || linked.has(entry.id)),
      launchers: this.launchers(profileKey),
    });
    return { items: this.linked(profileKey, items), more };
  }

  /**
   * Every line of the conversation with the words asked for, not just the ones
   * a window has loaded. It reads what `page` reads, through the same merge, so
   * it searches what the drawer draws; a line can only be judged once the merge
   * has said whose it is. The comparing is cut into batches with the event loop
   * let go between them, since this process relays every terminal, and a query
   * nobody is waiting for any more stops at the next batch (`gone`).
   *
   * Only the lines going back get their files looked for: that is a look at the
   * disk per line, and most of the history is not coming back.
   *
   * The history is read a page at a time (`SEARCH_PAGE`), oldest first, and
   * each page merged with the messages and replies its turns name; whatever
   * on the two lists no turn names is merged on its own at the end, which is
   * where the whole merge would have put it too. Not through `turns_fts`,
   * though the review that asked for this suggested it: that index has no
   * typos and no middle of a word, which are the two things this search is
   * for (`shared/kurusearch.ts`), and a prefilter through it would have
   * quietly dropped every line only they find.
   */
  async search(profileKey: string, words: string, gone: () => boolean = () => false): Promise<KuruSearchAnswer> {
    const query = parseKuruQuery(words);
    const answer: KuruSearchAnswer = { raw: query?.raw ?? "", items: [], total: 0, exact: 0 };
    if (!query) return answer;
    const outbox = this.deps.outbox(profileKey);
    const missed = this.deps.missed(profileKey);
    const merged = new Set<string>();
    const found: { item: KuruItem; tier: HitTier }[] = [];
    const judge = async (items: readonly KuruItem[]): Promise<boolean> => {
      for (let at = 0; at < items.length; at += SEARCH_BATCH) {
        await new Promise((resume) => setImmediate(resume));
        if (gone()) return false;
        for (const item of items.slice(at, at + SEARCH_BATCH)) {
          const tier = matchItem(query, item);
          if (tier) found.push({ item, tier });
        }
      }
      return true;
    };
    let after: { at: number; id: number } | null = null;
    for (;;) {
      const turns = this.deps.store.harnessTurnsFrom(profileKey, after, SEARCH_PAGE);
      const last = turns.at(-1);
      if (!last) break;
      after = { at: last.at, id: last.id };
      // An entry goes to the first page that names it and no other, so it is
      // never drawn twice; a second turn naming the same one is still found
      // by its own words, which are all a search reads.
      const linked = linkedBy(turns);
      const named = (entry: { id: string }) => linked.has(entry.id) && !merged.has(entry.id);
      const pageOutbox = outbox.filter(named);
      const pageMissed = missed.filter(named);
      for (const entry of [...pageOutbox, ...pageMissed]) merged.add(entry.id);
      if (!(await judge(mergeConversation({ turns, outbox: pageOutbox, missed: pageMissed })))) return answer;
      if (turns.length < SEARCH_PAGE) break;
    }
    const rest = mergeConversation({
      turns: [],
      outbox: outbox.filter((entry) => !merged.has(entry.id)),
      missed: missed.filter((entry) => !merged.has(entry.id)),
    });
    if (!(await judge(rest))) return answer;
    // Pages come oldest first already; the rest is put in among them by time.
    // A stable sort, so lines at one instant keep the merge's order.
    if (rest.length) found.sort((a, b) => a.item.at - b.item.at);
    return {
      raw: query.raw,
      items: this.linked(profileKey, pickHits(found)),
      total: found.length,
      exact: found.filter((hit) => hit.tier === "exact").length,
    };
  }

  /**
   * The lines either side of a moment: a result clicked that is older than
   * anything the drawer has loaded opens here, rather than loading every page
   * from the newest down to it into a list that has no virtual scroll.
   */
  around(profileKey: string, at: number, before = KURU_PAGE, after = KURU_PAGE): KuruAround {
    const older = this.deps.store.harnessTurns(profileKey, at + 1, before);
    const newer = this.deps.store.harnessTurnsAfter(profileKey, at, after);
    const turns = [...older.turns, ...newer.turns];
    const since = older.more ? (turns[0]?.at ?? at) : -Infinity;
    const until = newer.more ? (turns.at(-1)?.at ?? at) + 1 : Infinity;
    const linked = linkedBy(turns);
    const inSpan = (when: number) => when >= since && when < until;
    const items = mergeConversation({
      turns,
      outbox: this.deps.outbox(profileKey).filter((entry) => inSpan(entry.at) || linked.has(entry.id)),
      missed: this.deps.missed(profileKey).filter((entry) => inSpan(entry.at) || linked.has(entry.id)),
      launchers: this.launchers(profileKey),
    });
    return { items: this.linked(profileKey, items), older: older.more, newer: newer.more };
  }

  private conversation(profileId: string, profileKey: string): KuruConversation {
    const { turns, more } = this.deps.store.harnessTurns(profileKey, null, KURU_RECENT);
    const outbox = this.deps.outbox(profileKey);
    const missed = this.deps.missed(profileKey);
    // Everything on the two lists that is not older than the window, plus
    // whatever a turn in the window names: a clip is released a moment
    // before the prompt hook reports it, so the message behind the window's
    // first turn is always a little older than the window and must come
    // along or the turn loses its length and its Resend. And a message still
    // on its way, or a reply nobody heard, is always shown however old —
    // those are the items with something to do about them. And a window that
    // holds every turn there is holds everything older too, as `page` does.
    const since = more ? (turns[0]?.at ?? -Infinity) : -Infinity;
    const linked = linkedBy(turns);
    const items = mergeConversation({
      turns,
      outbox: outbox.filter((entry) => entry.at >= since || entry.state !== "delivered" || linked.has(entry.id)),
      missed: missed.filter((entry) => entry.at >= since || !entry.pending || linked.has(entry.id)),
      launchers: this.launchers(profileKey),
    });
    return { profileId, items: this.linked(profileKey, items), more, ...kuruCounts(outbox, missed) };
  }

  /** Each reply with the files it names beside it, for the drawer to draw as links. */
  private linked(profileKey: string, items: KuruItem[]): KuruItem[] {
    const files = this.deps.files;
    if (!files) return items;
    return items.map((item) => {
      if (item.kind !== "kuru") return item;
      const found = files(profileKey, item);
      return found.length ? { ...item, files: found } : item;
    });
  }

  private launchers(profileKey: string): Map<string, string | null> {
    return new Map(this.deps.store.conversations(profileKey, "harness").map((c) => [c.id, c.launcher] as const));
  }
}

/** The outbox messages and utterances a set of turns names, by id. */
function linkedBy(turns: readonly Turn[]): Set<string> {
  return new Set(turns.map((turn) => turn.voiceId).filter((id): id is string => id !== null));
}
