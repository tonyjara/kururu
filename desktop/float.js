/**
 * The floating Kuru: a logo over every application, and the conversation
 * behind a click on it.
 *
 * Kuru's drawer is a column of the window, so talking to Kuru meant bringing
 * the window to the front — and the things said to Kuru are mostly said from
 * somewhere else: the editor, a browser, a call. The floating pill
 * (`talkkey.js`) already put the voice over everything; this is the same for
 * the conversation, on the model of a web page's chat bubble. A small logo,
 * dragged anywhere and left there; a click opens the chat against it and a
 * second click shuts it.
 *
 * **Two windows, and the logo never changes.** The logo is a panel that
 * cannot take the focus, so pressing or dragging it never takes the keys
 * from whatever was being typed into. The chat is a second panel that can —
 * it has a box to type in — and takes them without bringing the application
 * forward, as a note does (`notes.js`). One window that grew when the chat
 * opened would have to move its origin and redraw the logo in the same
 * frame, and a frame late is a logo that jumps; a logo that is its own
 * window is never touched by anything the chat does.
 *
 * **Both are pages of the same build** (`?float=logo`, `?float=panel`, which
 * is `web/src/components/Float.tsx`), each a client of the server like the
 * pill and the notes: the chat is Kuru's drawer and the Needs drawer
 * themselves, not copies of them. What is kept here is only what a page
 * cannot know: where the logo is, whether the chat is open, and how tall and
 * how wide it was dragged — `desktop.json`'s `float`. Where the chat goes is never kept:
 * it is worked out against the logo each time (`floatshape.js`).
 *
 * **The voice moves here while this is on.** The pill is still the one voice
 * client — the microphone, the player and the pen's tools are its page's —
 * but its window is docked to the logo's row (`dock`, which `TalkKey.place`
 * asks) and its page draws a waveform there instead of the pill. So nothing
 * of the voice is relayed or drawn twice, and switching this off is the pill
 * exactly as it was.
 *
 * Only the logo's own webContents may press or drag it, and only the chat's
 * may resize or close it, both checked in `main.js`.
 */
const { BrowserWindow, Menu, screen, shell } = require("electron");
const { EventEmitter } = require("node:events");
const { editMenuTemplate } = require("./editmenu");
const { neverActivates, staysUp } = require("./stays");
const { LOGO, PANEL_FLOOR, adoptFloat, draggedHeight, draggedWidth, heldInside, logoBox, panelBox, placeOf, reach, waveBox, waveWidth } = require("./floatshape");

/** As in `talkkey.js`: macOS is still moving windows for a while after a display changes. */
const SETTLE_MS = [600, 2500];
/** The chat's fade, in and out: quick enough to feel like the click, long enough not to pop. */
const FADE_MS = 130;
const FADE_STEP_MS = 16;
/** How long after the last move of the logo its place is written down. */
const SAVE_AFTER_MS = 300;
/** The chat's ground until its page has drawn: `--chrome` in `web/src/styles.css`. */
const GROUND = "#21222c";

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Whether an address is the chat's own page, on the origin its pages come from. */
function isChatPage(url, page) {
  try {
    const to = new URL(url);
    return Boolean(page) && to.origin === originOf(page) && to.pathname === "/" && to.searchParams.get("float") === "panel";
  } catch {
    return false;
  }
}

/** The displays a logo may be put on, as `floatshape.js` reads them. */
function displays() {
  const all = screen.getAllDisplays();
  const real = all.filter((d) => d.detected !== false && d.workArea.width > 0 && d.workArea.height > 0);
  return (real.length > 0 ? real : all).map((d) => ({ id: d.id, workArea: d.workArea }));
}

/** Where a logo with no place of its own lands: the display under the pointer, or the primary one. */
function homeDisplay(all) {
  let at = null;
  try {
    at = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  } catch {
    // No pointer to ask.
  }
  const primary = screen.getPrimaryDisplay();
  return all.find((d) => d.id === at?.id) ?? all.find((d) => d.id === primary.id) ?? all[0] ?? null;
}

