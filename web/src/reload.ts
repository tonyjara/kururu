/**
 * The page's half of an agent reloading the window: wait for a moment it is
 * safe to, reload, and say so on the other side.
 *
 * The page decides, because every reason not to is here and nowhere else —
 * the microphone and the player are this page's or the pill's (`voiceNow`),
 * the keyboard and the pointer are this page's, and what is open over it is
 * in its DOM. The rules themselves are `reloadHolds` in `shared/reload.ts`;
 * this module only gathers what they are asked about.
 *
 * **A poll, while an ask is waiting, and nothing otherwise.** The inputs come
 * from five places, and two of them — the hands having been still for five
 * seconds, a dialog having closed — are the absence of an event, which no
 * listener hears. So four times a second, for as long as something has been
 * asked, and not at all when nothing has. What is holding the reload is sent
 * when it changes, so the agent can be told what it waited for.
 *
 * **What a dialog is, is read off the page,** not off `App`'s state: every
 * modal here draws a `.scrim`, every menu and picker a `.menu-backdrop`, and
 * a card's confirmation is an `alertdialog`. A list of `App`'s dialogs would
 * be a list somebody adds a dialog to without adding it here.
 *
 * **The notice crosses the reload in `sessionStorage`,** which survives a
 * reload of this page and no other: the window and the pill each keep their
 * own, and a phone has none to find. It is read once per page, at the first
 * install, so React's second mount in development and a hot update after it
 * do not show it twice.
 *
 * The reload is `location.reload()`, which is `C-a R`, so it costs a repaint
 * and rebuilds the emulators a repaint rebuilds — no more — and the pty host
 * never hears of it.
 */
import { useSyncExternalStore } from "react";
import { reloadHolds, type ReloadAsk, type ReloadPage } from "../../shared/reload";
import * as api from "./session";
import { voiceNow } from "./voice";

const CHECK_MS = 250;
/**
 * Past an ask's own deadline, before this page lets it go by itself. The
 * server says `reload-cancel` at the deadline; this is for a server that
 * cannot, and is short enough that a reload nobody is waiting for does not
 * arrive a minute later.
 */
const GRACE_MS = 5000;
const KEPT = "kururu:reloaded-for";
/** A notice older than this is from some other reload, and is dropped unshown. */
const KEPT_FRESH_MS = 120_000;
const OVER_PAGE = '.scrim, .menu-backdrop, [role="alertdialog"], [aria-modal="true"], dialog[open]';
const TEXTUAL = new Set(["text", "search", "url", "email", "tel", "password", "number"]);

const asks = new Map<string, { ask: ReloadAsk; until: number }>();
let lastInputAt = 0;
let pressing = false;
/** The last thing told to the server about what is holding, so it is told once per change. */
let said = "";
let ticking: ReturnType<typeof setInterval> | null = null;
let going = false;

// ---------------------------------------------------------------------------
// The notice
// ---------------------------------------------------------------------------

let notice: readonly ReloadAsk[] | null = null;
const listeners = new Set<() => void>();

function setNotice(next: readonly ReloadAsk[] | null): void {
  notice = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Who reloaded this window and why, for the moment after; null when nobody did. */
export function useReloadNotice(): readonly ReloadAsk[] | null {
  return useSyncExternalStore(subscribe, () => notice);
}

export function dismissReloadNotice(): void {
  setNotice(null);
}

interface Kept {
  ids: string[];
  asks: ReloadAsk[];
  at: number;
}

function isAsk(value: unknown): value is ReloadAsk {
  const a = value as ReloadAsk | null;
  return !!a && typeof a.id === "string" && typeof a.by === "string" && typeof a.why === "string";
}

/** Taken, not read: a notice is shown by the page that came back and by no page after it. */
function takeKept(): Kept | null {
  try {
    const raw = sessionStorage.getItem(KEPT);
    if (raw === null) return null;
    sessionStorage.removeItem(KEPT);
    const kept = JSON.parse(raw) as Partial<Kept> | null;
    if (!kept || !Array.isArray(kept.ids) || !Array.isArray(kept.asks) || typeof kept.at !== "number") return null;
    if (!Number.isFinite(kept.at) || Date.now() - kept.at > KEPT_FRESH_MS) return null;
    return { ids: kept.ids.filter((id): id is string => typeof id === "string"), asks: kept.asks.filter(isAsk), at: kept.at };
  } catch {
    return null;
  }
}

function keep(kept: Kept): void {
  try {
    sessionStorage.setItem(KEPT, JSON.stringify(kept));
  } catch {
    // A page that cannot keep it reloads without a notice afterwards; the
    // agent is still told, and the reload is still the one it asked for.
  }
}

/** What the page before this one reloaded for. `undefined` until the first install has looked. */
let came: Kept | null | undefined;
let carried = false;

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** A text field outside the terminals with focus and words in it: something being written that a reload would throw away. */
function hasDraft(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el.closest(".term")) return false;
  if (el instanceof HTMLTextAreaElement) return el.value.trim() !== "";
  if (el instanceof HTMLInputElement) return TEXTUAL.has(el.type) && el.value.trim() !== "";
  return el.isContentEditable && (el.textContent ?? "").trim() !== "";
}

