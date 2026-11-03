/**
 * A note window's quote, carried to the main window by the page rather than
 * by the app — for an app whose bridge is older than quoting.
 *
 * A note window has no Kuru box; its quote goes to the window's, with the
 * card's id beside it, and the bridge's `notes.quote` is the road built for
 * that. But the bridge is the app's, and an app is rebuilt and installed far
 * less often than the page is reloaded: an app from before quoting has
 * "Reference in Kuru"'s `notes.refer`, which carries the id and nothing
 * else, and its note windows quoted nothing at all. Both windows are pages
 * of one origin in one Electron session, so a `BroadcastChannel` between
 * them reaches across without the app: the note says the quote on it, the
 * window holds it for the card and says so, and only then does the note
 * press `refer` — the press that brings the window forward and names the
 * card — and the window, hearing a reference with no quote on it, takes the
 * one it holds for that card. Waiting for the window's word first is what
 * makes the order certain: the channel and the bridge are two roads, and a
 * reference that arrived before its quote would go in alone.
 *
 * The window writes the card's reference from its own snapshot and holds
 * what crossed to a quote's shape (`adoptQuote`), as it does for the
 * bridge's, so a same-origin page can put into the box only what the user
 * could have selected and typed — and sends nothing. A quote not taken in a
 * few seconds is dropped, so a later plain "Reference in Kuru" for the card
 * is never handed an old one.
 *
 * **The channel is not enough on its own, and the quote is also left in
 * localStorage** (`kururu.note-quote:<card>`), which every page of the origin
 * shares. The channel reaches only a window whose page is there and listening
 * at that moment, and on 2026-11-02 every quote from a note window went in as
 * the card's bare reference: each `[quote "…"]` was dropped without a word,
 * and quotes of different passages all read the same. A main window that was
 * closed is one road to that, reproduced — the note waits out `HELD_WAIT_MS`
 * for a window that is not there, presses `refer`, the app opens a fresh
 * window, and its page never heard the quote. A page left holding an old copy
 * of this module after a hot update (`Pill.tsx` has the same story) would be
 * another. The stored copy is read by whichever page takes the reference, from
 * whichever copy of this module, and is gone once taken; the window also
 * waits a moment for it (`awaitNoteQuote`) before it puts in a reference
 * alone, since the channel's message and the bridge's are two roads that
 * need not arrive in order. A plain "Reference in Kuru" from the note's bar
 * forgets a stored quote first (`forgetNoteQuote`), so it is never handed one.
 */
import { adoptQuote, type CardQuote } from "../../shared/kuru";

const CHANNEL = "kururu.note-quote";
/** How long the note waits for the window to say it holds the quote before pressing `refer` anyway, which puts the card's reference in alone. */
const HELD_WAIT_MS = 1500;
/** How long the window keeps a quote for the reference that should follow it. */
export const HELD_FOR_MS = 5000;
/** Where a quote is left for a window that was not there to hear it, by card. */
const STORED = "kururu.note-quote:";
/** How long a stored quote waits — long enough for a closed window to be opened and its page loaded. */
export const STORED_FOR_MS = 30_000;
/** How long the window waits for a quote before it puts the card's reference in alone. */
export const AWAIT_MS = 400;

type Said = { kind: "quote"; id: string; cardId: string; quote: CardQuote } | { kind: "held"; id: string };

/**
 * The quotes the window holds, by card — pure, for the test. One per card:
 * a second quote from the same note before the first was taken is the one
 * the next reference is for.
 */
export class HeldQuotes {
  private held = new Map<string, { quote: CardQuote; at: number }>();
  hold(cardId: string, quote: CardQuote, now: number): void {
    this.held.set(cardId, { quote, at: now });
  }
  take(cardId: string, now: number): CardQuote | null {
    const found = this.held.get(cardId);
    this.held.delete(cardId);
    for (const [id, was] of this.held) if (now - was.at > HELD_FOR_MS) this.held.delete(id);
    return found && now - found.at <= HELD_FOR_MS ? found.quote : null;
  }
}

const held = new HeldQuotes();

/** A stored quote as read back — pure, for the test: the quote, or null for anything stale, from the future or not a quote. */
export function storedQuote(raw: string | null, now: number): CardQuote | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { at?: unknown; quote?: unknown } | null;
    const at = value?.at;
    if (typeof at !== "number" || !Number.isFinite(at) || now - at > STORED_FOR_MS || at - now > HELD_WAIT_MS) return null;
    return adoptQuote(value?.quote);
  } catch {
    return null;
  }
}

function store(cardId: string, quote: CardQuote): void {
  try {
    localStorage.setItem(STORED + cardId, JSON.stringify({ at: Date.now(), quote }));
  } catch {
    // The channel still carries it to a window that is there.
  }
}

/** A note: forget a stored quote, before a plain reference to its card, which must not be handed one. */
export function forgetNoteQuote(cardId: string): void {
  try {
    localStorage.removeItem(STORED + cardId);
  } catch {
    // Nothing was stored.
  }
}

function takeStored(cardId: string, now: number): CardQuote | null {
  try {
    const raw = localStorage.getItem(STORED + cardId);
    if (raw !== null) localStorage.removeItem(STORED + cardId);
    return storedQuote(raw, now);
  } catch {
    return null;
  }
}

/** The window: hold what note windows say, until `takeNoteQuote`. Returns the stop. */
export function holdNoteQuotes(): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const said = event.data as Partial<Said> | null;
    if (!said || said.kind !== "quote" || typeof said.id !== "string" || typeof said.cardId !== "string") return;
    const quote = adoptQuote((said as { quote?: unknown }).quote);
    if (!quote) return;
    held.hold(said.cardId, quote, Date.now());
    channel.postMessage({ kind: "held", id: said.id } satisfies Said);
  };
  return () => channel.close();
}

/** The window: the quote a note said for this card, for the reference that just came across the bridge without one — held, or stored. */
export function takeNoteQuote(cardId: string): CardQuote | null {
  const now = Date.now();
  const heard = held.take(cardId, now);
  const stored = takeStored(cardId, now);
  return heard ?? stored;
}

/** The window: `takeNoteQuote`, waiting up to `AWAIT_MS` for a quote that is still on its way before settling for none. */
export async function awaitNoteQuote(cardId: string, ms = AWAIT_MS): Promise<CardQuote | null> {
  const until = Date.now() + ms;
  for (;;) {
    const found = takeNoteQuote(cardId);
    if (found || Date.now() >= until) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A note window: say the quote, and press `refer` once the window holds it — or, after a wait, without. */
export function quoteAcross(cardId: string, quote: CardQuote, refer: () => void): void {
  store(cardId, quote);
  if (typeof BroadcastChannel === "undefined") {
    refer();
    return;
  }
  const channel = new BroadcastChannel(CHANNEL);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    channel.close();
    refer();
  };
  const timer = window.setTimeout(finish, HELD_WAIT_MS);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const said = event.data as Partial<Said> | null;
    if (said?.kind === "held" && said.id === id) finish();
  };
  channel.postMessage({ kind: "quote", id, cardId, quote } satisfies Said);
}
