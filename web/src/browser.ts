/**
 * The browser's pages, as the window's page knows them.
 *
 * The server holds a browser tab — where it is and what address it is at —
 * and the main process holds its page (`desktop/browser.js`). What is left
 * for this side is the in-between: the page's live state for its tab's chrome
 * (loading, back and forward, a download, an error), told by main as it
 * changes and kept here by tab id so the chrome can be drawn by any pane the
 * tab is in; and the two things only the window that shows a page can do for
 * the server — say where the page went on its own (`browser-report`), and let
 * a page go when its tab has left the layout.
 *
 * In a browser and on the phone the bridge is absent and so is all of this:
 * a browser tab there is a placeholder that reads the layout alone.
 */
import { useSyncExternalStore } from "react";
import { panes, isWebTab, type LayoutNode } from "../../shared/layout";
import { desktop, type BrowserPageState } from "./desktop";
import * as api from "./session";

const states = new Map<string, BrowserPageState>();
const listeners = new Set<() => void>();
/** What was last said to the server per tab, so a report is sent only for a change. */
const reported = new Map<string, string>();
const reportTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** How long a page's reports are gathered before one goes: a load fires several in a few ms. */
const REPORT_MS = 250;

let started = false;

/** Start listening to main, once. Nothing in a runtime without the browser bridge. */
export function startBrowser(): void {
  const bridge = desktop()?.browser;
  if (!bridge || started) return;
  started = true;
  bridge.onState((state) => {
    if (!state || typeof state.tabId !== "string") return;
    if (state.gone) states.delete(state.tabId);
    else states.set(state.tabId, state);
    for (const listener of listeners) listener();
    if (!state.gone) queueReport(state);
  });
}

function queueReport(state: BrowserPageState): void {
  const { tabId, url, title } = state;
  if (!url || state.loading) return;
  const said = `${url}\n${title ?? ""}`;
  if (reported.get(tabId) === said) return;
  const timer = reportTimers.get(tabId);
  if (timer) clearTimeout(timer);
  reportTimers.set(
    tabId,
    setTimeout(() => {
      reportTimers.delete(tabId);
      reported.set(tabId, said);
      api.reportBrowser(tabId, url, title ?? "");
    }, REPORT_MS),
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A tab's page as main last told it, or null before it has. */
export function useBrowserState(tabId: string): BrowserPageState | null {
  return useSyncExternalStore(
    subscribe,
    () => states.get(tabId) ?? null,
    () => null,
  );
}

/** The browser tabs of a profile's layouts. */
export function webTabsIn(layouts: readonly LayoutNode[]): Set<string> {
  const out = new Set<string>();
  for (const layout of layouts) for (const pane of panes(layout)) for (const id of pane.agentIds) if (isWebTab(id)) out.add(id);
  return out;
}

let lastProfile: string | null = null;
let lastTabs = new Set<string>();

/**
 * Let go of the pages whose tabs have gone — closed here, on the phone, or by
 * a pane closed around them. Only by comparing a profile with itself: the
 * snapshot is the active profile's, so a tab in another profile is simply not
 * in it, and switching profiles must not end the pages of the one left.
 * Tabs never move between profiles, so one that went from a profile while it
 * stayed on screen went for good.
 */
export function letGoOfClosed(profileId: string, layouts: readonly LayoutNode[]): void {
  const bridge = desktop()?.browser;
  if (!bridge) return;
  const now = webTabsIn(layouts);
  if (profileId === lastProfile) {
    for (const id of lastTabs) {
      if (now.has(id)) continue;
      bridge.close(id);
      states.delete(id);
      reported.delete(id);
    }
  }
  lastProfile = profileId;
  lastTabs = now;
}
