/**
 * The window's wiring: effects that install a listener, keep a value on the
 * device or react to the window's shape, and need nothing of App's but a
 * value or two to do it.
 *
 * They were `useEffect`s inside `App()`, which held twenty-eight of them
 * between its state and its JSX. Each is here as it was, called from App at
 * the place it stood, so the order React runs them in is App's order. What
 * stayed in App reads App's own state at every turn — the prefix key above
 * all — and would only have moved its argument list here.
 */
import { useEffect, useRef } from "react";
import type { SessionSnapshot } from "../../shared/model";
import type { NotifySettings } from "../../shared/notify";
import { DEFAULT_VOICE, type VoiceStatus } from "../../shared/voice";
import type { VoiceGlobalState } from "./desktop";
import { desktop } from "./desktop";
import { isFileDrag } from "./drop";
import { drawerChord, type Action } from "./keys";
import { announce, primeAudio, primeNotifyPermission } from "./notify";
import { installInk } from "./ink";
import { installReload } from "./reload";
import { isLoopback } from "./preview";
import * as api from "./session";
import { useInterface } from "./fonts";
import { applyTerminalAppearance } from "./terminals";
import { installSpeech, installTalkKey, setSpeechVolume, setVoiceProfile, setVoiceRemote } from "./voice";

/**
 * Give every pooled emulator the type and cursor the server says. Nothing
 * React draws, which is the point of doing it in an effect rather than in the
 * tree.
 *
 * Keyed on the appearance *serialized*, and that is not laziness. A snapshot
 * goes out on every status tick and arrives as JSON, so the object is a new
 * one several times a second however little has changed — keying on it would
 * ask every pooled emulator whether its font had moved twice a second, for the
 * lifetime of the window.
 */
