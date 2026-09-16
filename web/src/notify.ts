/**
 * Making a noise, and putting a card on somebody's screen.
 *
 * Everything hard about notifications was decided before this file runs. The
 * server ran the gate (`shared/notify.ts`), composed the words, and addressed
 * the message to the clients that could not already see the terminal — so what
 * is left here is two mechanisms and their failure modes, and the failure modes
 * are the reason the module exists rather than being four lines in `session.ts`.
 *
 * **The sound and the card are independent, and the sound is the one that always
 * works.** A card needs a permission the browser may refuse, which on an iPhone
 * it will unless kururu has been added to the home screen; a sound needs a user
 * to have touched the page at some point, which in a terminal multiplexer they
 * have. So they are attempted separately and neither is conditional on the
 * other. That is not defensive coding — it is the whole design of the feature on
 * a phone, where a croak from your pocket is the notification and the card is a
 * bonus you may or may not have granted.
 *
 * **Web Audio rather than an `<audio>` element**, and the reason is the unlock.
 * Chromium will not let a page make a noise before it has been interacted with,
 * and with elements the unlock is per element — so changing the sound in
 * Settings would hand you a fresh, locked element, and the first notification
 * after a change would be silent. An `AudioContext` is one object for the
 * lifetime of the page: `resume()` it once on the first gesture and every sound
 * after that plays, including ones chosen later. It also gives a gain node,
 * which is how the volume setting is applied without re-fetching anything.
 *
 * **Nothing in here decides whether to notify.** If a message arrived, it passed.
 * The client applying a policy of its own would be the same rule in two places,
 * and the half that drifted would be invisible — a notification that does not
 * happen leaves no trace anywhere.
 */
import type { NotifySettings } from "../../shared/notify";
import type { Notification as Card } from "../../shared/wire";
import { desktop } from "./desktop";
import * as api from "./session";

/** Where the bytes for a sound come from. The server transcodes; see `sounds.ts`. */
export function soundUrl(id: string): string {
  return `/api/sound?id=${encodeURIComponent(id)}`;
}

// ---------------------------------------------------------------------------
// The noise
// ---------------------------------------------------------------------------

let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
/** Decoded audio, by url. Small, bounded by the length of the dropdown. */
const decoded = new Map<string, Promise<AudioBuffer | null>>();

/**
 * The one context, built on first use rather than at import.
 *
 * Constructing an AudioContext on module load creates a suspended one on every
 * page that never makes a noise, and some browsers log about it. It is also
 * genuinely unavailable in some runtimes, which is a thing to return null for
 * rather than to throw over — a kururu that cannot beep is a kururu, and a
 * kururu that fails to start because it cannot beep is not.
 */
function audio(): { ctx: AudioContext; gain: GainNode } | null {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
      gain = ctx.createGain();
      gain.connect(ctx.destination);
    } catch {
      ctx = null;
      return null;
    }
  }
  return ctx && gain ? { ctx, gain } : null;
}

/**
 * Let the page make a noise, at the first moment the browser will allow it.
 *
 * Autoplay policy needs a gesture and gives no way to ask whether one has
 * happened, so the only way to know is to be there when it does. `once` on every
 * listener, because after the first `resume()` the context stays running for the
 * life of the page — this is a latch, not a handler.
 *
 * Called from `App.tsx` on mount rather than from here on import, so that a page
 * that never mounts the app never installs listeners.
 */
export function primeAudio(): void {
  const wake = () => {
    const a = audio();
    if (a && a.ctx.state === "suspended") void a.ctx.resume().catch(() => {});
  };
  for (const event of ["pointerdown", "keydown", "touchstart"] as const) {
    window.addEventListener(event, wake, { once: true, passive: true });
  }
}

function load(url: string): Promise<AudioBuffer | null> {
  let pending = decoded.get(url);
  if (pending) return pending;
  pending = (async () => {
    const a = audio();
    if (!a) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return await a.ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      /**
       * A sound that will not load is silence, and silence is the right answer.
       * The two ways to get here are an id naming a file this machine no longer
       * has — `themeFor`'s case, where the fallback lasts as long as the
       * mismatch does — and a format the browser cannot decode, which is
       * supposed to be impossible because the server converts what it must.
       * Neither is worth interrupting somebody about, which would be an
       * unusually poor joke in this module.
       */
      return null;
    }
  })();
  decoded.set(url, pending);
  return pending;
}

/**
 * Play one, now. Resolves when it has been *started*, not when it has finished.
 *
 * Settings awaits it so that clicking a sound twice does not stack two fetches,
 * and nothing else cares.
 */
export async function playSound(id: string, volume: number): Promise<void> {
  if (!id) return; // Silent is a choice; see `NotifySettings.sound`.
  const a = audio();
  if (!a) return;
  // A gesture may be what is driving this — picking a sound in Settings — in
  // which case the context can be resumed right now whether or not the latch
  // above has fired yet.
  if (a.ctx.state === "suspended") await a.ctx.resume().catch(() => {});
  const buffer = await load(soundUrl(id));
  if (!buffer) return;
  a.gain.gain.value = Math.min(1, Math.max(0, volume));
  const source = a.ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(a.gain);
  source.start();
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export type Permission = NotificationPermission | "unsupported";

export function notifyPermission(): Permission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/**
 * Ask for the permission, from a button.
 *
 * It has to be a button. Safari requires a transient user activation for this
 * call and ignores it otherwise, and every browser that does not require one
 * still holds a page that asks on load in mild contempt. So Settings has a row
 * for it and nothing requests it behind anybody's back — which is also the
 * honest shape, since a notification is the one thing kururu does that reaches
 * you when you are not looking.
 */
export async function askPermission(): Promise<Permission> {
  if (typeof Notification === "undefined") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/**
 * Raise the card, and wire up what a click on it does.
 *
 * `tag` is the agent id, which makes the browser *replace* a live card from the
 * same terminal rather than stacking a second one — ghosttown's `-group`, and
 * the same reasoning: two cards about one agent is one agent's worth of news
 * taking up two slots in Notification Center.
 *
 * `silent` because we have just played the sound ourselves. Letting the OS pick
 * one too would mean two noises, one of which is not the one that was chosen.
 */
function raise(card: Card): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  let note: Notification;
  try {
    note = new Notification(card.title, {
      body: card.body,
      tag: card.agentId,
      silent: true,
      icon: "/favicon-32.png",
    });
  } catch {
    // Some browsers refuse the constructor outright when the page is only
    // reachable over a service worker. Nothing to do; the sound has played.
    return;
  }
  note.onclick = () => {
    /**
     * Three things, and only the first is kururu's own state. The server moves
     * the arrangement; the desktop bridge raises the window, which nothing in a
     * renderer can do for itself; and `window.focus()` is what a browser tab
     * needs instead, which is also the whole of what the phone can do.
     */
    api.revealAgent(card.agentId);
    desktop()?.show?.();
    window.focus();
    note.close();
  };
}

/**
 * A notification arrived. Make the noise, draw the card.
 *
 * In that order and not the other way round, because the sound is the half that
 * always works: a browser that will not show a card must not also swallow the
 * croak on the way past.
 */
export function announce(card: Card, settings: NotifySettings): void {
  void playSound(settings.sound, settings.volume);
  raise(card);
}
