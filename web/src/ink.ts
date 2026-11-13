/**
 * The screen pen, as a page sees it (docs/plans/screen-annotate.md).
 *
 * The ink and its pictures are the main process's (`desktop/ink.js`); what a
 * page does is own a session and end it. Two pages can. The voice client —
 * the floating pill while the talk key is hooked, the window otherwise —
 * owns a session with the voice: main tells it to start, and it opens the
 * microphone (`penTalk` in `voice.ts`), and when the clip ends, however it
 * ends, it asks main for the ink and posts both. The window owns a session
 * without the voice, started from the Kuru drawer's pencil: when it is told
 * to send, it asks for the ink, posts it, and puts the lines the server
 * answers with into the Kuru box as chips — for the user to write after and
 * send.
 *
 * Every page is told the session's state, so the pencil and the pill's pen
 * can say whether one is on; only the owner is told to send or drop.
 */
import { useSyncExternalStore } from "react";
import { desktop, type InkEvent, type InkState, type ShiftKeyEvent } from "./desktop";
import { insertInKuru } from "./kuru";
import * as api from "./session";
import { shiftChord, shiftDown, shiftHeld, shiftUp, type ShiftPress } from "./shiftpen";
import { cancelTalk, finishTalk, isListening, penRefused, penTalk, setPenWithVoice, voiceError } from "./voice";
import { TAP_MS } from "../../shared/voice";

const OFF: InkState = { on: false, id: null, voice: false, pen: false, marks: 0, ending: false };

export interface InkUi {
  state: InkState;
  /** Why the last pen with no voice put nothing in the box, the box's placeholder until the next press or keystroke. */
  note: string | null;
  /** A session with no voice is being posted, between Done and its lines landing in the box. */
  keeping: boolean;
}

let ui: InkUi = { state: OFF, note: null, keeping: false };
const listeners = new Set<() => void>();

function set(patch: Partial<InkUi>): void {
  ui = { ...ui, ...patch };
  for (const listener of listeners) listener();
}

export function useInk(): InkUi {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => ui,
  );
}

/** Whether this runtime has a pen at all: the desktop app, from a build with the bridge. */
export function hasPen(): boolean {
  return Boolean(desktop()?.ink);
}

/**
 * The drawer's pencil: a session with no voice, or Done on the one that is
 * on, or the pen on a recording's. A press that arrives here with a session
 * on was made with the pen up; with it down the ink is over the button, and
 * main takes the press there as Done (`pencilAt`).
 */
export function pencil(): void {
  const ink = desktop()?.ink;
  if (!ink) return;
  set({ note: null });
  if (!ui.state.on) void ink.start(false);
  else if (!ui.state.voice) ink.done();
  else ink.pen();
}

/** The last place told for this page's pencil, so a render that moved nothing sends nothing. */
let pencilTold = "null";

/** Where the box's pencil is, for main to take a press on it with the pen down as Done (`Ink.pencil`); null once there is none. */
export function pencilAt(el: Element | null): void {
  const r = el?.getBoundingClientRect();
  const rect = r && r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  const said = JSON.stringify(rect);
  if (said === pencilTold) return;
  pencilTold = said;
  desktop()?.ink?.pencil?.(rect);
}

export function clearInkNote(): void {
  if (ui.note) set({ note: null });
}

/** The pill's pen: a pen for the recording under way, or the pen on and off once it has one. */
export function pillPen(): void {
  const ink = desktop()?.ink;
  if (!ink) return;
  if (ui.state.on) ink.pen();
  else void ink.start(true);
}

/**
 * The pen on or off for the recording under way, from Shift: the pen of
 * the session that is on, or a session started for the recording when
 * there is none ("Draw with every recording" off) — the pill's own pen
 * button, with a side chosen. A session still starting when the press
 * that asked for it is let go is put back up as it arrives.
 */
let shiftWants: boolean | null = null;

function shiftPen(on: boolean): void {
  const ink = desktop()?.ink;
  if (!ink) return;
  shiftWants = on;
  if (ui.state.on) {
    if (ui.state.pen !== on) ink.pen(on);
    return;
  }
  if (!on) return;
  void ink.start(true).then((state) => {
    if (state.on && state.pen && shiftWants === false) ink.pen(false);
  });
}

/**
 * Shift while recording, in the pill page that holds the microphone
 * (`shiftpen.ts` says what a press is). The hook's release time decides a
 * tap; the hold is a timer from when the press arrived here, and a release
 * the timer did not see is read by its stamps all the same.
 */
export function installShiftPen(): () => void {
  const voice = desktop()?.voice;
  if (!voice?.onShift || !desktop()?.ink) return () => {};
  let press: ShiftPress | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const apply = (pen: boolean | null) => {
    if (pen !== null) shiftPen(pen);
  };
  const stop = voice.onShift((event: ShiftKeyEvent) => {
    if (event.ev === "down") {
      clearTimeout(timer);
      press = shiftDown(isListening(), ui.state.on && ui.state.pen, event.at);
      if (!press) return;
      timer = setTimeout(() => {
        if (!press) return;
        const held = shiftHeld(press, isListening());
        press = held.press;
        apply(held.pen);
      }, TAP_MS);
    } else if (event.ev === "up") {
      clearTimeout(timer);
      if (press) apply(shiftUp(press, event.at));
      press = null;
    } else if (event.ev === "chord" && press) {
      const chorded = shiftChord(press, event.by === "mouse" ? "mouse" : "key");
      press = chorded.press;
      apply(chorded.pen);
    }
  });
  return () => {
    clearTimeout(timer);
    stop();
  };
}

/**
 * A session with no voice, told to send: the ink, posted, and the lines put
 * into the box. Nothing drawn is nothing put in.
 */
async function keepSilent(id: string): Promise<void> {
  const ink = desktop()?.ink;
  if (!ink) return;
  set({ keeping: true });
  try {
    const bundle = await ink.finish(id);
    if (!bundle) return;
    const kept = await api.sendMarks(bundle);
    // The marks are what the user goes on to write about: the caret after everything, not only after them.
    insertInKuru(kept.lines.join("\n"), true, true);
  } catch (err) {
    set({ note: `The marks were not kept: ${err instanceof Error ? err.message : String(err)}.` });
  } finally {
    set({ keeping: false });
  }
}

function onEvent(event: InkEvent): void {
  switch (event.ev) {
    case "state": {
      const { ev: _, ...state } = event;
      set({ state });
      return;
    }
    case "start":
      if (event.voice) penTalk(event.id);
      return;
    case "send":
      if (event.voice) finishTalk();
      else void keepSilent(event.id);
      return;
    case "cancel":
      if (event.voice) {
        cancelTalk();
        if (event.why) voiceError("The pen stopped, and what you said with it was dropped.", event.why);
      } else if (event.why) set({ note: `The pen stopped: ${event.why}.` });
      return;
    case "refused":
      if (event.voice) {
        if (!penRefused()) voiceError("No pen on the screen.", event.why);
      }
      else set({ note: event.why });
      return;
  }
}

/** Listen to main for the pen. Called once by each page that can own a session: the window and the pill. */
export function installInk(): () => void {
  const ink = desktop()?.ink;
  if (!ink) return () => {};
  // Only a window that says it has the setting: one from before it keeps the pen to the keys and buttons.
  setPenWithVoice(() => ui.state.withVoice === true);
  void ink.state().then((state) => set({ state }));
  return ink.onEvent(onEvent);
}
