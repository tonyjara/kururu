/**
 * A terminal's menu, for its tab and its sidebar row alike: one list, built
 * here and nowhere else, so the two doors cannot drift apart — the reason
 * `workspaceItems` in `Sidebar.tsx` is one list for a workspace row's ⋯ and
 * its right-click.
 *
 * Until 2026-10-18 a tab's right-click was not a menu at all but a rename
 * field laid over the tab, and the row's menu had no rename: the same name,
 * reachable from one of its two places and by a gesture nothing else in
 * kururu used. A right-click is a menu everywhere else, so it is one here, and
 * Rename leads it because it is the verb the tab's right-click always was.
 *
 * Only what means the same thing from both. Hide and Show are the sidebar
 * list's — they put a row away in its drawer, and a tab has no drawer to be
 * put in — so the row passes them and the tab does not. Close is the tab's ✕
 * and the row's Kill at once, the same `close-tab`, and is spelt the way the
 * row spelt it: it ends the terminal, and "close" on a tab reads as if it
 * might not.
 */
import type { AgentSnapshot } from "../../shared/model";
import { showCardNext } from "./components/Board";
import type { MenuItem } from "./components/Menu";
import * as api from "./session";

export function agentItems(
  agent: AgentSnapshot,
  {
    rename,
    card,
    hidden,
    navigated,
  }: {
    /** Put the name in a field where the menu was opened. */
    rename: () => void;
    /** The card the agent runs under, if any. */
    card: { workspaceId: string; cardId: string } | undefined;
    /** Whether the row is put away — given only where there is a list to put it away in. */
    hidden?: boolean;
    /** After a verb that went somewhere: a phone's sidebar puts itself away. */
    navigated?: () => void;
  },
): MenuItem[] {
  return [
    { label: "Rename", run: rename },
    ...(hidden === undefined
      ? []
      : [{ label: hidden ? "Show" : "Hide", run: () => api.hideAgent(agent.id, !hidden) }]),
    {
      label: "Go to card",
      disabled: !card,
      run: () => {
        if (!card) return;
        showCardNext(card.workspaceId, card.cardId);
        api.openBoard(undefined, false, card.workspaceId);
        navigated?.();
      },
    },
    {
      label: agent.exited ? "Dismiss" : "Kill",
      sep: true,
      danger: true,
      run: () => api.closeTab(agent.id),
    },
  ];
}
