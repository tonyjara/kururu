/**
 * The conversation with Kuru, in the one place it has.
 *
 * It replaced a button with three facts on one glyph and a menu box asked to
 * hold prose. The bot button's ink said whether the session ran, its top
 * corner counted unheard replies, its bottom corner was a dot in three other
 * colours for your messages, and the button itself went somewhere else — the
 * terminal — while both corners opened a 340px popover with a scroll cap,
 * which is the wrong room for three paragraphs. Meanwhile the conversation had
 * no home: your spoken messages were on one list, your typed ones nowhere,
 * Kuru's replies existed while the pill said them and then only once missed,
 * and the rest was the terminal's scrollback.
 *
 * So: one timeline, oldest at the top, opened at the bottom. Your messages
 * carry a mic for a clip or nothing for a typed line, the time, the clip's
 * length, and one word in the status inks for where they are — Saving,
 * Hearing, Waiting for Kuru, Sent, Delivered, Failed — with Resend and
 * Discard inline on a failed one. Kuru's replies carry the speaker glyph and
 * the full text; the speaker is Play and Stop both, for any reply with words
 * to say again, and shows which it is — an unheard one also says so beside
 * it, the one audible right now says Speaking, and a line said mid-turn
 * through the `say` tool is drawn smaller. A live line over the composer
 * says what Kuru is doing now — thinking, with Stop beside it — and the
 * composer under it types to Kuru through the same outbox a clip goes
 * through — so the phone talks to Kuru today, since playback works over
 * plain http and only the microphone needs the secure context.
 *
 * **The live line stands outside the list, over the composer,** where it
 * was inside the list at its foot until 2026-10-18. At the foot it scrolled
 * away with everything else the moment you read up, which is when "is it
 * still going?" is asked; over the box it is always where the next message
 * is typed. Stop is the Escape a press in Kuru's terminal sends, through the
 * server (`Harness.interrupt`), which also puts the status right afterwards
 * — Claude Code tells no hook about a turn it was stopped in — so the line
 * goes when the turn has ended and not before. It leaves the composer alone:
 * a half-written message stays half-written.
 *
 * **Who spoke is a colour, and only two people speak.** Yours are on raised
 * chrome at the right, Kuru's on the terminals' ground at the left, and
 * nothing else wears either: kururu's notices that an agent finished or
 * blocked, and a background task reporting back, arrive in Kuru's session as
 * user turns, and were drawn as yours — most of "your" lines on a busy day,
 * so the two colours alternated and said nothing. They are a third kind now
 * (`readPrompt` in `shared/kuru.ts` decides, out of the database, wrappers
 * and all), drawn as one quiet line — who, which agent, what happened —
 * with the whole message behind a tap.
 *
 * **A column beside the panes, on the sidebar's terms.** It used to be a
 * panel floated over them, on the argument that a column resizes every pty
 * on open and close — which is true of a resize dragged frame by frame, and
 * not of one settled in `terminals.ts`'s usual 60ms, the same debounce a
 * sidebar toggle already rides. So it is a flex sibling of `.stage` now,
 * narrowing it the way the sidebar and the file tree do, and the terminals
 * resize once, at the end, instead of never. It does not dim them, because
 * you read Kuru's answer while watching the agent it talks about, and a
 * click into them — a terminal, a card — is just a click into the layout,
 * not a reason to close; only the close button, the chip, or the keyboard
 * does that. On a narrow window it is still a full-screen sheet over
 * everything, the usual close button, one sheet at a time like the board
 * and the databases — and there a click outside does close it, since
 * "outside" is still something else drawn above the sheet.
 *
 * **Unheard means neither heard nor seen.** A reply stops counting when it is
 * played to its end, or when it has been in view in the open drawer for
 * `KURU_SEEN_MS`. The count's job is to bring you here; once you are here it
 * has done it, and a count that survived reading would teach you to ignore
 * it. So nothing here clears the count by hand: a reply's own speaker says it
 * again, and asking Kuru what you missed has it call `play_missed` for all of
 * them. The header used to carry "Play unheard" and "Mark all heard" for
 * those two jobs, and they were two buttons nobody could say the use of.
 *
 * **The speaker in the header is Settings → Voice's "Speak replies"** — the
 * one setting, not a copy of it: read off the socket's `voice` and written
 * back whole through `setVoice`, so the two places cannot disagree. Muting
 * also stops a reply already audible here, because a mute that lets the
 * sentence finish reads as a mute that did not work.
 *
 * **Every node's Kuru, in the one drawer.** On a kururu linked with others
 * (`docs/nodes.md`), each other node's Kuru comes on the same message
 * (`peers`), and the list is all of them merged by time (`mergeNodes`),
 * each line of another node's wearing its name. A chip per node narrows it
 * to one; one that is away is greyed, with when it was last seen, and keeps
 * its last items. The composer is this node's Kuru's unless the message
 * starts `@omarchy`, and a peer's reply has Reply, which starts the message
 * that way — the server sends it over the link into that node's outbox, the
 * door Telegram uses, so "delivered" still means that Kuru said it took it.
 * A card code in another node's words is not a door here: it names that
 * node's board.
 *
 * **Any line can be answered on its own.** Kuru asks one thing, kururu
 * relays another, Kuru asks a third, and "yes" answers whichever Kuru takes
 * to be the last. So every line — Kuru's, kururu's notices, your own — has a
 * small reply arrow, on hover where there is a pointer and always on a touch
 * screen, and the composer then says what it is replying to, above the box,
 * until it is sent or cancelled. What is sent is the words with the line's
 * reference in front (`shared/reply.ts`), which is what Kuru reads; a sent
 * reply draws it as a quote that scrolls back to the line. A peer's line is
 * answered the same way, and the message starts `@node` so it goes there.
 *
 * **Any line folds to one row.** Beside the arrow, a fold leaves a message
 * of yours or a reply of Kuru's as who said it, when, and its first line,
 * and a click anywhere on that row opens it again; the header folds or
 * opens every line at once. What is folded is this device's, kept by
 * `kurufold.ts`, and so is the switch that starts long ones folded. A
 * quote's line and the reply the pill was showing open on the way to being
 * shown, and a folded reply is not seen by being in view, since its first
 * line is not the reply.
 *
 * **The search narrows the list in place.** The field is under the header —
 * the magnifier, ⌘F with the keyboard in the drawer, or `C-a /` from anywhere —
 * and as it is typed the list holds only the lines with those words, oldest
 * first as ever, with the words lit (`shared/kurusearch.ts`). The lines already
 * loaded are judged here on the keystroke and the server's answer for the whole
 * history lands a moment later, so there is never a blank list to wait through.
 * A line clicked opens the chat at it with the words still lit: from the loaded
 * lines when it is among them, and otherwise from a page around it, kept apart
 * from `known` with a "Show later" where it stops short of the newest, because
 * those pages are the jump's and the chat's own span must not grow a hole.
 * Empty field or Escape puts back the chat at the line that was at the top.
 * Searching opens no fold for good and hears no reply: a reply in view among
 * results has not been read as one of a conversation, so it stays unheard.
 *
 * **Kuru's words are Markdown, and drawn as such** since 2026-11-04: a
 * table is a table, a list a list, `code` in the mono face, headings a
 * step up, a fence a block with a copy button. The parse is `kurumd.ts`
 * and the drawing `KuruMarkdown.tsx`, and every run of words in the tree
 * still comes through `ReplyWords` here, so a path in a table cell is the
 * door it was in a sentence and a search's words are lit inside a code
 * span. A folded line is its first line with the block mark taken off.
 * Your own messages are drawn as you typed them: they are what Kuru read,
 * a `*` you typed is a `*`, and their references are chips already. A
 * quote selects the words as drawn, which is what you saw. Why the reader's
 * renderer is not borrowed is at the top of `kurumd.ts`.
 *
 * **Any line can be pinned, to come back to.** A pin beside the fold, on the
 * same terms, and always shown in the accent on a line that is pinned; the
 * header's pin with a count opens the list of them under it, newest said
 * first, and a press there opens the chat at the line as a result does —
 * from what is loaded, or a page around it, or the line alone as the server
 * keeps it. Pins are the database's, so the phone has them too
 * (`shared/kurupin.ts`), and only this node's turns take one.
 *
 * What it draws is the server's `kuru` message (`shared/kuru.ts`), already
 * merged: nothing in here decides what a message's state is or whether a
 * reply was heard. What it adds is this page's own two states for a clip the
 * server does not have yet — recording, and saving — from the voice module.
 */
import { Fragment, createContext, useCallback, useContext, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cardCode } from "../../../shared/board";
import { CHANNEL_NAMES, channelReady, isChannelKind, type TelegramStatus } from "../../../shared/channels";
import { dropRefusal } from "../../../shared/drops";
import { KURU_SEEN_MS, addressMatches, addressOf, addressQuery, clipLength, insertLine, insertWords, mergeNodes, pickAddress, quotedLine, replyRefOf, splitCardCodes, typedAddress, type CardRef, type KuruFile, type KuruItem, type KuruReply, type NodeKuruItem, type NoticeItem, type PeerKuru, type YouItem } from "../../../shared/kuru";
import { canPin, sortPins, type KuruPin } from "../../../shared/kurupin";
import { matchItem, parseKuruQuery, splitHits, type KuruQuery } from "../../../shared/kurusearch";
import { splitMentions } from "../../../shared/made";
import type { AgentSnapshot, MascotConfig, Profile } from "../../../shared/model";
import { REPLY_ME, replyClock, replyReference, splitReply, withReply, type ReplyRef } from "../../../shared/reply";
import { TAP_MS, type OutboxState, type VoiceSettings } from "../../../shared/voice";
import { chipsIn, filesStillIn, piecesOf, type Chip } from "../../../shared/chips";
import { escapePath, handoverFrom, isFileDrag } from "../drop";
import { kuruLive, kuruWorking, setKuruSearchExit, takeKuruSearch, takeKuruWords, useKuruDrawer, type KuruLive } from "../kuru";
import { firstLine, foldKeys, foldText, isFolded, isLong, readFolds, useFoldLong, withFold, withFolds, writeFolds, type Folds } from "../kurufold";
import { foldInline, replyTree } from "../kurumd";
import { useKuruSearch } from "../kurusearch";
import { isLoopback } from "../preview";
import * as api from "../session";
import { useKururu } from "../session";
import { dictate, dictateStop, dictateToggled, dismissVoice, useDictation, useOutgoing, useVoiceUi, voiceIsRemote, voiceNow } from "../voice";
import { CHIP_ICONS, CHIP_WORD, ChipField, type ChipFieldHandle } from "./ChipField";
import { Icon } from "./Icon";
import { KuruInline, KuruMarkdown, type MarkdownDoors } from "./KuruMarkdown";
import { PinButton, PinsButton, PinsList } from "./KuruPins";
import { MadeInline } from "./MadeLinks";
import { quotable } from "./Quote";
import { Mascot } from "./Status";
import { MicIcon, PlaneIcon, SpeakerIcon, SpeakerOffIcon } from "./VoiceIcons";
import { hueStyle } from "./NodeChip";

/** How close to the foot the list has to be for a new item to keep it there. Reading something older must not be yanked away. */
const STICK_PX = 48;
/** How long a reply just scrolled to stays marked, so the eye finds it. */
const FOCUS_MS = 1800;
/** Seen reports are gathered for a moment so a screenful read at once is one message. */
const SEEN_BATCH_MS = 300;
/**
 * How long Stop stays "Stopping…" waiting for the turn to end. A little over
 * the server's own watch (`STOP_WATCH_MS` in `harness.ts`), after which a
 * turn still running is one the Escape did not reach, and Stop is offered
 * again.
 */
const STOPPING_MS = 5000;

/** Which node's conversation the list is narrowed to, remembered per viewer: null for every node. */
const NODE_KEY = "kururu.kuru.node";

function readNodeFilter(): string | null {
  try {
    return localStorage.getItem(NODE_KEY);
  } catch {
    return null;
  }
}

function writeNodeFilter(node: string | null) {
  try {
    if (node === null) localStorage.removeItem(NODE_KEY);
    else localStorage.setItem(NODE_KEY, node);
  } catch {
    // Not remembered past this window.
  }
}

/** One of your messages as the drawer draws it: the server's states, and this page's two for a clip the server has not taken yet. */
type RowState = OutboxState | "saving" | "recording";

/**
 * Words for the states worth a mark: a message still working its way
 * through, or one that failed and needs Resend. A delivered message is the
 * normal case and gets no mark — it got through, and saying so on every
 * line it ever occupies is noise once that is true far more often than not.
 */
const STATE_WORD: Partial<Record<RowState, string>> = {
  recording: "Recording",
  saving: "Saving",
  transcribing: "Hearing",
  queued: "Waiting for Kuru",
  failed: "Failed",
};

