/**
 * kururu's browser: one page per browser tab, owned here, pooled by tab id and
 * moved between panes, never rebuilt.
 *
 * It is the terminals' rule (docs/terminals.md, "the pool") applied to pages,
 * and for the same reason: a page is state you cannot get back by drawing it
 * again — its scroll, its form, its sockets, an HMR client mid-session — so a
 * tab dragged to another pane or another workspace must arrive as the same
 * page. That rules out the two things a web page would reach for. A
 * `<webview>` moved in the DOM is a new guest, which is why Orca's pages
 * reload when moved; an iframe would be cross-site to a window at
 * `127.0.0.1:7717`, so a dev app's logins would break in it. So each page is a
 * `WebContentsView` in the main window's `contentView`, and the window's page
 * only ever says where its tab's box is (`place`), whether it is on screen
 * (`show`, `hide`), and what a button did. A view is created the first time
 * its tab is shown — so a restart, which brings tabs back as structure, loads
 * nothing until somebody looks — and destroyed only when its tab is closed or
 * the window goes.
 *
 * **The page is drawn above the window.** A view is a native layer over all of
 * the window's DOM, so kururu's own menus, drawers and dialogs would draw
 * under it. The window's page notices when one of them covers a tab
 * (`web/src/overlays.ts`), asks here for a still of the page, shows the still
 * in the tab's place and hides the view — VS Code's answer for its own
 * browser. `still` is that picture.
 *
 * **The page is hostile.** Its own session, `persist:kururu-browser`, never
 * `defaultSession`, whose CSP and frame headers `main.js` strips for the
 * preview; sandboxed, context-isolated, no node, and **no preload at all**, so
 * nothing kururu holds is reachable from a page. Permissions and devices are
 * refused by default; downloads go to `~/Downloads` under a name that never
 * overwrites, quarantined, and are never opened. A top frame may be at
 * `http:`, `https:` or `about:blank` only (`browserrules.js`), popups become
 * tabs, and every request to kururu's own ports is cancelled — see
 * `browserrules.js` for why that last one is needed at all.
 *
 * **The keys.** A page with the focus would swallow the prefix, and `C-a`
 * must reach kururu from anywhere. `before-input-event` sees every key before
 * the page: the prefix hands the focus back to the window and arms it there,
 * and the browser's own ⌘ keys (⌘L, ⌘R, ⌘[, ⌘], ⌘+, ⌘−, ⌘0) are this tab's.
 * Everything else is the page's — except while marking, when Esc, ↑ and ↓
 * are the marks', and ⌘⇧M and ⌘⇧H always are (`marks.js`).
 *
 * **Marks.** Each page has a `TabMarks` (`marks.js`) beside it from the
 * moment it is made: the debugger on the page, which keeps its console
 * errors whether or not anybody marks, and the marking script's world while
 * somebody does. The window's page drives it through `mark`.
 *
 * Only the main window's page may drive any of this, checked by the sender in
 * `main.js`; a page in a tab has no bridge to call it with.
 */
const { Menu, WebContentsView, clipboard, session, shell } = require("electron");
const { execFile } = require("node:child_process");
const { lookup } = require("node:dns/promises");
const { EventEmitter } = require("node:events");
const os = require("node:os");
const path = require("node:path");
const {
  allowedAddress,
  cleanUserAgent,
  downloadPath,
  judgeRequest,
  ownHosts,
  quarantineValue,
  resolvesHere,
} = require("./browserrules");
const { TabMarks } = require("./marks");

const PARTITION = "persist:kururu-browser";
/** A still's quality: enough to read text under a menu, small enough to send every second. */
const STILL_QUALITY = 70;
/** How long a name's lookup is believed, for the port check. */
const LOOKUP_TTL_MS = 5000;
/** How long this Mac's own addresses are believed: a Wi-Fi change moves them. */
const OWN_TTL_MS = 30000;
/** Downloads kept per tab for its line, newest last. */
const DOWNLOADS_KEPT = 5;
/** Page zoom steps, Chrome's. */
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

