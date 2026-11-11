/**
 * The profile's Dashboard: a space of fixed tabs that are the profile's
 * rather than any workspace's — the profile's board first, and later the
 * usage page and whatever else is about the whole profile.
 *
 * It exists because the profile's board was a sheet over the window, and a
 * sheet is a place you visit and leave: it covered the panes, took the
 * keyboard, and had to be put away before anything behind it could be used.
 * The board is somewhere people work — plan, sort, send — so it wanted to be
 * where work is, a tab in a pane, with the window's keys and its splits. But a
 * tab lives in a workspace, and this board is the one that is no workspace's:
 * in every workspace it would be many boards, and in one of them it would move
 * with whichever was picked. So the profile gets a space of its own.
 *
 * It is a `Workspace` in shape and nothing else, and that is deliberate. In
 * shape, because the panes, the strip, focus, splits, ratios and the drag
 * rules are all written against that shape, and the Dashboard gets every one
 * of them by being drawn and arranged by the same code. In nothing else,
 * because it is kept on `Profile.dashboard` and never in `Profile.workspaces`:
 * every list of workspaces — the sidebar's, `kururu_status`'s, the Needs
 * drawer's, the store's, another node's summary — walks that array, so the
 * Dashboard is left out of all of them without one of them having to know it
 * exists. It has no folder, no board, no machine and no agents, and it cannot
 * be renamed, moved or deleted, because no verb that does those finds it.
 *
 * What it holds is the other half, and it is one rule (`fitsDashboard`):
 * every fixed tab, exactly once, nothing else, and no empty pane. The server
 * checks every change to the Dashboard against it and keeps the old layout
 * when one fails, so a close, a drag out, a terminal dropped in or a split
 * with nothing to fill it is refused in one place rather than in each verb
 * that could cause it. Workspaces get the mirror of it: a layout with a
 * Dashboard tab in it is refused, so a fixed tab can never be carried out.
 *
 * Adding a tab is an entry in `DASHBOARD_TABS` and its view in
 * `web/src/components/Dashboard.tsx`, which TypeScript holds to one per id.
 * A profile from before it is given it, in the first pane, the next time its
 * Dashboard is read (`dashboardLayout`).
 */
import { isDashTab, panes, type LayoutNode, type PaneState } from "./layout";
import type { Workspace } from "./model";

/** The fixed tabs, in the order a fresh Dashboard has them. */
export const DASHBOARD_TABS = [{ id: "dash:board", label: "Profile board" }] as const;

export type DashboardTab = (typeof DASHBOARD_TABS)[number]["id"];

/** The profile's board, as the Dashboard's tab. */
export const PROFILE_BOARD_TAB: DashboardTab = "dash:board";

/** What the sidebar and the strip call the space. */
export const DASHBOARD_NAME = "Dashboard";

/** One of the Dashboard's fixed tabs — not merely shaped like one. */
export function isDashboardTab(id: unknown): id is DashboardTab {
  return DASHBOARD_TABS.some((tab) => tab.id === id);
}

/** What a fixed tab's strip says. */
export function dashboardTabLabel(id: string): string {
  return DASHBOARD_TABS.find((tab) => tab.id === id)?.label ?? id;
}

/**
 * Whether a layout is one the Dashboard may hold: every fixed tab exactly
 * once, nothing that is not one, and no pane without a tab — an empty pane
 * there would offer to open a terminal in a space that holds none.
 */
export function fitsDashboard(layout: LayoutNode): boolean {
  const seen = new Set<string>();
  for (const pane of panes(layout)) {
    if (pane.agentIds.length === 0) return false;
    for (const id of pane.agentIds) {
      if (!isDashboardTab(id) || seen.has(id)) return false;
      seen.add(id);
    }
  }
  return DASHBOARD_TABS.every((tab) => seen.has(tab.id));
}

/** Whether a workspace's layout holds a Dashboard tab, which no workspace may. */
export function holdsDashTab(layout: LayoutNode): boolean {
  return panes(layout).some((pane) => pane.agentIds.some(isDashTab));
}

