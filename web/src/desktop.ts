/**
 * The Electron preload bridge, as the web app is allowed to see it.
 *
 * Everything here is `null` in a browser, and that is the contract rather than a
 * degradation to apologise for: the phone loads exactly this build over the
 * tailnet, so any feature that reaches through here has to have an answer for
 * not having it. The bridge stays deliberately tiny for the same reason — the
 * more the desktop can do that the phone cannot, the more there are two UIs.
 *
 * See `desktop/preload.js`, which is the other half of this file.
 */
import type { CardQuote } from "../../shared/kuru";

export interface DesktopBridge {
  desktop: true;
  serverUrl(): Promise<string>;
  /** Where a dropped file is on disk, or null in a runtime that cannot say. */
  pathForFile(file: File): string | null;
  /**
   * Bring this window forward. Clicking a notification is the only caller.
   *
   * It is on the bridge because it cannot be anywhere else: a renderer's
   * `window.focus()` does not raise an Electron window, and only the process
   * that owns one can. Optional so that a window from a kururu older than this
   * bridge simply does nothing — the reveal has already happened over the
   * socket, so the cost of missing it is that you have to click the dock icon.
   *
   * Worth being clear about what is being handed to a served page, since the
   * file above argues for keeping this surface tiny: the ability to raise the
   * window it is already in, and nothing else. It cannot move the window
   * anywhere, and it is the same act as clicking the app in the dock. The
   * capability the picker has and this must never get — pointing the window at
   * an address — stays on the other side of the `file:` split.
   */
  show?(): void;
  /**
   * Raise the main window specifically, rather than whichever window called
   * this — the floating pill's click needs that distinction, since the panel
   * it runs in is never the window to raise and may be all that is open.
   * Makes a window if there is none, and toggles the Kuru drawer in it, at
   * the reply named when one is: open it unless the window was already in
   * front with the drawer already open, in which case the second click is
   * the one that puts it away. Optional for the same reason as `show`.
   */
  raiseMain?(focus?: string | null): void;
  /**
   * The main process wants the Kuru drawer touched in this window — the
   * floating pill was clicked, or the menu bar's Open. Told with the reply to
   * show, or null for the newest, and whether to toggle rather than only
   * open: the main process knows whether the window was already in front,
   * this page knows whether the drawer is already open, and the flag is how
   * the two halves of that decision meet. Returns the unsubscribe. Optional:
   * a window from before the drawer has nothing to open.
   */
  onOpenKuru?(listener: (focus: string | null, toggle: boolean) => void): () => void;
  /**
   * Replacing this application, when this application is one that can be
   * replaced. Optional so a window older than this bridge simply draws the
   * link, which is the same thing it drew before the updater existed.
   */
  update?: DesktopUpdater;
  /**
   * The talk key heard in every application, and the pill that floats over
   * them. Optional for the same reason as `update`: a window from before
   * this bridge keeps the key it has, which works while it is focused.
   */
  voice?: DesktopVoice;
  /**
   * The window's three buttons, which the page may draw itself
   * (`WindowButtons.tsx`) once it has asked for the system's to be put away.
   * Optional, and its absence is an answer: a window from an app built
   * before 2026-11-10 keeps macOS's own over its corner, and the page keeps
   * the room for those instead.
   */
  frame?: DesktopFrame;
  /**
   * Cards popped out as windows of their own, over every application.
   * Optional: a window from before them keeps its notes in the page, which
   * is what a browser and the phone do anyway.
   */
  notes?: DesktopNotes;
  /**
   * The screen pen (`desktop/ink.js`): ink over every display, with one
   * picture per burst. Optional — the phone, a browser and a window from
   * before it have no pen, and draw no pencil.
   */
  ink?: DesktopInk;
  /**
   * The floating Kuru (`desktop/float.js`): Kuru's logo over every
   * application, and the conversation behind a click on it. Optional — a
   * browser and the phone have no desktop to float over, and a window from
   * before it has no switch to show.
   */
  float?: DesktopFloat;
}

/**
 * The floating Kuru as the main process holds it, told to every page of
 * ours: the logo and the chat draw from it, the pill's page draws the voice
 * as a waveform beside the logo while it is on, and Settings shows `on`.
 */