export function KuruDrawer({
  profile,
  agents,
  mascot,
  sheet,
  focus,
  asked,
  onClose,
  onResize,
  onResetWidth,
  onEditing,
  onCard,
  onTerminal,
  chips,
}: {
  profile: Profile;
  agents: AgentSnapshot[];
  mascot: MascotConfig;
  /** A full-screen sheet on a narrow window, rather than a panel beside the panes. */
  sheet: boolean;
  /** The reply to open at — an utterance id — and a counter so the same ask twice scrolls twice. */
  focus: string | null;
  asked: number;
  onClose: () => void;
  /** A width proposed by the drawer's own grip — desktop only, see `Grip` below. */
  onResize: (px: number) => void;
  onResetWidth: () => void;
  /** The composer has the keyboard, so the prefix and the panes must leave it alone. */
  onEditing: (editing: boolean) => void;
  /** A card named in a reply was clicked: take me to it — the profile's sheet for one of its own, the workspace's board for the rest. */
  onCard: (workspaceId: string | null, cardId: string) => void;
  /** Take me to Kuru's terminal — started, resumed or revealed. Rejects with why a Kuru would not start. */
  onTerminal: () => Promise<unknown>;
  /**
   * The two drawers' chips, which lead this header while the drawer is open —
   * Kuru's lit, since it is this drawer, and the other the way across. See
   * `DrawerChips.tsx`.
   */
  chips: ReactNode;
}) {
  const { kuru, kuruPeers, channels, voice, nodes } = useKururu();
  const conversation = kuru.find((c) => c.profileId === profile.id) ?? null;
  const selfName = nodes?.self.name ?? "here";
  const peerNames = kuruPeers.map((peer) => peer.node.name);
  const [nodeFilter, setNodeFilter] = useState<string | null>(readNodeFilter);
  // A node that left the roster is not a filter any more.
  const filter = nodeFilter !== null && nodeFilter !== selfName && !peerNames.includes(nodeFilter) ? null : nodeFilter;
  const pickNode = (node: string | null) => {
    setNodeFilter(node);
    writeNodeFilter(node);
  };
  /**
   * A line's reply arrow was pressed: the composer quotes it, and has the
   * keyboard — and starts `@node ` for another node's line, so the reply goes
   * to the Kuru that knows it. A counter, so the same line twice asks twice.
   */
  const [replyAsk, setReplyAsk] = useState<{ quoting: Quoting; n: number } | null>(null);
  const replyTo = useCallback((item: NodeKuruItem & (YouItem | KuruReply | NoticeItem)) => {
    const ref = replyRefOf(item, ownId(item), Date.now());
    if (ref) setReplyAsk((was) => ({ quoting: { node: item.node, at: item.at, ref }, n: (was?.n ?? 0) + 1 }));
  }, []);
  /**
   * The words a quote of a line's words is written after — the reference
   * its reply arrow writes, so Kuru finds the message as it finds a reply's
   * — for Kuru's replies and kururu's notices in this node's conversation.
   * Another node's line is left unquotable: a quote is a line among others
   * in the box, with no `@node` in front of it to send it to the Kuru that
   * said it, and the id in it would be that Kuru's.
   */
  const quoteRefOf = (item: NodeKuruItem & (KuruReply | NoticeItem)): string | null => {
    if (item.node !== null) return null;
    const ref = replyRefOf(item, item.id, Date.now());
    return ref ? replyReference(ref) : null;
  };
  // The drawer is the active profile's, so Telegram is this conversation's
  // when it talks to whichever profile is active, or was pointed at this one.
  const telegram = channels?.telegram && channelReady(channels.telegram) && (channels.telegram.profileId ?? profile.id) === profile.id ? channels.telegram : null;
  const outgoing = useOutgoing();
  const ui = useVoiceUi();
  const live = kuruLive(profile, agents, conversation, ui.phase === "speaking");
  const working = kuruWorking(profile, agents);
  const list = useRef<HTMLOListElement>(null);
  const stuck = useRef(true);

  /**
   * The speaker icon's own replay: which row asked to hear its reply again.
   * There is one player, so one id is enough. Set the moment it is asked
   * for, so a click shows the stop state at once rather than waiting out the
   * gap before the first sentence is ready; `started` keeps that optimism
   * from reading as "done" the instant it is set, and is what tells a replay
   * that reached the pill's phase from one that never did — the row clears
   * only once the player has actually left `speaking`, not before it got
   * there, whatever took it away: the reply ending, Escape, or another row's
   * click stopping it first.
   */
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const replayStarted = useRef(false);
  useEffect(() => {
    if (!replayingId) return;
    if (ui.phase === "speaking") {
      replayStarted.current = true;
      return;
    }
    if (replayStarted.current) {
      replayStarted.current = false;
      setReplayingId(null);
    }
  }, [ui.phase, replayingId]);

  /**
   * The speaker clicked, on any reply: stop whatever that row is doing if it
   * is the one audible right now — this row's own replay, or Kuru genuinely
   * saying it for the first time — through `dismissVoice`, the pill's ✕
   * itself, so a reply cut off here lands unheard exactly as it would from
   * there. Otherwise this reply was not playing, so anything else that was
   * is stopped first — one player, one row at a time — and this one is asked
   * for, with the words the drawer already has: a reply already heard has
   * left the missed list and kept no other copy of them.
   */
  const onReplay = useCallback(
    (item: KuruReply) => {
      if (!item.utterance) return;
      if (replayingId === item.id || item.fate === "speaking") {
        dismissVoice();
        if (replayingId === item.id) {
          replayStarted.current = false;
          setReplayingId(null);
        }
        return;
      }
      if (ui.phase === "speaking") dismissVoice();
      replayStarted.current = false;
      setReplayingId(item.id);
      api.kuruReplay(profile.id, item.utterance, item.text);
    },
    [profile.id, replayingId, ui.phase],
  );

  /**
   * Everything seen so far, by id, so items the socket's window has slid past
   * stay on screen and pages fetched from before it have somewhere to go. The
   * window is the truth for its own span: an item in it replaces the one here,
   * and one from inside its span that it no longer carries — a failed message
   * discarded — goes. A message that became a turn changes id on the way, so
   * the entry it was is dropped by the outbox id they share.
   */
  const [known, setKnown] = useState<Map<string, KuruItem>>(() => new Map());
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setKnown(new Map());
    setMore(false);
  }, [profile.id]);
  useEffect(() => {
    if (!conversation) return;
    const items = conversation.items;
    const since = items[0]?.at ?? Infinity;
    const linked = new Set(items.map((item) => (item.kind === "you" ? item.outboxId : null)).filter((id): id is string => id !== null));
    setKnown((prev) => {
      const next = new Map<string, KuruItem>();
      for (const [id, item] of prev) {
        if (item.at >= since) continue;
        if (item.kind === "you" && item.outboxId && linked.has(item.outboxId)) continue;
        next.set(id, item);
      }
      for (const item of items) next.set(item.id, item);
      return next;
    });
    setMore((was) => was || conversation.more);
  }, [conversation]);

  /**
   * The search. `words` is the field; `viewing` is a result opened in the chat,
   * with whatever had to be fetched to show it, kept out of `known` so that
   * leaving puts the chat back exactly as it was.
   */
  const [searchOpen, setSearchOpen] = useState(false);
  const [words, setWords] = useState("");
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const [opening, setOpening] = useState(false);
  /** The line the arrows have reached in the results, which Enter opens. Null for the newest. */
  const [walked, setWalked] = useState<string | null>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const query = useMemo(() => parseKuruQuery(words), [words]);
  // Typing never waits on the list: the field takes the key at once, and the
  // lines catch up when React has a moment. The server's half is its own pause.
  const deferred = useDeferredValue(query);
  const lit = query && (deferred ?? query);
  const searching = query !== null && viewing === null;
  const { answer, failed } = useKuruSearch(profile.id, query?.raw ?? null);
  const hits = useMemo(() => {
    if (!lit) return null;
    // The answer to something shorter than this still narrows: what is typed
    // next only ever takes lines away from it, so it stands until its own.
    const lines = new Map((answer?.items ?? []).filter((item) => matchItem(lit, item)).map((item) => [item.id, item] as const));
    for (const item of known.values()) if (matchItem(lit, item)) lines.set(item.id, item);
    const peers = kuruPeers.map((peer) => ({ ...peer, items: peer.items.filter((item) => matchItem(lit, item)) }));
    return mergeNodes([...lines.values()].sort((a, b) => a.at - b.at), peers);
  }, [lit, answer, known, kuruPeers]);

  const context = viewing?.pages ?? null;
  // A page of `viewing`'s and a line of `known`'s can be the same line, and `known`'s is the live one.
  const own = [...(context?.size ? new Map([...context, ...known]) : known).values()].sort((a, b) => a.at - b.at);
  const fetched = context?.size ? [...context.values()].sort((a, b) => a.at - b.at) : null;
  const first = (fetched ?? own)[0]?.at ?? null;
  const merged = searching && hits ? hits : mergeNodes(own, kuruPeers);
  const items = filter === null ? merged : merged.filter((item) => (item.node ?? selfName) === filter);
  const away = filter !== null && !searching ? kuruPeers.find((peer) => peer.node.name === filter && peer.state !== "up") : undefined;
  const moreEarlier = searching ? false : fetched ? viewing!.older : more;
  /** The last line of what was fetched for a result, where the chat stops short of the newest. */
  const fetchedLast = fetched?.at(-1) ?? null;
  const gapAfter = viewing?.newer ? (fetchedLast?.id ?? null) : null;
  /** Lines a search matched that the answer left out to stay at its cap. They are this node's, so they do not count while the list is narrowed to another's. */
  const leftOut = answer && query && answer.raw === query.raw && (filter === null || filter === selfName) ? Math.max(0, answer.total - answer.items.length) : 0;

  /**
   * Which lines are folded to one row (`kurufold.ts`): open by default, or
   * folded when long while "Fold long messages" is on on this device.
   */
  const [folds, setFolds] = useState<Folds>(readFolds);
  const foldLong = useFoldLong();
  const foldDefault = (item: NodeKuruItem): boolean => {
    const text = foldText(item);
    return foldLong && text !== null && isLong(text);
  };
  /** Null for a line with nothing to fold. */
  // A result stands open, and so does the one opened in the chat, without
  // writing that down: what a line is folded to is for reading, and a search
  // passing over it should leave it as it found it.
  const foldedOf = (item: NodeKuruItem): boolean | null => (foldText(item) === null ? null : !searching && viewing?.id !== item.id && isFolded(folds, foldKeys(item), foldDefault(item)));
  const keepFolds = (next: Folds) => {
    setFolds(next);
    writeFolds(next);
  };
  const foldable = searching ? [] : items.filter((item) => foldText(item) !== null);
  const anyOpen = foldable.some((item) => !foldedOf(item));

  /**
   * Where a fold leaves the eye. Folding or opening one line keeps its top
   * where it was, and the rest of it comes and goes below; one folded while
   * its top was above the list's comes to the top, or it would fold out of
   * sight. Folding or opening all of them keeps the first line in view where
   * it was — or the foot, when the list was at the foot.
   */
  const keep = useRef<{ id: string; top: number } | "foot" | null>(null);
  useLayoutEffect(() => {
    const el = list.current;
    const kept = keep.current;
    keep.current = null;
    if (!el || !kept) return;
    if (kept === "foot") {
      el.scrollTop = el.scrollHeight;
      return;
    }
    const row = el.querySelector(`[data-item="${CSS.escape(kept.id)}"]`);
    if (row) el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - kept.top;
  }, [folds]);
  const toggleFold = (item: NodeKuruItem) => {
    const el = list.current;
    const row = el?.querySelector(`[data-item="${CSS.escape(item.id)}"]`);
    if (el && row) keep.current = { id: item.id, top: Math.max(0, row.getBoundingClientRect().top - el.getBoundingClientRect().top) };
    keepFolds(withFold(folds, foldKeys(item), !foldedOf(item), foldDefault(item)));
  };
  const foldAll = () => {
    const el = list.current;
    if (el) keep.current = stuck.current ? "foot" : firstInView(el);
    keepFolds(withFolds(folds, foldable.map((item) => ({ keys: foldKeys(item), byDefault: foldDefault(item) })), anyOpen));
  };

  /**
   * A line to bring into view — a quote's, the reply the pill was showing —
   * opened first when it is folded, and scrolled to once it has its height:
   * to the middle, or to its top when it is taller than the list can show.
   */
  const [goal, setGoal] = useState<{ id: string; smooth: boolean; n: number } | null>(null);
  const reveal = (item: NodeKuruItem, smooth: boolean) => {
    if (foldedOf(item)) keepFolds(withFold(folds, foldKeys(item), false, foldDefault(item)));
    setGoal((was) => ({ id: item.id, smooth, n: (was?.n ?? 0) + 1 }));
  };
  useLayoutEffect(() => {
    const el = list.current;
    const row = goal ? el?.querySelector<HTMLElement>(`[data-item="${CSS.escape(goal.id)}"]`) : null;
    if (!el || !row || !goal) return;
    row.scrollIntoView({ block: row.offsetHeight > el.clientHeight * 0.8 ? "start" : "center", behavior: goal.smooth ? "smooth" : "auto" });
  }, [goal]);

  const earlier = () => {
    if (loading) return;
    setLoading(true);
    const reading = fetched !== null;
    api
      .fetchKuru(profile.id, first)
      .then((page) => {
        // Kept where the eye is: the list grows above, and the scroll
        // position is put back by the layout effect below.
        anchor.current = list.current ? { height: list.current.scrollHeight, top: list.current.scrollTop } : null;
        // Reading back from a result older than the chat's span: these are
        // the jump's lines, and the chat's own stays as it was.
        if (reading) {
          setViewing((was) => was && { ...was, pages: new Map([...page.items.map((item) => [item.id, item] as const), ...was.pages]), older: page.more });
          return;
        }
        setKnown((prev) => {
          const next = new Map(prev);
          for (const item of page.items) if (!next.has(item.id)) next.set(item.id, item);
          return next;
        });
        setMore(page.more);
      })
      .catch(() => setMore(false))
      .finally(() => setLoading(false));
  };
  const anchor = useRef<{ height: number; top: number } | null>(null);

  /** Reading on from a result, towards the chat's own lines. Once a page reaches them there is no gap left to show. */
  const later = () => {
    if (loading || !fetchedLast) return;
    setLoading(true);
    api
      .fetchKuruAround(profile.id, fetchedLast.at, 0)
      .then((page) => setViewing((was) => was && { ...was, pages: new Map([...was.pages, ...page.items.map((item) => [item.id, item] as const)]), newer: page.newer && !page.items.some((item) => known.has(item.id)) }))
      .catch(() => setViewing((was) => was && { ...was, newer: false }))
      .finally(() => setLoading(false));
  };

  /**
   * Where the chat was when the search began, which is where it goes back to:
   * the first line in view and how far down it sat, or the foot. A line and not
   * a `scrollTop`, since a reply that arrives meanwhile moves every offset.
   */
  const left = useRef<{ id: string; top: number } | "foot" | null>(null);
  const putBack = useRef(false);
  const noteWhereWeAre = () => {
    const el = list.current;
    if (!el) return;
    const line = stuck.current ? null : firstInView(el);
    // Its real offset, and not `firstInView`'s, which stops at the list's top:
    // a tall line half scrolled past it has to come back half scrolled past it.
    const row = line && el.querySelector(`[data-item="${CSS.escape(line.id)}"]`);
    left.current = line && row ? { id: line.id, top: row.getBoundingClientRect().top - el.getBoundingClientRect().top } : "foot";
  };
  const editWords = (next: string) => {
    const was = query !== null;
    const now = parseKuruQuery(next) !== null;
    if (!was && now) noteWhereWeAre();
    if (was && !now) putBack.current = true;
    if (viewing || !now) setViewing(null);
    setWalked(null);
    setWords(next);
  };
  const [searchAsks, setSearchAsks] = useState(0);
  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setSearchAsks((n) => n + 1);
  }, []);
  // After the commit, since the field may only now have been drawn.
  useLayoutEffect(() => {
    if (!searchAsks) return;
    searchField.current?.focus();
    searchField.current?.select();
  }, [searchAsks]);
  /** Escape, or the ✕: the full chat, where it was. Says whether there was a search to leave. */
  const leaveSearch = useCallback((): boolean => {
    if (!searchOpen) return false;
    // Before it goes: a focused field taken out of the page tells nobody, and
    // the prefix would go on believing a field has the keyboard.
    searchField.current?.blur();
    if (parseKuruQuery(words)) putBack.current = true;
    setViewing(null);
    setWords("");
    setWalked(null);
    setSearchOpen(false);
    return true;
  }, [searchOpen, words]);
  useEffect(() => {
    setKuruSearchExit(leaveSearch);
    return () => setKuruSearchExit(null);
  }, [leaveSearch]);
  useEffect(() => {
    searchField.current?.blur();
    setSearchOpen(false);
    setWords("");
    setViewing(null);
  }, [profile.id]);
  const { search: searchAsked } = useKuruDrawer();
  useEffect(() => {
    if (!searchAsked) return;
    takeKuruSearch();
    openSearch();
  }, [searchAsked, openSearch]);
  /**
   * ⌘F, while the drawer is open: from anywhere on a Mac, a terminal included,
   * since reading the drawer usually means the keyboard is still in a pane and
   * no ⌘ chord ever reaches a pty — but not from another field, whose words a
   * find may mean. Everywhere else it is ctrl+f, which a terminal does want, so
   * there only with the keyboard in the drawer or in nothing. `C-a /` is the
   * door from any pane on any machine.
   */
  useEffect(() => {
    const mac = /Mac|iP(hone|ad)/.test(navigator.platform);
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f" || event.shiftKey || event.altKey || !(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
      const target = event.target instanceof Element ? event.target : null;
      const here = target === document.body || root.current?.contains(target);
      if (!here && (!mac || target?.closest("input, textarea, select, [contenteditable]:not(.term)"))) return;
      event.preventDefault();
      event.stopPropagation();
      openSearch();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openSearch]);

  /**
   * A result opened: the chat at that line, in context, with the words still
   * lit. A line the chat has loaded or another node's, which is all this drawer
   * has of it, is there already; anything older is fetched first.
   */
  const openResult = (item: NodeKuruItem) => {
    const show = (next: Viewing) => {
      setViewing(next);
      setGoal((was) => ({ id: item.id, smooth: false, n: (was?.n ?? 0) + 1 }));
      setFlash(item.id);
      stuck.current = false;
    };
    if (item.node !== null || known.has(item.id)) {
      show({ id: item.id, pages: new Map(), older: false, newer: false });
      return;
    }
    if (opening) return;
    setOpening(true);
    api
      .fetchKuruAround(profile.id, item.at)
      .then((page) => {
        const pages = new Map(page.items.map((line) => [line.id, line] as const));
        pages.set(item.id, item);
        show({ id: item.id, pages, older: page.older, newer: page.newer && !page.items.some((line) => known.has(line.id)) });
      })
      .catch(() => show({ id: item.id, pages: new Map([[item.id, item]]), older: false, newer: false }))
      .finally(() => setOpening(false));
  };
  const backToResults = () => {
    const id = viewing?.id;
    setViewing(null);
    stuck.current = false;
    if (id) setGoal((was) => ({ id, smooth: false, n: (was?.n ?? 0) + 1 }));
  };
  /** A click on a result that was not on one of its own doors, nor the end of selecting some of its words. */
  const onListClick = (event: React.MouseEvent) => {
    if (!searching || !(event.target instanceof Element) || event.target.closest("button, a") || window.getSelection()?.toString()) return;
    const id = event.target.closest<HTMLElement>("[data-item]")?.dataset.item;
    const item = id ? items.find((line) => line.id === id) : undefined;
    if (item) openResult(item);
  };
  // The hits, and not `items`, which is the chat again while one of them is open.
  const results = (hits ?? []).filter((item) => filter === null || (item.node ?? selfName) === filter);
  const walkedAt = walked === null ? results.length - 1 : results.findIndex((item) => item.id === walked);
  /** The field's own keys: the arrows walk the results, Enter opens the one reached, Escape leaves. */
  const onSearchKey = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      leaveSearch();
    } else if (searching && results.length > 0 && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const next = results[Math.max(0, Math.min(results.length - 1, (walkedAt < 0 ? results.length - 1 : walkedAt) + (event.key === "ArrowUp" ? -1 : 1)))]!;
      setWalked(next.id);
      setGoal((was) => ({ id: next.id, smooth: false, n: (was?.n ?? 0) + 1 }));
    } else if (event.key === "Enter" && searching) {
      event.preventDefault();
      const item = results[walkedAt];
      if (item) openResult(item);
    }
  };

  /**
   * Where the list sits. Opened, it is at the foot, or at the reply the pill
   * was showing; after that it follows new items only while it was already
   * at the foot, and a page prepended keeps what was on screen on screen.
   */
  const [marked, setMarked] = useState<string | null>(null);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (focus) {
      const row = el.querySelector<HTMLElement>(`[data-utterance="${CSS.escape(focus)}"]`);
      const item = row ? items.find((line) => line.id === row.dataset.item) : undefined;
      if (item) {
        reveal(item, false);
        setMarked(focus);
        const timer = setTimeout(() => setMarked(null), FOCUS_MS);
        return () => clearTimeout(timer);
      }
    }
    el.scrollTop = el.scrollHeight;
    stuck.current = true;
    return undefined;
  }, [asked, focus]);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (anchor.current) {
      el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = null;
      return;
    }
    if (stuck.current) el.scrollTop = el.scrollHeight;
  }, [items.length, live, working, outgoing.length, ui.phase]);
  // Results open at the foot, the newest of them over the composer, as the chat does.
  // New words only: coming back from a result goes to that result (`backToResults`).
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || !searching) return;
    el.scrollTop = el.scrollHeight;
    stuck.current = true;
  }, [lit?.raw]);
  // Last of these on purpose: the chat is back and has its height, whatever the
  // effects above just did with it.
  useLayoutEffect(() => {
    const el = list.current;
    if (!putBack.current || !el) return;
    putBack.current = false;
    const was = left.current;
    left.current = null;
    if (was === "foot" || !was) {
      el.scrollTop = el.scrollHeight;
      stuck.current = true;
      return;
    }
    const row = el.querySelector(`[data-item="${CSS.escape(was.id)}"]`);
    if (row) el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - was.top;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  }, [query === null]);
  const onScroll = () => {
    const el = list.current;
    if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  };

  /**
   * Seen: a reply in view for `KURU_SEEN_MS` while the page is visible stops
   * counting as unheard. Observed rather than assumed from the drawer being
   * open, because the whole point is that a glance at the drawer is not
   * reading the reply at the top of a long list. Nor is a folded reply in
   * view read: its first line is not the reply, and it is folded unread when
   * it was long on its way in, or folded with all the rest.
   */
  const unheard = (searching ? [] : items)
    .filter((item): item is NodeKuruItem & KuruReply => item.kind === "kuru" && item.fate === "unheard" && item.utterance !== null && !foldedOf(item))
    .map((item) => item.utterance!);
  const unheardKey = unheard.join("\n");
  useEffect(() => {
    const el = list.current;
    if (!el || !unheard.length) return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let pending: string[] = [];
    let flush: ReturnType<typeof setTimeout> | null = null;
    const send = () => {
      flush = null;
      if (pending.length) api.kuruSeen(profile.id, pending);
      pending = [];
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.utterance;
          if (!id) continue;
          const timer = timers.get(id);
          if (entry.isIntersecting && document.visibilityState === "visible") {
            if (timer) continue;
            timers.set(
              id,
              setTimeout(() => {
                timers.delete(id);
                observer.unobserve(entry.target);
                pending.push(id);
                flush ??= setTimeout(send, SEEN_BATCH_MS);
              }, KURU_SEEN_MS),
            );
          } else if (timer) {
            clearTimeout(timer);
            timers.delete(id);
          }
        }
      },
      { root: el, threshold: 0.6 },
    );
    for (const id of unheard) {
      const row = el.querySelector(`[data-utterance="${CSS.escape(id)}"]`);
      if (row) observer.observe(row);
    }
    return () => {
      observer.disconnect();
      for (const timer of timers.values()) clearTimeout(timer);
      if (flush) clearTimeout(flush);
      send();
    };
    // The ids are the dependency, as one string: a new unheard reply starts
    // watching, and a re-render that changed nothing about them does not.
  }, [unheardKey, profile.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * On a phone the drawer is a sheet over the whole screen, so a click
   * outside only reaches something drawn above it — the chip, a menu, a
   * dialog — and still means "go there instead". On a desktop it narrows
   * `.stage` rather than covering it, so a click outside is just a click
   * into the layout (a terminal, a card) and must not close the drawer; only
   * its own close button, the chip, or the keyboard does. Capture phase, so
   * a terminal's own handler taking the press cannot keep the drawer up.
   * The quote popover over the sheet's own words (`Quote.tsx`) is drawn into
   * `document.body`, outside the sheet, but a press on it is a press on what
   * the sheet shows.
   */
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!sheet) return;
    const away = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (root.current?.contains(target) || target.closest(".sb-kuru, .voice-pill, .scrim, .menu-backdrop, .menu, .quote-pop")) return;
      onClose();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [sheet, onClose]);

  /** A card code in a reply, resolved against the profile's boards. Not a card is not a link. */
  const cardOf = useCallback(
    (code: string): { workspaceId: string | null; cardId: string } | null => {
      for (const workspace of profile.workspaces) {
        if (!workspace.board) continue;
        const prefix = cardCode(workspace.name, 0).slice(0, -1);
        if (!prefix.endsWith("-") || !code.startsWith(prefix)) continue;
        const number = Number(code.slice(prefix.length));
        const card = workspace.board.cards.find((c) => c.number === number);
        if (card) return { workspaceId: workspace.id, cardId: card.id };
      }
      return null;
    },
    [profile.workspaces],
  );

  /**
   * A card a message of yours referenced, found by its id alone: the
   * workspace id written beside it is this run's and a draft can outlive
   * the run, but a card id is never reused. Another node's card is that
   * node's board, which is not a door here.
   */
  const refOf = useCallback(
    (ref: CardRef): { workspaceId: string | null; cardId: string } | null => {
      if (ref.place.includes(":")) return null;
      if (profile.board.cards.some((c) => c.id === ref.cardId)) return { workspaceId: null, cardId: ref.cardId };
      const workspace = profile.workspaces.find((w) => w.board?.cards.some((c) => c.id === ref.cardId));
      return workspace ? { workspaceId: workspace.id, cardId: ref.cardId } : null;
    },
    [profile.board, profile.workspaces],
  );

  /**
   * A path in a reply was opened. On a phone the drawer is a sheet over the
   * pane the file just landed in, so it gets out of the way, as the file tree
   * does; on the desktop it stays, beside what it opened.
   */
  const onFile = useCallback(() => {
    if (sheet) onClose();
  }, [sheet, onClose]);

  /**
   * The line a sent reply quotes, as the list draws it: looked for among the
   * lines of the conversation the reply went to — another node's when it was
   * written there or addressed there — under the ids that conversation knows
   * them by. Null when it is not among the lines loaded, and then the quote
   * is only a quote.
   */
  const quotedOf = (ref: ReplyRef, node: string | null, before: number): string | null => {
    const lines = items.filter((line) => line.node === node).map((line) => ({ ...line, id: ownId(line), drawn: line.id }));
    return quotedLine(lines, ref, before)?.drawn ?? null;
  };
  /** A quote was pressed: its line, opened when it is folded and in the middle of the list, lit for a moment as a reply the pill named is. */
  const [flash, setFlash] = useState<string | null>(null);
  const goTo = (id: string) => {
    const item = items.find((line) => line.id === id);
    if (!item) return;
    reveal(item, true);
    setFlash(id);
  };
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), FOCUS_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  /**
   * The pins: the server's, with a press not yet answered laid over them, so
   * the pin turns at once on a phone whose socket is slow. Each press is
   * forgotten once a message from the server has been read after it.
   */
  const serverPins = conversation?.pins;
  const pins = useMemo(() => sortPins(serverPins ?? []), [serverPins]);
  const [pinPresses, setPinPresses] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  useEffect(() => setPinPresses(new Map()), [serverPins]);
  const pinnedIds = useMemo(() => new Set(pins.map((pin) => pin.id)), [pins]);
  const isPinned = (id: string): boolean => pinPresses.get(id) ?? pinnedIds.has(id);
  const togglePin = (id: string) => {
    const next = !isPinned(id);
    setPinPresses((was) => new Map(was).set(id, next));
    api.kuruPin(profile.id, id, next);
  };
  const pinOf = (item: NodeKuruItem) => (canPin(item) ? { pinned: isPinned(item.id), onPin: () => togglePin(item.id) } : null);
  const [pinsOpen, setPinsOpen] = useState(false);
  useEffect(() => setPinsOpen(false), [profile.id]);
  /**
   * A pin pressed in the list: the chat at its line, lit for a moment. Out of
   * a search first, and onto every node or this one, since the line is this
   * node's. A line already loaded is scrolled to and opened if folded, as a
   * quote's is; anything older opens on a page around it, kept apart from the
   * chat's own lines as a search's result is (`openResult`), and with nothing
   * forced open, so its fold still works. The server's copy of the line is
   * put among that page whatever it says, so a line it cannot find a page
   * around is still drawn, whole.
   */
  const openPinned = (pin: KuruPin) => {
    setPinsOpen(false);
    if (searchOpen) {
      leaveSearch();
      putBack.current = false;
    }
    if (filter !== null && filter !== selfName) pickNode(null);
    const item: NodeKuruItem = { ...pin.item, node: null };
    const show = (smooth: boolean) => {
      reveal(item, smooth);
      setFlash(item.id);
      stuck.current = false;
    };
    if (own.some((line) => line.id === item.id)) {
      show(true);
      return;
    }
    const keepApart = (pages: Map<string, KuruItem>, older: boolean, newer: boolean) => {
      setViewing({ id: "", pages, older, newer });
      show(false);
    };
    api
      .fetchKuruAround(profile.id, item.at)
      .then((page) => {
        const pages = new Map(page.items.map((line) => [line.id, line] as const));
        pages.set(item.id, pin.item);
        keepApart(pages, page.older, page.newer && !page.items.some((line) => known.has(line.id)));
      })
      .catch(() => keepApart(new Map([[item.id, pin.item]]), false, false));
  };

  // This page's own clips, before the server has them, and the one being recorded.
  const saving = searching ? [] : outgoing.filter((clip) => clip.profileId === profile.id && !known.has(clip.id));
  const recording = !searching && ui.phase === "listening" && !voiceIsRemote();
  /** Whether the server has answered for these very words, or never will: until then an empty list is not "nothing". */
  const settled = failed || (answer !== null && answer.raw === query?.raw);

  return (
    <aside className={`kuru-drawer ${sheet ? "kuru-sheet" : ""}`} ref={root} role="dialog" aria-label="Kuru">
      {/* The chips stand where the title was: Kuru's chip already says what
          the title and its state word did — the mark, the name, and "asking"
          or "off" — and a header carrying both would say Kuru twice. The
          Terminal button went on 2026-10-18; the terminal is still a press
          away from the live line over the composer while Kuru is asking or
          off, which is when it was ever wanted. */}
      <header className="kuru-head">
        {chips}
        <span className="kuru-head-spacer" />
        <button type="button" className={`kuru-head-btn kuru-head-icon ${searchOpen ? "kuru-head-btn-on" : ""}`} aria-pressed={searchOpen} aria-label="Search the conversation" title="Search the conversation (⌘F, or C-a /)" onClick={() => (searchOpen ? leaveSearch() : openSearch())}>
          <SearchIcon />
        </button>
        {pins.length > 0 && <PinsButton count={pins.length} open={pinsOpen} onToggle={() => setPinsOpen((was) => !was)} />}
        {foldable.length > 0 && <FoldAll open={anyOpen} onFold={foldAll} />}
        {voice && <SpeakSwitch settings={voice.settings} />}
        {telegram && <TelegramSwitch status={telegram} />}
        <button className="sidebar-close kuru-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="close" />
        </button>
      </header>

      {kuruPeers.length > 0 && <NodeChips self={selfName} peers={kuruPeers} filter={filter} onPick={pickNode} />}

      {searchOpen && (
        <div className="kuru-search" role="search">
          <SearchIcon />
          <input
            ref={searchField}
            className="kuru-search-field"
            type="text"
            value={words}
            placeholder="Search the conversation"
            aria-label="Search the conversation"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(event) => editWords(event.target.value)}
            onKeyDown={onSearchKey}
            onFocus={() => onEditing(true)}
            onBlur={() => onEditing(false)}
          />
          {query && (
            <span className="kuru-search-count" role="status">
              {opening ? "Opening…" : searchCount(results.length, leftOut, results.filter((item) => lit && matchItem(lit, item) === "near").length, settled)}
            </span>
          )}
          {viewing && (
            <button type="button" className="kuru-head-btn" onClick={backToResults}>
              Results
            </button>
          )}
          <button type="button" className="kuru-quoting-cancel" onMouseDown={(event) => event.preventDefault()} onClick={leaveSearch} title="Back to the full chat (Esc)" aria-label="Close the search">
            <Icon name="close" />
          </button>
        </div>
      )}

      {pinsOpen && pins.length > 0 && <PinsList pins={pins} onOpen={openPinned} onUnpin={(pin) => togglePin(pin.id)} onClose={() => setPinsOpen(false)} />}

      <HitWords.Provider value={lit ?? null}>
        <ol className={`kuru-list ${searching ? "kuru-searching" : ""}`} ref={list} onScroll={onScroll} onClick={onListClick}>
          {moreEarlier && (
            <li className="kuru-earlier">
              <button className="kuru-head-btn" onClick={earlier} disabled={loading}>
                {loading ? "Loading…" : "Show earlier"}
              </button>
            </li>
          )}
          {searching && results.length === 0 && settled && (
            <li className="kuru-search-none" role="status">
              {failed ? <>The search could not reach the server, so only the lines loaded here were looked through. Nothing there has “{query.raw}”.</> : <>Nothing in this conversation has “{query.raw}”, or anything spelt close to it.</>}
            </li>
          )}
          {items.map((item) =>
            withGap(item.id === gapAfter, later, loading, item.id, item.kind === "session" ? (
              <li key={item.id} className="kuru-mark">
                <span>New conversation{item.launcher ? ` · ${item.launcher}` : ""}</span>
                <time dateTime={new Date(item.at).toISOString()}>{dayAt(item.at)}</time>
              </li>
            ) : item.kind === "you" ? (
              (() => {
                const to = item.node === null && item.text ? (addressOf(item.text, peerNames, item.via === "voice")?.node ?? null) : null;
                const reply = item.text ? splitReply(item.text) : null;
                const quoted = reply ? quotedOf(reply.ref, item.node ?? to, item.at) : null;
                return (
                  <You
                    key={item.id}
                    item={item}
                    state={item.state}
                    note={item.note}
                    node={item.node}
                    to={to}
                    refOf={item.node === null ? refOf : noRefs}
                    onCard={onCard}
                    reply={reply}
                    onQuote={quoted ? () => goTo(quoted) : null}
                    answerOf={(ref) => {
                      const line = quotedOf(ref, item.node ?? to, item.at);
                      return line ? () => goTo(line) : null;
                    }}
                    onReplyTo={() => replyTo(item)}
                    flash={flash === item.id || (searching && walked === item.id)}
                    folded={foldedOf(item) === true}
                    onFold={item.text ? () => toggleFold(item) : null}
                    pin={pinOf(item)}
                  />
                );
              })()
            ) : item.kind === "notice" ? (
              <Notice
                key={item.id}
                item={item}
                node={item.node}
                cardOf={item.node === null ? cardOf : noCards}
                onCard={onCard}
                onReplyTo={() => replyTo(item)}
                quoteRef={quoteRefOf(item)}
                flash={flash === item.id || (searching && walked === item.id)}
                onResult={searching ? () => openResult(item) : null}
                pin={pinOf(item)}
              />
            ) : (
              <Reply
                key={item.id}
                item={item}
                node={item.node}
                // Not `marked === item.utterance` alone: with nothing marked that
                // is null === null for every reply never spoken, and each of them
                // wore the accent of the one just scrolled to, for good.
                marked={marked !== null && marked === item.utterance}
                flash={flash === item.id || (searching && walked === item.id)}
                replaying={replayingId === item.id}
                onReplay={onReplay}
                onReplyTo={() => replyTo(item)}
                quoteRef={quoteRefOf(item)}
                folded={foldedOf(item) === true}
                onFold={() => toggleFold(item)}
                cardOf={item.node === null ? cardOf : noCards}
                onCard={onCard}
                onFile={onFile}
                pin={pinOf(item)}
              />
            )),
          )}
          {away && (
            <li className="kuru-mark">
              <span>
                {away.node.name} {away.state === "away" ? "is away" : "is not linked yet"}
                {away.lastSeen ? ` · last seen ${dayAt(away.lastSeen)}` : ""} · these are the last items it sent
              </span>
            </li>
          )}
          {saving.map((clip) => (
            <You
              key={clip.id}
              item={{ kind: "you", id: clip.id, at: clip.at, text: null, via: "voice", ms: clip.ms, state: "queued", typedAt: null, note: null, outboxId: null }}
              state="saving"
              note={clip.error ? `Not with the server yet (${clip.error}). Kept on this device and sent again until it is.` : null}
            />
          ))}
          {recording && (
            <li className="kuru-item kuru-you kuru-you-recording">
              <span className="kuru-meta">
                <MicIcon />
                <span className="kuru-state kuru-state-recording">{STATE_WORD.recording}</span>
              </span>
            </li>
          )}
        </ol>
      </HitWords.Provider>

      <Live live={live} working={working} profileId={profile.id} mascot={mascot} onTerminal={onTerminal} />

      <Composer profileId={profile.id} onEditing={onEditing} peers={kuruPeers} replyAsk={replyAsk} />

      {/* The edge you drag, on the sidebar's and the tree's terms: last in the
          tree and absolutely positioned, so it sits over the border rather
          than taking a column of its own. Only where there is a column to
          resize — a phone's sheet has no edge beside the panes to grab. */}
      {!sheet && <Grip onResize={onResize} onReset={onResetWidth} />}
    </aside>
  );
}

