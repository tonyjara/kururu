/**
 * The bridge, and the two very different pages it has to serve.
 *
 * The app is HTTP content served by a kururu server — which may be on this
 * machine or on a box across a tailnet — so it is treated like any other web
 * page: context isolation on, node integration off. What it is handed is the
 * whole surface it gets, and it stays tiny on purpose. Anything the web app can
 * do from a phone it should do the same way here, or the two drift.
 *
 * The picker is the other page, and it needs the one capability that must never
 * be on that surface: pointing this window at an arbitrary address. A served
 * page able to call `connect()` is a served page able to move the window
 * somewhere else, which is a redirect attack with none of the work.
 *
 * A preload is chosen when the window is built and cannot be swapped per
 * navigation, so the two APIs live in one file and the boundary is drawn where
 * it can actually be trusted: `location.protocol`. The picker is a file kururu
 * ships and loads from disk; nothing arriving over HTTP can make itself
 * `file:`, and nothing served can therefore reach the half below.
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const isPicker = location.protocol === "file:" && location.pathname.endsWith("connect.html");

if (isPicker) {
  contextBridge.exposeInMainWorld("picker", {
    /** Told on every probe sweep: which addresses and nodes are known, and which answered. */
    onState(listener) {
      ipcRenderer.on("picker:state", (_event, state) => listener(state));
    },
    /** Say the page is listening, so the current state arrives without waiting for a sweep. */
    ready() {
      ipcRenderer.send("picker:ready");
    },
    connect(address) {
      return ipcRenderer.invoke("picker:connect", address);
    },
    /** One of the nodes the local server knows, by id: the main process holds its address and token. */
    connectNode(id) {
      return ipcRenderer.invoke("picker:connect-node", id);
    },
    forget(address) {
      return ipcRenderer.invoke("picker:forget", address);
    },
  });
} else {
  /**
   * A terminal's right-click stays the terminal's, which in this window has
   * always been nothing at all.
   *
   * The emulator leaves the event unclaimed unless the program asked for the
   * mouse, and moves its input textarea under the pointer as it goes — so
   * unclaimed, it reaches `editmenu.js` as a right-click in an editable field
   * and would open Paste over a pty, where a paste is typing into an agent.
   * Claimed here, after the page's own handlers have had it, rather than in
   * `terminals.ts`, because a browser tab and the phone keep the browser's
   * menu on a terminal and only this window has a second one to suppress.
   */
  window.addEventListener("contextmenu", (event) => {
    if (event.target instanceof Element && event.target.closest(".term")) event.preventDefault();
  });
  /** An open-the-drawer ask that landed before the page subscribed: `undefined` is none. */
  let pendingKuru;
  ipcRenderer.on("kururu:open-kuru", (_event, focus, toggle) => {
    if (ipcRenderer.listenerCount("kururu:open-kuru") === 1)
      pendingKuru = { focus: typeof focus === "string" ? focus : null, toggle: Boolean(toggle) };
  });
  /** The tray's Reset, landed on a pill page still mounting — which is what a page loaded again for not answering one is. */
  let pendingLocate = false;
  ipcRenderer.on("kururu:pill-locate", () => {
    if (ipcRenderer.listenerCount("kururu:pill-locate") === 1) pendingLocate = true;
  });
  /** A note's "show it on its board", landed on a window still loading — one made for the purpose. */
  let pendingCard;
  ipcRenderer.on("kururu:show-card", (_event, cardId) => {
    if (ipcRenderer.listenerCount("kururu:show-card") === 1 && typeof cardId === "string") pendingCard = cardId;
  });
  contextBridge.exposeInMainWorld("kururu", {
    /** True in the Electron window, absent in a browser or on the phone. */
    desktop: true,
    /** Which server this window is showing, for the rare thing that needs an absolute URL. */
    serverUrl: () => ipcRenderer.invoke("kururu:server-url"),
    /**
     * Raise this window, for a click on a notification. See the note on
     * `show?()` in `web/src/desktop.ts` for why this is on the bridge and why
     * it is the whole of what it can do.
     */
    show: () => ipcRenderer.send("kururu:show"),
    /**
     * Raise the *main* window, for a click on the floating pill — which may be
     * sent from the panel's own webContents, so `show()` (whichever window sent
     * it) is the wrong half to reuse: the panel is non-focusable and was never
     * the window to raise. Makes one if there is none.
     */
    raiseMain: (focus) => ipcRenderer.send("kururu:raise-main", typeof focus === "string" ? focus : null),
    /**
     * The main process wants the Kuru drawer touched here — the floating
     * pill was clicked, or the menu bar's Open — with the reply to show, or
     * null for the newest, and whether this is a toggle (the window was
     * already in front, so a second click means close) rather than only an
     * open. An ask that arrives before the page is listening is kept and
     * handed to the first listener: a window opened for the purpose gets the
     * message while React is still mounting.
     */
    onOpenKuru: (listener) => {
      const relay = (_event, focus, toggle) => listener(typeof focus === "string" ? focus : null, Boolean(toggle));
      ipcRenderer.on("kururu:open-kuru", relay);
      if (pendingKuru !== undefined) {
        const pending = pendingKuru;
        pendingKuru = undefined;
        listener(pending.focus, pending.toggle);
      }
      return () => ipcRenderer.removeListener("kururu:open-kuru", relay);
    },
    /**
     * Where a file dropped onto the window actually is on disk.
     *
     * This has to be here because it cannot be anywhere else. A renderer is given
     * a `File` for a dropped file and, by the web's rules, is told nothing about
     * where it came from — `File.path` was Electron's non-standard answer to that
     * and was removed in Electron 32. `webUtils.getPathForFile` replaced it, and
     * it only exists on this side of the bridge.
     *
     * Which is also why the web app must not assume it: a phone dropping a photo
     * into the same UI over the tailnet has no path to be told, and the caller
     * treats null as "this runtime cannot answer that" rather than as a failure.
     *
     * Worth knowing what it now means for a *remote* server: the path is real on
     * the machine holding the window and means nothing on the machine holding the
     * agent. That is a live wrong answer rather than a missing one, and it is the
     * next thing to fix on this bridge.
     */
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file) || null;
      } catch {
        return null;
      }
    },
    /**
     * Replacing this application with a newer one.
     *
     * The whole of what a page may say is "fetch it" and "restart into it".
     * Where the download comes from is `app-update.yml` inside the bundle and
     * is not addressable from here, and Squirrel refuses an archive that is not
     * signed the way the running app is — so this is two verbs and no nouns,
     * which is what makes it something a served page can be handed. See the
     * long note in `main.js`; it also answers `unavailable` for every case
     * except a packaged window showing the server it started itself.
     *
     * `onState` hands back its own unsubscribe rather than relying on the page
     * living as long as the window: Settings is a dialog that opens and closes
     * all afternoon, and a listener per open is a listener per open forever.
     */
    update: {
      state: () => ipcRenderer.invoke("kururu:update-state"),
      onState: (listener) => {
        const relay = (_event, state) => listener(state);
        ipcRenderer.on("kururu:update", relay);
        return () => ipcRenderer.removeListener("kururu:update", relay);
      },
      download: () => ipcRenderer.send("kururu:update-download"),
      install: () => ipcRenderer.send("kururu:update-install"),
    },
    /**
     * The talk key everywhere, and the pill that floats over every app.
     *
     * Two pages use this and they are the same build. The window asks whether
     * the native hook is on, is told when that changes, may switch it, and
     * sends its own gestures — the mic button, Escape — to be acted on by the
     * one page that holds the microphone while the hook is on. That page is
     * the floating pill, loaded with `?pill`, which is the only webContents
     * `onKey` ever delivers to and the only one `report` is accepted from;
     * `main.js` checks the sender. A served page in the window can therefore
     * switch the hook and talk through it, which is the same thing its mic
     * button already does, and nothing more.
     */
    voice: {
      global: () => ipcRenderer.invoke("kururu:voice-global"),
      onGlobal: (listener) => {
        const relay = (_event, state) => listener(state);
        ipcRenderer.on("kururu:voice-global", relay);
        return () => ipcRenderer.removeListener("kururu:voice-global", relay);
      },
      setGlobal: (on) => ipcRenderer.send("kururu:voice-set-global", on === true),
      setAltSpace: (on) => ipcRenderer.send("kururu:voice-set-altspace", on === true),
      gesture: (gesture) => ipcRenderer.send("kururu:voice-gesture", String(gesture)),
      pause: (on) => ipcRenderer.send("kururu:voice-pause", on === true),
      openInputMonitoring: () => ipcRenderer.send("kururu:voice-open-settings"),
      onKey: (listener) => {
        const relay = (_event, gesture) => listener(String(gesture));
        ipcRenderer.on("kururu:talk", relay);
        return () => ipcRenderer.removeListener("kururu:talk", relay);
      },
      report: (state) => ipcRenderer.send("kururu:pill", state),
      onLocate: (listener) => {
        const relay = () => listener();
        ipcRenderer.on("kururu:pill-locate", relay);
        if (pendingLocate) {
          pendingLocate = false;
          listener();
        }
        return () => ipcRenderer.removeListener("kururu:pill-locate", relay);
      },
    },
    /**
     * Cards popped out as windows of their own, over every application.
     *
     * Two kinds of page use this, as with the voice. The window pops a card
     * out, is told which cards are up so its menus can say "bring it
     * forward", and is asked to show a card on its board. A note window's
     * page — `?note=` — asks which card it is, says what it is showing, and
     * folds, closes or leaves itself. `main.js` checks the sender of each:
     * only the main window pops a card out, and a note's verbs act on the
     * note whose page sent them and no other, so the most a served page can
     * do here is put a card of its own server over the screen, which its
     * menu already does.
     */
    notes: {
      popOut: (ask) => ipcRenderer.invoke("kururu:note-pop", ask && typeof ask === "object" ? ask : {}),
      list: () => ipcRenderer.invoke("kururu:note-list"),
      onList: (listener) => {
        const relay = (_event, list) => listener(Array.isArray(list) ? list : []);
        ipcRenderer.on("kururu:note-list", relay);
        return () => ipcRenderer.removeListener("kururu:note-list", relay);
      },
      onShowCard: (listener) => {
        const relay = (_event, cardId) => {
          if (typeof cardId === "string") listener(cardId);
        };
        ipcRenderer.on("kururu:show-card", relay);
        if (pendingCard !== undefined) {
          const cardId = pendingCard;
          pendingCard = undefined;
          listener(cardId);
        }
        return () => ipcRenderer.removeListener("kururu:show-card", relay);
      },
      self: () => ipcRenderer.invoke("kururu:note-self"),
      onSelf: (listener) => {
        const relay = (_event, self) => listener(self);
        ipcRenderer.on("kururu:note-self", relay);
        return () => ipcRenderer.removeListener("kururu:note-self", relay);
      },
      onFocus: (listener) => {
        const relay = (_event, focused) => listener(focused === true);
        ipcRenderer.on("kururu:note-focus", relay);
        return () => ipcRenderer.removeListener("kururu:note-focus", relay);
      },
      report: (state) => ipcRenderer.send("kururu:note-report", state && typeof state === "object" ? state : {}),
      fold: (collapsed) => ipcRenderer.send("kururu:note-fold", collapsed === true),
      close: () => ipcRenderer.send("kururu:note-close"),
      toBoard: () => ipcRenderer.send("kururu:note-board"),
      raiseMain: () => ipcRenderer.send("kururu:note-raise"),
    },
  });
}
