/**
 * Whether the Kuru drawer is open, and what it was opened to show.
 *
 * Module state rather than a flag in `App`, for the reason the voice's state
 * is: more than one thing opens the drawer, and not all of them are in the
 * tree under `App`. The chip in the status bar is; so is the harness key. The
 * pill is drawn by `App` too, but the floating pill is a page of its own
 * whose click arrives through the desktop bridge as an event, and a card's
 * robot or a notification may one day want the same door. One function,
 * `openKuru`, is what all of them call, and `App` subscribes to the answer —
 * so a new door is one call and never a prop threaded through five layers.
 *
 * View state and nothing else: which drawer is open is this window's, the way
 * the sidebar's width is, and a phone must not be shown a drawer because the
 * desktop opened one.
 *
 * One drawer at a time, both directions: opening this one closes the needs
 * drawer the way opening that one closes this, since both now push the stage
 * aside and a second one left open behind the first would double the squeeze
 * rather than just losing a click to it.
 */
import { useSyncExternalStore } from "react";
import { cardCode } from "../../shared/board";
import { cardPlace, cardReference, quoteReference, type CardQuote, type CardRef, type KuruConversation } from "../../shared/kuru";
import type { AgentSnapshot, Profile } from "../../shared/model";
import type { ReplyRef } from "../../shared/reply";
import type { MenuItem } from "./components/Menu";
import { desktop, type FloatState } from "./desktop";
import { floatNow, followFloat } from "./float";
import { closeNeeds } from "./needs";
import { locateCard } from "./notes";

/**
 * What Kuru is doing now, in one word, for the chip and the drawer's live
 * row — the two places that draw it, which must not disagree.
 *
 * `off` is no session running; `thinking` is its turn under way; `asking` is
 * a prompt in its terminal that is the user's to answer; `speaking` is a
 * reply being said on some client; `quiet` is between turns, which is nothing
 * to say. Speaking wins over thinking, since a line said mid-turn is the
 * louder of the two facts.
 */
export type KuruLive = "off" | "quiet" | "thinking" | "asking" | "speaking";

export function kuruLive(profile: Profile, agents: readonly AgentSnapshot[], conversation: KuruConversation | null, speakingHere: boolean): KuruLive {
  const id = profile.harness?.agentId;
  const agent = id ? agents.find((a) => a.id === id) : undefined;
  if (!agent || agent.exited) return "off";
  // Said here, or — when another page is the mouth — said anywhere, which
  // the server knows by the reply still being held.
  if (speakingHere || conversation?.items.some((item) => item.kind === "kuru" && item.fate === "speaking")) return "speaking";
  if (agent.status === "working") return "thinking";
  if (agent.status === "blocked") return "asking";
  return "quiet";
}

/**
 * Whether Kuru's turn is under way, whatever else is true — the drawer's
 * Stop is for exactly this. Not `kuruLive(…) === "thinking"`, because a line
 * Kuru says mid-turn through `say` makes that word `speaking`, and the turn
 * it is said in can still want stopping.
 */
export function kuruWorking(profile: Profile, agents: readonly AgentSnapshot[]): boolean {
  const id = profile.harness?.agentId;
  const agent = id ? agents.find((a) => a.id === id) : undefined;
  return agent !== undefined && !agent.exited && agent.status === "working";
}

export interface KuruDrawerState {
  open: boolean;
  /**
   * An item the drawer should scroll to and mark when it opens — the
   * utterance of the reply the pill was showing — and a counter so the same
   * reply asked for twice scrolls twice. Null is the bottom, which is the
   * newest.
   */
  focus: string | null;
  asked: number;
  /**
   * Words waiting to go into the composer at its cursor — a card's
   * reference, from its menu — and a counter so the same card twice is two
   * insertions. The composer takes them (`takeKuruWords`) as it puts them in,
   * so a drawer closed and opened again does not put them in twice, and they
   * wait here when the drawer was closed, for the composer it mounts.
   */
  words: (KuruGift & { n: number }) | null;
  /** The search was asked for from the keyboard: the drawer opens it and takes this down. */
  search: boolean;
}

let state: KuruDrawerState = { open: false, focus: null, asked: 0, words: null, search: false };
let wordsAsked = 0;
const listeners = new Set<() => void>();