/**
 * What Kuru is doing now, over the composer: thinking, with Stop; asking,
 * with the way to its terminal; not running, with Start. Nothing between
 * turns, since quiet is the ordinary state and a line saying so is noise, and
 * nothing while a reply is only being said, which the reply's own row shows.
 * Thinking is `working` rather than `live`'s word, so a line said mid-turn
 * does not take Stop away for as long as it is being said.
 *
 * Stop is pressed once: "Stopping…" until the turn ends, or until
 * `STOPPING_MS` says the Escape did not reach it — the server sends no
 * second one meanwhile, since two Escapes together are Claude Code's rewind.
 * It does not take the keyboard from the composer, so a message being
 * written goes on being written.
 *
 * Start waits for the server's answer, which for a new Kuru is once it is
 * up or has died (`Harness.whenUp`), and a Kuru that would not start says
 * why under the line until the next press. Before, a press that failed
 * opened a tab that vanished, or nothing at all, and the drawer said "not
 * running" as if nobody had asked.
 */
function Live({ live, working, profileId, mascot, onTerminal }: { live: KuruLive; working: boolean; profileId: string; mascot: MascotConfig; onTerminal: () => Promise<unknown> }) {
  const [stopping, setStopping] = useState(false);
  const [start, setStart] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  useEffect(() => {
    if (!working) setStopping(false);
  }, [working]);
  useEffect(() => {
    if (live !== "off") setStart({ busy: false, error: null });
  }, [live]);
  const press = () => {
    setStart({ busy: true, error: null });
    onTerminal().then(
      () => setStart({ busy: false, error: null }),
      (err: unknown) => setStart({ busy: false, error: err instanceof Error ? err.message : String(err) }),
    );
  };
  useEffect(() => {
    if (!stopping) return;
    const timer = setTimeout(() => setStopping(false), STOPPING_MS);
    return () => clearTimeout(timer);
  }, [stopping]);
  if (working) {
    return (
      <div className="kuru-live kuru-live-thinking" role="status">
        <span className="status status-working">
          <Mascot config={mascot} clip={mascot.working} />
        </span>
        <span className="kuru-live-word">{stopping ? "Stopping…" : "Thinking…"}</span>
        <button
          type="button"
          className="kuru-head-btn kuru-stop"
          disabled={stopping}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setStopping(true);
            api.kuruStop(profileId);
          }}
          title="Stop Kuru's turn, as Esc in its terminal would"
          aria-label="Stop Kuru"
        >
          <Icon name="stop" />
          <span>Stop</span>
        </button>
      </div>
    );
  }
  if (live === "asking") {
    return (
      <div className="kuru-live kuru-live-asking" role="status">
        <span className="kuru-dot kuru-dot-asking" />
        <span className="kuru-live-word">asking something in its terminal</span>
        <button className="kuru-head-btn" onClick={() => void onTerminal().catch(() => {})}>
          Open terminal
        </button>
      </div>
    );
  }
  if (live === "off") {
    return (
      <div className="kuru-live-off-box" role="status">
        <div className="kuru-live kuru-live-off">
          <span className="kuru-dot kuru-dot-off" />
          <span className="kuru-live-word">{start.busy ? "starting…" : start.error ? "would not start" : "not running"}</span>
          <button className="kuru-head-btn" onClick={press} disabled={start.busy}>
            {start.error ? "Try again" : "Start"}
          </button>
        </div>
        {start.error && <p className="kuru-live-error">{start.error}</p>}
      </div>
    );
  }
  return null;
}

