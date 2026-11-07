/**
 * The screen pen's session in the main process (`ink.js`), with Electron
 * faked and a stand-in for the helper: a session's overlays come and, above
 * all, go — on Done, on ✕, with the page that owned it, with the helper —
 * since an overlay left behind is a Mac where nothing can be clicked; a
 * burst is one still and one inked pair of pictures; Escape lifts the pen
 * and is the pen's once; and a refused Screen Recording puts nothing on the
 * screen; and the pill, where the tools are, is above the ink and is shown
 * draw-only for a session that is not its own (`TalkKey.forPen`). The real
 * helper and real windows are the user's to try
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
  invalidate() {}
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
  loadURL(url) {
    this.url = url;
    return Promise.resolve();
  }
  showInactive() {
    this.shown = true;
  }
  hide() {
    this.shown = false;
  }
  isVisible() {
    return this.shown;
  }
  getBounds() {
    const [x, y] = this.getPosition();
    const [width, height] = this.getSize();
    return { x, y, width, height };
  }
  moveTop() {
    this.raised = (this.raised ?? 0) + 1;
  }
  setSize(width, height) {
    this.size = [width, height];
  }
  getSize() {
    return this.size ?? [this.options.width, this.options.height];
  }
  setPosition(x, y) {
    this.position = [x, y];
  }
  getPosition() {
    return this.position ?? [0, 0];
  }
  on(event, fn) {
    (this.handlers ??= {})[event] = fn;
  }
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
  { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 }, scaleFactor: 2 },
  { id: 2, bounds: { x: 1440, y: 0, width: 1920, height: 1080 }, workArea: { x: 1440, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
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

// The pill's log goes somewhere of the test's own, never the user's `pill.log`.
const stateDir = mkdtempSync(join(tmpdir(), "kururu-ink-state-"));
process.env.KURURU_STATE_DIR = stateDir;
const { Ink } = await import("../ink.js");
const { TalkKey } = await import("../talkkey.js");

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
  else if (req.op === "under") {
    // Nothing above NOTHING_ABOVE: the desktop, which is no window.
    const above = Number(process.env.NOTHING_ABOVE || "-1");
    out = req.y < above ? { front: null } : { app: "Safari", bundle: "com.apple.Safari", window: "Stripe", bounds: null, front: null };
  }
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
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function setup(extra = {}) {
  windows.length = 0;
  shortcuts.clear();
  opened.length = 0;
  delete process.env.ACCESS;
  delete process.env.SECURE;
  delete process.env.NOTHING_ABOVE;
  const owner = new FakeContents();
  const main = new FakeContents();
  const ink = new Ink({
    helperPath,
    pagePath: "/app/ink.html",
    preloadPath: "/app/inkpreload.js",
    voiceClient: () => owner,
    mainWindow: () => main,
    pill: () => null,
    ...extra,
  });
  return { ink, owner, main };
}

const overlays = () => windows.filter((w) => !w.destroyed && w.file === "/app/ink.html");

const live = () => overlays();
const anyWindow = () => windows.filter((w) => !w.destroyed);
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
    await settle();
    expect(live().every((w) => w.shown)).toBe(true);
    expect(told(owner, "start")).toHaveLength(1);
    expect(shortcuts.has("Escape")).toBe(true);
    ink.dispose();
  });

  it("lets the mouse through with the pen up", async () => {
    await ink.start({ voice: true });
    ink.setPen(false);
    expect(live().every((w) => w.ignore === true)).toBe(true);
    expect(shortcuts.has("Escape")).toBe(false);
    ink.setPen(true);
    expect(live().every((w) => w.ignore === false)).toBe(true);
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
    expect(anyWindow()).toHaveLength(0);
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
    expect(anyWindow()).toHaveLength(0);
    ink.dispose();
  });

  it("tells its owner to send on Done, and takes the overlays down if it never asks", async () => {
    await ink.start({ voice: true });
    ink.send(live()[0].webContents);
    expect(told(owner, "send")).toHaveLength(1);
    expect(live()).toHaveLength(2);
    ink.dispose();
    expect(anyWindow()).toHaveLength(0);
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
    expect(anyWindow()).toHaveLength(0);
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
      expect(anyWindow()).toHaveLength(0);
      expect(ink.session).toBeNull();
      ink.dispose();
    }
  });

  it("an overlay's page dying", async () => {
    await ink.start({ voice: true });
    live()[1].webContents.emit("render-process-gone", {}, {});
    expect(anyWindow()).toHaveLength(0);
    ink.dispose();
  });

  it("the helper being killed", async () => {
    await ink.start({ voice: true });
    ink.helper.kill("SIGKILL");
    await settle(100);
    expect(anyWindow()).toHaveLength(0);
    expect(told(owner, "cancel").at(-1)[1].why).toContain("helper");
    ink.dispose();
  });

  it("a display coming or going makes them again, never more than one per display", async () => {
    await ink.start({ voice: true });
    screenEvents.emit("display-added");
    expect(live()).toHaveLength(2);
    ink.dispose();
    expect(anyWindow()).toHaveLength(0);
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

describe("phase 2: the pen made pleasant", () => {
  it("keeps what each stroke was drawn with, and the pill's choice is the next stroke's", async () => {
    const { ink, owner } = setup();
    const { at } = await ink.start({ voice: true }).then(() => ink.session);
    const [one] = live();
    draw(ink, one, [[100, 100], [140, 120]], at + 100);
    ink.setStyle({ tool: "pen", color: "blue" });
    draw(ink, one, [[100, 200], [140, 220]], at + 400);
    ink.setStyle({ tool: "highlighter", color: "nonsense" });
    draw(ink, one, [[100, 300], [140, 300]], at + 700);
    expect(ink.state().tool).toBe("highlighter");
    expect(ink.state().color).toBe("blue");
    const bundle = await ink.finish(owner, ink.session.id);
    expect(bundle.marks[0].styles).toEqual([
      { tool: "pen", color: "red" },
      { tool: "pen", color: "blue" },
      { tool: "highlighter", color: "yellow" },
    ]);
    ink.dispose();
  });

  it("undo takes the last mark back, its ink off its overlay, and the next mark never reuses its pictures", async () => {
    const { ink, owner } = setup();
    const { at } = await ink.start({ voice: true }).then(() => ink.session);
    const [one, two] = live();
    draw(ink, one, [[100, 100], [140, 120]], at + 100);
    draw(ink, two, [[10, 10], [40, 40]], at + 2000);
    ink.closeBurst();
    const undone = ink.session.bursts[1];
    ink.undo();
    expect(ink.session.bursts).toHaveLength(1);
    expect(two.webContents.sent.some(([channel]) => channel === "ink:undo")).toBe(true);
    expect(one.webContents.sent.some(([channel]) => channel === "ink:undo")).toBe(false);
    draw(ink, two, [[20, 20], [60, 60]], at + 4000);
    const again = ink.session.bursts[1];
    expect(again.n).toBe(2);
    expect(again.id).not.toBe(undone.id);
    const bundle = await ink.finish(owner, ink.session.id);
    expect(bundle.marks).toHaveLength(2);
    expect(bundle.marks[1].strokes[0][0]).toEqual([20, 20]);
    ink.dispose();
  });

  it("⌘Z is the pen's only while the pen is down, as Escape is", async () => {
    const { ink } = setup();
    await ink.start({ voice: true });
    expect(shortcuts.has("Command+Z")).toBe(true);
    ink.setPen(false);
    expect(shortcuts.has("Command+Z")).toBe(false);
    ink.setPen(true);
    ink.dispose();
    expect(shortcuts.has("Command+Z")).toBe(false);
  });

  it("a snapshot is a mark with no ink and only the whole display, and its key is the session's", async () => {
    const { ink, owner } = setup();
    const log = join(dir, "snap.log");
    process.env.INK_LOG = log;
    await ink.start({ voice: true });
    expect(shortcuts.has("Control+Alt+Command+S")).toBe(true);
    ink.setPen(false);
    shortcuts.get("Control+Alt+Command+S")();
    expect(live()[0].webContents.sent.some(([channel]) => channel === "ink:flash")).toBe(true);
    const bundle = await ink.finish(owner, ink.session.id);
    delete process.env.INK_LOG;
    expect(bundle.marks).toHaveLength(1);
    expect(bundle.marks[0].snap).toBe(true);
    expect(bundle.marks[0].strokes).toEqual([]);
    expect(bundle.marks[0].crop).toBe("");
    expect(Buffer.from(bundle.marks[0].frame, "base64")[0]).toBe(0xff);
    const sent = require("node:fs").readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const inked = sent.find((r) => r.op === "ink");
    expect(inked.crop).toBeUndefined();
    // The never-capture list goes with every still and every look under the pen.
    expect(sent.find((r) => r.op === "shot").deny).toContain("com.1password.1password");
    expect(sent.find((r) => r.op === "under").deny).toContain("com.apple.MobileSMS");
    expect(shortcuts.has("Control+Alt+Command+S")).toBe(false);
    ink.dispose();
  });

  it("hold-to-draw puts the pen down while held and back as it was after", async () => {
    const { ink } = setup();
    await ink.start({ voice: true });
    ink.setPen(false);
    ink.hold(true);
    expect(ink.session.pen).toBe(true);
    expect(ink.state().held).toBe(true);
    ink.hold(false);
    expect(ink.session.pen).toBe(false);
    // Pressed by hand mid-hold, the hand wins.
    ink.hold(true);
    ink.setPen(false);
    ink.hold(false);
    expect(ink.session.pen).toBe(false);
    ink.dispose();
    // No session, nothing to hold.
    ink.hold(true);
    expect(ink.session).toBeNull();
  });

  it("asks kururu's page what is under a mark, and does not wait on one that never says", async () => {
    const owner = new FakeContents();
    const asked = [];
    let answer = { kururu: { what: "agent", name: "Fastermenu migration", detail: "", workspace: "fastermenu", element: "" } };
    const ink = new Ink({
      helperPath,
      pagePath: "/app/ink.html",
      preloadPath: "/app/inkpreload.js",
      voiceClient: () => owner,
      mainWindow: () => null,
      pill: () => null,
      whatAt: (global, under) => {
        asked.push({ global, under });
        return answer === "never" ? new Promise(() => {}) : Promise.resolve(answer);
      },
    });
    windows.length = 0;
    await ink.start({ voice: true });
    const at = ink.session.at;
    draw(ink, live()[1], [[100, 100], [140, 120]], at + 100);
    const bundle = await ink.finish(owner, ink.session.id);
    expect(asked[0].global).toEqual({ x: 1440 + 120, y: 110 });
    expect(asked[0].under.app).toBe("Safari");
    expect(bundle.marks[0].kururu.name).toBe("Fastermenu migration");
    answer = "never";
    await ink.start({ voice: true });
    draw(ink, live()[0], [[10, 10], [20, 20]], ink.session.at + 50);
    const started = Date.now();
    const slow = await ink.finish(owner, ink.session.id);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(slow.marks[0].kururu).toBeNull();
    ink.dispose();
  });

  it("a roll takes the marks so far with the clip and keeps the session, its pen and its overlays", async () => {
    const { ink, owner } = setup();
    const { at, id } = await ink.start({ voice: true }).then(() => ink.session);
    draw(ink, live()[0], [[100, 100], [140, 120]], at + 100);
    const first = await ink.finish(owner, id, true);
    expect(first.marks).toHaveLength(1);
    expect(ink.session.id).toBe(id);
    expect(live()).toHaveLength(2);
    expect(ink.state().marks).toBe(0);
    draw(ink, live()[0], [[200, 200], [240, 220]], at + 5000);
    expect(ink.session.bursts[0].n).toBe(1);
    const second = await ink.finish(owner, id);
    expect(second.marks).toHaveLength(1);
    expect(second.marks[0].t0).toBe(5000);
    expect(anyWindow()).toHaveLength(0);
    ink.dispose();
  });
});

describe("the tools", () => {
  /** A floating pill as main has it: its page, its level, whether it is up, and how often it was ordered to the front. */
  function fakePill(visible = true) {
    const contents = new FakeContents();
    return {
      webContents: contents,
      visible,
      level: null,
      relative: null,
      raised: 0,
      isDestroyed: () => false,
      isVisible() {
        return this.visible;
      },
      setAlwaysOnTop(_on, level, relative = 0) {
        this.level = level;
        this.relative = relative;
      },
      moveTop() {
        this.raised += 1;
      },
      getMediaSourceId: () => `window:${contents.id}:0`,
    };
  }

  it("are in the pill's draw-only form when the pill does not own the session: asked for at the start, let go at the end, and no window of their own", async () => {
    const asked = [];
    const { ink, owner } = setup({ penPanel: (on) => asked.push(on) });
    await ink.start({ voice: false, asker: owner });
    expect(asked).toEqual([true]);
    expect(ink.state().tools).toBe("draw");
    // Nothing on the screen but the overlays: the tools are the pill's.
    expect(anyWindow()).toHaveLength(DISPLAYS.length);
    ink.send(owner);
    await ink.finish(owner, ink.session.id);
    expect(asked).toEqual([true, false]);
    // And let go however the session ends.
    await ink.start({ voice: true });
    ink.cancel(ink.session.id, "gone");
    expect(asked).toEqual([true, false, true, false]);
    ink.dispose();
  });

  it("are pressed from the pill in its draw-only form: Done and ✕ from it end the window's session", async () => {
    const pill = fakePill();
    const { ink, owner } = setup({ pill: () => pill });
    await ink.start({ voice: false, asker: owner });
    expect(ink.state().tools).toBe("draw");
    // Another page may not end it; the pill may.
    ink.send(new FakeContents());
    expect(told(owner, "send")).toHaveLength(0);
    ink.send(pill.webContents);
    expect(told(owner, "send")).toHaveLength(1);
    await ink.finish(owner, ink.session.id);
    await ink.start({ voice: false, asker: owner });
    ink.drop(pill.webContents);
    expect(told(owner, "cancel")).toHaveLength(1);
    expect(anyWindow()).toHaveLength(0);
    ink.dispose();
  });

  it("are beside the meter when the pill owns the session, and the pill is a level above the ink until it ends", async () => {
    const pill = fakePill();
    const { ink } = setup({ voiceClient: () => pill.webContents, pill: () => pill });
    await ink.start({ voice: true });
    await settle();
    expect(ink.state().tools).toBe("pill");
    // Above the overlays' level, not only ordered last within it.
    expect(live().every((w) => w.level === "screen-saver")).toBe(true);
    expect(pill.level).toBe("screen-saver");
    expect(pill.relative).toBe(1);
    expect(pill.raised).toBeGreaterThan(0);
    // The pill may press them.
    ink.setStyle({ tool: "pen", color: "blue" });
    expect(ink.state().color).toBe("blue");
    ink.cancel(ink.session.id, null);
    expect(pill.level).toBe("floating");
    expect(pill.relative).toBe(0);
    ink.dispose();
  });

  it("never orders a hidden pill to the front, which would show an empty window", async () => {
    const pill = fakePill(false);
    const { ink, owner } = setup({ pill: () => pill });
    await ink.start({ voice: false, asker: owner });
    await settle();
    expect(pill.level).toBe("screen-saver");
    expect(pill.raised).toBe(0);
    ink.dispose();
  });

  it("says whether every recording starts with the pen, session or not", async () => {
    let on = true;
    const { ink } = setup({ withVoice: () => on });
    expect(ink.state().withVoice).toBe(true);
    on = false;
    expect(ink.state().withVoice).toBe(false);
    await ink.start({ voice: true });
    expect(ink.state().withVoice).toBe(false);
    ink.dispose();
  });
});

