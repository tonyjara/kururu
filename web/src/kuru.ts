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
 */
import { useSyncExternalStore } from "react";
import type { KuruConversation } from "../../shared/kuru";
import type { AgentSnapshot, Profile } from "../../shared/model";

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
}

let state: KuruDrawerState = { open: false, focus: null, asked: 0 };
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

/** Open the drawer, at a reply when one is named, at the newest otherwise. */
export function openKuru(focus: string | null = null): void {
  set({ open: true, focus, asked: state.asked + 1 });
}

export function closeKuru(): void {
  if (state.open) set({ open: false, focus: null, asked: state.asked });
}

/** The chip, the harness key, and the pill: one press opens, the next closes. */
export function toggleKuru(focus: string | null = null): void {
  if (state.open) closeKuru();
  else openKuru(focus);
}
