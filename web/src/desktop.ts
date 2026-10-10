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
}

/**
 * What the native key hook is doing, as the main process reports it.
 *
 * `live` is the one that matters to `voice.ts`: while the hook is live the
 * floating pill is the page that holds the microphone and this page sends
 * its gestures there. Any other status leaves this page's own key handler
 * in charge, so a hook that is denied or has died costs nothing but the
 * everywhere. `phase` is the pill's, so a window can tell whether an Escape
 * pressed in it is a clip being dropped.
 */
export interface VoiceGlobalState {
  on: boolean;
  live: boolean;
  status: "off" | "starting" | "live" | "denied" | "missing" | "unsupported" | "crashed";
  phase: "idle" | "listening" | "sending" | "heard" | "speaking" | "error";
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
}

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