/**
 * One chip per node, under the header, on a kururu linked with others:
 * every node's conversation, or one's. A node that is away is greyed, and
 * says since when in its title; its last items are still there to read.
 * Its count is its replies said here that nobody heard out, as the lines
 * themselves are marked.
 */
function NodeChips({ self, peers, filter, onPick }: { self: string; peers: PeerKuru[]; filter: string | null; onPick: (node: string | null) => void }) {
  return (
    <nav className="kuru-nodes" aria-label="Whose conversation">
      <button type="button" className={`kuru-node-chip ${filter === null ? "kuru-node-chip-on" : ""}`} aria-pressed={filter === null} onClick={() => onPick(null)}>
        All
      </button>
      <button type="button" className={`kuru-node-chip ${filter === self ? "kuru-node-chip-on" : ""}`} aria-pressed={filter === self} onClick={() => onPick(self)} title="This node's Kuru">
        {self}
      </button>
      {peers.map((peer) => {
        const gone = peer.state !== "up";
        const title = gone
          ? `${peer.node.name} ${peer.state === "away" ? "is away" : "is not linked yet"}${peer.lastSeen ? `, last seen ${dayAt(peer.lastSeen)}` : ""}. Its last items are kept here.`
          : peer.talks
            ? `The Kuru on ${peer.node.name}. Start a message with @${peer.node.name} to talk to it.`
            : `The kururu on ${peer.node.name} is too old to talk to; update it there.`;
        return (
          <button
            key={peer.node.id}
            type="button"
            className={`kuru-node-chip ${filter === peer.node.name ? "kuru-node-chip-on" : ""} ${gone ? "kuru-node-chip-away" : ""}`}
            aria-pressed={filter === peer.node.name}
            onClick={() => onPick(peer.node.name)}
            title={title}
            /* The node's own hue, the one its band and chips wear when its
               workspace is on screen, so the two read as one machine. */
            style={hueStyle(peer.node.id)}
          >
            <span className="node-chip-dot" aria-hidden="true" />
            {peer.node.name}
            {peer.unheard > 0 && <span className="kuru-node-count">{peer.unheard}</span>}
          </button>
        );
      })}
    </nav>
  );
}