export interface FloatState {
  on: boolean;
  /** The chat is open against the logo. */
  open: boolean;
  /** Where the chat is from the logo — which is also which edge of it is dragged. */
  side: "above" | "below";
  /** Which way the chat and the waveform extend from the logo along its row: towards the middle of its display. */
  reach: "left" | "right";
  /** How wide the waveform is drawn, in CSS pixels: its own width beside a shut chat, the rest of the chat's along an open one. */
  wave: number;
  /** Which of the floating Kuru's two pages asked, when one of them did (`state()` only). */
  role?: "logo" | "panel" | null;
  /**
   * What the app this page is drawn in can do for the chat, which a page
   * newer than its app has to ask rather than assume: drag the chat's width
   * as well as its height, and start a screen pen from the chat's box.
   * Missing from an app from before either.
   */
  wide?: boolean;
  pen?: boolean;
  /** How big the logo's window is, a side, in CSS pixels: what the logo's page fills. Missing from an app whose logo was 64. */
  logo?: number;
}

export interface DesktopFloat {
  state(): Promise<FloatState>;
  /** Told on every change. Returns the unsubscribe. */
  onState(listener: (state: FloatState) => void): () => void;
  /** Switch it on or off, from the window's Settings. */
  set(on: boolean): void;
  /** The logo's page only: it was clicked. */
  press(): void;
  /** The logo's page only: a drag of it began, moved or ended — the main process reads where the pointer is. */
  drag(phase: "start" | "move" | "end"): void;
  /** The logo's page only: it was right-clicked. */
  menu(): void;
  /** The chat's page only: one of its far edges is being dragged — its height's, its width's, or the corner between them. */
  grip(phase: "start" | "move" | "end", edge?: "height" | "width" | "both"): void;
  /** The chat's page only: put it away. */
  close(): void;
  /** The chat's page only: open it, for something that landed in its box while it was shut. Optional: an app from before it. */
  show?(): void;
  /** The chat's page only: bring the window up, at a card on its board when one is named. */
  go(cardId?: string | null): void;
}

/** The screen pen's session as main holds it. */
/** What the page cannot see about the window it is in. */
export interface FrameState {
  /** The key window: the buttons wear their colours. Grey otherwise, as the system's are. */
  focused: boolean;
  /** Full screen has no buttons, the system's or these, and needs no room kept for them. */
  fullscreen: boolean;
}

/**
 * The window's three buttons, for a page that draws them. The page asks
 * (`claim`), and the main process puts the system's away and says what the
 * window's state is, or answers null where they are not the page's to draw: a
 * platform whose windows have a frame, a note's window. `release` gives the
 * system's back, for a page that has stopped drawing. `act` is what a button
 * does: `zoom` is the green one with Option held, the window fitted to the
 * screen without leaving the desktop it is on. All of it reaches the window
 * the page is in and no other, which is the reach `show` has.
 */
export interface DesktopFrame {
  claim(): Promise<FrameState | null>;
  release(): void;
  onState(listener: (state: FrameState) => void): () => void;
  act(verb: "close" | "minimize" | "fullscreen" | "zoom"): void;
}

export interface InkState {
  on: boolean;
  id: string | null;
  /** A recording to Kuru goes with it; without, its marks go into the window's Kuru box. */
  voice: boolean;
  pen: boolean;
  marks: number;
  ending: boolean;
  /** What the next stroke is drawn with. Missing from a window older than phase 2. */
  tool?: "pen" | "highlighter";
  color?: "red" | "blue";
  /** The hook's hold-to-draw key has the pen down. */
  held?: boolean;
  /**
   * Where the session's tools are: beside the floating pill's meter, since
   * it owns the session (`pill`), or in the pill's draw-only form at the
   * same spot (`draw`, `DrawPill`). Missing from a window from before the
   * tools moved, whose toolbar is inside an overlay.
   */
  tools?: "pill" | "draw";
  /** Every recording starts with the pen down (Settings → Voice → Screen pen). Missing from a window from before the setting. */
  withVoice?: boolean;
}

/**
 * What main tells the pages: the session's state (every page), and — to the
 * page that owns it only — to start its recording, to send, to drop, or why
 * there is no pen.
 */
export type InkEvent =
  | ({ ev: "state" } & InkState)
  | { ev: "start"; id: string; voice: boolean }
  | { ev: "send"; id: string; voice: boolean }
  | { ev: "cancel"; id: string; voice: boolean; why?: string }
  | { ev: "refused"; voice: boolean; why: string };