export function useAppearance(snapshot: SessionSnapshot | null): void {
  const terminal = snapshot?.appearance.terminal;
  const key = terminal ? JSON.stringify(terminal) : null;
  useEffect(() => {
    if (terminal) applyTerminalAppearance(terminal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useInterface(snapshot);
}

/**
 * What the window's shape decides, as App's effects did it: the attribute
 * the stylesheet reads, the sidebar on a crossing of the breakpoint, and one
 * sheet at a time on a phone. In App's order, since two of them set the
 * sidebar.
 */
export function useNarrowLayout(
  narrow: boolean,
  drawerOpen: boolean,
  setSidebarOpen: (open: boolean) => void,
  setFilesSheet: (open: boolean) => void,
): void {
  /**
   * Tell the stylesheet which shape the window is in.
   *
   * An attribute on the root rather than a `@media` rule of its own, so the
   * breakpoint is stated once — see `NARROW` in `App.tsx`. The cascade is the
   * cheapest way to tell several hundred rules something, and it costs no
   * render at all.
   */
  useEffect(() => {
    document.documentElement.toggleAttribute("data-narrow", narrow);
  }, [narrow]);

  /**
   * Crossing the breakpoint decides for you, once.
   *
   * Going narrow closes the sidebar, because a sidebar that is a full-screen
   * overlay is not something to leave standing over the panes; coming back wide
   * opens it, because a column beside them is the ordinary state of the window.
   * Only on the *crossing* — a deliberate `toggle-sidebar` either side of it
   * survives until the window changes shape again, which is the difference
   * between the layout having an opinion and the layout overruling you.
   */
  useEffect(() => {
    setSidebarOpen(!narrow);
  }, [narrow, setSidebarOpen]);
  useEffect(() => {
    if (narrow) setFilesSheet(false);
  }, [narrow, setFilesSheet]);

  /**
   * One sheet at a time on a phone: the drawer opening puts the sidebar and
   * the tree away, as the board does. On a desktop it is a panel beside
   * them and nothing moves.
   */
  useEffect(() => {
    if (!narrow || !drawerOpen) return;
    setSidebarOpen(false);
    setFilesSheet(false);
  }, [narrow, drawerOpen, setSidebarOpen, setFilesSheet]);
}

/**
 * A value remembered per device, in `localStorage`, whenever it changes.
 * Storage that refuses to answer — a private window — is a default next
 * time, not a failure, so nothing is said.
 */
export function useRemembered(key: string, value: string): void {
  useEffect(() => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // A private window keeps the default. Nothing here is worth a dialog.
    }
  }, [key, value]);
}

/**
 * Make the noise and draw the card when the server says somebody is wanted.
 *
 * Registered once, and the settings are read through a ref rather than
 * captured, for the reason the appearance effect is keyed on a string: a
 * snapshot arrives several times a second and is a new object every time, so
 * a dependency on it would tear this subscription down and rebuild it at that
 * rate forever. Nothing is lost by reading late — a notification is answered
 * with whatever the settings are at the moment it arrives, which is the only
 * sensible reading of them.
 *
 * No policy here. Everything that decides *whether* is in `shared/notify.ts`
 * and has already run on the server; a message that got this far passed.
 */
export function useNotifyWiring(notifySettings: NotifySettings | undefined): void {
  const notifyRef = useRef(notifySettings);
  notifyRef.current = notifySettings;
  useEffect(() => {
    // The browser will not let a page make a noise until it has been touched,
    // and there is no way to ask whether it has — so be there when it happens.
    primeAudio();
    // And ask for the cards on that same first touch, so somebody opening kururu
    // for the first time is asked rather than finding out months later that the
    // notifications they never saw were a permission nobody had requested. The
    // gesture matters: Safari ignores an ask without one, and a prompt raised
    // while the window is still drawing gets dismissed — which is `denied`, and
    // a page cannot take that back.
    primeNotifyPermission();
    return api.onNotify((card) => {
      const settings = notifyRef.current;
      if (settings) announce(card, settings);
    });
  }, []);
}

/**
 * The voice: the talk key on the window, and what Kuru says off the socket.
 *
 * Installed once and read through refs rather than re-installed on every
 * change of settings or profile, for the prefix listener's reason in
 * reverse: this one must *not* move to the back of the capture list, since
 * a key held across a re-render would lose its key-up. The module holds the
 * microphone and the player; see `voice.ts`.
 */
export function useVoiceWiring(voice: VoiceStatus | null, profileId: string): void {
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const profileRef = useRef(profileId);
  profileRef.current = profileId;
  useEffect(() => {
    setVoiceProfile(() => profileRef.current);
    setSpeechVolume(() => voiceRef.current?.settings.volume ?? DEFAULT_VOICE.volume);
    const stopKey = installTalkKey(() => voiceRef.current?.settings.talkKey ?? DEFAULT_VOICE.talkKey);
    const stopSpeech = installSpeech();
    // The screen pen: this window owns a session with no voice, and one with
    // the voice while it is the voice client (`ink.ts`).
    const stopInk = installInk();
    /**
     * In the desktop window, whether the key is hooked system-wide. While it
     * is, the floating pill is the voice client and this page hands its
     * gestures over; the moment the hook is denied or dies, this page's own
     * handler is back, so the key never fires twice and never fires nowhere.
     */
    const bridge = desktop()?.voice ?? null;
    const follow = (state: VoiceGlobalState) => setVoiceRemote(state.live && bridge ? (gesture) => bridge.gesture(gesture) : null, state.phase);
    let stopGlobal = () => {};
    if (bridge) {
      void bridge.global().then(follow);
      stopGlobal = bridge.onGlobal(follow);
    }
    return () => {
      stopKey();
      stopSpeech();
      stopInk();
      stopGlobal();
      setVoiceRemote(null);
    };
  }, []);
}

/**
 * Agents may ask this page to reload, and it does once that is safe — see
 * `reload.ts`. The desktop window and a browser on this Mac; never a page
 * on another device, which is somebody's phone and reloads when they say.
 */
export function useReloadGate(): void {
  useEffect(() => {
    const page = desktop() ? "window" : isLoopback(location.hostname) ? "tab" : null;
    return page ? installReload(page) : undefined;
  }, []);
}

/**
 * A file dropped anywhere that is not a terminal does nothing.
 *
 * This is a guard, not a feature. A web page's default answer to a dropped
 * file is to navigate to it, and this page is the whole application — so a
 * screenshot missing the pane by ten pixels would replace kururu with a
 * picture of a screenshot, and take every terminal on screen with it. The
 * agents would survive, being processes on the other end; the window would
 * not.
 *
 * Bubble phase on purpose, so `Terminal.tsx` gets the drop first and this only
 * ever sees the ones that missed. And only for file drags: kururu's own tab
 * and pane drags carry custom MIME types and must keep reaching their own drop
 * zones untouched.
 */
export function useFileDropGuard(): void {
  useEffect(() => {
    const swallow = (event: DragEvent) => {
      if (isFileDrag(event.dataTransfer)) event.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);
}

/**
 * The ⌘ shortcuts, kept from before the prefix existed. A second door: ⌘W and
 * ⌘R stay Electron's, which is why closing a pane is ⇧⌘W. ⌘, and ⌘. are
 * the ones added since, for the two drawers — see `drawerChord`.
 */
export function useCommandChords(run: (action: Action) => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey) return;
      const key = event.key.toLowerCase();
      const take = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      const drawer = drawerChord(event);
      if (drawer) {
        take();
        run(drawer);
      } else if (key === "d") {
        take();
        run(event.shiftKey ? "split-down" : "split-right");
      } else if (key === "t" && !event.shiftKey) {
        take();
        run("new-tab");
      } else if (key === "w" && event.shiftKey) {
        take();
        run("close-pane");
      } else if (key === "[" || key === "]") {
        take();
        api.stepPane(key === "]" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [run]);
}