/** A result opened in the chat: which line, what had to be fetched to show it, and whether that stops short of either end. */
interface Viewing {
  id: string;
  pages: Map<string, KuruItem>;
  older: boolean;
  newer: boolean;
}

/** What the count beside the field says: how many, how many of them only by a typo, and that more may be coming. */
function searchCount(shown: number, leftOut: number, near: number, settled: boolean): string {
  if (!settled) return shown ? `${shown} so far…` : "Searching…";
  if (!shown) return "No matches";
  if (leftOut) return `Best ${shown} of ${(shown + leftOut).toLocaleString()}`;
  const count = `${shown} ${shown === 1 ? "match" : "matches"}`;
  return near ? `${count} · ${near} close` : count;
}

/** A row, and the door on past the end of a result's page when this row is that end. */
function withGap(gap: boolean, later: () => void, loading: boolean, key: string, row: ReactNode): ReactNode {
  if (!gap) return row;
  return (
    <Fragment key={key}>
      {row}
      <li className="kuru-earlier">
        <button className="kuru-head-btn" onClick={later} disabled={loading}>
          {loading ? "Loading…" : "Show later"}
        </button>
      </li>
    </Fragment>
  );
}

/** The query whose words are lit in the list, for every piece of a line however deep it is drawn. */
const HitWords = createContext<KuruQuery | null>(null);

/**
 * Words, with what the search found in them in a `<mark>`. Every leaf of a line
 * goes through this and nothing else: the words reach React as strings, cut by
 * `splitHits` and never parsed, so a message holding a tag or a backtick draws
 * as those characters with the highlight among them, and a path's link and a
 * card's door stay what they are with the highlight inside. Kept per piece by
 * `useMemo`, since the drawer draws again on every message of the socket.
 */
function Lit({ text }: { text: string }) {
  const query = useContext(HitWords);
  const parts = useMemo(() => (query ? splitHits(query, text) : null), [query, text]);
  if (!parts) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        part.hit ? (
          <mark key={i} className={part.hit === "near" ? "kuru-hit kuru-hit-near" : "kuru-hit"}>
            {part.text}
          </mark>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

/** Whose line it is, beside the time, when it is another node's: `omarchy`. */
function NodeTag({ node }: { node: string | null }) {
  return node === null ? null : <span className="kuru-node">{node}</span>;
}

/** A card code in another node's words names that node's board, which is not a door here. */
const noCards: CardOf = () => null;
const noRefs: RefOf = () => null;

/**
 * A line's id in its own conversation: this node's as it is, another
 * node's without the `<node id>/` the merge put in front (`mergeNodes`) —
 * the id that node's Kuru and drawer know it by, and so the one a reply to
 * it carries.
 */
function ownId(item: NodeKuruItem): string {
  return item.node === null ? item.id : item.id.slice(item.id.indexOf("/") + 1);
}

/** What the composer is replying to: the line's reference, whose conversation it is in (null for this node's), and when it was said, for the time the reference is sent with. */
interface Quoting {
  node: string | null;
  at: number;
  ref: ReplyRef;
}

/** Who a quote is from, as the drawer says it: your own lines are yours, and another node's Kuru is that node's. */
function quoteWho(who: string, node: string | null): string {
  if (who === REPLY_ME) return node ? `you, on ${node}` : "you";
  return node && who === "Kuru" ? `Kuru on ${node}` : who;
}

/**
 * The drawer's left edge, as something to take hold of — `FileTree.tsx`'s
 * `Grip` mirrored, because this column grows leftwards too, so its width is
 * measured from the right edge of the box rather than from the left. Shared
 * in spirit with `NeedsDrawer.tsx`'s copy of the same handle: the two drawers
 * never hold the slot at once, and `App.tsx` resizes both from one width.
 */
function Grip({ onResize, onReset }: { onResize: (px: number) => void; onReset: () => void }) {
  const onPointerDown = (event: React.PointerEvent) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const box = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!box) return;
    onResize(box.right - event.clientX);
  };
  const release = (event: React.PointerEvent) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  return (
    <div
      className="kuru-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the drawer"
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={release}
      onDoubleClick={onReset}
    />
  );
}

/**
 * Settings → Voice's "Speak replies", in the header of the conversation it
 * governs. The glyph is the state — the speaker while replies are read aloud,
 * the speaker struck through while they are only on screen — so the button
 * does not also wear the accent ink the Telegram switch wears when on: on is
 * this switch's ordinary position, and a colour worn all the time says
 * nothing. Its name stays the same both ways and `aria-pressed` says which,
 * as a toggle's should. Muting asks the voice client what it is doing at the
 * moment of the click — this page, or the pill when the pill is the mouth —
 * and stops a reply mid-sentence through `dismissVoice`, the ✕ itself, so it
 * lands unheard exactly as it would from there.
 */
function SpeakSwitch({ settings }: { settings: VoiceSettings }) {
  const on = settings.speak;
  return (
    <button
      type="button"
      className="kuru-head-btn kuru-head-icon"
      aria-pressed={on}
      aria-label="Speak the replies"
      title={on ? "Replies are read aloud. Click to mute them (Settings → Voice → Speak replies)" : "Replies are muted. Click to read them aloud (Settings → Voice → Speak replies)"}
      onClick={() => {
        if (on && voiceNow().phase === "speaking") dismissVoice();
        api.setVoice({ ...settings, speak: !on });
      }}
    >
      {on ? <SpeakerIcon /> : <SpeakerOffIcon />}
    </button>
  );
}

/**
 * The Telegram channel's switch, beside the speaker: the same switch as
 * Settings → Channels, here because the drawer is where you notice you are
 * leaving the Mac. Drawn only once the channel is set up — a token and an
 * account — since a switch that can only refuse is not a switch. Its ink
 * says on; a link that is failing says so in the warning ink and the title.
 * The plane alone since 2026-10-18, on the speaker's terms: the words "on"
 * and "off" were the widest thing in the header, the ink already says which,
 * and the title and `aria-pressed` say it in words.
 */
function TelegramSwitch({ status }: { status: TelegramStatus }) {
  const bot = status.bot ? `@${status.bot.username}` : "the bot";
  const title = status.error
    ? `Telegram: ${status.error}`
    : status.enabled
      ? `Kuru listens to Telegram: what you write to ${bot} comes here, and every reply also goes there. Click to turn it off.`
      : `Telegram is off. Click to let ${bot} reach Kuru, and send Kuru's replies there.`;
  return (
    <button
      className={`kuru-head-btn kuru-head-icon ${status.enabled ? (status.error ? "kuru-head-btn-warn" : "kuru-head-btn-on") : ""}`}
      aria-pressed={status.enabled}
      aria-label="Telegram"
      title={title}
      onClick={() => void api.setChannel("telegram", { enabled: !status.enabled }).catch(() => {})}
    >
      <PlaneIcon />
    </button>
  );
}

/**
 * One of your messages. The state is passed beside the item so this page's
 * `saving` can wear the row the server's states do. `node` is whose
 * conversation it is in, for another node's; `to` is the node a message of
 * this one's was addressed to with `@`, on its way there. A reply draws the
 * line it answers as a quote over the words, a door back to that line when
 * `onQuote` found it, and the reference itself — written for Kuru — not at
 * all. A reply the box drew as a quote's chip — the reference and the words
 * quoted after it, which is what quoting a line of the chat writes — is drawn
 * as that chip, the door back to the line, rather than as the line's opening
 * over the whole of the words quoted: what was sent is what was seen. Folded,
 * it is the meta line with the first of its words in it, and the quote is
 * behind the fold with the rest.
 */
function You({
  item,
  state,
  note,
  node = null,
  to = null,
  refOf = noRefs,
  onCard,
  reply = null,
  onQuote = null,
  answerOf = noAnswers,
  onReplyTo = null,
  flash = false,
  folded = false,
  onFold = null,
  pin = null,
}: {
  item: YouItem;
  state: RowState;
  note: string | null;
  node?: string | null;
  to?: string | null;
  refOf?: RefOf;
  onCard?: (workspaceId: string | null, cardId: string) => void;
  reply?: { ref: ReplyRef; text: string } | null;
  onQuote?: (() => void) | null;
  /** The door back to a line of the chat a quote in the words is of, or null when that line is not loaded. */
  answerOf?: AnswerOf;
  /** Reply to this message. Null for a clip still on this page, which has no words to quote. */
  onReplyTo?: (() => void) | null;
  flash?: boolean;
  folded?: boolean;
  /** Fold it to one row, or open it. Null for a message with no words to fold. */
  onFold?: (() => void) | null;
  /** Its pin, or null for a line that cannot take one (`canPin`). */
  pin?: PinProps | null;
}) {
  const word = state === "queued" ? (item.typedAt !== null ? "Sent" : STATE_WORD.queued) : STATE_WORD[state];
  const channel = isChannelKind(item.via) ? item.via : null;
  const inline = reply !== null && item.text !== null && quotesAtFront(item.text);
  const text = reply && !inline ? reply.text : item.text;
  const line = folded && onFold && text ? firstLine(text) : null;
  const words = (shown: string) => <SentWords text={shown} refOf={refOf} onCard={onCard} answerOf={answerOf} />;
  return (
    <li
      className={`kuru-item kuru-you kuru-you-${state} ${line ? "kuru-folded" : ""} ${flash ? "kuru-flash" : ""} ${pin?.pinned ? "kuru-pinned" : ""}`}
      data-item={item.id}
      onClick={line && onFold ? opensOnClick(onFold) : undefined}
    >
      <span className="kuru-meta">
        {line ? <span className="kuru-fold-who">{foldWho("you", node)}</span> : <NodeTag node={node} />}
        {to && <span className="kuru-node" title={`For the Kuru on ${to}`}>→ {to}</span>}
        {item.through && <span className="kuru-via" title={`Written or said at ${item.through}`}>from {item.through}</span>}
        {item.via === "voice" ? (
          <MicIcon />
        ) : channel ? (
          <span className="kuru-via" title={`From ${CHANNEL_NAMES[channel]}`}>
            <PlaneIcon />
            <span>{CHANNEL_NAMES[channel]}</span>
          </span>
        ) : (
          <KeysIcon />
        )}
        <time dateTime={new Date(item.at).toISOString()}>{saidAt(item.at)}</time>
        {item.via === "voice" && item.ms > 0 && <span className="kuru-length">{clipLength(item.ms)}</span>}
        {word && <span className={`kuru-state kuru-state-${state}`}>{word}</span>}
        {line && (
          <FoldLine more={line.more}>
            {words(line.line)}
          </FoldLine>
        )}
        {onReplyTo && item.text && <ReplyButton onReply={onReplyTo} />}
        {onFold && <FoldButton folded={line !== null} onFold={onFold} />}
        {pin && <PinButton {...pin} />}
      </span>
      {!line && reply && !inline && <Quote quote={reply.ref} node={node ?? to} onOpen={onQuote} />}
      {line ? null : text ? (
        <p className="kuru-text">
          {words(text)}
        </p>
      ) : (
        <p className="kuru-text kuru-pending">Not in words yet — the audio is kept.</p>
      )}
      {!line && note && <p className="kuru-note">{note}</p>}
      {!line && state === "failed" && item.outboxId && (
        <span className="kuru-actions">
          <button className="kuru-head-btn" onClick={() => api.resendVoice(item.outboxId!)}>
            {item.text ? "Resend" : "Listen again"}
          </button>
          <button className="kuru-head-btn" onClick={() => api.discardVoice(item.outboxId!)}>
            Discard
          </button>
        </span>
      )}
    </li>
  );
}