function stopTicking(): void {
  if (ticking) clearInterval(ticking);
  ticking = null;
}

function check(): void {
  if (going) return;
  const now = Date.now();
  for (const [id, entry] of asks) if (now > entry.until) asks.delete(id);
  if (asks.size === 0) return stopTicking();
  const voice = voiceNow();
  const holds = reloadHolds({
    voice: voice.phase,
    hushed: voice.hushed,
    lastInputAt,
    pressing,
    now,
    dialog: document.querySelector(OVER_PAGE) !== null,
    draft: hasDraft(),
  });
  const ids = [...asks.keys()];
  if (holds.length) {
    const word = `${ids.join()}:${holds.join()}`;
    if (word !== said) {
      said = word;
      api.reloadHeld(ids, holds);
    }
    return;
  }
  void go(ids);
}

async function go(ids: string[]): Promise<void> {
  going = true;
  stopTicking();
  keep({ ids, asks: [...asks.values()].map((entry) => entry.ask), at: Date.now() });
  await api.reloading(ids);
  location.reload();
}

/**
 * Make this page one an agent can ask to reload. Called once by whatever
 * owns the page — `App` for the window and a tab on this Mac, `Pill` for
 * the pill, `NotePage` for a note window — and never for a phone, which is
 * never asked. The pill reloads but shows no notice: it is hidden while it
 * is idle, and idle is the only time it reloads. A note shows none either,
 * having no room for one; the window that asked says what happened.
 */
export function installReload(page: ReloadPage): () => void {
  if (came === undefined) {
    came = takeKept();
    if (came && came.asks.length && page !== "pill" && page !== "note") setNotice(came.asks);
  }
  api.reloadable(page, came && !carried ? came.ids : []);
  carried = true;

  const touched = () => {
    lastInputAt = Date.now();
  };
  const pressed = () => {
    pressing = true;
    lastInputAt = Date.now();
  };
  const released = () => {
    pressing = false;
    lastInputAt = Date.now();
  };
  // A button let go of outside the window sends its `pointerup` nowhere.
  const left = () => {
    pressing = false;
  };
  window.addEventListener("keydown", touched, true);
  window.addEventListener("pointerdown", pressed, true);
  window.addEventListener("pointerup", released, true);
  window.addEventListener("pointercancel", released, true);
  window.addEventListener("wheel", touched, { capture: true, passive: true });
  window.addEventListener("blur", left);

  const stop = api.onReload((event) => {
    if (event.type === "ask") {
      asks.set(event.ask.id, { ask: event.ask, until: Date.now() + Math.max(0, event.until) + GRACE_MS });
      said = "";
      ticking ??= setInterval(check, CHECK_MS);
      check();
      return;
    }
    if (event.type === "cancel") asks.delete(event.id);
    else asks.clear();
    if (asks.size === 0) stopTicking();
  });
  // A hot update in the middle of a wait keeps the asks it had.
  if (asks.size) ticking ??= setInterval(check, CHECK_MS);

  return () => {
    window.removeEventListener("keydown", touched, true);
    window.removeEventListener("pointerdown", pressed, true);
    window.removeEventListener("pointerup", released, true);
    window.removeEventListener("pointercancel", released, true);
    window.removeEventListener("wheel", touched, { capture: true });
    window.removeEventListener("blur", left);
    stop();
    stopTicking();
  };
}
