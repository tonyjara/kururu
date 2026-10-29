/**
 * Cards popped out as windows of their own, over every application.
 *
 * The window's notes (`web/src/components/Notes.tsx`) float over the panes
 * and nothing else: the moment somebody turns to the editor, the browser or
 * a call, the card they were working from is behind it, which is the one
 * thing a note was for. A page cannot put anything over another
 * application. Only this process can, and the floating pill already showed
 * how (`talkkey.js`): a small window kept on top of every space, loading the
 * same web build in a mode that draws one thing (`?note=<card>`, which is
 * `NotePage.tsx`).
 *
 * **The card is the page's, never this file's.** Each note window is a client
 * of the server like the pill — its own socket, the same snapshot — so an
 * edit from the board, from Kuru or from an agent's run is in it on the next
 * message, and its editor is the board's composer through the board's verbs.
 * What is kept here is only what a page cannot know or keep: where the
 * window is, how big, whether it is folded, and whether it is up. That lives
 * in `desktop.json` (`notelist.js` reads it), so a restart puts every note
 * back where it was left, and the title the page last reported rides along
 * so the menu bar can list a note whose window is not up.
 *
 * **Up, away and put away.** A note the menu bar hides is a window ended, not
 * one kept hidden: a page and a socket per card nobody can see is the cost
 * of the pill for nothing. A note of a profile that is not the active one is
 * different — the snapshot carries only the active profile's cards — so its
 * page is kept, hidden, and comes up by itself when that profile is active
 * again, as the window's notes wait under their profile's key.
 *
 * **Over full-screen apps without moving the Dock.** A `panel` window is what
 * macOS lets float over another application's full-screen space, and
 * `setVisibleOnAllWorkspaces` puts it on every space. That call would also,
 * by default, turn the whole app into an accessory for a moment to get the
 * full-screen half — which hides the Dock icon of a window that is open —
 * and the panel type already gives that half, so the transform is skipped.
 * A panel never activates the app: clicking a note to type in it leaves
 * whichever application was in front where it was, and the note takes the
 * keys, as Spotlight does.
 *
 * Only a note window's own webContents may say anything about its note, and
 * only the main window may pop a card out, both checked in `main.js`, so a
 * served page cannot move or close a note it is not.
 *
 * **Kuru's box is the window's.** A note has no drawer, so pointing Kuru at
 * its card — its title bar's button, or its right-click here, which emits
 * `refer` — brings the window up and hands it the card's id, and the window
 * writes the reference the card's menu writes.
 */
const { BrowserWindow, Menu, screen, shell } = require("electron");
const { EventEmitter } = require("node:events");
const { editMenuTemplate } = require("./editmenu");
const {
  NOTE_HEAD,
  NOTE_MIN,
  adoptNotes,
  bringForward,
  cascade,
  changeNote,
  fitOnScreen,
  isCardId,
  overOpen,
  trimNotes,
} = require("./notelist");

/**
 * A note somebody is not using, a little see-through: enough to say it is
 * not the window with the keys, not so much that it cannot be read over a
 * busy screen. The page draws less chrome at the same moment.
 */
const UNFOCUSED_OPACITY = 0.94;
/** How long after a drag or a resize the box is written down: once, when it has stopped. */
const SAVE_AFTER_MS = 300;
/** As in `talkkey.js`: macOS is still moving windows for a while after a display changes. */
const SETTLE_MS = [600, 2500];
/** Where under the top of the window or display a new note goes: below the window's top band and a board's header. */
const TOP_IN_WINDOW = 64;
const TOP_ON_DISPLAY = 48;

/** A colour the page reports for the window behind it, as `getComputedStyle` spells one. */
function isColor(value) {
  return typeof value === "string" && /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%/]+\))$/i.test(value);
}