/**
 * One of Kuru's replies, with its fate beside it and a door onto every card
 * it names. The speaker is the one control for Play and Stop both: it plays
 * this reply again while idle, and stops whatever is audible — this replay,
 * or Kuru saying it for the first time — while `active`. Folded, the meta
 * line holds its first line, still with every door in it.
 */
function Reply({
  item,
  node,
  marked,
  flash,
  replaying,
  onReplay,
  onReplyTo,
  quoteRef,
  folded,
  onFold,
  cardOf,
  onCard,
  onFile,
  pin = null,
}: {
  item: KuruReply;
  /** Whose Kuru said it, when that is another node's. */
  node: string | null;
  marked: boolean;
  /** A quote of it was just pressed. */
  flash: boolean;
  replaying: boolean;
  onReplay: (item: KuruReply) => void;
  /** Reply to this one: the composer quotes it — and starts `@node ` for another node's Kuru. */
  onReplyTo: () => void;
  /** The reference a quote of its words is written after (`quotable`); null for another node's, which this Kuru cannot find. */
  quoteRef: string | null;
  folded: boolean;
  /** Fold it to one row, or open it. */
  onFold: () => void;
  cardOf: CardOf;
  onCard: (workspaceId: string | null, cardId: string) => void;
  /** A path in the reply was opened. */
  onFile: () => void;
  pin?: PinProps | null;
}) {
  const active = replaying || item.fate === "speaking";
  // Parsed once per reply, not per draw: the drawer draws again on every
  // message of the socket, and a long conversation is hundreds of replies.
  const tree = useMemo(() => (folded ? null : replyTree(item.text)), [folded, item.text]);
  const line = useMemo(() => (folded ? foldInline(item.text) : null), [folded, item.text]);
  const doors = useMemo<MarkdownDoors>(
    () => ({
      leaf: (text) => <ReplyWords text={text} files={item.files} cardOf={cardOf} onCard={onCard} onFile={onFile} />,
      link: (href, label) => {
        const file = fileNamed(item.files, href);
        return file ? <MadeInline file={file} label={label} onOpened={onFile} /> : null;
      },
    }),
    [item.files, cardOf, onCard, onFile],
  );
  return (
    <li
      className={`kuru-item kuru-reply ${item.aside ? "kuru-aside" : ""} ${item.fate ? `kuru-fate-${item.fate}` : ""} ${line ? "kuru-folded" : ""} ${marked ? "kuru-marked" : ""} ${flash ? "kuru-flash" : ""} ${pin?.pinned ? "kuru-pinned" : ""}`}
      data-utterance={item.utterance ?? undefined}
      data-item={item.id}
      onClick={line ? opensOnClick(onFold) : undefined}
    >
      <span className="kuru-meta">
        {item.utterance ? (
          <button
            type="button"
            className={`kuru-speaker ${active ? "kuru-speaker-playing" : ""}`}
            onClick={() => onReplay(item)}
            title={active ? "Stop (Esc)" : "Play again"}
            aria-label={active ? "Stop" : "Play this reply again"}
            aria-pressed={active}
          >
            {active ? <Icon name="stop" /> : <SpeakerIcon />}
          </button>
        ) : (
          <SpeakerIcon />
        )}
        {line ? <span className="kuru-fold-who">{foldWho("kuru", node)}</span> : <NodeTag node={node} />}
        <time dateTime={new Date(item.at).toISOString()}>{saidAt(item.at)}</time>
        {active ? (
          <span className="kuru-state kuru-state-speaking">Speaking</span>
        ) : item.fate === "unheard" ? (
          <span className="kuru-state kuru-state-unheard">Unheard</span>
        ) : null}
        {line && (
          <FoldLine more={line.more}>
            <KuruInline nodes={line.children} doors={doors} />
          </FoldLine>
        )}
        <ReplyButton onReply={onReplyTo} />
        <FoldButton folded={line !== null} onFold={onFold} />
        {pin && <PinButton {...pin} />}
      </span>
      {tree && (
        <div className="kuru-text kuru-md" {...(quoteRef ? quotable(quoteRef, "body", "message") : {})}>
          <KuruMarkdown blocks={tree} doors={doors} />
        </div>
      )}
    </li>
  );
}

/**
 * The file a link's target names, among the ones the server found in the
 * reply: by the words as written (`KuruFile.text` is the target as the
 * reply spelt it), or decoded, since a link has to spell a space `%20`.
 */
function fileNamed(files: KuruReply["files"], href: string): KuruFile | null {
  if (!files?.length) return null;
  let decoded = href;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    // Spelt with a stray `%`: the words as written are the only match.
  }
  return files.find((file) => file.text === href || file.text === decoded) ?? null;
}

/**
 * Kuru's words with their doors in: paths first, each a link when the server
 * found its file, then card codes in the words between — a path such as
 * docs/KUR-12.md is a file, not a card.
 */
function ReplyWords({ text, files, cardOf, onCard, onFile }: { text: string; files: KuruReply["files"]; cardOf: CardOf; onCard: (workspaceId: string | null, cardId: string) => void; onFile: () => void }) {
  return (
    <>
      {(files?.length ? splitMentions(text) : [{ text }]).map((part, i) => {
        if ("mention" in part) {
          const file = files?.find((f) => f.text === part.mention.text);
          if (file) return <MadeInline key={i} file={file} label={<Lit text={part.mention.text} />} onOpened={onFile} />;
        }
        return <CardWords key={i} text={"mention" in part ? part.mention.text : part.text} cardOf={cardOf} onCard={onCard} />;
      })}
    </>
  );
}

/** Who a folded line is from, in words: one row has no room for the side and the ground to say it alone. */
function foldWho(kind: "you" | "kuru", node: string | null): string {
  if (kind === "kuru") return node ? `Kuru on ${node}` : "Kuru";
  return node ? `You, on ${node}` : "You";
}

/** The first of a folded line's words, cut where the bubble ends, and an ellipsis of its own when there is more below a line that fits. */
function FoldLine({ more, children }: { more: boolean; children: ReactNode }) {
  return (
    <span className="kuru-fold-line">
      {children}
      {more && " …"}
    </span>
  );
}

/**
 * A folded line opens wherever it is clicked, except on what is a door of
 * its own — the speaker, the arrows, a card, a file — and except at the end
 * of a drag that was selecting some of its words.
 */
function opensOnClick(open: () => void) {
  return (event: React.MouseEvent) => {
    if (event.target instanceof Element && event.target.closest("button, a")) return;
    if (window.getSelection()?.toString()) return;
    open();
  };
}

/**
 * The fold, beside the reply arrow and on its terms: on hover where there is
 * a pointer, quietly always on a touch screen. The glyph is what a press
 * does — chevrons closing on a line that is open, opening on one that is
 * folded — and the name stays the same both ways, with `aria-pressed` saying
 * which, as the speaker switch's does.
 */
function FoldButton({ folded, onFold }: { folded: boolean; onFold: () => void }) {
  return (
    <button
      type="button"
      className="kuru-fold-btn"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onFold}
      title={folded ? "Unfold this message" : "Fold this message to one row"}
      aria-label="Fold this message to one row"
      aria-pressed={folded}
    >
      <FoldIcon folded={folded} />
    </button>
  );
}

/**
 * Every line folded at once, or every line opened — the lines the list is
 * drawing, narrowed to one node or not, and none it has still to load. It
 * folds while any of them is open, and opens them once none is, and its
 * glyph says which.
 */
function FoldAll({ open, onFold }: { open: boolean; onFold: () => void }) {
  return (
    <button type="button" className="kuru-head-btn kuru-head-icon" onClick={onFold} title={open ? "Fold every message to one row" : "Unfold every message"} aria-label={open ? "Fold every message" : "Unfold every message"}>
      <FoldIcon folded={!open} />
    </button>
  );
}

/** The first line in view in the list, and how far below the list's top it is — what folding them all keeps in place. */
function firstInView(el: HTMLElement): { id: string; top: number } | null {
  const top = el.getBoundingClientRect().top;
  for (const row of el.querySelectorAll<HTMLElement>("[data-item]")) {
    const box = row.getBoundingClientRect();
    if (box.bottom > top && row.dataset.item) return { id: row.dataset.item, top: Math.max(0, box.top - top) };
  }
  return null;
}

/** A line's pin, as the list hands it down: whether it is on, and the press. */
interface PinProps {
  pinned: boolean;
  onPin: () => void;
}

/**
 * The arrow that answers one line: on hover where there is a pointer, and
 * always, quietly, on a touch screen, where nothing hovers. It keeps the
 * keyboard where it was on the way, so the composer can take it.
 */
function ReplyButton({ onReply }: { onReply: () => void }) {
  return (
    <button type="button" className="kuru-reply-btn" onMouseDown={(event) => event.preventDefault()} onClick={onReply} title="Reply to this" aria-label="Reply to this">
      <ReplyIcon />
    </button>
  );
}

/**
 * The line a sent reply answers, over its words: who and when, and the
 * opening the reference quoted. A button back to that line when it is among
 * the lines loaded; only a quote when it is not.
 */
function Quote({ quote, node, onOpen }: { quote: ReplyRef; node: string | null; onOpen: (() => void) | null }) {
  const body = (
    <>
      <span className="kuru-quote-who">
        {quoteWho(quote.who, node)} · {quote.when}
      </span>
      <span className="kuru-quote-text">{quote.quote}</span>
    </>
  );
  return onOpen ? (
    <button type="button" className="kuru-quote" onClick={onOpen} title="Go to the message this answers">
      {body}
    </button>
  ) : (
    <span className="kuru-quote">{body}</span>
  );
}

type CardOf = (code: string) => { workspaceId: string | null; cardId: string } | null;
type RefOf = (ref: CardRef) => { workspaceId: string | null; cardId: string } | null;
type AnswerOf = (ref: ReplyRef) => (() => void) | null;
const noAnswers: AnswerOf = () => null;

/**
 * Whether a message of yours opens with a quote of a line of the chat — the
 * reference and the quote as one chip (`chipsIn`) — after the `@node` that
 * routes it, if any. That is a reply drawn as its chip, not over its words.
 */
function quotesAtFront(text: string): boolean {
  const first = chipsIn(text)[0];
  return first?.answers !== undefined && /^\s*(?:@[\p{L}\p{N}-]+[,:]?\s*)?$/u.test(text.slice(0, first.from));
}

/**
 * Your words as Kuru's box drew them while you wrote them: each run written
 * for Kuru — a card's reference, a quote, a file's reference — as the same
 * chip (`chips.ts`, `ChipField.tsx`), and the rest as words. A card's chip is
 * a door onto the card, and the chip of a quote of a line of the chat a door
 * back to that line, when `answerOf` found it; any other chip opens in place
 * on a press to show all it stands for, as the box's does on a tap. A card
 * that is gone, or another node's, keeps its chip without the door.
 */
function SentWords({ text, refOf, onCard, answerOf }: { text: string; refOf: RefOf; onCard?: (workspaceId: string | null, cardId: string) => void; answerOf: AnswerOf }) {
  const pieces = useMemo(() => piecesOf(text), [text]);
  return (
    <>
      {pieces.map((piece, j) => {
        if ("text" in piece) return <Lit key={j} text={piece.text} />;
        const chip = piece.chip;
        const card = chip.kind === "card" && chip.card && onCard ? refOf(chip.card) : null;
        const door = card ? () => onCard!(card.workspaceId, card.cardId) : chip.answers ? answerOf(chip.answers) : null;
        return <SentChip key={j} chip={chip} door={door} doorTitle={card ? "Open the board at this card" : "Go to the message this answers"} />;
      })}
    </>
  );
}

/** One chip in a sent message, drawn as the box draws it (`chipNode` in `ChipField.tsx`), with its door or its press to open. */
function SentChip({ chip, door, doorTitle }: { chip: Chip; door: (() => void) | null; doorTitle: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className={`kc kc-${chip.kind} ${open ? "kc-open" : ""}`}
      title={door ? `${chip.full}\n${doorTitle}` : chip.full}
      aria-label={`${CHIP_WORD[chip.kind]}: ${chip.full}`}
      aria-expanded={door ? undefined : open}
      onClick={door ?? (() => setOpen((was) => !was))}
    >
      <svg className="kc-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: CHIP_ICONS[chip.kind] }} />
      {chip.kind === "card" && (
        <span className="kc-code">
          <Lit text={chip.source} />
        </span>
      )}
      <span className="kc-label">
        <Lit text={chip.label} />
      </span>
      {chip.kind === "quote" && chip.source && <span className="kc-from">{chip.source}</span>}
      <span className="kc-full">
        <Lit text={chip.full} />
      </span>
    </button>
  );
}