function set(next: KuruDrawerState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function useKuruDrawer(): KuruDrawerState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** The drawer's state at the moment, for a caller that is not a component. */
export function kuruDrawerNow(): KuruDrawerState {
  return state;
}

/** Open the drawer, at a reply when one is named, at the newest otherwise. */
export function openKuru(focus: string | null = null): void {
  // Both drawers push the stage now, so one left open behind the other
  // would double the squeeze rather than just losing a click to it.
  closeNeeds();
  set({ open: true, focus, asked: state.asked + 1, words: state.words, search: state.search });
}

export function closeKuru(): void {
  if (state.open) set({ open: false, focus: null, asked: state.asked, words: state.words, search: false });
}

/** Open the drawer if it is shut, and put the keyboard in its search. Open already, the list stays where it was being read. */
export function searchInKuru(): void {
  closeNeeds();
  set(state.open ? { ...state, search: true } : { ...state, open: true, focus: null, asked: state.asked + 1, search: true });
}

/** The drawer has opened its search. */
export function takeKuruSearch(): void {
  if (state.search) set({ ...state, search: false });
}

/**
 * What Escape does to a search that is up — or to the filter's panel, which
 * goes before it — for the window's key handler, which is above the drawer
 * and otherwise closes it. Registered by the drawer while it is mounted; it
 * answers whether there was something to leave, so that the first Escape
 * takes that away and the next the drawer.
 */
let searchExit: (() => boolean) | null = null;

export function setKuruSearchExit(exit: (() => boolean) | null): void {
  searchExit = exit;
}

export function leaveKuruSearch(): boolean {
  return searchExit?.() ?? false;
}

/**
 * What the composer is replying to: the line's reference, whose conversation
 * it is in (null for this node's), and when it was said, for the time the
 * reference is sent with. The drawer's, and here because a reply arrow is
 * one of the hand-offs below and may land in another page's box.
 */
export interface KuruQuoting {
  node: string | null;
  at: number;
  ref: ReplyRef;
}

/**
 * Something handed to Kuru's box, unsent: words at the cursor (`line` for a
 * line of their own, which is how a quote and its comment, or a pen's
 * marks, stack up as one message's lines), the paths among them that a drop
 * or a paste put there and the box draws as files, or a line of the
 * conversation to reply to. Plain data, since it may cross to another page.
 */
export interface KuruGift {
  text: string;
  line?: boolean;
  paths?: string[];
  reply?: KuruQuoting;
  /**
   * The caret to the very end of the draft afterwards, and the box scrolled
   * there, rather than just after what went in: a picture, a dictation or
   * the pen's marks are what the user goes on to write about (the owner,
   * 2026-11-13: "as soon as I draw, add or say something I'm gonna want to
   * put a comment or something after").
   */
  end?: boolean;
}

/**
 * When this page's box was last pressed or typed in — the one fact
 * `kuruTarget` needs from the window that the main process cannot know. Not
 * when it last took the focus: a window brought forward gives the focus back
 * to the box it was in, and a click on the window to reach a card's menu
 * would count as writing in its drawer.
 */
let boxAt = 0;

export function kuruBoxUsed(): void {
  boxAt = Date.now();
}

/**
 * Which of the two boxes a hand-off goes into: this page's drawer, or the
 * floating Kuru's chat (`desktop/float.js`), which is the same drawer in a
 * window of its own over every application.
 *
 * The chat whenever it is open (the owner, 2026-11-11: "When the floating
 * Kuru window is open, everything that hands something to Kuru should land
 * there"), with one exception: the window's own drawer is open too and its
 * box had the keyboard after the chat did, which is somebody writing there
 * — and the chat's focus time is the main process's (`chatAt`), on the same
 * clock as this page's. Here, always, in the chat's own page (it is the
 * chat), in a browser or on the phone (there is no chat), and in an app from
 * before the chat could be handed anything (`give` missing), which keeps
 * everything as it was when the floating Kuru is shut.
 */
export function kuruTarget(): "here" | "float" {
  return pickKuruTarget(floatNow(), Boolean(desktop()?.float?.give), state.open, boxAt);
}

/** `kuruTarget`'s rule on what it read, pure: the main process's word on the chat, whether this bridge can give, and this drawer's. */
export function pickKuruTarget(float: FloatState | null, canGive: boolean, drawerOpen: boolean, boxUsedAt: number): "here" | "float" {
  if (!float || !float.on || !float.open || !float.give || !canGive || float.role === "panel") return "here";
  if (drawerOpen && boxUsedAt > (float.chatAt ?? 0)) return "here";
  return "float";
}

/**
 * The one door every hand-off to Kuru goes through: a card's "Reference in
 * Kuru", a quote of a card, a file or a line, a reader's file, a note's
 * reference, the pen's marks, a dropped or pasted file and a reply arrow.
 * It picks the box (`kuruTarget`) and puts the gift there — into this
 * page's drawer, opened if it was shut, or across to the chat, which the
 * main process brings forward with the keyboard in its box. Nothing calls
 * the drawer's box directly for any of these, so a new hand-off is one call
 * and lands wherever the others do. Says which box it chose.
 *
 * There is only one draft either way: both boxes keep it in the same
 * `localStorage` entry (the pages share an origin) and each follows the
 * other's writes (`KuruDrawer`'s composer), so what was half-typed in one is
 * in the other and the gift is put in after it, never over it.
 */
export function handToKuru(gift: KuruGift): "here" | "float" {
  if (kuruTarget() === "float") {
    desktop()?.float?.give?.(gift);
    return "float";
  }
  takeGift(gift);
  return "here";
}

/**
 * A gift put into this page's own drawer whatever the target: `handToKuru`'s
 * own half, and what the chat's page does with one the main process brings
 * it — which has been decided already, and must not be sent on again.
 */
export function takeGift(gift: KuruGift): void {
  closeNeeds();
  const words = { ...gift, n: ++wordsAsked };
  // Open already, the list stays where it was being read: only the box changes.
  set(state.open ? { ...state, words } : { open: true, focus: null, asked: state.asked + 1, words, search: state.search });
}

/**
 * Gifts from the main process, for as long as the page lives: the chat's
 * page gets what the window handed over, and a page whose gift found no
 * chat to take it (shut a moment before) gets its own back. Adopted as
 * another process's word: only the shapes a gift can have.
 */
export function listenForGifts(): () => void {
  // `kuruTarget` reads the main process's word on the chat, which a page hears only once something asks for it.
  followFloat();
  const bridge = desktop()?.float;
  if (!bridge?.onGift) return () => {};
  return bridge.onGift((raw) => {
    const gift = adoptGift(raw);
    if (gift) takeGift(gift);
  });
}

export function adoptGift(raw: unknown): KuruGift | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== "string") return null;
  const gift: KuruGift = { text: r.text, line: r.line === true };
  if (r.end === true) gift.end = true;
  if (Array.isArray(r.paths)) gift.paths = r.paths.filter((path): path is string => typeof path === "string" && path.length > 0).slice(0, 200);
  const q = r.reply as Partial<KuruQuoting> | undefined;
  const ref = q?.ref as Partial<ReplyRef> | undefined;
  if (q && ref && typeof q.at === "number" && Number.isFinite(q.at) && (q.node === null || typeof q.node === "string")) {
    if (typeof ref.who === "string" && typeof ref.when === "string" && typeof ref.quote === "string" && (ref.id === null || typeof ref.id === "string")) {
      gift.reply = { node: q.node, at: q.at, ref: { who: ref.who, when: ref.when, quote: ref.quote, id: ref.id } };
    }
  }
  if (!gift.text && !gift.reply) return null;
  return gift;
}

