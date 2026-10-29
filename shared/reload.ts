/**
 * An agent asking for the window to be reloaded, and the rules for when it may
 * be.
 *
 * Agents change `web/` all day, and twice an hour one of them stopped to ask
 * for ⌘R: to clear the copies a hot update leaves behind — a module replaced
 * under vite keeps its old instance alive, which is how a voice module that
 * had been hot-updated held the microphone open for a quarter of an hour on
 * 2026-10-11 — or to measure the window as a fresh load draws it. Reloading is
 * a thing only a page can do to itself, and nothing on the server could ask a
 * page to, so the agent's only lever was the user's hand.
 *
 * Now `bun run reload-window` and the harness's `reload_window` ask the
 * server, the server asks every page on this Mac that said it can be asked
 * (`ReloadPage`), and **each page decides for itself when**, because what
 * makes a reload unsafe is known in the page and only there: whether the
 * microphone is open, whether Kuru is mid-sentence on it, whether the hands
 * on its keyboard have been still, what is open over it. The server's part is
 * to deliver the ask, keep the time, and tell the agent what happened. The
 * phone is never asked; see `docs/architecture.md#reloading-the-window` for
 * why, and for why the floating pill is.
 *
 * Pure, so the rules are tested as arithmetic, the way `SwapGate` is.
 */

/**
 * The pages that can take a reload. `window` is the desktop app's, `pill` the
 * floating panel's (`/?pill`), `note` a card popped out as a window of its
 * own (`/?note=`), and `tab` a browser on this Mac pointed at a loopback
 * address. A page that is none of these — a phone — never says it can be
 * reloaded, and so is never asked.
 */
export type ReloadPage = "window" | "pill" | "note" | "tab";

export function isReloadPage(value: unknown): value is ReloadPage {
  return value === "window" || value === "pill" || value === "note" || value === "tab";
}

/**
 * What can hold a reload, one word each.
 *
 * - `talking`: the microphone is open, the talk key is down, a clip is on its
 *   way to Kuru, or the server's hush says somebody somewhere is talking.
 * - `speaking`: Kuru is mid-reply.
 * - `showing`: the pill is still showing what Kuru heard, or why it did not.
 * - `hands`: a key, a click or a scroll in this page within `RELOAD_QUIET_MS`,
 *   or a button still held down — a drag.
 * - `dialog`: a dialog, a sheet or a menu is open over it.
 * - `draft`: a text field outside the terminals has focus and words in it.
 */
export type ReloadHold = "talking" | "speaking" | "showing" | "hands" | "dialog" | "draft";

const HOLDS: readonly ReloadHold[] = ["talking", "speaking", "showing", "hands", "dialog", "draft"];

export function isReloadHold(value: unknown): value is ReloadHold {
  return typeof value === "string" && (HOLDS as readonly string[]).includes(value);
}

/**
 * How long the hands must have been still. Twice Auto Swap's
 * `SWAP_QUIET_MS`, because a swap moves a pane and a reload repaints the whole
 * window: a pause between two sentences is not the end of the work, and a
 * reload that lands on the next keystroke has eaten it.
 */
export const RELOAD_QUIET_MS = 5000;
/**
 * How long an ask waits when the agent names no time. Longer than a reply
 * Kuru reads aloud and a burst of typing, shorter than the two minutes an
 * agent's shell call is given by default — so the command answers before
 * the agent's own tool gives up on it.
 */
export const RELOAD_TIMEOUT_MS = 90_000;
/** The least an ask may wait: time for a page to hear it and answer at all. */
export const RELOAD_TIMEOUT_MIN_MS = 2000;
/** The most: the harness's MCP calls time out at ten minutes, and so does a shell call. */
export const RELOAD_TIMEOUT_MAX_MS = 600_000;
/**
 * How long a page that reloaded has to come back on the socket before the
 * server stops waiting for it. A fresh load under vite on a busy machine is a
 * few seconds; one that has not connected in twenty has failed, and the agent
 * is told it reloaded but did not come back, which is its own news.
 */
export const RELOAD_BACK_MS = 20_000;

/** An ask as a page holds it, and as the notice afterwards names it. */
export interface ReloadAsk {
  id: string;
  /** Who asked, already a name: `"window reload" (claude in kururu)`, or Kuru. */
  by: string;
  /** Why, in the agent's words. One line. */
  why: string;
}

/** What a page knows about itself at the moment it asks whether it may reload. */
export interface HoldInputs {
  /**
   * The voice on this Mac as this page sees it: its own phase, or the pill's
   * while the pill is the voice client — the window cannot reload under a
   * reply the pill is reading out any more than the pill can.
   */
  voice: "idle" | "listening" | "sending" | "heard" | "speaking" | "error";
  /** The server's hush: some client is talking, or a clip's words are still on their way. */
  hushed: boolean;
  /** When this page last saw a key, a press or a wheel. */
  lastInputAt: number;
  /** A button is down on this page and has not come up. */
  pressing: boolean;
  now: number;
  dialog: boolean;
  draft: boolean;
}

/**
 * Everything holding a reload right now; empty means go. All of them rather
 * than the first, because the agent is told what it waited for, and "a dialog
 * was open" is a different thing to do about than "Kuru was speaking".
 */
export function reloadHolds(h: HoldInputs): ReloadHold[] {
  const holds: ReloadHold[] = [];
  if (h.voice === "listening" || h.voice === "sending" || h.hushed) holds.push("talking");
  if (h.voice === "speaking") holds.push("speaking");
  if (h.voice === "heard" || h.voice === "error") holds.push("showing");
  if (h.pressing || h.now - h.lastInputAt < RELOAD_QUIET_MS) holds.push("hands");
  if (h.dialog) holds.push("dialog");
  if (h.draft) holds.push("draft");
  return holds;
}