/** Words with every card code in them a door onto the board — one that is not a card stays a word. */
function CardWords({ text, cardOf, onCard }: { text: string; cardOf: CardOf; onCard: (workspaceId: string | null, cardId: string) => void }) {
  return (
    <>
      {splitCardCodes(text).map((bit, j) => {
        if ("text" in bit) return <Lit key={j} text={bit.text} />;
        const card = cardOf(bit.code);
        return card ? (
          <button key={j} className="kuru-card" onClick={() => onCard(card.workspaceId, card.cardId)} title="Open the board at this card">
            <Lit text={bit.code} />
          </button>
        ) : (
          <Lit key={j} text={bit.code} />
        );
      })}
    </>
  );
}

/**
 * Something Kuru was told that neither of you said — kururu's notice that an
 * agent finished or blocked, a background task reporting back — as one quiet
 * line rather than a bubble, since a bubble is a side of the conversation and
 * this is neither. The agent's name is what a narrow drawer cuts short, never
 * what happened to it; a blocked one says so in the blocked ink, because that
 * one may be waiting on you. A tap opens the whole message under the line —
 * the agent's reply, its card a door as it is in a reply — and closes it
 * again; nothing about it is unread or needs clearing, so it keeps no state
 * past this row's.
 */
function Notice({
  item,
  node = null,
  cardOf,
  onCard,
  onReplyTo,
  quoteRef = null,
  flash = false,
  onResult = null,
  pin = null,
}: {
  item: NoticeItem;
  node?: string | null;
  cardOf: CardOf;
  onCard: (workspaceId: string | null, cardId: string) => void;
  onReplyTo: () => void;
  /** The reference a quote of the message's words is written after, as a reply's is. */
  quoteRef?: string | null;
  flash?: boolean;
  /** It is a search's result, and a press on the line opens it in the chat rather than opening the message under it. */
  onResult?: (() => void) | null;
  pin?: PinProps | null;
}) {
  const [opened, setOpen] = useState(false);
  const query = useContext(HitWords);
  // What the search found may be behind the tap, and a result that does not
  // show why it is one is no use: so the message stands open while it is lit.
  const lit = useMemo(() => query !== null && splitHits(query, item.text).some((part) => part.hit), [query, item.text]);
  const open = opened || lit;
  const agent = item.agent;
  // Another node's notice about its agents crosses without the reply it
  // quoted (`peerItems`), so there is nothing behind a tap.
  const more = item.text.trim().length > 0;
  // An agent's reply relayed as a notice is Markdown as a reply of Kuru's is;
  // the server finds no files in it, so a path in it is words and a card
  // code the one door.
  const tree = useMemo(() => (open && more ? replyTree(item.text) : null), [open, more, item.text]);
  const doors = useMemo<MarkdownDoors>(() => ({ leaf: (text) => <CardWords text={text} cardOf={cardOf} onCard={onCard} />, link: () => null }), [cardOf, onCard]);
  return (
    <li className={`kuru-notice ${item.event === "blocked" ? "kuru-notice-blocked" : ""} ${flash ? "kuru-flash" : ""} ${pin?.pinned ? "kuru-pinned" : ""}`} data-item={item.id}>
      {/* The arrow beside the line rather than in it, since the line is a
          button already, and a button in a button is neither. */}
      <span className="kuru-notice-row">
        <button
          type="button"
          className="kuru-notice-line"
          aria-expanded={more ? open : undefined}
          disabled={!more && !onResult}
          onClick={onResult ?? (() => setOpen((was) => !was))}
          title={onResult ? "Show this in the chat" : more ? (open ? "Hide the message" : "Show the whole message") : undefined}
        >
          {more && <Icon name="caret" />}
          <NodeTag node={node} />
          <span className="kuru-notice-from">
            <Lit text={item.from} />
          </span>
          <span aria-hidden="true">·</span>
          {agent && (
            <span className="kuru-notice-cut">
              <Lit text={agent.name ? `"${agent.name}"` : agent.program} />
            </span>
          )}
          {agent?.workspace && (
            <span className="kuru-notice-where">
              in <Lit text={agent.workspace} />
            </span>
          )}
          <span className={`kuru-notice-what ${agent ? "" : "kuru-notice-cut"}`}>
            <Lit text={item.what} />
          </span>
          <time dateTime={new Date(item.at).toISOString()}>{saidAt(item.at)}</time>
        </button>
        <ReplyButton onReply={onReplyTo} />
        {pin && <PinButton {...pin} />}
      </span>
      {tree && (
        <div className="kuru-notice-text kuru-md" {...(quoteRef ? quotable(quoteRef, "body", "message") : {})}>
          <KuruMarkdown blocks={tree} doors={doors} />
        </div>
      )}
    </li>
  );
}

/** Where a draft not yet sent waits out a closed drawer, one profile at a time. */
const DRAFT_KEY = "kururu.kuru.draft:";

/**
 * Where the cursor was in each profile's draft when the box last had it —
 * where a card's reference goes once the box has lost the keyboard to the
 * card's menu, or gone with a closed drawer. This page's only, and not kept
 * past it: a reload puts a reference at the end, which is where the cursor
 * of a draft nobody has clicked into would be anyway.
 */
const carets = new Map<string, { from: number; to: number }>();

function readDraft(profileId: string): string {
  try {
    return localStorage.getItem(DRAFT_KEY + profileId) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(profileId: string, text: string) {
  try {
    if (text) localStorage.setItem(DRAFT_KEY + profileId, text);
    else localStorage.removeItem(DRAFT_KEY + profileId);
  } catch {
    // Not remembered past this window; the draft still sends.
  }
}

/** Where what a draft replies to waits beside it, on the draft's terms: a reply half-written is still a reply after a reload. */
const QUOTING_KEY = "kururu.kuru.reply:";

function readQuoting(profileId: string): Quoting | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(QUOTING_KEY + profileId) ?? "null");
    const q = raw as Partial<Quoting> | null;
    const ref = q?.ref as Partial<ReplyRef> | undefined;
    if (!q || !ref || typeof q.at !== "number" || !Number.isFinite(q.at) || (q.node !== null && typeof q.node !== "string")) return null;
    if (typeof ref.who !== "string" || typeof ref.when !== "string" || typeof ref.quote !== "string" || (ref.id !== null && typeof ref.id !== "string")) return null;
    return { node: q.node, at: q.at, ref: { who: ref.who, when: ref.when, quote: ref.quote, id: ref.id } };
  } catch {
    return null;
  }
}

function writeQuoting(profileId: string, quoting: Quoting | null) {
  try {
    if (quoting) localStorage.setItem(QUOTING_KEY + profileId, JSON.stringify(quoting));
    else localStorage.removeItem(QUOTING_KEY + profileId);
  } catch {
    // Not remembered past this window; the reply still sends.
  }
}

/**
 * The paths a drop or a paste put into each profile's draft, which the box
 * draws as files (`chips.ts`) — remembered beside the draft for the draft's
 * reason, and only these: a path typed out is words.
 */
const FILES_KEY = "kururu.kuru.files:";

function readFiles(profileId: string): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(FILES_KEY + profileId) ?? "[]");
    return Array.isArray(raw) ? raw.filter((path): path is string => typeof path === "string" && path.length > 0).slice(0, 200) : [];
  } catch {
    return [];
  }
}

function writeFiles(profileId: string, files: readonly string[]) {
  try {
    if (files.length) localStorage.setItem(FILES_KEY + profileId, JSON.stringify(files));
    else localStorage.removeItem(FILES_KEY + profileId);
  } catch {
    // Not remembered past this window; the paths still send, drawn as words.
  }
}

/**
 * Typing to Kuru. Enter sends and Shift+Enter is a new line, as every chat
 * box has agreed; Escape gives the keyboard back to the panes. There is no
 * send button, because Enter is one on every keyboard this box is typed on,
 * the phone's included. The mic is inside the box, at its foot: held, it
 * records, and tapped, it toggles. What is typed
 * and not yet sent survives closing the drawer and reloading the page — a
 * thought half-written must not vanish because the drawer did — and the field
 * grows with it up to `.chip-field`'s `max-height`, so writing more than one
 * line does not hide the lines above it.
 *
 * An `@` at the front offers the other nodes' names as it is typed, and a
 * name that will route is drawn bold — off `typedAddress`, the grammar the
 * server routes on, so the bold cannot promise a route the server will not
 * take.
 *
 * The box is `ChipField`, not a textarea, since 2026-11-02: a card's
 * reference, a quote and a dropped file are text written for Kuru, and the
 * box draws each as a chip while keeping that text, to the character, as
 * what is sent (`chips.ts`). A contenteditable was rejected here once, for
 * one word's bold, because it gives up what a textarea does for free; chips
 * are what a textarea cannot draw at all, and `ChipField` takes those things
 * back by hand.
 *
 * A file dropped on the box puts its path in at the cursor, escaped as a
 * terminal writes it, unsent — Claude Code's own box does the same, and the
 * role tells Kuru a path is a file to Read. A picture pasted from the
 * clipboard has no path, nor has anything from a phone or from a window on
 * another node's server, so those go to the server first and the path of its
 * copy goes in when it is kept (`handover`, `shared/drops.ts`). A paste that
 * also carries words — a cell copied out of Numbers comes with a picture of
 * itself — is left to paste the words.
 *
 * A reply is a bar over the box — whose line, and its opening, and ✕ — and
 * not words in it, where it would be a bracket of ids to type around. It is
 * put in front of the words as they are sent (`withReply`), after an
 * `@node`, which the server reads only at the very front. A reply is to one
 * conversation's line, so a message whose address no longer goes there —
 * `@omarchy` taken off a reply to Omarchy's Kuru, or put on one to this
 * node's — goes without it, and the bar says so before Enter does it.
 * Escape takes the reply away first, as it does the names, and a second
 * Escape gives the keyboard back. A clip said while it is up goes as a
 * clip always has: the reference is the typed message's.
 */
