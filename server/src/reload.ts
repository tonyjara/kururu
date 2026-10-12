/**
 * The server's half of an agent reloading the window: deliver the ask, keep
 * the time, and say what happened.
 *
 * The page decides when (`shared/reload.ts` says why), so this could have been
 * a broadcast and nothing more. It is not, because the agent asking needs an
 * answer it can act on — reloaded and back, so measure now; or held by a
 * dialog for ninety seconds, so ask the user — and only the server sees every
 * page at once. It is the one place that can say "the pill reloaded, the
 * window is still held", and the one that knows when to stop waiting.
 *
 * What it never does is reload anything. It sends a word to pages and counts
 * what they say back; the pty host is not in it, and a page's reload is the
 * same `location.reload()` as `C-a R`, so it costs exactly what ⌘R costs.
 *
 * Generic over the client, so the tests drive it with strings rather than
 * sockets, and the clock and the timers are lent for the same reason.
 */
import { randomUUID } from "node:crypto";
import type { ServerMessage } from "../../shared/wire";
import {
  RELOAD_BACK_MS,
  outcomeOf,
  type ReloadAsk,
  type ReloadHold,
  type ReloadOutcome,
  type ReloadPage,
  type ReloadPageResult,
} from "../../shared/reload";

type Timer = unknown;

/**
 * How long a page that closed while it waited has to come back saying it
 * reloaded, before it is called gone. A page announces its reload before it
 * goes, but a word can be lost with its socket, and the page that comes back
 * carries the asks it reloaded for — so a close is not yet an answer.
 */
const LEFT_MS = 5000;

export interface ReloadDeps<C> {
  send: (client: C, msg: ServerMessage) => void;
  /** Every client on the socket, whether or not it said it can be reloaded — the rest are told apart in the answer. */
  connected: () => number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

/**
 * One page's part in one ask. `waiting`, `reloading` and `left` are not
 * answers yet: still held, gone and not yet back, closed and not yet called
 * gone (`LEFT_MS`). `reloaded` is the wait for a reloading page running out.
 */
interface Entry {
  page: ReloadPage;
  state: "waiting" | "reloading" | "left" | "back" | "reloaded" | "held" | "gone";
  holds: ReloadHold[];
  waitedFor: ReloadHold[];
  reloadedAt: number | null;
  backAt: number | null;
  backTimer: Timer | null;
}

interface Pending<C> {
  ask: ReloadAsk;
  at: number;
  others: number;
  entries: Map<C, Entry>;
  deadline: Timer;
  resolve: (outcome: ReloadOutcome) => void;
}

export class WindowReloads<C> {
  private readonly pages = new Map<C, ReloadPage>();
  private readonly pending = new Map<string, Pending<C>>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;

  constructor(private readonly deps: ReloadDeps<C>) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  /**
   * A page on this Mac said it can be asked. `reloaded` is the asks the page
   * before it reloaded for — this is the page that came back.
   */
  declare(client: C, page: ReloadPage, reloaded: readonly string[]): void {
    this.pages.set(client, page);
    for (const id of reloaded) this.cameBack(id, page);
  }

  /**
   * A socket closed. Expected of a page that said it was reloading — that is
   * what a reload looks like from here — and, for one that was still
   * waiting, nearly always the end of the matter: closed, or reloaded by
   * hand. Nearly, so it is called gone only once `LEFT_MS` has passed
   * without its new page naming the ask.
   */
  leave(client: C): void {
    this.pages.delete(client);
    for (const [id, pending] of this.pending) {
      const entry = pending.entries.get(client);
      if (entry?.state !== "waiting") continue;
      entry.state = "left";
      entry.backTimer = this.setTimer(() => {
        entry.backTimer = null;
        if (entry.state !== "left") return;
        entry.state = "gone";
        this.settle(id);
      }, LEFT_MS);
    }
  }