/** A hold in a sentence, as the agent reads it. */
export function holdWords(hold: ReloadHold): string {
  switch (hold) {
    case "talking":
      return "the user was talking to Kuru";
    case "speaking":
      return "Kuru was speaking";
    case "showing":
      return "the pill was showing what Kuru heard";
    case "hands":
      return "the user was typing or clicking in it";
    case "dialog":
      return "a dialog or menu was open";
    case "draft":
      return "a text field had unsent words in it";
  }
}

export function pageWords(page: ReloadPage): string {
  switch (page) {
    case "window":
      return "the Kururu window";
    case "pill":
      return "the floating pill";
    case "note":
      return "a card's note window";
    case "tab":
      return "a browser tab on this Mac";
  }
}

/** Why, kept to one line: it is read on a notice and in a tool result, not as a letter. */
export const WHY_MAX = 160;
/** Who, likewise. */
export const BY_MAX = 80;

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Who asked, as the notice says it. The name somebody gave the terminal, or
 * what it says it is doing; then the program and the workspace. No id: the
 * notice is for the user, who does not know agents by one.
 */
export function reloaderName(agent: { name: string | null; doing: string | null; program: string; workspace: string | null }): string {
  const where = agent.workspace ? `${agent.program} in ${agent.workspace}` : agent.program;
  const what = oneLine(agent.name || agent.doing || "", 48);
  return oneLine(what ? `“${what}” (${where})` : where, BY_MAX);
}

/** What happened to one page, as the server tells the agent. */
export interface ReloadPageResult {
  page: ReloadPage;
  /**
   * `back`: reloaded, and its new page is on the socket again. `reloaded`:
   * reloaded, and nothing came back within `RELOAD_BACK_MS`. `held`: still
   * held when the time ran out. `gone`: its socket closed before it reloaded —
   * the window was closed, or reloaded by somebody's own hand.
   */
  result: "back" | "reloaded" | "held" | "gone";
  /** What it waited for, in the order each was first seen. */
  waitedFor: ReloadHold[];
  /** What was holding it when the time ran out. */
  holds: ReloadHold[];
  /** From the ask to the reload, and to the new page connecting. */
  reloadedAfterMs: number | null;
  backAfterMs: number | null;
}

export interface ReloadOutcome {
  /** Every page that was asked reloaded. */
  ok: boolean;
  outcome: "reloaded" | "partly" | "held" | "no-window";
  waitedMs: number;
  pages: ReloadPageResult[];
  /** Pages on the socket that never said they can be reloaded: a phone, or a page older than this. */
  others: number;
}

export function outcomeOf(pages: ReloadPageResult[], waitedMs: number, others: number): ReloadOutcome {
  const reloaded = pages.filter((p) => p.result === "back" || p.result === "reloaded").length;
  const outcome = pages.length === 0 ? "no-window" : reloaded === pages.length ? "reloaded" : reloaded === 0 ? "held" : "partly";
  return { ok: outcome === "reloaded", outcome, waitedMs, pages, others };
}

function seconds(ms: number): string {
  return ms < 50 ? "at once" : `after ${(ms / 1000).toFixed(1)} s`;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The outcome in words, for the agent — the command prints it and the
 * harness's tool returns it. A first line that answers the question, then a
 * line per page, then what to do next when the answer was no.
 */
export function outcomeText(o: ReloadOutcome): string {
  if (o.outcome === "no-window") {
    const others = o.others
      ? ` ${o.others === 1 ? "One other page is" : `${o.others} other pages are`} connected — a phone, which is never reloaded, or a page loaded before this existed.`
      : "";
    return `Nothing was reloaded: no Kururu window on this Mac can take a reload request. Either none is open, or the one that is was loaded before this command existed and needs one ⌘R from the user to learn it.${others}`;
  }
  const done = o.pages.filter((p) => p.result === "back" || p.result === "reloaded").length;
  const head =
    o.outcome === "reloaded"
      ? `Reloaded ${done === 1 ? pageWords(o.pages[0]!.page) : `${done} pages`} in ${(o.waitedMs / 1000).toFixed(1)} s.`
      : o.outcome === "partly"
        ? `Reloaded ${done} of ${o.pages.length} pages; gave up on the rest after ${Math.round(o.waitedMs / 1000)} s.`
        : `Not reloaded: gave up after ${Math.round(o.waitedMs / 1000)} s.`;
  const lines = o.pages.map((p) => {
    const waited = p.waitedFor.length ? ` (waited while ${list(p.waitedFor.map(holdWords))})` : "";
    switch (p.result) {
      case "back":
        return `- ${pageWords(p.page)}: reloaded ${seconds(p.reloadedAfterMs ?? 0)}${waited}, and back ${seconds(p.backAfterMs ?? 0)}.`;
      case "reloaded":
        return `- ${pageWords(p.page)}: reloaded ${seconds(p.reloadedAfterMs ?? 0)}${waited}, and has not come back on the socket; it may be stuck loading.`;
      case "held": {
        const earlier = p.waitedFor.filter((h) => !p.holds.includes(h));
        return `- ${pageWords(p.page)}: still held — ${list(p.holds.map(holdWords)) || "it never answered"}.${earlier.length ? ` Earlier: ${list(earlier.map(holdWords))}.` : ""}`;
      }
      case "gone":
        return `- ${pageWords(p.page)}: closed, or was reloaded by hand, before it was safe to reload it.`;
    }
  });
  const next = o.ok ? [] : ["Nothing more will happen. Ask the user to press ⌘R when it suits them, or ask again later."];
  return [head, ...lines, ...next].join("\n");
}