function Composer({
  profileId,
  onEditing,
  peers,
  replyAsk,
}: {
  profileId: string;
  onEditing: (editing: boolean) => void;
  /** The other nodes' Kurus, which `@name` at the start of a message is for. */
  peers: PeerKuru[];
  /** A line's reply arrow: quote it, address its node, and take the keyboard. */
  replyAsk: { quoting: Quoting; n: number } | null;
}) {
  const [text, setText] = useState(() => readDraft(profileId));
  const [caret, setCaret] = useState<number | null>(null);
  /** The suggestions moved through with the arrows, and the draft Escape closed them on — they open again once it changes. */
  const [chosen, setChosen] = useState(0);
  const [closedOn, setClosedOn] = useState<string | null>(null);
  const field = useRef<ChipFieldHandle>(null);
  /** A file held over the box. */
  const [over, setOver] = useState(false);
  /** How many dropped or pasted files are on their way to the server, and why the last one was not taken. */
  const [handing, setHanding] = useState<{ waiting: number; refused: string | null }>({ waiting: 0, refused: null });
  /** Whose box this is now, for a copy kept after the drawer moved to another profile's. */
  const shown = useRef(profileId);
  shown.current = profileId;
  const [quoting, setQuoting] = useState<Quoting | null>(() => readQuoting(profileId));
  const [files, setFiles] = useState<string[]>(() => readFiles(profileId));
  useEffect(() => {
    setText(readDraft(profileId));
    setQuoting(readQuoting(profileId));
    setFiles(readFiles(profileId));
  }, [profileId]);
  /**
   * Paths the box put in, drawn as files. Kept until the draft is sent, and
   * not forgotten when one is deleted, so an undo that puts it back puts back
   * the chip; the ones gone from the draft are let go only as new ones come.
   */
  const keepFiles = (draft: string, add: readonly string[]) => {
    setFiles((was) => {
      const next = filesStillIn(draft, [...was, ...add.filter((path) => !was.includes(path))]);
      writeFiles(profileId, next);
      return next;
    });
  };
  const quote = (next: Quoting | null) => {
    setQuoting(next);
    writeQuoting(profileId, next);
  };
  const names = peers.map((peer) => peer.node.name);
  useEffect(() => {
    if (!replyAsk) return;
    quote(replyAsk.quoting);
    const node = replyAsk.quoting.node;
    // Whatever was already being written stays, addressed to where the line
    // is: another node's line puts `@node` in front, this node's takes off
    // an address to another, which would carry the reply away from it.
    setText((was) => {
      const at = typedAddress(was, names);
      const rest = at ? was.slice(at.to).replace(/^[,:]?\s*/, "") : was;
      const next = node ? `@${node} ${rest}` : rest;
      writeDraft(profileId, next);
      return next;
    });
    const el = field.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
    }
    // Only a new ask, not a re-render, moves the cursor.
  }, [replyAsk?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const address = typedAddress(text, names);
  const toPeer = address ? peers.find((peer) => peer.node.name === address.node) : undefined;
  const query = caret === null || closedOn === text ? null : addressQuery(text, caret);
  const offered = query ? addressMatches(query.query, names) : [];
  const open = offered.length > 0;
  const active = Math.min(chosen, offered.length - 1);
  const edit = (next: string) => {
    setText(next);
    writeDraft(profileId, next);
  };
  const pick = (node: string) => {
    if (!query) return;
    const picked = pickAddress(text, query, node);
    edit(picked.text);
    setCaret(picked.caret);
    const el = field.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(picked.caret, picked.caret));
    }
  };
  /** Whether the reply still goes where its line is: a reply to one conversation's line means nothing in another's. */
  const quoteGoes = quoting !== null && quoting.node === (address?.node ?? null);
  const send = () => {
    const words = text.trim();
    // An address and nothing after it goes nowhere: the server would hand
    // `@omarchy` to this Kuru as words, which is not what the bold promised.
    if (!words || (address && !address.rest)) return;
    if (quoting && quoteGoes) {
      const to = typedAddress(words, names);
      const reference = replyReference({ ...quoting.ref, when: replyClock(quoting.at, Date.now()) });
      api.kuruSay(profileId, withReply(words, reference, to ? to.to : null));
    } else {
      api.kuruSay(profileId, words);
    }
    edit("");
    carets.delete(profileId);
    if (quoting) quote(null);
    setFiles([]);
    writeFiles(profileId, []);
  };
  // Told once each way, and told off on unmount: a drawer closed with the
  // cursor still in the box must not leave the prefix believing a field has
  // the keyboard.
  useEffect(() => () => onEditing(false), [onEditing]);
  /**
   * Words put in from outside — a card's reference, off its menu — at the
   * cursor, unsent, with the keyboard back in the box to go on typing. Taken
   * off the drawer's state as they go in, so the drawer closed and opened
   * again does not put them in twice; `took` is the same promise against
   * React running an effect twice in development.
   */
  const { words } = useKuruDrawer();
  const took = useRef(0);
  const putIn = (words: string, line = false, paths: readonly string[] = []) => {
    const el = field.current;
    const was = el?.value ?? readDraft(profileId);
    const at = el?.focused ? { from: el.selectionStart, to: el.selectionEnd } : (carets.get(profileId) ?? { from: was.length, to: was.length });
    const put = (line ? insertLine : insertWords)(was, at.from, at.to, words);
    if (paths.length) keepFiles(put.text, paths);
    edit(put.text);
    carets.set(profileId, { from: put.caret, to: put.caret });
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(put.caret, put.caret));
    }
  };
  useEffect(() => {
    if (!words || took.current === words.n) return;
    took.current = words.n;
    takeKuruWords(words.n);
    putIn(words.text, words.line);
    // Only new words, not a re-render, touch the draft.
  }, [words?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  /**
   * What a drop or a paste handed over, into the draft in the order given:
   * the paths at once, and a file to be sent once its copy is kept, at the
   * cursor as it is by then — the hands went on typing meanwhile. A refusal
   * is said over the box, the first one with a count of the rest. A copy
   * kept after the drawer moved to another profile goes on the end of the
   * draft it was dropped into.
   */
  const take = (items: ({ path: string } | { file: File })[]) => {
    if (items.length === 0) return;
    const refused: string[] = [];
    const sends = items.map((item) => {
      if ("path" in item) return item.path;
      const why = dropRefusal(item.file);
      if (why) {
        refused.push(why);
        return null;
      }
      return api.sendDrop(item.file).catch((err: unknown) => {
        refused.push(`${item.file.name || "That file"} was not kept: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
    });
    const waiting = sends.filter((send) => send instanceof Promise).length;
    const said = () => (refused.length > 1 ? `${refused[0]} (and ${refused.length - 1} more)` : (refused[0] ?? null));
    const finish = (paths: (string | null)[]) => {
      const escaped = paths.filter((path): path is string => !!path).map(escapePath);
      const words = escaped.join(" ");
      if (!words) return;
      if (shown.current === profileId) putIn(words, false, escaped);
      else {
        const was = readDraft(profileId);
        const next = insertWords(was, was.length, was.length, words).text;
        writeDraft(profileId, next);
        writeFiles(profileId, filesStillIn(next, [...readFiles(profileId), ...escaped]));
      }
    };
    if (waiting === 0) {
      setHanding((was) => ({ waiting: was.waiting, refused: said() }));
      finish(sends as (string | null)[]);
      return;
    }
    setHanding((was) => ({ waiting: was.waiting + waiting, refused: null }));
    void Promise.all(sends).then((paths) => {
      setHanding((was) => ({ waiting: was.waiting - waiting, refused: said() }));
      finish(paths);
    });
  };
  /**
   * The mic is a pen, not the talk key: what is said goes into the box at the
   * cursor, after the cards, quotes and pictures already in it, and nothing is
   * sent — the send is yours, as it is after a quote. Held, it listens until
   * the release; tapped, until it is pressed again or Escape (`voice.ts`
   * keeps the words either way). The release is caught on the window, since a
   * finger slides off a button it holds, and a tap is told from a hold by the
   * two events' own stamps, not the clock when each is handled: opening the
   * microphone can hold the page for a few hundred milliseconds, and a tap
   * whose release waited behind it measured as a hold, ended on the spot and
   * was too short to hear. `dictatingFor` is whose box the words
   * are for, so words heard after the drawer moved to another profile go on
   * the end of the draft they were said into, as a dropped file's do.
   */
  const dictation = useDictation();
  const dictatingFor = useRef<string | null>(null);
  /** Why the last dictation put nothing in, said over the box until the next press or keystroke. */
  const [unheard, setUnheard] = useState<string | null>(null);
  const putInNow = useRef(putIn);
  putInNow.current = putIn;
  const said = dictatingFor.current !== null ? dictation.phase : "idle";
  const speak = (pressed: number) => {
    if (dictatingFor.current !== null) {
      // The second press of a tapped dictation; one already being heard has nothing left to stop.
      dictateStop();
      return;
    }
    setUnheard(null);
    const forProfile = profileId;
    dictatingFor.current = forProfile;
    const up = (event: PointerEvent) => {
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      if (event.timeStamp - pressed < TAP_MS) dictateToggled();
      else dictateStop();
    };
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    void dictate().then((outcome) => {
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      if (dictatingFor.current !== forProfile) return;
      dictatingFor.current = null;
      if (!outcome.ok) {
        if (outcome.why) setUnheard(outcome.why);
        return;
      }
      if (field.current && shown.current === forProfile) putInNow.current(outcome.text);
      else {
        const was = readDraft(forProfile);
        writeDraft(forProfile, insertWords(was, was.length, was.length, outcome.text).text);
      }
    });
  };
  // The drawer closed while it listened: what was said is still heard, and
  // kept in the draft, rather than a microphone left open with nothing to stop it.
  useEffect(
    () => () => {
      if (dictatingFor.current !== null) dictateStop();
    },
    [],
  );
  return (
    <form
      className="kuru-composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
      // The whole composer takes the drop, so a file let go a little above
      // the box is not a miss; `App.tsx` swallows the misses anyway.
      onDragOver={(event) => {
        if (!isFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOver(false);
      }}
      onDrop={(event) => {
        if (!isFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        take(handoverFrom(event.dataTransfer, isLoopback(window.location.hostname)));
      }}
    >
      {(handing.waiting > 0 || handing.refused) && (
        <p
          className={`kuru-handing ${handing.waiting > 0 ? "" : "kuru-handing-refused"}`}
          role="status"
          onClick={() => setHanding((was) => ({ ...was, refused: null }))}
        >
          {handing.waiting > 0 ? `Keeping ${handing.waiting === 1 ? "a file" : `${handing.waiting} files`} for Kuru…` : handing.refused}
        </p>
      )}
      {(said !== "idle" || unheard) && (
        <p className={`kuru-handing ${said === "idle" ? "kuru-handing-refused" : "kuru-dictating"}`} role="status" onClick={() => setUnheard(null)}>
          {said === "listening"
            ? "Listening… press the mic again, or Esc, to put it in the box."
            : said === "hearing"
              ? "Hearing…"
              : `${unheard} Hold or tap the mic to try again.`}
        </p>
      )}
      {toPeer && (
        <p className="kuru-to" role="status">
          To the Kuru on {toPeer.node.name}
          {toPeer.state !== "up" ? " — away; it goes when it is back" : !toPeer.talks ? " — its kururu is too old to take it" : ""}
        </p>
      )}
      {quoting && (
        <div className={`kuru-quoting ${quoteGoes ? "" : "kuru-quoting-off"}`} role="status">
          <ReplyIcon />
          <span className="kuru-quoting-what">
            <span className="kuru-quote-who">Replying to {quoteWho(quoting.ref.who, quoting.node)}</span>
            <span className="kuru-quote-text">{quoteGoes ? quoting.ref.quote : `left off: this message is for ${address ? `the Kuru on ${address.node}` : "the Kuru here"}`}</span>
          </span>
          <button
            type="button"
            className="kuru-quoting-cancel"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => quote(null)}
            title="Cancel the reply (Esc)"
            aria-label="Cancel the reply"
          >
            <Icon name="close" />
          </button>
        </div>
      )}
      {open && (
        <ul className="kuru-suggest" id={`kuru-suggest-${profileId}`} role="listbox" aria-label="Nodes">
          {offered.map((name, i) => {
            const peer = peers.find((p) => p.node.name === name);
            return (
              <li
                key={name}
                id={`kuru-suggest-${profileId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`menu-item kuru-suggest-item ${i === active ? "kuru-suggest-on" : ""}`}
                // The field keeps the keyboard: a tap that took the focus
                // would close the phone's keyboard under the pick.
                onPointerDown={(event) => event.preventDefault()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(name)}
              >
                <span className="menu-label">@{name}</span>
                {peer && peer.state !== "up" ? <span className="menu-hint">away</span> : peer && !peer.talks ? <span className="menu-hint">too old</span> : null}
              </li>
            );
          })}
        </ul>
      )}
      <div className={`kuru-box ${over ? "kuru-box-drop" : ""}`}>
        <div className="kuru-write">
          <ChipField
            ref={field}
            className="kuru-field"
            value={text}
            files={files}
            bold={address ? { from: address.from, to: address.to } : null}
            placeholder={peers.length ? `Say something to Kuru, or @${peers[0]!.node.name} …` : "Say something to Kuru"}
            ariaLabel="A message for Kuru"
            ariaExpanded={open}
            ariaControls={open ? `kuru-suggest-${profileId}` : undefined}
            ariaActiveDescendant={open ? `kuru-suggest-${profileId}-${active}` : undefined}
            onChange={(next, at) => {
              edit(next);
              setCaret(at);
              setChosen(0);
              if (handing.refused) setHanding((was) => ({ ...was, refused: null }));
              if (unheard) setUnheard(null);
            }}
            onPaste={(event) => {
              if (event.clipboardData.files.length === 0) return;
              const items = handoverFrom(event.clipboardData, isLoopback(window.location.hostname));
              if (items.some((item) => "file" in item) && event.clipboardData.getData("text/plain")) return;
              event.preventDefault();
              take(items);
            }}
            onCaret={(from, to) => {
              setCaret(from);
              carets.set(profileId, { from, to });
            }}
            onEnter={send}
            onFocus={() => onEditing(true)}
            onBlur={() => {
              onEditing(false);
              setCaret(null);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                setChosen((active + (event.key === "ArrowDown" ? 1 : offered.length - 1)) % offered.length);
              } else if (open && (event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
                event.preventDefault();
                pick(offered[active]!);
              } else if (open && event.key === "Escape") {
                // Only the list: a second Escape gives the keyboard back.
                event.preventDefault();
                event.stopPropagation();
                setClosedOn(text);
              } else if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              } else if (event.key === "Escape" && quoting) {
                // Only the reply, as only the list above: a second Escape gives the keyboard back.
                event.preventDefault();
                event.stopPropagation();
                quote(null);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                field.current?.blur();
              }
            }}
          />
        </div>
        <button
          type="button"
          className={`kuru-mic ${said === "listening" ? "kuru-mic-listening" : said === "hearing" ? "kuru-mic-hearing" : ""}`}
          style={{ "--mic-level": said === "listening" ? dictation.level : 0 } as CSSProperties}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            // The field keeps the keys and the cursor the words go in at.
            event.preventDefault();
            speak(event.timeStamp);
          }}
          onMouseDown={(event) => event.preventDefault()}
          onContextMenu={(event) => event.preventDefault()}
          title={said === "listening" ? "Put what you said in the box (Esc)" : "Dictate into the box — hold, or tap to start and again to stop. Nothing is sent"}
          aria-label={said === "listening" ? "Stop dictating" : "Dictate into the box"}
          aria-pressed={said === "listening"}
        >
          <MicIcon />
        </button>
      </div>
    </form>
  );
}

/** The time a thing was said: the clock today, and the day before that. */
function saidAt(at: number): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return when.toDateString() === new Date().toDateString() ? time : `${when.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function dayAt(at: number): string {
  return new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * A keyboard, for a message that was typed rather than spoken — the pair of
 * the mic, drawn here for `VoiceIcons.tsx`'s reason: a picture of a physical
 * object that means the same thing in any chrome.
 */
function KeysIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
    </svg>
  );
}

/** Two chevrons opening away from a line, to unfold it, or closing on it, to fold it — drawn here for `KeysIcon`'s reason. */
function FoldIcon({ folded }: { folded: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={folded ? "m7 15 5 5 5-5M7 9l5-5 5 5" : "m7 20 5-5 5 5M7 4l5 5 5-5"} />
    </svg>
  );
}

/** A magnifier, for the search — drawn here for `KeysIcon`'s reason. */
function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </svg>
  );
}

/** An arrow turning back, for answering one line — drawn here for `KeysIcon`'s reason. */
function ReplyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}