/**
 * Words put into Kuru's box at the cursor, unsent, and the keyboard in the
 * box — so what was pointed at is the start of a sentence the user goes on
 * typing. `line` puts them in as a line of their own (`insertLine`).
 */
export function insertInKuru(text: string, line = false, end = false): void {
  handToKuru(end ? { text, line, end } : { text, line });
}

/** A line of the conversation replied to: the box quotes it, addressed to its node, with the keyboard. */
export function replyInKuru(reply: KuruQuoting): void {
  handToKuru({ text: "", reply });
}

/** The composer has put the words in: they are not to be put in again. */
export function takeKuruWords(n: number): void {
  if (state.words?.n === n) set({ ...state, words: null });
}

/**
 * The row every card's menu carries, on the profile's board, its timeline,
 * a workspace's board and the needs drawer: one builder, so the four menus
 * say it the same way and do the same thing. `then` is for a menu drawn
 * over the drawer — the profile's board is a scrim over the whole window,
 * and the composer behind it could not be typed into — to get out of the way.
 */
export function referItem(ref: CardRef, then?: () => void): MenuItem {
  return {
    label: "Reference in Kuru",
    sep: true,
    run: () => {
      insertInKuru(cardReference(ref));
      then?.();
    },
  };
}

/**
 * A part of a card quoted to Kuru with a comment on it, from the popover
 * over a selection (`Quote.tsx`): the card's reference as its menu writes
 * it, the quote and the comment, as a line of their own in the box.
 */
export function quoteInKuru(cardRef: string, quote: CardQuote): "here" | "float" {
  return handToKuru({ text: quoteReference(cardRef, quote), line: true });
}

/**
 * A card known only by its id pointed at as its menu would point at it — a
 * note's, which has the id and no board around it: its own button over this
 * page, and a note window's, which reaches this window across the bridge as
 * the id alone. Looked for wherever the card is in the profile on screen, so
 * a card sent to a workspace since its note was popped out is referred to
 * where it is now. Null for a card that is not there, and nothing is put
 * in; otherwise which box it went into (`handToKuru`).
 * `nameOf` is `cardPlace`'s, a node's name for a workspace of another node.
 * With a `quote` — a note window's selection, which crosses the bridge with
 * the id — it is that part of the card, quoted with its comment.
 */
export function referCardIn(profile: Profile, cardId: string, nameOf: (nodeId: string) => string | null, quote: CardQuote | null = null): "here" | "float" | null {
  const found = locateCard(profile, cardId);
  if (!found) return null;
  const { card, workspace } = found;
  const ref = cardReference({
    code: cardCode(workspace ? workspace.name : profile.name, card.number),
    title: card.title,
    place: cardPlace(workspace ? workspace.id : null, nameOf),
    cardId: card.id,
  });
  return quote ? quoteInKuru(ref, quote) : handToKuru({ text: ref });
}

/** The chip, the harness key, and the pill: one press opens, the next closes. */
export function toggleKuru(focus: string | null = null): void {
  if (state.open) closeKuru();
  else openKuru(focus);
}
