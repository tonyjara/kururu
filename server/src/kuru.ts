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
 * On the restartable side, like everything that reads the database.
 */
import { KURU_PAGE, KURU_RECENT, kuruCounts, mergeConversation, type KuruConversation, type KuruFile, type KuruItem, type KuruPage } from "../../shared/kuru";
import type { Turn } from "../../shared/store";
import type { StoredMissed, StoredOutboxEntry } from "../../shared/voice";
import type { ServerMessage } from "../../shared/wire";
import type { Store } from "./store";

/** How long a burst of changes settles before one broadcast says all of it. */
const COALESCE_MS = 25;

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
}

export class Kuru {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: KuruDeps) {}

  /** What every client is told, on connect and after every change. */
  message(): ServerMessage {
    return { type: "kuru", kuru: this.deps.profiles().map(({ id, key }) => this.conversation(id, key)) };
  }

  /** Something the conversation is made of moved. Said once for a burst. */
  changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deps.broadcast(this.message());
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