describe("what a mark was drawn on", () => {
  it("is asked under the ink, not where the pen first went down: a line drawn down onto a button from the desktop above it", async () => {
    const asked = [];
    const { ink, owner } = setup({
      whatAt: (global, under) => {
        asked.push({ global, under });
        return Promise.resolve({ kururu: { what: "Kuru's drawer", name: "", detail: "its header", workspace: "", element: 'button "Search the conversation"' } });
      },
    });
    process.env.NOTHING_ABOVE = "140";
    await ink.start({ voice: true });
    // Begins at y 100 on the desktop, its middle at 125 still there, and ends at 150 on the window.
    draw(ink, live()[0], [[500, 100], [500, 125], [500, 150]], ink.session.at + 100);
    const bundle = await ink.finish(owner, ink.session.id);
    expect(bundle.marks[0].under.app).toBe("Safari");
    expect(asked[0].global).toEqual({ x: 500, y: 150 });
    expect(bundle.marks[0].kururu.element).toBe('button "Search the conversation"');
    ink.dispose();
  });

  it("falls back to where it began when nothing under the ink is a window, and still asks kururu — the pill is no window to the helper", async () => {
    const asked = [];
    const { ink, owner } = setup({
      whatAt: (global, under) => {
        asked.push({ global, under });
        return Promise.resolve(null);
      },
    });
    process.env.NOTHING_ABOVE = "10000";
    await ink.start({ voice: true });
    draw(ink, live()[0], [[500, 100], [520, 125]], ink.session.at + 100);
    const bundle = await ink.finish(owner, ink.session.id);
    expect(bundle.marks[0].under).toBeNull();
    expect(asked).toHaveLength(1);
    expect(asked[0].global).toEqual({ x: 500, y: 100 });
    ink.dispose();
  });
});