export interface DesktopInk {
  /** Start a session: with the voice, as ⌃⌥⌘D does, or without, from the Kuru drawer's pencil. */
  start(voice: boolean): Promise<InkState>;
  state(): Promise<InkState>;
  /** The pen on or off; no argument toggles it. */
  pen(on?: boolean): void;
  /** Done: the owner is told to send. */
  done(): void;
  /** ✕: the marks dropped, and the owner told to drop its clip. */
  drop(): void;
  /**
   * The owner's: the set to post, with every picture in it, and the overlays
   * gone. Null when there was no ink. With `roll`, the marks so far only, and
   * the session carries on — a recording that rolled over at five minutes.
   */
  finish(id: string, roll?: boolean): Promise<InkBundle | null>;
  /** Take the last mark back. Optional, as the rest of phase 2 is: a window from before it has none. */
  undo?(): void;
  /** A picture of the display under the pointer, now, as a mark. */
  snap?(): void;
  /** The next stroke's pen. */
  style?(style: { tool: "pen" | "highlighter"; color: "red" | "blue" }): void;
  /**
   * The never-capture list: bundle ids whose windows are left out of every
   * still. Read with no argument, saved with a list, back to the pen's own
   * with null; `custom` says whether it is the user's.
   */
  deny?(list?: string[] | null): Promise<{ list: string[]; custom: boolean }>;
  /** Whether every recording starts with the pen down: read with no argument, saved with one. */
  withVoice?(on?: boolean): Promise<boolean>;
  /** The owner's: let the session go with nothing kept. */
  cancel(id: string): void;
  onEvent(listener: (event: InkEvent) => void): () => void;
}

/** The body `POST /api/marks` takes for a screen set (`adoptScreenSet` in `shared/ink.ts`); the owner fills `audioAt`. */
export interface InkBundle {
  kind: "screen";
  at: number;
  audioAt: number | null;
  displays: unknown[];
  marks: unknown[];
}

/** What the window asks for when it pops a card out as a window. */
export interface NotePopOut {
  cardId: string;
  /** Whose card it is — a note is kept under its profile's key, as the page's are. */
  profileKey: string;
  profileName: string;
  title: string;
  code: string;
  /** The page's own note of the card being handed over, in this window's CSS pixels: it goes up exactly there. */
  box?: { x: number; y: number; w: number; h: number };
}

/** A note window as the main process lists it. `away` is a note of a profile that is not the active one. */
export interface NoteWindowView {
  cardId: string;
  title: string;
  code: string;
  profileName: string;
  state: "shown" | "hidden";
  away: boolean;
  waiting: boolean;
}

/** What a note window's page is told it is. */
export interface NoteSelf {
  cardId: string;
  profileKey: string;
  collapsed: boolean;
}

/**
 * What a note window's page tells the main process: whether it is drawing
 * its card (`here`), nothing because the card's profile is not the active
 * one (`away`, and the window is hidden), or that the card is gone; the
 * card's title and code for the menu bar; the ground it is drawn on, for the
 * window behind it; and its title bar's height, which a folded note is.
 */
export interface NoteReport {
  present: "here" | "away" | "gone";
  title: string;
  code: string;
  profileName?: string;
  background?: string;
  head?: number;
}

export interface DesktopNotes {
  /**
   * The window: pop a card out as a window. Resolves false when this
   * window cannot — it is showing another server than the one the notes
   * come from — and the page keeps the card as a note of its own instead.
   */
  popOut(ask: NotePopOut): Promise<boolean>;
  /** The notes there are, for the menus' "bring it forward". */
  list(): Promise<NoteWindowView[]>;
  /** Told on every change. Returns the unsubscribe. */
  onList(listener: (notes: NoteWindowView[]) => void): () => void;
  /** The window: a note asked for its card on its board. An ask before the page listened is handed to the first listener. */
  onShowCard(listener: (cardId: string) => void): () => void;
  /**
   * The window: a note pointed Kuru at its card, which goes into the
   * drawer's box here, as the card's menu puts it. Held for the first
   * listener as `onShowCard` is. Optional, like `refer`: an app from before
   * it never asks. With a `quote` — any value, until `adoptQuote` has read
   * it — the note quoted part of its card (`quote`).
   */
  onReferCard?(listener: (cardId: string, quote?: unknown) => void): () => void;
  /** A note window's page only, here and below: which card it is, or null for any other page. */
  self(): Promise<NoteSelf | null>;
  onSelf(listener: (self: NoteSelf) => void): () => void;
  /** Whether the note's window has the keys — it draws less while it does not. */
  onFocus(listener: (focused: boolean) => void): () => void;
  report(state: NoteReport): void;
  fold(collapsed: boolean): void;
  /** The note closed: the card stays where it is. */
  close(): void;
  /** The card shown on its board, in the window. */
  toBoard(): void;
  /**
   * The card pointed at in Kuru's box, in the window, which comes up with
   * the keys in the box. Optional: a note window in an app from before it
   * draws no button for it, since there would be nobody across the bridge
   * to hear the press.
   */
  refer?(): void;
  /**
   * Part of the card quoted with a comment, into Kuru's box in the window
   * as `refer` puts the card there, and by the same road: the window writes
   * the card's reference from its id. Optional for `refer`'s reason, and a
   * note window without it opens no popover over a selection.
   */
  quote?(quote: CardQuote): void;
  /** The window brought up, for something the note did there — an agent revealed, a file opened. */
  raiseMain(): void;
}