class FloatKuru extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.preloadPath
   * @param {boolean} options.debug  relay the pages' consoles to stderr
   * @param {object} options.saved  `float` from `desktop.json`
   * @param {(float: object) => void} options.save
   * @param {() => void} options.redock  the pill placed again against the logo, or back where it was (`TalkKey.redock`)
   */
  constructor({ preloadPath, debug = false, saved, save, redock = () => {} }) {
    super();
    this.preloadPath = preloadPath;
    this.debug = debug;
    this.save = save;
    this.redock = redock;
    const kept = adoptFloat(saved);
    this.enabled = kept.on;
    /** @type {{ displayId: number, x: number, y: number } | null} */
    this.placeKept = kept.place;
    this.height = kept.height;
    this.width = kept.width;
    /** The origin the pages come from — the pill's — or null while there is none. */
    this.page = null;
    /** @type {import("electron").BrowserWindow | null} */
    this.logo = null;
    /** @type {import("electron").BrowserWindow | null} */
    this.panel = null;
    this.logoLoaded = null;
    this.panelLoaded = null;
    /** The chat is open, or on its way to being. */
    this.open = false;
    /** The chat's box as last worked out against the logo. @type {ReturnType<typeof panelBox> | null} */
    this.box = null;
    /** The logo is being dragged: where in it the pointer took hold. @type {{ dx: number, dy: number } | null} */
    this.dragging = null;
    /**
     * The chat's far edge or corner is being dragged: which of its two sizes
     * follow the pointer, and how far from each edge the pointer took hold.
     * @type {{ tall: boolean, wide: boolean, offY: number, offX: number } | null}
     */
    this.gripping = null;
    /**
     * When the chat last had the keyboard, opened or clicked into, in
     * `Date.now()`: the window's page weighs it against its own drawer's box
     * to say which one a card's reference goes into (`kuruTarget`).
     */
    this.chatAt = 0;
    this.fadeTimer = null;
    this.saveTimer = null;
    this.watchingDisplays = false;
    this.settleTimers = [];
  }

  // --- what the pages are told -----------------------------------------------------

  /**
   * On or off, whether the chat is open and which way it opened, and how
   * wide the pill's page draws the waveform. Every page of ours is told: the
   * logo and the chat draw from it, the pill's page changes its shape with
   * `on`, and the window's Settings shows the switch.
   */
  state() {
    const logo = this.logoBounds();
    const area = logo ? this.areaOf(logo) : null;
    const box = this.open ? this.box : null;
    return {
      on: this.enabled,
      open: this.open,
      side: this.box?.side ?? "above",
      reach: logo && area ? reach(logo, area) : "left",
      wave: waveWidth(box),
      // What this build of the app is and can do, for pages that may be
      // newer than the app they are drawn in: how big the logo's window is,
      // which its page has to fill exactly; and that the chat's width can
      // be dragged as well as its height, and a screen pen started from it.
      logo: LOGO,
      wide: true,
      pen: true,
      // And that what is handed to Kuru in the window can be put in the
      // chat's box (`give`), and when the chat last had the keyboard.
      give: true,
      chatAt: this.chatAt,
    };
  }

  changed() {
    this.emit("change", this.state());
  }

  keep() {
    this.save({ on: this.enabled, place: this.placeKept, height: this.height, width: this.width });
  }

  // --- on and off --------------------------------------------------------------------

  setEnabled(on) {
    on = on === true;
    if (on === this.enabled) return;
    this.enabled = on;
    this.keep();
    if (on) this.ensureLogo();
    else this.destroyWindows();
    this.changed();
    this.redock();
  }

  /**
   * Where the pages come from, as the pill's and the notes': the server's own
   * page or the checkout's vite in front of it. The logo comes up the first
   * time there is one, and both move to a new origin when it changes; a
   * server restart is the same origin, and each page reconnects by itself.
   */
  setPage(origin) {
    const was = this.page;
    this.page = origin;
    if (!origin || !this.enabled) return;
    if (origin !== was) {
      if (this.logo && this.logoLoaded !== origin) this.loadLogo();
      if (this.panel && this.panelLoaded !== origin) this.loadPanel();
    }
    this.ensureLogo();
  }

  /** Both pages loaded again: the tray's rebuild of the built page, and View → Reload. */
  reloadAll() {
    if (this.logo) this.loadLogo();
    if (this.panel) this.loadPanel();
  }

  loadLogo() {
    if (!this.logo || this.logo.isDestroyed() || !this.page) return;
    this.logoLoaded = this.page;
    void this.logo.loadURL(`${this.page}/?float=logo`).catch(() => {});
  }

  loadPanel() {
    if (!this.panel || this.panel.isDestroyed() || !this.page) return;
    this.panelLoaded = this.page;
    void this.panel.loadURL(`${this.page}/?float=panel`).catch(() => {});
  }

  // --- the logo ----------------------------------------------------------------------

  ensureLogo() {
    if (this.logo || !this.enabled || !this.page) return;
    this.watchDisplays();
    const logo = new BrowserWindow({
      width: LOGO,
      height: LOGO,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Never focusable, so pressing or dragging it takes no keys from the
      // application in front; and a press on it presses, with that
      // application in front, rather than only waking the panel.
      focusable: false,
      acceptFirstMouse: true,
      alwaysOnTop: true,
      type: "panel",
      title: "Kuru",
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        // Mostly not the window in front, and it hops while Kuru thinks.
        backgroundThrottling: false,
      },
    });
    // A click on it never brings kururu forward, before the window server too (`stays.js`).
    neverActivates(logo);
    logo.setAlwaysOnTop(true, "floating");
    // On every space and over full-screen apps, without the app becoming an
    // accessory for a moment to get there — `notes.js` has why.
    logo.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    // And while kururu is hidden, as by a workspace switch (`stays.js`).
    staysUp(logo);
    const contents = logo.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    if (this.debug) contents.on("console-message", (event, ...legacy) => console.log(`kururu float: ${event?.message ?? legacy[1]}`));
    contents.on("did-fail-load", (_event, code, text, url) => {
      if (this.debug) console.error(`kururu float: ${url} failed to load (${code} ${text})`);
    });
    contents.on("did-finish-load", () => {
      if (this.logo !== logo || logo.isDestroyed()) return;
      this.placeLogo();
      logo.showInactive();
      this.changed();
      // Again now that the logo is up: a pill that was showing while it loaded was left at its own place.
      this.redock();
    });
    // A renderer that went is a logo that went; one load again, then it is left to the switch.
    let revived = 0;
    contents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit" || Date.now() - revived < 30_000) return;
      revived = Date.now();
      this.loadLogo();
    });
    logo.on("closed", () => {
      if (this.logo === logo) this.logo = null;
    });
    this.logo = logo;
    this.logoLoaded = null;
    this.placeLogo();
    this.loadLogo();
    // The chat's page is made with the logo's and kept, hidden, so the first
    // click opens a conversation that is already there and not a page load.
    this.ensurePanel();
  }

  logoBounds() {
    return this.logo && !this.logo.isDestroyed() ? this.logo.getBounds() : null;
  }

  /** The work area a box is over: its middle's display, as `screen` says now. */
  areaOf(bounds) {
    return screen.getDisplayNearestPoint({ x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }).workArea;
  }

  /** The logo where it was left, on a display that is there; and whatever hangs off it placed again. */
  placeLogo() {
    if (!this.logo || this.logo.isDestroyed()) return;
    const all = displays();
    const box = logoBox(this.placeKept, all, homeDisplay(all));
    this.moveLogo(box.x, box.y);
    this.follow();
  }

  moveLogo(x, y) {
    if (this.logo && !this.logo.isDestroyed()) this.logo.setBounds({ x, y, width: LOGO, height: LOGO });
  }

  /** The chat and the waveform put where the logo now is, and every page told if that changed which way they face. */
  follow() {
    const was = JSON.stringify(this.state());
    if (this.open) this.placePanel();
    if (JSON.stringify(this.state()) !== was) this.changed();
    this.redock();
  }

  // --- dragging the logo ---------------------------------------------------------------

  /**
   * A drag is the page's to notice and this process's to do. A draggable
   * region (`-webkit-app-region`) swallows every pointer event that lands in
   * it, the click included, and the logo is all click; so the page takes the
   * press, tells apart a click from a drag by how far it travelled, and says
   * `start`, `move` and `end`. Where the pointer is comes from `screen` here
   * rather than from the page's events, whose coordinates are relative to a
   * window that is moving under them.
   */
  drag(phase) {
    const logo = this.logo;
    if (!logo || logo.isDestroyed()) return;
    if (phase === "start") {
      const at = screen.getCursorScreenPoint();
      const [x, y] = /** @type {[number, number]} */ (logo.getPosition());
      this.dragging = { dx: at.x - x, dy: at.y - y };
      return;
    }
    if (!this.dragging) return;
    if (phase === "move") {
      const at = screen.getCursorScreenPoint();
      const held = heldInside(at.x - this.dragging.dx, at.y - this.dragging.dy, screen.getDisplayNearestPoint(at).workArea);
      this.moveLogo(held.x, held.y);
      this.follow();
      return;
    }
    this.dragging = null;
    this.rememberPlace();
  }

  /**
   * The tray's reset: forget where the logo was dragged to and put it back
   * in its corner of the display under the pointer — the way out for a logo
   * left somewhere it cannot be seen or reached.
   */
  resetPlace() {
    this.placeKept = null;
    this.keep();
    this.placeLogo();
    if (this.logo && !this.logo.isDestroyed()) this.logo.showInactive();
  }

  /** Where the logo is now, written down as a share of the display it is on. */
  rememberPlace() {
    const bounds = this.logoBounds();
    if (!bounds) return;
    const display = screen.getDisplayNearestPoint({ x: Math.round(bounds.x + LOGO / 2), y: Math.round(bounds.y + LOGO / 2) });
    this.placeKept = placeOf(bounds, { id: display.id, workArea: display.workArea });
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.keep(), SAVE_AFTER_MS);
  }

  // --- the chat ----------------------------------------------------------------------

  ensurePanel() {
    if (this.panel || !this.enabled || !this.page) return;
    const panel = new BrowserWindow({
      width: this.width,
      height: this.height,
      minHeight: PANEL_FLOOR,
      show: false,
      frame: false,
      // What floats over a full-screen application and never activates the
      // app: a click in it takes the keys and leaves whatever was in front
      // where it was, as a note does.
      type: "panel",
      alwaysOnTop: true,
      // Its size is dragged by the page's own handles, on the edges away
      // from the logo, so the logo's side of it never moves (`grip`).
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: true,
      backgroundColor: GROUND,
      title: "Kuru",
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // Typing in it takes the keys and leaves the app in front where it was:
    // a click here that brought kururu forward would have a workspace
    // switcher follow it to kururu's window (`stays.js`).
    neverActivates(panel);
    panel.setAlwaysOnTop(true, "floating");
    panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    staysUp(panel);
    const contents = panel.webContents;
    // A link in a reply is somewhere else's business, and the chat is never
    // navigated away from itself.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      // Loading itself again is the page's own business: it does that in place of a hot update (`Float.tsx`).
      if (isChatPage(url, this.page)) return;
      event.preventDefault();
      if (/^https?:/i.test(url) && originOf(url) !== originOf(this.page ?? "")) void shell.openExternal(url);
    });
    // Cut, Copy and Paste in the box, and Copy on a reply's words, as in the window.
    contents.on("context-menu", (_event, params) => {
      const template = editMenuTemplate(params);
      if (!template) return;
      for (const item of template) {
        if (item.id === "replace") item.click = () => contents.replaceMisspelling(/** @type {string} */ (item.word));
        if (item.id === "learn") item.click = () => contents.session.addWordToSpellCheckerDictionary(/** @type {string} */ (item.word));
      }
      Menu.buildFromTemplate(template).popup({ window: panel });
    });
    if (this.debug) contents.on("console-message", (event, ...legacy) => console.log(`kururu float chat: ${event?.message ?? legacy[1]}`));
    contents.on("did-fail-load", (_event, code, text, url) => {
      if (this.debug) console.error(`kururu float chat: ${url} failed to load (${code} ${text})`);
    });
    let revived = 0;
    contents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit" || Date.now() - revived < 30_000) return;
      revived = Date.now();
      this.loadPanel();
    });
    panel.on("focus", () => {
      if (this.panel !== panel) return;
      this.chatAt = Date.now();
      this.changed();
    });
    panel.on("closed", () => {
      if (this.panel !== panel) return;
      this.panel = null;
      if (this.open) {
        this.open = false;
        this.changed();
      }
    });
    this.panel = panel;
    this.panelLoaded = null;
    this.loadPanel();
  }

  /** The logo was pressed: the chat, or away with it. */
  toggle() {
    if (this.open) this.closePanel();
    else this.openPanel();
  }

  openPanel() {
    if (!this.enabled || !this.logo || this.logo.isDestroyed()) return;
    this.ensurePanel();
    const panel = this.panel;
    if (!panel || panel.isDestroyed()) return;
    this.open = true;
    this.placePanel();
    // Told before it is shown, so the page has the drawer in it by the time
    // the window is anything but clear.
    this.changed();
    panel.setOpacity(0);
    panel.show();
    panel.focus();
    this.fade(panel, 1);
    this.redock();
  }

  closePanel() {
    if (!this.open) return;
    this.open = false;
    this.gripping = null;
    this.changed();
    const panel = this.panel;
    if (panel && !panel.isDestroyed()) this.fade(panel, 0, () => panel.hide());
    this.redock();
  }

  /**
   * The chat's page asking to be seen: something landed in its box while it
   * was shut — the marks of a pen it started — and a box nobody can see is
   * marks nobody knows arrived.
   */
  show() {
    if (!this.open) this.openPanel();
  }

  /**
   * Something handed to Kuru from the window — a card's reference, a quote,
   * a file, the pen's marks, a reply — for the chat's box, which the page
   * there puts in at its cursor (`takeGift` in `web/src/kuru.ts`). The chat
   * comes forward and takes the keyboard, so the gift is the start of a
   * sentence typed where it landed. Opened if it was shut a moment before
   * the window decided; false when there is no chat to be had (off, or no
   * logo), and the window keeps its gift.
   *
   * Sent once the page is there: a chat window just made is still loading,
   * and the preload keeps a gift that lands before the page listens.
   */
  give(gift) {
    if (!this.enabled || !this.logo || this.logo.isDestroyed()) return false;
    if (!this.open) this.openPanel();
    const panel = this.panel;
    if (!panel || panel.isDestroyed()) return false;
    const contents = panel.webContents;
    const send = () => {
      if (!panel.isDestroyed()) contents.send("kururu:float-gift", gift);
    };
    if (contents.isLoading()) contents.once("did-finish-load", send);
    else send();
    panel.moveTop();
    panel.focus();
    return true;
  }

  /** The chat's window against the logo, at the size it was dragged to or as much of it as there is that way. */
  placePanel() {
    const logo = this.logoBounds();
    const panel = this.panel;
    if (!logo || !panel || panel.isDestroyed()) return;
    this.box = panelBox(logo, this.areaOf(logo), this.height, this.width);
    const { x, y, width, height } = this.box;
    panel.setBounds({ x, y, width, height });
  }

  /** The window's opacity walked to `to`, and `then` once it is there; a fade under way is taken over, never raced. */
  fade(win, to, then = () => {}) {
    clearInterval(this.fadeTimer);
    const from = win.getOpacity();
    const steps = Math.max(1, Math.round(FADE_MS / FADE_STEP_MS));
    let step = 0;
    this.fadeTimer = setInterval(() => {
      step++;
      if (win.isDestroyed()) {
        clearInterval(this.fadeTimer);
        return;
      }
      // Eased out: most of the change in the first frames, which is what makes it feel like the click's.
      const t = 1 - (1 - step / steps) ** 2;
      win.setOpacity(from + (to - from) * Math.min(1, t));
      if (step < steps) return;
      clearInterval(this.fadeTimer);
      then();
    }, FADE_STEP_MS);
  }

  /**
   * The chat's far edges dragged, by the page's handles: the edge away from
   * the logo follows the pointer and the logo's side stays, so the chat
   * never comes off the thing it is anchored to. `edge` is which — `height`
   * for the far horizontal edge, `width` for the far vertical one, `both`
   * for the corner between them. As with the logo's drag, the pointer is
   * read from `screen`.
   */
  grip(phase, edge = "height") {
    const panel = this.panel;
    if (!this.open || !this.box || !panel || panel.isDestroyed()) return;
    if (phase === "start") {
      const at = screen.getCursorScreenPoint();
      const box = this.box;
      this.gripping = {
        tall: edge !== "width",
        wide: edge === "width" || edge === "both",
        offY: at.y - (box.side === "above" ? box.y : box.y + box.height),
        offX: at.x - (box.reach === "left" ? box.x : box.x + box.width),
      };
      return;
    }
    const held = this.gripping;
    if (!held) return;
    if (phase === "move") {
      const at = screen.getCursorScreenPoint();
      const height = held.tall ? draggedHeight(this.box, at.y - held.offY) : this.box.height;
      const width = held.wide ? draggedWidth(this.box, at.x - held.offX) : this.box.width;
      if (height === this.box.height && width === this.box.width) return;
      if (held.tall) this.height = height;
      if (held.wide) this.width = width;
      const was = this.state().wave;
      this.placePanel();
      // The waveform runs the chat's width, so a width that changed is told.
      if (this.state().wave !== was) {
        this.changed();
        this.redock();
      }
      return;
    }
    this.gripping = null;
    this.keep();
  }

  // --- who is asking -------------------------------------------------------------------

  isLogo(contents) {
    return Boolean(this.logo && !this.logo.isDestroyed() && this.logo.webContents.id === contents.id);
  }

  isPanel(contents) {
    return Boolean(this.panel && !this.panel.isDestroyed() && this.panel.webContents.id === contents.id);
  }

  // --- the pill, docked ------------------------------------------------------------------

  /**
   * Where the pill's window goes while this is on, for `TalkKey.place`: in
   * the logo's row, on the side with the room. Null while this is off or has
   * no logo up, which leaves the pill where it has always been.
   */
  dock(size) {
    const logo = this.enabled ? this.logoBounds() : null;
    if (!logo || !this.logo?.isVisible()) return null;
    return waveBox(logo, this.areaOf(logo), size);
  }

  // --- displays ------------------------------------------------------------------------

  /** A display plugged in, unplugged or changed: the logo put back on one that is there, now and as the change settles. */
  watchDisplays() {
    if (this.watchingDisplays) return;
    this.watchingDisplays = true;
    const again = () => {
      for (const timer of this.settleTimers) clearTimeout(timer);
      this.placeLogo();
      this.settleTimers = SETTLE_MS.map((ms) => setTimeout(() => this.placeLogo(), ms));
    };
    screen.on("display-added", again);
    screen.on("display-removed", again);
    screen.on("display-metrics-changed", again);
  }

  destroyWindows() {
    clearInterval(this.fadeTimer);
    clearTimeout(this.saveTimer);
    for (const timer of this.settleTimers) clearTimeout(timer);
    this.settleTimers = [];
    this.open = false;
    this.box = null;
    this.dragging = null;
    this.gripping = null;
    const logo = this.logo;
    const panel = this.panel;
    this.logo = null;
    this.panel = null;
    if (logo && !logo.isDestroyed()) logo.destroy();
    if (panel && !panel.isDestroyed()) panel.destroy();
  }

  /** Both windows ended and what is kept left as it stands, for a quit: the next launch brings the logo back where it was. */
  dispose() {
    this.destroyWindows();
  }
}

module.exports = { FloatKuru };
