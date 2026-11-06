/**
 * The screen pen's session in the main process (`ink.js`), with Electron
 * faked and a stand-in for the helper: a session's overlays come and, above
 * all, go — on Done, on ✕, with the page that owned it, with the helper —
 * since an overlay left behind is a Mac where nothing can be clicked; a
 * burst is one still and one inked pair of pictures; Escape lifts the pen
 * and is the pen's once; and a refused Screen Recording puts nothing on the
 * screen. The real helper and real windows are the user's to try
 * (docs/plans/screen-annotate.md); this is everything around them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const windows = [];
const shortcuts = new Map();
const opened = [];
let nextId = 100;

class FakeContents extends EventEmitter {
  constructor() {
    super();
    this.id = nextId++;
    this.sent = [];
    this.destroyed = false;
  }
  send(channel, ...args) {
    this.sent.push([channel, ...args]);
  }
  isDestroyed() {
    return this.destroyed;
  }
  setWindowOpenHandler() {}
}

class FakeWindow {
  constructor(options) {
    this.options = options;
    this.webContents = new FakeContents();
    this.ignore = null;
    this.level = null;
    this.shown = false;
    this.destroyed = false;
    windows.push(this);
  }
  static getAllWindows() {
    return windows.filter((w) => !w.destroyed);
  }
  setAlwaysOnTop(_on, level) {
    this.level = level;
  }
  setVisibleOnAllWorkspaces() {}
  setBounds(bounds) {
    this.bounds = bounds;
  }
  setIgnoreMouseEvents(on) {
    this.ignore = on;
  }
  loadFile(file, { query }) {
    this.file = file;
    this.query = query;
    queueMicrotask(() => this.webContents.emit("did-finish-load"));
    return Promise.resolve();
  }
  showInactive() {
    this.shown = true;
  }
  moveTop() {}
  getMediaSourceId() {
    return `window:${this.webContents.id}:0`;
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.webContents.destroyed = true;
  }
}

const DISPLAYS = [
  { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 },
  { id: 2, bounds: { x: 1440, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
];
const screenEvents = new EventEmitter();
// One `Ink` per test, each listening for display changes as the app's one does.
screenEvents.setMaxListeners(100);

mock.module("electron", () => ({
  BrowserWindow: FakeWindow,
  globalShortcut: {
    register: (key, fn) => {
      shortcuts.set(key, fn);
      return true;
    },
    unregister: (key) => shortcuts.delete(key),
    isRegistered: (key) => shortcuts.has(key),
  },
  screen: {
    getAllDisplays: () => DISPLAYS,
    getPrimaryDisplay: () => DISPLAYS[0],
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => DISPLAYS[0],
    on: (event, fn) => screenEvents.on(event, fn),
  },
  shell: { openExternal: (url) => opened.push(url) },
}));

const { Ink } = await import("../ink.js");

/**
 * The helper, stood in for by a script: Screen Recording as `ACCESS` says,
 * every still taken, and `ink` writing a PNG and a JPEG's first bytes where
 * it is told — which is what the server will judge them by.
 */
const HELPER = `#!/usr/bin/env node
const fs = require("node:fs");
const lines = require("node:readline").createInterface({ input: process.stdin });
const log = process.env.INK_LOG;
lines.on("line", (line) => {
  const req = JSON.parse(line);
  if (log) fs.appendFileSync(log, line + "\\n");
  let out = { ok: true };
  if (req.op === "access" || req.op === "ask") out = { screen: process.env.ACCESS || "granted" };
  else if (req.op === "secure") out = { secure: process.env.SECURE === "1" };
  else if (req.op === "under") out = { app: "Safari", bundle: "com.apple.Safari", window: "Stripe", bounds: null, front: null };
  else if (req.op === "ink") {
    if (req.crop) fs.writeFileSync(req.crop.path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (req.frame) fs.writeFileSync(req.frame.path, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    out = { ok: true, crop: { width: 1, height: 1 }, frame: { width: 1, height: 1 } };
  }
  process.stdout.write(JSON.stringify({ ...out, seq: req.seq }) + "\\n");
});
`;