/**
 * What the native key hook is doing, as the main process reports it.
 *
 * `live` is the one that matters to `voice.ts`: while the hook is live the
 * floating pill is the page that holds the microphone and this page sends
 * its gestures there. Any other status leaves this page's own key handler
 * in charge, so a hook that is denied or has died costs nothing but the
 * everywhere. `phase` is the pill's, so a window can tell whether an Escape
 * pressed in it is the voice's — a clip being dropped, or Kuru being stopped
 * mid-reply — and kept from the terminal, or the terminal's.
 */
export interface VoiceGlobalState {
  on: boolean;
  live: boolean;
  status: "off" | "starting" | "live" | "denied" | "missing" | "unsupported" | "crashed";
  phase: "idle" | "listening" | "sending" | "speaking" | "error";
  altSpace: boolean;
}

/**
 * A gesture on the talk key or the pill, as the hook and the window both
 * spell them. `chord` is another key pressed during a hold, which is a
 * shortcut for the application in front; `toggle` is ⌥Space, a tap with no
 * key-up; `dismiss` is the pill's ✕.
 */
export type TalkGesture = "down" | "up" | "escape" | "chord" | "dismiss" | "toggle";

/** What the pill page tells the main process: what it shows, how big it is, and which key the settings name. */
export interface PillReport {
  phase: VoiceGlobalState["phase"];
  width: number;
  height: number;
  key: string;
  /**
   * Showing itself for the tray's Reset rather than for anything said: the
   * panel is up while this is true, idle or not. Apart from `phase`, which
   * every window is told and reads Escape by.
   */
  locating?: boolean;
  /**
   * Showing the screen pen's tools in the draw-only form (`DrawPill`): up
   * for that as for a reset, and no phase either.
   */
  drawing?: boolean;
}

export interface DesktopVoice {
  global(): Promise<VoiceGlobalState>;
  /** Told on every change. Returns the unsubscribe. */
  onGlobal(listener: (state: VoiceGlobalState) => void): () => void;
  setGlobal(on: boolean): void;
  setAltSpace(on: boolean): void;
  /** From the window, to whichever page holds the microphone. */
  gesture(gesture: TalkGesture): void;
  /** The settings page is capturing a new key, so the hook should ignore the press. */
  pause(on: boolean): void;
  openInputMonitoring(): void;
  /** The pill page only: the hook's events, delivered to no other page. */
  onKey(listener: (gesture: TalkGesture) => void): () => void;
  /** The pill page only. */
  report(state: PillReport): void;
  /**
   * The pill page only: the tray's Reset asking it to show where it now is,
   * whether or not it has anything to say. Returns the unsubscribe. Optional:
   * an app from before Reset showed anything never asks.
   */
  onLocate?(listener: () => void): () => void;
  /**
   * The pill page only: Shift as the hook hears it, while a recording is
   * under way (`web/src/shiftpen.ts`). Optional: an app from before it
   * never sends one.
   */
  onShift?(listener: (event: ShiftKeyEvent) => void): () => void;
}

/** Shift going down or up at its own time, or something pressed with it. */
export type ShiftKeyEvent = { ev: "down" | "up"; at: number } | { ev: "chord"; by: "key" | "mouse" };

/**
 * Where the desktop app has got to in replacing itself.
 *
 * `unavailable` is the ordinary case rather than the failure: it is what a
 * browser gets, what the phone gets, and what the window gets whenever it is
 * showing a server it did not start — see `desktop/main.js` for why that last
 * one is a refusal rather than an oversight. Every one of those is answered
 * with a link to the release page, so nothing here is a dead end.
 *
 * `error` is kept separate from `idle` for the reason the sentence under the
 * *Check for updates* button is: "there is nothing to do" and "I could not do
 * it" are the same picture and opposite facts.
 */
export type UpdateState =
  | { status: "unavailable" }
  | { status: "idle" }
  | { status: "downloading"; percent: number }
  | { status: "ready"; version: string }
  | { status: "error"; message: string };

export interface DesktopUpdater {
  /** What it is doing now, for a page that has just opened. */
  state(): Promise<UpdateState>;
  /** Told on every change. Returns the unsubscribe, which a dialog must call. */
  onState(listener: (state: UpdateState) => void): () => void;
  download(): void;
  /** Quit, apply it, come back. Only meaningful from `ready`. */
  install(): void;
}

declare global {
  interface Window {
    kururu?: DesktopBridge;
  }
}

/** The bridge, or null when this is a browser rather than the Electron window. */
export function desktop(): DesktopBridge | null {
  return typeof window === "undefined" ? null : (window.kururu ?? null);
}