function short(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

class NoteWindows extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.preloadPath
   * @param {boolean} options.debug  relay each note page's console to stderr
   * @param {object[]} options.saved  `notes` from `desktop.json`
   * @param {(notes: object[]) => void} options.save
   */
  constructor({ preloadPath, debug = false, saved, save }) {
    super();
    this.preloadPath = preloadPath;
    this.debug = debug;
    this.save = save;
    this.records = adoptNotes(saved);
    /** By card id: the window, whether its page has said what it is showing, and what it said. */
    this.open = new Map();
    /** The origin the note pages come from — the pill's — or null while there is none. */
    this.page = null;
    this.watchingDisplays = false;
    this.settleTimers = [];
  }

  // --- the list -------------------------------------------------------------------

  /** Every note that is not closed, front last, as the menu bar and the window's menus read them. */
  list() {
    return this.records
      .filter((note) => note.state !== "closed")
      .map((note) => {
        const entry = this.open.get(note.cardId);
        return {
          cardId: note.cardId,
          title: note.title,
          code: note.code,
          profileName: note.profileName,
          state: note.state,
          // Up but not drawn: its profile is not the active one, or its page has not said yet.
          away: entry?.present === "away",
          waiting: note.state === "shown" && (!entry || entry.present === null),
        };
      });
  }

  record(cardId) {
    return this.records.find((note) => note.cardId === cardId) ?? null;
  }

  /** Written down and told, after every change to which notes there are or what they say. */
  commit(next) {
    this.records = trimNotes(next);
    this.save(this.records);
    this.emit("change", this.list());
  }

  // --- the page ---------------------------------------------------------------------

  /**
   * Where the note pages come from, as the pill's: the server's own page or
   * the checkout's vite in front of it. Every note that should be up is
   * brought up the first time there is one, and moved to a new origin when
   * it changes; a server restart is the same origin, and each page
   * reconnects by itself.
   */
  setPage(origin) {
    const was = this.page;
    this.page = origin;
    if (!origin) return;
    if (origin !== was) {
      for (const [cardId, entry] of this.open) {
        if (entry.loaded !== origin) this.load(cardId);
      }
    }
    for (const note of this.records) {
      if (note.state === "shown" && !this.open.has(note.cardId)) this.create(note);
    }
  }

  /** Every note page loaded again — the tray's rebuild of the built page, which no vite pushes. */
  reloadAll() {
    for (const cardId of this.open.keys()) this.load(cardId);
  }

  load(cardId) {
    const entry = this.open.get(cardId);
    if (!entry || !this.page || entry.win.isDestroyed()) return;
    entry.loaded = this.page;
    void entry.win.loadURL(`${this.page}/?note=${encodeURIComponent(cardId)}`).catch(() => {});
  }

  // --- the windows ------------------------------------------------------------------

  /** A window for a note, made hidden: it is shown when its page says what it is showing (`report`). */
  create(note) {
    if (this.open.has(note.cardId) || !this.page) return;
    this.watchDisplays();
    const box = fitOnScreen({ x: note.x, y: note.y, width: note.width, height: note.collapsed ? NOTE_HEAD : note.height }, displays());
    const win = new BrowserWindow({
      ...box,
      minWidth: NOTE_MIN.width,
      minHeight: note.collapsed ? NOTE_HEAD : NOTE_MIN.height,
      show: false,
      frame: false,
      // What macOS lets float over a full-screen application, and what never
      // activates the app it belongs to — see the header.
      type: "panel",
      alwaysOnTop: true,
      resizable: !note.collapsed,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: true,
      // The page reports its own ground once it is drawn; this is the gap before.
      backgroundColor: "#0d0f0e",
      title: note.title || "Note",
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setAlwaysOnTop(true, "floating");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setOpacity(UNFOCUSED_OPACITY);

    const contents = win.webContents;
    // A link in a card is somewhere else's business, as in the window — and a
    // note is never navigated away from its card, by a link or anything else.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      event.preventDefault();
      if (/^https?:/i.test(url) && originOf(url) !== originOf(this.page)) void shell.openExternal(url);
    });
    // Cut, Copy and Paste in the card's editor, as in the window. Anywhere
    // else on a card that is there, its menu's "Reference in Kuru" too —
    // never in a field, where a right-click is about the words in it.
    contents.on("context-menu", (_event, params) => {
      const template = editMenuTemplate(params) ?? [];
      for (const item of template) {
        if (item.id === "replace") item.click = () => contents.replaceMisspelling(item.word);
        if (item.id === "learn") item.click = () => contents.session.addWordToSpellCheckerDictionary(item.word);
      }
      if (!params.isEditable && entry.present === "here") {
        if (template.length) template.push({ type: "separator" });
        template.push({ label: "Reference in Kuru", click: () => this.emit("refer", note.cardId) });
      }
      if (template.length === 0) return;
      Menu.buildFromTemplate(template).popup({ window: win });
    });
    if (this.debug) {
      contents.on("console-message", (event, ...legacy) => console.log(`kururu note: ${event?.message ?? legacy[1]}`));
    }
    contents.on("did-fail-load", (_event, code, text, url) => {
      if (this.debug) console.error(`kururu note: ${url} failed to load (${code} ${text})`);
    });
    // A renderer that went is a note that went blank; one load again, then it is left to the menu bar.
    let revived = 0;
    contents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit" || Date.now() - revived < 30_000) return;
      revived = Date.now();
      this.load(note.cardId);
    });

    win.on("focus", () => {
      win.setOpacity(1);
      if (!contents.isDestroyed()) contents.send("kururu:note-focus", true);
    });
    win.on("blur", () => {
      win.setOpacity(UNFOCUSED_OPACITY);
      if (!contents.isDestroyed()) contents.send("kururu:note-focus", false);
    });
    const remember = () => {
      clearTimeout(entry.saveTimer);
      entry.saveTimer = setTimeout(() => this.remember(note.cardId), SAVE_AFTER_MS);
    };
    // Every move and resize, settled: `moved` and `resized` are only the
    // ends of a drag by hand, and a box the system or this file set is as
    // much where the note is.
    win.on("move", remember);
    win.on("resize", remember);
    win.on("closed", () => {
      clearTimeout(entry.saveTimer);
      if (this.open.get(note.cardId) === entry) this.open.delete(note.cardId);
    });

    const entry = { win, loaded: null, present: null, head: NOTE_HEAD, saveTimer: null, shownOnce: false };
    this.open.set(note.cardId, entry);
    this.load(note.cardId);
  }

  /** The box a window was dragged or resized to, written down — a folded note's height is its bar's and is not kept. */
  remember(cardId) {
    const entry = this.open.get(cardId);
    const note = this.record(cardId);
    if (!entry || !note || entry.win.isDestroyed()) return;
    const { x, y, width, height } = entry.win.getBounds();
    const patch = note.collapsed ? { x, y, width } : { x, y, width, height };
    if (Object.entries(patch).every(([key, value]) => note[key] === value)) return;
    this.records = changeNote(this.records, cardId, patch);
    this.save(this.records);
  }

  /** End a note's window, leaving its record as it is: hiding, closing and quitting all come through here. */
  end(cardId) {
    const entry = this.open.get(cardId);
    if (!entry) return;
    this.remember(cardId);
    this.open.delete(cardId);
    if (!entry.win.isDestroyed()) entry.win.destroy();
  }

  /** Up, in front of the other notes, without taking the keys from whatever has them. */
  front(cardId) {
    const entry = this.open.get(cardId);
    if (!entry || entry.win.isDestroyed() || entry.present === null || entry.present === "away") return;
    entry.win.showInactive();
    entry.win.moveTop();
    entry.shownOnce = true;
  }

  // --- the verbs ----------------------------------------------------------------------

  /**
   * A card popped out: its note up, unfolded and in front — where it was last
   * left, if it has had one, and otherwise at `bounds`, or the next place along
   * against `anchor`. Popping out a card that is a note already brings that
   * note forward, which is what the person wanted: to see it. Past
   * `OPEN_MAX`, the note up longest is put away.
   */
  popOut({ cardId, profileKey, profileName, title, code, bounds, anchor, fromWindow }) {
    if (!isCardId(cardId) || typeof profileKey !== "string" || !profileKey) return false;
    const had = this.record(cardId);
    const facts = {
      profileKey: short(profileKey, 64),
      ...(profileName ? { profileName: short(profileName, 80) } : {}),
      ...(title ? { title: short(title, 200) } : {}),
      ...(code ? { code: short(code, 40) } : {}),
    };
    let next;
    if (had) {
      if (had.collapsed) this.remember(cardId);
      next = bringForward(this.records, cardId, { ...facts, state: "shown", collapsed: false });
    } else {
      const up = this.records.filter((note) => note.state === "shown").length;
      const place = anchor ?? this.anchorUnderPointer();
      const box = fitOnScreen(bounds ?? cascade(place, up, fromWindow ? TOP_IN_WINDOW : TOP_ON_DISPLAY), displays());
      next = [
        ...this.records,
        { cardId, profileName: "", title: "", code: "", ...facts, ...box, collapsed: false, state: "shown" },
      ];
    }
    for (const id of overOpen(next)) {
      if (id === cardId) continue;
      next = changeNote(next, id, { state: "hidden" });
      this.end(id);
    }
    this.commit(next);
    if (!this.open.has(cardId)) {
      this.create(this.record(cardId));
      return true;
    }
    if (had?.collapsed) {
      this.shape(cardId);
      this.tellSelf(cardId);
    }
    this.front(cardId);
    return true;
  }

  /** Where a note popped out from the menu bar goes: against the work area of the display the pointer is on. */
  anchorUnderPointer() {
    try {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    } catch {
      return screen.getPrimaryDisplay().workArea;
    }
  }

  /** The menu bar's tick beside a note: up, made if it is not, or put away. */
  setShown(cardId, shown) {
    const note = this.record(cardId);
    if (!note || note.state === "closed") return;
    if (shown) {
      this.commit(changeNote(this.records, cardId, { state: "shown" }));
      if (this.open.has(cardId)) this.front(cardId);
      else this.create(this.record(cardId));
      return;
    }
    this.end(cardId);
    this.commit(changeNote(this.records, cardId, { state: "hidden" }));
  }

  showAll() {
    const hidden = this.records.filter((note) => note.state === "hidden").map((note) => note.cardId);
    if (hidden.length === 0) {
      for (const cardId of this.open.keys()) this.front(cardId);
      return;
    }
    let next = this.records;
    for (const cardId of hidden) next = changeNote(next, cardId, { state: "shown" });
    for (const cardId of overOpen(next)) next = changeNote(next, cardId, { state: "hidden" });
    this.commit(next);
    for (const note of this.records) {
      if (note.state !== "shown") continue;
      if (this.open.has(note.cardId)) this.front(note.cardId);
      else this.create(note);
    }
  }

  hideAll() {
    let next = this.records;
    for (const note of this.records) {
      if (note.state !== "shown") continue;
      this.end(note.cardId);
      next = changeNote(next, note.cardId, { state: "hidden" });
    }
    this.commit(next);
  }

  /** Closed: the window ended and the note off the list, its box kept for the next time the card is popped out. */
  close(cardId) {
    if (!this.record(cardId)) return;
    this.end(cardId);
    this.commit(changeNote(this.records, cardId, { state: "closed" }));
  }

  // --- what a note's page says ---------------------------------------------------------

  /** The note a webContents is the page of, or null for anything that is not a note window. */
  cardOf(contents) {
    for (const [cardId, entry] of this.open) {
      if (!entry.win.isDestroyed() && entry.win.webContents.id === contents.id) return cardId;
    }
    return null;
  }

  /** What a note's page is told it is: which card, whose, and whether it is folded. */
  self(cardId) {
    const note = this.record(cardId);
    return note ? { cardId: note.cardId, profileKey: note.profileKey, collapsed: note.collapsed } : null;
  }

  tellSelf(cardId) {
    const entry = this.open.get(cardId);
    const self = this.self(cardId);
    if (entry && self && !entry.win.isDestroyed()) entry.win.webContents.send("kururu:note-self", self);
  }

  /**
   * The page saying what it is showing: its card (`here`), nothing because
   * its profile is not the active one (`away`), or that the card is no longer
   * there (`gone`, which is drawn so it can be closed). With the card's title
   * and code for the menu bar, the ground it is drawn on, and how tall its
   * title bar is, which is what a folded note is.
   */
  report(cardId, state) {
    const entry = this.open.get(cardId);
    const note = this.record(cardId);
    if (!entry || !note || !state || typeof state !== "object" || entry.win.isDestroyed()) return;
    const present = ["here", "away", "gone"].includes(state.present) ? state.present : null;
    if (!present) return;
    if (isColor(state.background)) entry.win.setBackgroundColor(state.background);
    if (Number.isFinite(state.head) && state.head >= 20 && state.head <= 80) {
      const head = Math.round(state.head);
      if (head !== entry.head) {
        entry.head = head;
        if (note.collapsed) this.shape(cardId);
      }
    }
    const facts = {};
    if (typeof state.title === "string" && state.title && state.title !== note.title) facts.title = short(state.title, 200);
    if (typeof state.code === "string" && state.code && state.code !== note.code) facts.code = short(state.code, 40);
    if (typeof state.profileName === "string" && state.profileName && state.profileName !== note.profileName) {
      facts.profileName = short(state.profileName, 80);
    }
    const was = entry.present;
    entry.present = present;
    if (Object.keys(facts).length) {
      if (facts.title) entry.win.setTitle(facts.title);
      this.commit(changeNote(this.records, cardId, facts));
    } else if (was !== present) this.emit("change", this.list());
    if (present === "away") {
      if (entry.win.isVisible()) entry.win.hide();
      return;
    }
    if (note.state === "shown" && (!entry.win.isVisible() || was === "away" || was === null)) this.front(cardId);
  }

  /** Folded to the title bar, or opened again — the window is the note, so it is the window that changes height. */
  fold(cardId, collapsed) {
    const note = this.record(cardId);
    if (!note || note.collapsed === collapsed) return;
    this.remember(cardId);
    this.records = changeNote(this.records, cardId, { collapsed });
    this.save(this.records);
    this.shape(cardId);
    this.tellSelf(cardId);
  }

  /** The window made the height its note is: the bar alone, fixed, or the box last left, resizable and on screen. */
  shape(cardId) {
    const entry = this.open.get(cardId);
    const note = this.record(cardId);
    if (!entry || !note || entry.win.isDestroyed()) return;
    const win = entry.win;
    const [x, y] = win.getPosition();
    if (note.collapsed) {
      win.setResizable(false);
      win.setMinimumSize(NOTE_MIN.width, entry.head);
      win.setBounds({ x, y, width: note.width, height: entry.head });
    } else {
      win.setMinimumSize(NOTE_MIN.width, NOTE_MIN.height);
      win.setResizable(true);
      win.setBounds(fitOnScreen({ x, y, width: note.width, height: note.height }, displays()));
    }
  }

  // --- displays ------------------------------------------------------------------------

  /**
   * A display plugged in, unplugged, or changed under the notes: each one
   * held on a display that is there, now and again as the change settles
   * (`talkkey.js` says why once is not enough).
   */
  watchDisplays() {
    if (this.watchingDisplays) return;
    this.watchingDisplays = true;
    const again = () => {
      for (const timer of this.settleTimers) clearTimeout(timer);
      this.refit();
      this.settleTimers = SETTLE_MS.map((ms) => setTimeout(() => this.refit(), ms));
    };
    screen.on("display-added", again);
    screen.on("display-removed", again);
    screen.on("display-metrics-changed", again);
  }

  refit() {
    const all = displays();
    for (const [cardId, entry] of this.open) {
      if (entry.win.isDestroyed()) continue;
      const now = entry.win.getBounds();
      const fit = fitOnScreen(now, all);
      if (fit.x !== now.x || fit.y !== now.y || fit.width !== now.width || fit.height !== now.height) {
        entry.win.setBounds(fit);
        this.remember(cardId);
      }
    }
  }

  /** Every window ended and every record kept as it stands, for a quit: the next launch brings the same notes up. */
  dispose() {
    for (const timer of this.settleTimers) clearTimeout(timer);
    for (const cardId of [...this.open.keys()]) this.end(cardId);
  }
}

/** The displays a note may be put on, as `notelist.js` reads them. */
function displays() {
  return screen
    .getAllDisplays()
    .filter((d) => d.detected !== false && d.workArea.width > 0 && d.workArea.height > 0)
    .map((d) => ({ id: d.id, workArea: d.workArea }));
}

module.exports = { NoteWindows };