/**
 * A Dashboard's layout made to fit, from whatever came back: the host's blob
 * from an older server, a file edited by hand, or nothing at all. Anything
 * that is not a fixed tab goes, a tab twice is kept once, a pane left with
 * nothing closes, and a fixed tab missing — a new one, to a profile from
 * before it — joins the first pane. `mint` makes a pane id, for a Dashboard
 * that had none.
 */
export function dashboardLayout(layout: LayoutNode | null | undefined, mint: () => string): LayoutNode {
  const seen = new Set<string>();
  const clean = (node: unknown): LayoutNode | null => {
    const n = node as LayoutNode | null | undefined;
    if (!n || typeof n !== "object") return null;
    if (n.type === "pane") {
      const pane = n.pane as Partial<PaneState> | undefined;
      if (!pane || typeof pane.id !== "string") return null;
      const ids = Array.isArray(pane.agentIds) ? pane.agentIds : [];
      const kept = ids.filter((id) => {
        if (!isDashboardTab(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (kept.length === 0) return null;
      const shown = typeof pane.activeIdx === "number" ? ids[pane.activeIdx] : undefined;
      return { type: "pane", pane: { id: pane.id, agentIds: kept, activeIdx: Math.max(0, shown ? kept.indexOf(shown) : 0) } };
    }
    if (n.type !== "split") return null;
    const a = clean(n.a);
    const b = clean(n.b);
    if (!a) return b;
    if (!b) return a;
    const ratio = Number.isFinite(n.ratio) && n.ratio > 0 && n.ratio < 1 ? n.ratio : 0.5;
    return { type: "split", id: n.id, dir: n.dir === "col" ? "col" : "row", ratio, a, b };
  };
  const out = clean(layout);
  const missing = DASHBOARD_TABS.map((tab) => tab.id as string).filter((id) => !seen.has(id));
  if (!out) return { type: "pane", pane: { id: mint(), agentIds: missing, activeIdx: 0 } };
  if (missing.length === 0) return out;
  const first = panes(out)[0]!.id;
  const add = (node: LayoutNode): LayoutNode =>
    node.type === "pane"
      ? node.pane.id === first
        ? { type: "pane", pane: { ...node.pane, agentIds: [...node.pane.agentIds, ...missing] } }
        : node
      : { ...node, a: add(node.a), b: add(node.b) };
  return add(out);
}

/**
 * A Dashboard, as the `Workspace` it is shaped as: the arrangement, and
 * every field that would make it a workspace empty — no board, no machine,
 * no mascot, no group.
 */
export function makeDashboard(id: string, key: string, layout: LayoutNode): Workspace {
  return {
    id,
    key,
    name: DASHBOARD_NAME,
    layout,
    focusedPaneId: panes(layout)[0]!.id,
    lastPaneId: null,
    mascotId: null,
    group: null,
    board: null,
    machine: null,
    mobile: false,
  };
}

/**
 * A change to the Dashboard, as the server keeps it: the arrangement taken
 * from `after` when it fits, and `before` whole when it does not. Only the
 * arrangement — layout, focus and the way back — because every other field
 * is what would make it a workspace, and a verb that set one (a board opened
 * on it, a name) is a verb that does not apply here.
 */
export function arrangeDashboard(before: Workspace, after: Workspace): Workspace {
  if (after === before || !fitsDashboard(after.layout)) return before;
  const all = panes(after.layout);
  const focusedPaneId = all.some((pane) => pane.id === after.focusedPaneId) ? after.focusedPaneId : all[0]!.id;
  if (after.layout === before.layout && focusedPaneId === before.focusedPaneId && after.lastPaneId === before.lastPaneId) return before;
  return { ...before, layout: after.layout, focusedPaneId, lastPaneId: after.lastPaneId };
}

/** The pane a fixed tab is in, and where in its strip. */
export function dashTabAt(layout: LayoutNode, id: string): { paneId: string; index: number } | null {
  for (const pane of panes(layout)) {
    const index = pane.agentIds.indexOf(id);
    if (index !== -1) return { paneId: pane.id, index };
  }
  return null;
}