let dir;
let helperPath;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-ink-test-"));
  helperPath = join(dir, "glance");
  writeFileSync(helperPath, HELPER);
  chmodSync(helperPath, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function setup() {
  windows.length = 0;
  shortcuts.clear();
  opened.length = 0;
  delete process.env.ACCESS;
  delete process.env.SECURE;
  const owner = new FakeContents();
  const main = new FakeContents();
  const ink = new Ink({
    helperPath,
    pagePath: "/app/ink.html",
    preloadPath: "/app/inkpreload.js",
    voiceClient: () => owner,
    mainWindow: () => main,
    pill: () => null,
  });
  return { ink, owner, main };
}

const live = () => windows.filter((w) => !w.destroyed);
const told = (contents, ev) => contents.sent.filter(([channel, event]) => channel === "kururu:ink" && event.ev === ev);
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stroke on an overlay, as its page reports one. */
function draw(ink, overlay, points, at) {
  ink.begin(overlay.webContents, { point: points[0], t: at });
  ink.points(overlay.webContents, points.slice(1));
  ink.lift(overlay.webContents, { t: at + 200 });
}

describe("a session", () => {
  let ink;
  let owner;
  beforeEach(() => {
    ({ ink, owner } = setup());
  });

  it("puts an overlay over every display, takes the mouse, and tells its owner to start", async () => {
    await ink.start({ voice: true });
    expect(live()).toHaveLength(2);
    expect(live().map((w) => w.bounds)).toEqual(DISPLAYS.map((d) => d.bounds));
    expect(live().every((w) => w.level === "screen-saver" && w.ignore === false && w.options.focusable === false)).toBe(true);
    expect(live().map((w) => w.query.home)).toEqual(["1", "0"]);
    await settle();
    expect(live().every((w) => w.shown)).toBe(true);
    expect(told(owner, "start")).toHaveLength(1);
    expect(shortcuts.has("Escape")).toBe(true);
    ink.dispose();
  });

  it("lets the mouse through with the pen up, but not over the toolbar", async () => {
    await ink.start({ voice: true });
    ink.setPen(false);
    expect(live().every((w) => w.ignore === true)).toBe(true);
    expect(shortcuts.has("Escape")).toBe(false);
    ink.hoverBar(live()[0].webContents, true);
    expect(live()[0].ignore).toBe(false);
    ink.hoverBar(live()[0].webContents, false);
    expect(live()[0].ignore).toBe(true);
    ink.dispose();
  });

  it("makes one mark of strokes close together, a second of a stroke later or elsewhere, and finishes with the pictures", async () => {
    const { at } = await ink.start({ voice: true }).then(() => ink.session);
    const [one, two] = live();
    draw(ink, one, [[100, 100], [140, 120], [180, 100]], at + 100);
    draw(ink, one, [[180, 100], [200, 90]], at + 900);
    draw(ink, two, [[50, 50], [60, 60]], at + 1500);
    expect(ink.session.bursts).toHaveLength(2);
    const bundle = await ink.finish(owner, ink.session.id);
    expect(live()).toHaveLength(0);
    expect(bundle.kind).toBe("screen");
    expect(bundle.marks).toHaveLength(2);
    const [first, second] = bundle.marks;
    expect(first.display).toBe(1);
    expect(first.strokes).toHaveLength(2);
    expect(first.t0).toBe(100);
    expect(first.t1).toBe(1100);
    expect(first.box).toEqual({ x: 100, y: 90, width: 100, height: 30 });
    expect(Buffer.from(first.crop, "base64")[0]).toBe(0x89);
    expect(Buffer.from(first.frame, "base64")[0]).toBe(0xff);
    expect(first.under.app).toBe("Safari");
    expect(second.display).toBe(2);
    expect(bundle.displays.map((d) => d.id).sort()).toEqual([1, 2]);
    // The folder the pictures were in is gone with the session.
    expect(ink.session).toBeNull();
    ink.dispose();
  });

  it("takes no still while a password field has the keyboard, and keeps the mark", async () => {
    await ink.start({ voice: true });
    process.env.SECURE = "1";
    // The helper was started with the environment it had; a fresh one reads this.
    ink.stopHelper();
    const at = ink.session.at;
    draw(ink, live()[0], [[10, 10], [20, 20]], at + 50);
    const bundle = await ink.finish(owner, ink.session.id);
    expect(bundle.marks[0].secure).toBe(true);
    expect(bundle.marks[0].crop).toBe("");
    expect(bundle.marks[0].frame).toBe("");
    ink.dispose();
  });

  it("finishes with nothing when nothing was drawn, and only for its owner", async () => {
    await ink.start({ voice: true });
    expect(await ink.finish(new FakeContents(), ink.session.id)).toBeNull();
    expect(live()).toHaveLength(2);
    expect(await ink.finish(owner, ink.session.id)).toBeNull();
    expect(live()).toHaveLength(0);
    ink.dispose();
  });

  it("tells its owner to send on Done, and takes the overlays down if it never asks", async () => {
    await ink.start({ voice: true });
    ink.send(live()[0].webContents);
    expect(told(owner, "send")).toHaveLength(1);
    expect(live()).toHaveLength(2);
    ink.dispose();
    expect(live()).toHaveLength(0);
  });
});

describe("every way out leaves no overlay", () => {
  let ink;
  let owner;
  beforeEach(() => {
    ({ ink, owner } = setup());
  });

  it("✕", async () => {
    await ink.start({ voice: true });
    ink.drop(live()[0].webContents);
    expect(live()).toHaveLength(0);
    expect(told(owner, "cancel")).toHaveLength(1);
    expect(shortcuts.has("Escape")).toBe(false);
    ink.dispose();
  });

  it("the owner's page reloading, crashing or closing", async () => {
    for (const event of ["did-start-navigation", "render-process-gone", "destroyed"]) {
      ({ ink, owner } = setup());
      await ink.start({ voice: true });
      if (event === "did-start-navigation") {
        // The page's own history moving is not the page going.
        owner.emit(event, { isMainFrame: true, isSameDocument: true });
        expect(live()).toHaveLength(2);
        owner.emit(event, { isMainFrame: true, isSameDocument: false });
      }
      else owner.emit(event, {}, {});
      expect(live()).toHaveLength(0);
      expect(ink.session).toBeNull();
      ink.dispose();
    }
  });

  it("an overlay's page dying", async () => {
    await ink.start({ voice: true });
    live()[1].webContents.emit("render-process-gone", {}, {});
    expect(live()).toHaveLength(0);
    ink.dispose();
  });

  it("the helper being killed", async () => {
    await ink.start({ voice: true });
    ink.helper.kill("SIGKILL");
    await settle(100);
    expect(live()).toHaveLength(0);
    expect(told(owner, "cancel").at(-1)[1].why).toContain("helper");
    ink.dispose();
  });

  it("a display coming or going makes them again, never more than one per display", async () => {
    await ink.start({ voice: true });
    screenEvents.emit("display-added");
    expect(live()).toHaveLength(2);
    ink.dispose();
    expect(live()).toHaveLength(0);
  });
});

describe("Escape and the shortcut", () => {
  it("Escape lifts a pen that is down, and the same press heard twice is the pen's both times", async () => {
    const { ink } = setup();
    await ink.start({ voice: true });
    expect(ink.takeEscape()).toBe(true);
    expect(ink.session.pen).toBe(false);
    // The hook's copy of the same press, just after.
    expect(ink.takeEscape()).toBe(true);
    ink.lastEscapeAt = 0;
    // A later Escape with the pen up is the voice's: the pill drops the clip.
    expect(ink.takeEscape()).toBe(false);
    ink.dispose();
  });

  it("⌃⌥⌘D starts a session with the voice, and then puts the pen up and down", async () => {
    const { ink, owner } = setup();
    ink.register();
    expect(shortcuts.has("Control+Alt+Command+D")).toBe(true);
    shortcuts.get("Control+Alt+Command+D")();
    // The helper is asked about Screen Recording first: a process started and answered.
    for (let i = 0; i < 50 && !ink.session; i++) await settle(20);
    expect(told(owner, "start")).toHaveLength(1);
    shortcuts.get("Control+Alt+Command+D")();
    expect(ink.session.pen).toBe(false);
    shortcuts.get("Control+Alt+Command+D")();
    expect(ink.session.pen).toBe(true);
    ink.dispose();
    expect(shortcuts.has("Control+Alt+Command+D")).toBe(false);
  });
});

describe("refused", () => {
  it("with Screen Recording off, nothing goes on the screen and the owner is told why", async () => {
    const { ink, owner } = setup();
    process.env.ACCESS = "denied";
    await ink.start({ voice: true });
    expect(windows).toHaveLength(0);
    expect(ink.session).toBeNull();
    expect(told(owner, "refused")[0][1].why).toContain("Screen Recording");
    expect(opened[0]).toContain("Privacy_ScreenCapture");
    ink.dispose();
  });

  it("with no helper in the build, likewise", async () => {
    const owner = new FakeContents();
    const ink = new Ink({ helperPath: join(dir, "nothing"), pagePath: "", preloadPath: "", voiceClient: () => owner, mainWindow: () => null, pill: () => null });
    await ink.start({ voice: true });
    expect(ink.session).toBeNull();
    expect(told(owner, "refused")[0][1].why).toContain("no screen pen");
    expect(existsSync(join(dir, "nothing"))).toBe(false);
    ink.dispose();
  });

  it("a session with no voice is the page's that asked, and needs one", async () => {
    const { ink, main } = setup();
    await ink.start({ voice: false, asker: main });
    expect(ink.session.owner).toBe(main);
    expect(ink.session.voice).toBe(false);
    ink.dispose();
    await ink.start({ voice: false });
    expect(ink.session).toBeNull();
  });
});