class BrowserPool extends EventEmitter {
  /**
   * `window()` is the main window or null; `kururuPorts()` the ports beyond
   * the proxies' that are kururu's right now (the server's, vite's while it
   * serves); `downloads` the folder downloads go to.
   *
   * @param {{ window: () => import("electron").BrowserWindow | null, kururuPorts: () => number[], downloads?: string, log?: (line: string) => void }} options
   */
  constructor({ window, kururuPorts, downloads, log }) {
    super();
    this.window = window;
    this.kururuPorts = kururuPorts;
    this.downloadsDir = downloads || path.join(os.homedir(), "Downloads");
    this.log = log || ((line) => console.log(`kururu browser: ${line}`));
    /** @type {Map<string, Tab>} */
    this.tabs = new Map();
    /** @type {import("electron").Session | null} */
    this.session = null;
    /** @type {{ at: number, own: Set<string> } | null} */
    this.own = null;
    /** @type {Map<string, { at: number, here: boolean }>} */
    this.lookups = new Map();
    this.nextDownload = 1;
  }

  /** The session and every handler on it. Once, after `app` is ready. */
  init() {
    if (this.session) return;
    const ses = session.fromPartition(PARTITION);
    this.session = ses;
    ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));

    // Security 1: nothing in this session reaches kururu.
    ses.webRequest.onBeforeRequest((details, callback) => {
      void this.judge(details.url).then(
        (blocked) => {
          if (blocked) this.log(`refused a page's request to kururu's own ${details.resourceType}: ${details.url.slice(0, 200)}`);
          callback({ cancel: blocked });
        },
        () => callback({ cancel: true }),
      );
    });

    // Security 2: permissions and devices, refused unless named here. Writing
    // to the clipboard on a click ("Copy" on a docs site) is the one let
    // through, being something a page can only do with the user's gesture.
    const allowed = new Set(["clipboard-sanitized-write"]);
    ses.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed.has(permission)));
    ses.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
    ses.setDevicePermissionHandler(() => false);
    ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    ses.on("select-hid-device", (event, _details, callback) => {
      event.preventDefault();
      callback();
    });
    ses.on("select-serial-port", (event, _ports, _contents, callback) => {
      event.preventDefault();
      callback("");
    });
    ses.on("select-usb-device", (event, _details, callback) => {
      event.preventDefault();
      callback();
    });
    ses.on("will-download", (_event, item, contents) => this.download(item, contents));
  }

  /** Whether a request is to kururu, by `judgeRequest`, with a lookup when it says so. */
  async judge(url) {
    const rules = { ports: new Set(this.kururuPorts().filter((p) => Number.isInteger(p))), own: this.ownHosts() };
    const verdict = judgeRequest(url, rules);
    if (verdict !== "resolve") return verdict === "block";
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      return false;
    }
    const cached = this.lookups.get(host);
    if (cached && Date.now() - cached.at < LOOKUP_TTL_MS) return cached.here;
    let here = false;
    try {
      const addresses = await lookup(host, { all: true });
      here = resolvesHere(addresses.map((a) => a.address), rules.own);
    } catch {
      // A name that does not resolve goes nowhere, here included.
      here = false;
    }
    this.lookups.set(host, { at: Date.now(), here });
    return here;
  }

  ownHosts() {
    if (!this.own || Date.now() - this.own.at > OWN_TTL_MS) {
      this.own = { at: Date.now(), own: ownHosts(os.networkInterfaces(), os.hostname()) };
    }
    return this.own.own;
  }

  // -------------------------------------------------------------------------
  // The pool
  // -------------------------------------------------------------------------

  /** The tab's view, made — and its page loaded — the first time it is asked for. */
  ensure(tabId, url) {
    const existing = this.tabs.get(tabId);
    if (existing) return existing;
    if (!this.session) this.init();
    const view = new WebContentsView({
      webPreferences: {
        session: /** @type {import("electron").Session} */ (this.session),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
        spellcheck: true,
      },
    });
    view.setBackgroundColor("#ffffff");
    view.setVisible(false);
    /** @type {Tab} */
    const tab = { id: tabId, view, nav: -1, shown: false, error: null, downloads: [], zoom: 1, marks: /** @type {any} */ (null) };
    this.tabs.set(tabId, tab);
    this.wire(tab);
    // Before the first load, so the console is kept from the page's first line.
    tab.marks = new TabMarks(view.webContents, {
      log: this.log,
      changed: () => this.report(tab),
      picked: (n, at) => this.emit("mark", tab.id, n, this.toWindowPixels(tab, at)),
    });
    const win = this.window();
    if (win && !win.isDestroyed()) win.contentView.addChildView(view);
    if (url && allowedAddress(url, { top: true })) void view.webContents.loadURL(url).catch(() => {});
    return tab;
  }

  /**
   * Show a tab's page at a box of the window, in CSS pixels of the window's
   * page. `nav` is the tab's `WebTabState.nav`: higher than the one this
   * view last loaded is an ask to go to `url`, and a view made just now loads
   * `url` whatever it is.
   */
  show(tabId, url, nav, rect) {
    const fresh = !this.tabs.has(tabId);
    const tab = this.ensure(tabId, url);
    if (fresh) tab.nav = nav;
    else if (Number.isFinite(nav) && nav > tab.nav) {
      tab.nav = nav;
      if (allowedAddress(url, { top: true })) void tab.view.webContents.loadURL(url).catch(() => {});
    }
    this.attach(tab);
    this.place(tabId, rect);
    tab.view.setVisible(true);
    tab.shown = true;
    this.report(tab);
    return this.state(tab);
  }

  /** Make sure the view is in the main window's tree, which a window made again does not have it in. */
  attach(tab) {
    const win = this.window();
    if (!win || win.isDestroyed()) return;
    if (!win.contentView.children.includes(tab.view)) win.contentView.addChildView(tab.view);
  }

  /** The box, in the window's CSS pixels, scaled to its zoom and snapped to whole pixels as VS Code does. */
  place(tabId, rect) {
    const tab = this.tabs.get(tabId);
    const win = this.window();
    if (!tab || !win || win.isDestroyed() || !rect) return;
    const values = [rect.x, rect.y, rect.width, rect.height];
    if (!values.every((v) => typeof v === "number" && Number.isFinite(v))) return;
    const zoom = win.webContents.getZoomFactor();
    const x = Math.round(rect.x * zoom);
    const y = Math.round(rect.y * zoom);
    const width = Math.max(0, Math.round((rect.x + rect.width) * zoom) - x);
    const height = Math.max(0, Math.round((rect.y + rect.height) * zoom) - y);
    tab.view.setBounds({ x, y, width, height });
  }

  /**
   * The element under a point of the main window's content, on whichever
   * shown tab is there, for the screen pen (`ink.js`). Points are the
   * window's; the view's page may be zoomed. Null where no tab is.
   */
  async elementAt(x, y) {
    for (const tab of this.tabs.values()) {
      if (!tab.shown || !tab.marks || tab.view.webContents.isDestroyed()) continue;
      const b = tab.view.getBounds();
      if (x < b.x || y < b.y || x >= b.x + b.width || y >= b.y + b.height) continue;
      const zoom = tab.view.webContents.getZoomFactor() || 1;
      return tab.marks.elementAt((x - b.x) / zoom, (y - b.y) / zoom);
    }
    return null;
  }

  hide(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.view.setVisible(false);
    tab.shown = false;
  }

  /** Every view hidden: the window's page is going away (a reload), and its new page will say again what shows. */
  hideAll() {
    for (const tab of this.tabs.values()) {
      tab.view.setVisible(false);
      tab.shown = false;
    }
  }

  /** The only thing that ends a page: its tab closed, or the window gone. */
  close(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.tabs.delete(tabId);
    tab.marks?.dispose();
    const win = this.window();
    if (win && !win.isDestroyed()) win.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }

  closeAll() {
    for (const id of [...this.tabs.keys()]) this.close(id);
  }

  /** The ids of the pages that are up, for the window to let go of the ones whose tabs it no longer has. */
  ids() {
    return [...this.tabs.keys()];
  }

  /**
   * A picture of the page as it is, for the window to show while one of its
   * own overlays covers the tab. Taken with `stayHidden`, so a page already
   * swapped out can be pictured again without being shown.
   */
  async still(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.view.webContents.isDestroyed()) return null;
    try {
      const image = await tab.view.webContents.capturePage(undefined, { stayHidden: true });
      if (image.isEmpty()) return null;
      return `data:image/jpeg;base64,${image.toJPEG(STILL_QUALITY).toString("base64")}`;
    } catch {
      return null;
    }
  }

  /** A button in the tab's chrome. */
  go(tabId, what, arg) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const contents = tab.view.webContents;
    const history = contents.navigationHistory;
    switch (what) {
      case "back":
        if (history.canGoBack()) history.goBack();
        break;
      case "forward":
        if (history.canGoForward()) history.goForward();
        break;
      case "reload":
        contents.reload();
        break;
      case "stop":
        contents.stop();
        break;
      case "zoom-in":
      case "zoom-out":
      case "zoom-reset": {
        const at = ZOOMS.indexOf(tab.zoom);
        const step = what === "zoom-in" ? 1 : -1;
        tab.zoom = what === "zoom-reset" ? 1 : ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (at === -1 ? ZOOMS.indexOf(1) : at) + step))] ?? 1;
        contents.setZoomFactor(tab.zoom);
        this.report(tab);
        break;
      }
      case "devtools":
        contents.openDevTools({ mode: "detach" });
        break;
      case "external": {
        const url = contents.getURL();
        if (/^https?:/.test(url)) void shell.openExternal(url);
        break;
      }
      case "focus":
        contents.focus();
        break;
      case "reveal": {
        const download = tab.downloads.find((d) => d.id === arg);
        if (download && download.path) shell.showItemInFolder(download.path);
        break;
      }
      case "dismiss":
        tab.downloads = tab.downloads.filter((d) => d.id !== arg || d.state === "progressing");
        this.report(tab);
        break;
    }
  }

  /**
   * A verb of the tab's marks, from its chrome: marking on or off, the tool,
   * the selection, the hover held, a comment kept, a mark dropped, the tray
   * cleared, and the set for Send. A comment comes in here and goes nowhere
   * but the set: never into the page.
   */
  async mark(tabId, verb, a, b) {
    const tab = this.tabs.get(tabId);
    if (!tab || !tab.marks) return null;
    const marks = tab.marks;
    switch (verb) {
      case "mode":
        return marks.setMode(a === true);
      case "tool":
        return marks.setTool(String(a), String(b));
      case "selection":
        return marks.markSelection();
      case "hold":
        return marks.hold();
      case "comment":
        return Number.isInteger(a) ? marks.comment(a, typeof b === "string" ? b : "") : false;
      case "drop":
        return Number.isInteger(a) ? marks.drop(a) : false;
      case "clear":
        return marks.clear();
      case "crop":
        return Number.isInteger(a) ? marks.cropOf(a) : null;
      case "bundle":
        return marks.bundle();
      case "focus":
        // Back into the page after a comment, so the next pick needs no click to focus it.
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.focus();
        return true;
      default:
        return null;
    }
  }

  /** A point in a view's own pixels, as the window's page measures: its CSS pixels, at the window's zoom. */
  toWindowPixels(_tab, at) {
    const win = this.window();
    const zoom = win && !win.isDestroyed() ? win.webContents.getZoomFactor() || 1 : 1;
    return { x: at.x / zoom, y: at.y / zoom };
  }

  // -------------------------------------------------------------------------
  // A page's events
  // -------------------------------------------------------------------------

  /** @param {Tab} tab */
  wire(tab) {
    const contents = tab.view.webContents;
    const changed = () => this.report(tab);

    // Popups are tabs, never windows: the window's page puts one in the same
    // pane as the tab that asked.
    contents.setWindowOpenHandler(({ url }) => {
      if (allowedAddress(url, { top: true }) && url !== "about:blank") this.emit("open", tab.id, url);
      return { action: "deny" };
    });
    const guard = (event, url, top) => {
      if (allowedAddress(url, { top })) return;
      event.preventDefault();
      this.log(`refused a ${top ? "page" : "frame"} going to ${String(url).slice(0, 120)}`);
      if (top) {
        tab.error = `kururu's browser does not open ${schemeOf(url)} addresses.`;
        this.report(tab);
      }
    };
    contents.on("will-navigate", (event) => guard(event, event.url, true));
    contents.on("will-frame-navigate", (event) => guard(event, event.url, event.isMainFrame));
    contents.on("will-redirect", (event) => guard(event, event.url, event.isMainFrame));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("select-bluetooth-device", (event, _devices, callback) => {
      event.preventDefault();
      callback("");
    });

    contents.on("did-start-loading", () => {
      tab.error = null;
      changed();
    });
    contents.on("did-stop-loading", changed);
    contents.on("did-navigate", changed);
    contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => isMainFrame && changed());
    contents.on("page-title-updated", changed);
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      // -3 is a load aborted by another one starting, which is not a failure.
      if (!isMainFrame || code === -3) return;
      tab.error = `${description || "The page did not load"} (${code}) — ${url}`;
      changed();
    });
    contents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit") return;
      tab.error = `The page stopped (${details.reason}). Reload to bring it back.`;
      changed();
    });
    contents.on("focus", () => this.emit("focused", tab.id));
    contents.on("before-input-event", (event, input) => this.key(tab, event, input));
    contents.on("context-menu", (_event, params) => this.menu(tab, params));
  }

  /**
   * A key the page has not seen yet. The prefix and the browser's ⌘ keys are
   * kururu's; anything else goes on to the page, and so to the app's menus
   * for whatever they have — ⌘C, ⌘V and ⌘Q work in a page as anywhere.
   */
  key(tab, event, input) {
    if (input.type !== "keyDown") return;
    const key = String(input.key || "").toLowerCase();
    const command = process.platform === "darwin" ? input.meta : input.control;
    if (input.control && !input.meta && !input.alt && !input.shift && key === "a") {
      event.preventDefault();
      this.toWindow();
      this.emit("prefix", tab.id);
      return;
    }
    // Marking's keys: Esc, ↑ and ↓ while it is on, so the page never sees
    // them; ⌘⇧M (the selection, or marking on and off) and ⌘⇧H (hold the
    // hover) whenever.
    const marks = tab.marks;
    if (marks && marks.mode && !input.meta && !input.control && !input.alt) {
      if (key === "escape") {
        event.preventDefault();
        void marks.escape();
        return;
      }
      if (key === "arrowup" || key === "arrowdown") {
        event.preventDefault();
        void marks.walk(key === "arrowup" ? "up" : "down");
        return;
      }
    }
    if (marks && command && input.shift && !input.alt && (key === "m" || key === "h")) {
      event.preventDefault();
      void (key === "m" ? marks.markKey() : marks.hold());
      return;
    }
    if (!command || input.alt) return;
    const own = {
      l: "address",
      r: input.shift ? "reload-hard" : "reload",
      "[": "back",
      "]": "forward",
      arrowleft: "back",
      arrowright: "forward",
      "=": "zoom-in",
      "+": "zoom-in",
      "-": "zoom-out",
      0: "zoom-reset",
    }[key];
    if (!own) return;
    event.preventDefault();
    if (own === "address") {
      this.toWindow();
      this.emit("address", tab.id);
    } else if (own === "reload-hard") tab.view.webContents.reloadIgnoringCache();
    else this.go(tab.id, own);
  }

  /** The keyboard back to the window's page, from a page that had it. */
  toWindow() {
    const win = this.window();
    if (win && !win.isDestroyed()) win.webContents.focus();
  }

  /** The page's right-click: the few things a browser's menu has, built here so the page never decides. */
  menu(tab, params) {
    const contents = tab.view.webContents;
    const history = contents.navigationHistory;
    /** @type {import("electron").MenuItemConstructorOptions[]} */
    const items = [];
    if (params.linkURL && allowedAddress(params.linkURL, { top: true })) {
      items.push(
        { label: "Open Link in New Tab", click: () => this.emit("open", tab.id, params.linkURL) },
        { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
        { type: "separator" },
      );
    }
    if (params.isEditable) {
      items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { type: "separator" });
    } else if (params.selectionText) {
      items.push({ role: "copy" }, { type: "separator" });
    }
    items.push(
      { label: "Back", enabled: history.canGoBack(), click: () => history.goBack() },
      { label: "Forward", enabled: history.canGoForward(), click: () => history.goForward() },
      { label: "Reload", click: () => contents.reload() },
      { type: "separator" },
      { label: "Inspect Element", click: () => contents.inspectElement(params.x, params.y) },
    );
    const win = this.window();
    Menu.buildFromTemplate(items).popup(win && !win.isDestroyed() ? { window: win } : {});
  }

  // -------------------------------------------------------------------------
  // Downloads
  // -------------------------------------------------------------------------

  /** A download: into the folder under a name nothing is using, followed on its tab's line, quarantined, never opened. */
  download(item, contents) {
    const tab = [...this.tabs.values()].find((t) => !t.view.webContents.isDestroyed() && t.view.webContents.id === contents?.id);
    const target = downloadPath(this.downloadsDir, item.getFilename());
    item.setSavePath(target);
    const record = {
      id: this.nextDownload++,
      name: path.basename(target),
      path: target,
      received: 0,
      total: item.getTotalBytes(),
      state: "progressing",
    };
    this.log(`downloading ${record.name} to ${this.downloadsDir}`);
    if (tab) {
      tab.downloads = [...tab.downloads, record].slice(-DOWNLOADS_KEPT);
      this.report(tab);
    }
    item.on("updated", (_event, state) => {
      record.received = item.getReceivedBytes();
      record.total = item.getTotalBytes();
      record.state = state === "interrupted" ? "interrupted" : "progressing";
      if (tab) this.report(tab);
    });
    item.once("done", (_event, state) => {
      record.received = item.getReceivedBytes();
      record.state = state;
      if (state === "completed") quarantine(target, this.log);
      if (tab) this.report(tab);
    });
  }

  // -------------------------------------------------------------------------
  // What the window is told
  // -------------------------------------------------------------------------

  /** @param {Tab} tab */
  state(tab) {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return { tabId: tab.id, gone: true };
    const history = contents.navigationHistory;
    return {
      tabId: tab.id,
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canBack: history.canGoBack(),
      canForward: history.canGoForward(),
      zoom: tab.zoom,
      error: tab.error,
      downloads: tab.downloads.map((d) => ({ id: d.id, name: d.name, received: d.received, total: d.total, state: d.state })),
      marking: tab.marks ? tab.marks.state() : null,
    };
  }

  /** @param {Tab} tab */
  report(tab) {
    this.emit("state", this.state(tab));
  }
}

/** The scheme of an address, for the sentence that refuses it. */
function schemeOf(url) {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(String(url));
  return match && match[1] ? `${match[1].toLowerCase()}:` : "those";
}

/**
 * The quarantine flag on a finished download, if Chromium did not put one
 * there — so the first open goes through Gatekeeper, as a Safari or Chrome
 * download does. Read first, and written only when missing.
 */
function quarantine(file, log) {
  if (process.platform !== "darwin") return;
  execFile("xattr", ["-p", "com.apple.quarantine", file], (err) => {
    if (!err) return;
    execFile("xattr", ["-w", "com.apple.quarantine", quarantineValue(), file], (writeErr) => {
      if (writeErr) log(`could not quarantine ${path.basename(file)}: ${writeErr.message}`);
    });
  });
}

/**
 * @typedef {{ id: string, view: import("electron").WebContentsView, nav: number, shown: boolean, error: string | null,
 *   downloads: { id: number, name: string, path: string, received: number, total: number, state: string }[], zoom: number,
 *   marks: import("./marks").TabMarks }} Tab
 */

module.exports = { BrowserPool, PARTITION };