  /**
   * Ask every page on this Mac to reload once it is safe, and answer when
   * each one has — or when the time is up. Asked of the pages there are at
   * this moment: one that connects later loaded after the change it would be
   * reloading for. `signal` is the asker hanging up, which ends the wait as
   * the time running out would.
   */
  ask(why: string, by: string, timeoutMs: number, signal?: AbortSignal): Promise<ReloadOutcome> {
    const at = this.now();
    const others = Math.max(0, this.deps.connected() - this.pages.size);
    if (this.pages.size === 0) return Promise.resolve(outcomeOf([], 0, others));
    const ask: ReloadAsk = { id: randomUUID(), by, why };
    return new Promise((resolve) => {
      const entries = new Map<C, Entry>();
      for (const [client, page] of this.pages) {
        entries.set(client, { page, state: "waiting", holds: [], waitedFor: [], reloadedAt: null, backAt: null, backTimer: null });
      }
      const deadline = this.setTimer(() => this.expire(ask.id), timeoutMs);
      this.pending.set(ask.id, { ask, at, others, entries, deadline, resolve });
      for (const client of entries.keys()) this.deps.send(client, { type: "reload", ask, until: timeoutMs });
      if (signal?.aborted) this.expire(ask.id);
      else signal?.addEventListener("abort", () => this.expire(ask.id), { once: true });
    });
  }

  /** What is holding those asks on that page. Kept as the latest word and as everything it has waited for. */
  held(client: C, ids: readonly string[], holds: readonly ReloadHold[]): void {
    for (const id of ids) {
      const entry = this.pending.get(id)?.entries.get(client);
      if (entry?.state !== "waiting") continue;
      entry.holds = [...holds];
      for (const hold of holds) if (!entry.waitedFor.includes(hold)) entry.waitedFor.push(hold);
    }
  }

  /** That page is reloading now. Its new page has `RELOAD_BACK_MS` to say it is back. */
  reloading(client: C, ids: readonly string[]): void {
    for (const id of ids) {
      const entry = this.pending.get(id)?.entries.get(client);
      if (entry?.state !== "waiting") continue;
      entry.state = "reloading";
      entry.holds = [];
      entry.reloadedAt = this.now();
      entry.backTimer = this.setTimer(() => {
        entry.backTimer = null;
        if (entry.state !== "reloading") return;
        entry.state = "reloaded";
        this.settle(id);
      }, RELOAD_BACK_MS);
    }
  }

  /**
   * A page came back from reloading for this ask. Matched by kind, since the
   * new page is a new socket: a reload that was announced first, then one
   * whose word was lost with its socket — the page only carries ids it
   * reloaded for, so a page that `left` and is named here was a reload all
   * along.
   */
  private cameBack(id: string, page: ReloadPage): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    const entries = [...pending.entries.values()].filter((e) => e.page === page);
    const entry = entries.find((e) => e.state === "reloading") ?? entries.find((e) => e.state === "left");
    if (!entry) return;
    if (entry.backTimer !== null) this.clearTimer(entry.backTimer);
    entry.backTimer = null;
    entry.state = "back";
    entry.backAt = this.now();
    entry.reloadedAt ??= entry.backAt;
    this.settle(id);
  }

  /** Time is up: every page still held stops waiting and is told so. One that is reloading is given its time to come back. */
  private expire(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    for (const [client, entry] of pending.entries) {
      if (entry.state !== "waiting") continue;
      entry.state = "held";
      this.deps.send(client, { type: "reload-cancel", id });
    }
    this.settle(id);
  }

  /** Answer the ask once every page has an answer. */
  private settle(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    const entries = [...pending.entries.values()];
    if (entries.some((e) => e.state === "waiting" || e.state === "reloading" || e.state === "left")) return;
    this.pending.delete(id);
    this.clearTimer(pending.deadline);
    const pages: ReloadPageResult[] = entries.map((e) => ({
      page: e.page,
      result: e.state as ReloadPageResult["result"],
      waitedFor: e.waitedFor,
      holds: e.state === "held" ? e.holds : [],
      reloadedAfterMs: e.reloadedAt === null ? null : e.reloadedAt - pending.at,
      backAfterMs: e.backAt === null ? null : e.backAt - pending.at,
    }));
    pending.resolve(outcomeOf(pages, this.now() - pending.at, pending.others));
  }
}
