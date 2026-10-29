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
import { cardPlace, cardReference, type CardRef, type KuruConversation } from "../../shared/kuru";
import type { AgentSnapshot, Profile } from "../../shared/model";
import type { MenuItem } from "./components/Menu";
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
  words: { text: string; n: number } | null;
}

let state: KuruDrawerState = { open: false, focus: null, asked: 0, words: null };
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
  set({ open: true, focus, asked: state.asked + 1, words: state.words });
}

export function closeKuru(): void {
  if (state.open) set({ open: false, focus: null, asked: state.asked, words: state.words });
}

/**
 * Open the drawer with words put into its composer at the cursor, unsent,
 * and the keyboard in the box — so what was pointed at is the start of a
 * sentence the user goes on typing.
 */
export function insertInKuru(text: string): void {
  closeNeeds();
  const words = { text, n: ++wordsAsked };
  // Open already, the list stays where it was being read: only the box changes.
  set(state.open ? { ...state, words } : { open: true, focus: null, asked: state.asked + 1, words });
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
 * A card known only by its id pointed at as its menu would point at it — a
 * note's, which has the id and no board around it: its own button over this
 * page, and a note window's, which reaches this window across the bridge as
 * the id alone. Looked for wherever the card is in the profile on screen, so
 * a card sent to a workspace since its note was popped out is referred to
 * where it is now. False for a card that is not there, and nothing is put in.
 * `nameOf` is `cardPlace`'s, a node's name for a workspace of another node.
 */
export function referCardIn(profile: Profile, cardId: string, nameOf: (nodeId: string) => string | null): boolean {
  const found = locateCard(profile, cardId);
  if (!found) return false;
  const { card, workspace } = found;
  insertInKuru(
    cardReference({
      code: cardCode(workspace ? workspace.name : profile.name, card.number),
      title: card.title,
      place: cardPlace(workspace ? workspace.id : null, nameOf),
      cardId: card.id,
    }),
  );
  return true;
}

/** The chip, the harness key, and the pill: one press opens, the next closes. */
export function toggleKuru(focus: string | null = null): void {
  if (state.open) closeKuru();
  else openKuru(focus);
}