describe("the pill for the pen (TalkKey.forPen)", () => {
  const PAGE = "http://127.0.0.1:7717";
  function talkKey(saved = {}) {
    windows.length = 0;
    const talk = new TalkKey({ helperPath: join(dir, "no-hook"), preloadPath: "/app/preload.js", saved, save: () => {} });
    talk.setPage(PAGE);
    return talk;
  }
  const panels = () => windows.filter((w) => !w.destroyed);
  const report = (talk, drawing) => talk.report({ phase: "idle", width: 300, height: 40, key: "ControlRight", drawing });

  it("makes a draw-only panel when nothing keeps one, shows it while its page draws, and lets it go with the session", () => {
    const talk = talkKey();
    talk.forPen(true);
    expect(panels()).toHaveLength(1);
    const [panel] = panels();
    expect(panel.url).toBe(`${PAGE}/?pill&draw`);
    // Pressed between strokes on another app's window: the first click presses.
    expect(panel.options.acceptFirstMouse).toBe(true);
    expect(panel.options.focusable).toBe(false);
    expect(panel.shown).toBe(false);
    report(talk, true);
    expect(panel.shown).toBe(true);
    // Up for the pen, and still no phase for the window to read Escape by.
    expect(talk.state().phase).toBe("idle");
    report(talk, false);
    expect(panel.shown).toBe(false);
    talk.forPen(false);
    expect(panels()).toHaveLength(0);
  });

  it("is the whole pill again when the talk key is turned on mid-session, and kept after", () => {
    const talk = talkKey();
    talk.forPen(true);
    const [panel] = panels();
    talk.setEnabled(true);
    expect(panels()).toEqual([panel]);
    expect(panel.url).toBe(`${PAGE}/?pill`);
    talk.forPen(false);
    expect(panels()).toEqual([panel]);
    talk.stopHelper();
    talk.destroyPanel();
  });

  it("borrows the panel the talk key keeps, as it is, and leaves it there", () => {
    const talk = talkKey({ talkKeyEverywhere: true });
    talk.ensurePanel();
    const [panel] = panels();
    expect(panel.url).toBe(`${PAGE}/?pill`);
    talk.forPen(true);
    expect(panels()).toEqual([panel]);
    expect(panel.url).toBe(`${PAGE}/?pill`);
    talk.forPen(false);
    expect(panels()).toEqual([panel]);
    talk.destroyPanel();
  });

  it("goes draw-only, not away, when the talk key is turned off while a pen has its tools there", () => {
    const talk = talkKey({ talkKeyEverywhere: true });
    talk.ensurePanel();
    const [panel] = panels();
    talk.forPen(true);
    talk.setEnabled(false);
    expect(panels()).toEqual([panel]);
    expect(panel.url).toBe(`${PAGE}/?pill&draw`);
    talk.forPen(false);
    expect(panels()).toHaveLength(0);
  });

  it("waits for the pen to be put away before a reload, as it waits for the voice", () => {
    const talk = talkKey();
    talk.forPen(true);
    const [panel] = panels();
    report(talk, true);
    panel.url = null;
    talk.reloadPanel();
    expect(panel.url).toBeNull();
    report(talk, false);
    expect(panel.url).toBe(`${PAGE}/?pill&draw`);
    talk.forPen(false);
  });
});
