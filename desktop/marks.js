/**
 * A browser tab's marks, held in main: the debugger on its page, the marking
 * script's isolated world, the marks themselves, and the page's console.
 *
 * The marking script (`markscript.js`) runs in the page and knows the DOM;
 * this knows everything else, and is the only side that holds a mark whole.
 * A comment lives here and in the window's popover and nowhere else — never
 * in the page, which only ever learns a pin's number. The marks outlive the
 * page's document, so a navigation or a reload keeps the tray, and the pins
 * of the marks made on the page now shown are found again by their selectors.
 *
 * **Why the debugger.** The plan's "no preload at all" for a page that may be
 * any website: everything kururu does in a page goes through CDP from here.
 * An isolated world (`Page.createIsolatedWorld`, and on every new document
 * `Page.addScriptToEvaluateOnNewDocument` with its `worldName`) gives the
 * script the page's DOM and none of its globals, and `Runtime.addBinding`
 * scoped to that world's name is a function only the script can call. The
 * same connection gives what only a debugger has: the accessibility tree's
 * role and name for a marked node, a hover held on a CSS-only menu
 * (`CSS.forcePseudoState`), and the console and failed requests, kept the
 * last 200 per tab whether or not anybody marks, since the error that matters
 * is the one logged before the user thought to look.
 *
 * Opening DevTools on a page can take the debugger away; it is attached again
 * when that happens, and the tab says so when it cannot be.
 */
const { MARK_SOURCE, WORLD, BINDING } = require("./markscript");

/** The marks one set holds: Orca's rule, refused out loud past it. Kept in step with `MARKS_MAX` in `shared/marks.ts`. */
const MARKS_MAX = 20;
/** Console lines kept per tab. */
const RING = 200;
/** Requests remembered by id, for the address of one that fails. */
const REQUESTS_KEPT = 500;
/** Room around a mark's box in its crop, in CSS pixels. */
const CROP_MARGIN = 24;
/** How long to wait before attaching again after the debugger was taken. */
const REATTACH_MS = 1500;

class TabMarks {
  /**
   * @param {import("electron").WebContents} contents
   * @param {{ log: (line: string) => void, changed: () => void, picked: (n: number, at: {x: number, y: number}) => void }} hooks
   */
  constructor(contents, hooks) {
    this.contents = contents;
    this.hooks = hooks;
    this.attached = false;
    this.why = null;
    this.mainFrame = null;
    /** The marking world's context in the top frame, once there is one. */
    this.ctx = null;
    this.scriptId = null;
    this.mode = false;
    this.tool = "element";
    this.shape = "free";
    /** @type {Mark[]} */
    this.marks = [];
    /** Hover held on these nodes (`CSS.forcePseudoState`). */
    this.held = [];
    this.note = null;
    /** @type {object[]} */
    this.ring = [];
    /** @type {Map<string, string>} */
    this.requests = new Map();
    this.domReady = false;
    this.cssReady = false;
    this.gone = false;
    this.onMessage = (_event, method, params) => this.message(method, params);
    this.onDetach = (_event, reason) => this.detached(reason);
    contents.debugger.on("message", this.onMessage);
    contents.debugger.on("detach", this.onDetach);
    void this.attach();
  }

  // -------------------------------------------------------------------------
  // The connection
  // -------------------------------------------------------------------------

  async attach() {
    if (this.gone || this.contents.isDestroyed()) return;
    try {
      if (!this.contents.debugger.isAttached()) this.contents.debugger.attach("1.3");
    } catch (err) {
      this.attached = false;
      this.why = "Marking needs the page's debugger, which DevTools is holding. Close DevTools for this tab to mark.";
      this.hooks.log(`could not attach to a page: ${err instanceof Error ? err.message : String(err)}`);
      this.hooks.changed();
      return;
    }
    this.attached = true;
    this.why = null;
    this.ctx = null;
    this.scriptId = null;
    this.domReady = false;
    this.cssReady = false;
    try {
      await this.send("Runtime.enable");
      await this.send("Page.enable");
      await this.send("Log.enable");
      await this.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
      await this.send("Runtime.addBinding", { name: BINDING, executionContextName: WORLD });
      const tree = await this.send("Page.getFrameTree");
      this.mainFrame = tree?.frameTree?.frame?.id ?? null;
      // Marks kept across the debugger going away: the script back on the page.
      if (this.mode || this.marks.length) await this.ensureWorld();
    } catch (err) {
      this.hooks.log(`setting up a page's debugger: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.hooks.changed();
  }

  detached(reason) {
    this.attached = false;
    this.ctx = null;
    this.scriptId = null;
    this.held = [];
    if (this.gone || this.contents.isDestroyed() || reason === "target closed") return;
    this.why = "The page's debugger was taken (DevTools?). Trying again…";
    this.hooks.changed();
    setTimeout(() => void this.attach(), REATTACH_MS);
  }

  /** The tab closed: let go of everything. */
  dispose() {
    this.gone = true;
    try {
      this.contents.debugger.off("message", this.onMessage);
      this.contents.debugger.off("detach", this.onDetach);
      if (this.contents.debugger.isAttached()) this.contents.debugger.detach();
    } catch {
      // Already gone with its page.
    }
  }

  send(method, params) {
    if (!this.attached || this.contents.isDestroyed()) return Promise.reject(new Error("no debugger"));
    return this.contents.debugger.sendCommand(method, params);
  }

  // -------------------------------------------------------------------------
  // What the page says
  // -------------------------------------------------------------------------

  message(method, params) {
    switch (method) {
      case "Runtime.executionContextCreated": {
        const c = params.context;
        if (c && c.name === WORLD && c.auxData && c.auxData.frameId === this.mainFrame) this.ctx = c.id;
        break;
      }
      case "Runtime.executionContextDestroyed":
        if (params.executionContextId === this.ctx) this.ctx = null;
        break;
      case "Runtime.executionContextsCleared":
        this.ctx = null;
        break;
      case "Runtime.bindingCalled":
        if (params.name === BINDING) this.fromScript(params.executionContextId, params.payload);
        break;
      case "Page.frameNavigated":
        if (params.frame && !params.frame.parentId) {
          this.mainFrame = params.frame.id;
          this.held = [];
          this.domReady = false;
          // "Since the page loaded": a new document starts the list again.
          this.ring = [];
          this.requests.clear();
        }
        break;
      case "Runtime.consoleAPICalled":
        if (params.type === "error" || params.type === "warning" || params.type === "assert") {
          const text = (params.args || []).map(previewOf).join(" ");
          const frame = params.stackTrace?.callFrames?.[0];
          // Electron's own words in an unpackaged build's pages, not the page's.
          if (frame && String(frame.url).startsWith("node:electron")) break;
          this.keep({ level: params.type === "warning" ? "warning" : "error", source: "console", text, url: frame ? `${frame.url}:${frame.lineNumber + 1}` : "" });
        }
        break;
      case "Runtime.exceptionThrown": {
        const d = params.exceptionDetails || {};
        const text = d.exception?.description || d.text || "an exception";
        this.keep({ level: "error", source: "exception", text: String(text).split("\n").slice(0, 6).join("\n"), url: d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}` : "" });
        break;
      }
      case "Log.entryAdded": {
        const e = params.entry || {};
        // The console's own lines arrive above, and a network line below with its status.
        if ((e.level === "error" || e.level === "warning") && e.source !== "console-api" && e.source !== "network") {
          this.keep({ level: e.level, source: "log", text: String(e.text || ""), url: e.url || "" });
        }
        break;
      }
      case "Network.requestWillBeSent":
        if (params.requestId && params.request?.url) {
          this.requests.set(params.requestId, params.request.url);
          if (this.requests.size > REQUESTS_KEPT) this.requests.delete(/** @type {string} */ (this.requests.keys().next().value));
        }
        break;
      case "Network.responseReceived": {
        const r = params.response || {};
        if (r.status >= 400) this.keep({ level: "error", source: "network", text: String(r.statusText || ""), url: r.url || "", status: r.status });
        break;
      }
      case "Network.loadingFailed":
        if (!params.canceled || params.blockedReason) {
          this.keep({ level: "error", source: "network", text: String(params.errorText || params.blockedReason || "failed"), url: this.requests.get(params.requestId) || "", status: 0 });
        }
        break;
    }
  }

  keep(entry) {
    this.ring.push({ status: 0, ...entry, text: String(entry.text).slice(0, 2000), url: String(entry.url).slice(0, 2000), at: Date.now() });
    if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);
  }

  fromScript(contextId, payload) {
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    // Only the top frame's marking world speaks for the tab.
    if (this.ctx !== null && contextId !== this.ctx) return;
    if (this.ctx === null) this.ctx = contextId;
    if (msg.t === "ready") void this.sync();
    else if (msg.t === "pick") void this.picked(msg);
    else if (msg.t === "lost") {
      const mark = this.marks.find((m) => m.k === msg.k);
      if (mark && mark.lost !== (msg.lost === true)) {
        mark.lost = msg.lost === true;
        this.hooks.changed();
      }
    }
  }

  // -------------------------------------------------------------------------
  // The world
  // -------------------------------------------------------------------------

  /** The script in the page's top frame now, and on every document after while it is wanted. */
  async ensureWorld() {
    if (!this.attached) return false;
    if (!this.scriptId) {
      const added = await this.send("Page.addScriptToEvaluateOnNewDocument", { source: MARK_SOURCE, worldName: WORLD });
      this.scriptId = added?.identifier ?? null;
    }
    if (this.ctx === null && this.mainFrame) {
      const made = await this.send("Page.createIsolatedWorld", { frameId: this.mainFrame, worldName: WORLD, grantUniveralAccess: false });
      this.ctx = made?.executionContextId ?? null;
    }
    if (this.ctx === null) return false;
    // Idempotent in the page: a world that already has it returns at once.
    await this.send("Runtime.evaluate", { expression: MARK_SOURCE, contextId: this.ctx });
    return true;
  }

  /** The script off every document from now on, once there is nothing to draw. */
  async dropWorld() {
    if (this.scriptId) {
      const id = this.scriptId;
      this.scriptId = null;
      await this.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: id }).catch(() => {});
    }
  }

  /** Call into the world: `expression` after `__kururuMarks.`, its value back. */
  async call(expression, awaitPromise = false) {
    if (this.ctx === null) return undefined;
    const result = await this.send("Runtime.evaluate", {
      expression: `globalThis.__kururuMarks ? globalThis.__kururuMarks.${expression} : undefined`,
      contextId: this.ctx,
      returnByValue: true,
      awaitPromise,
    });
    return result?.result?.value;
  }

  /** What the page draws: the mode, the tool, and a pin per mark. */
  async sync() {
    if (this.ctx === null) return;
    const pins = this.marks.map((m) => ({ k: m.k, n: m.n, kind: m.kind, selectors: m.elements.map((e) => e.selectors), fx: m.pin.fx, fy: m.pin.fy, pageBox: m.pageBox, stroke: m.stroke, shape: m.shape, url: m.url }));
    try {
      await this.call(`setMode(${JSON.stringify(this.mode)}, ${JSON.stringify(this.tool)}, ${JSON.stringify(this.shape)})`);
      await this.call(`setPins(${JSON.stringify(pins)})`);
    } catch (err) {
      this.hooks.log(`drawing the marks: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // The window's verbs
  // -------------------------------------------------------------------------

  async setMode(on) {
    this.note = null;
    this.mode = on === true;
    if (!this.mode) await this.release();
    if (this.mode || this.marks.length) {
      if (!(await this.ensureWorld().catch(() => false))) {
        if (this.mode) this.note = this.why || "This page cannot be marked yet: wait for it to load.";
        this.mode = false;
      }
    }
    await this.sync();
    if (!this.mode && !this.marks.length) await this.dropWorld();
    this.hooks.changed();
    return this.mode;
  }

  async setTool(tool, shape) {
    if (tool === "element" || tool === "region" || tool === "pen") this.tool = tool;
    if (shape === "free" || shape === "arrow" || shape === "ellipse") this.shape = shape;
    if (!this.mode) await this.setMode(true);
    else await this.sync();
    this.hooks.changed();
  }

  /** ⌘⇧M: the page's selection as a text mark when there is one, and marking on or off when not. */
  async markKey() {
    if (!this.mode) {
      if (await this.ensureWorld().catch(() => false)) {
        const took = await this.call("selectionMark()").catch(() => false);
        if (took) return true;
      }
    }
    return this.setMode(!this.mode);
  }

  /** "Mark selection": only the selection, never the mode. */
  async markSelection() {
    if (!(await this.ensureWorld().catch(() => false))) return false;
    const took = await this.call("selectionMark()").catch(() => false);
    if (!took) {
      this.note = "Select some text on the page first, with marking off.";
      this.hooks.changed();
    }
    return took === true;
  }

  async walk(dir) {
    await this.call(`walk(${JSON.stringify(dir)})`).catch(() => {});
  }

  /** Esc in the page while marking: a drag or a gathering dropped first, then marking off. */
  async escape() {
    const said = await this.call("escape()").catch(() => "exit");
    if (said !== "kept") await this.setMode(false);
  }

  /**
   * ⌘⇧H: the hover state of the element under the pointer and every
   * ancestor of it held, until pressed again — for a menu that CSS opens on
   * `:hover` and would shut the moment the pointer left it for the pick.
   */
  async hold() {
    if (this.held.length) {
      await this.release();
      this.hooks.changed();
      return false;
    }
    if (!this.mode) await this.setMode(true);
    if (this.ctx === null) return false;
    try {
      if (!this.domReady) {
        await this.send("DOM.enable");
        await this.send("DOM.getDocument", { depth: 0 });
        this.domReady = true;
      }
      if (!this.cssReady) {
        await this.send("CSS.enable");
        this.cssReady = true;
      }
      const chain = await this.send("Runtime.evaluate", { expression: "globalThis.__kururuMarks.hoverChain()", contextId: this.ctx });
      const objectId = chain?.result?.objectId;
      if (!objectId) {
        this.note = "Point at something on the page first, then hold its hover.";
        this.hooks.changed();
        return false;
      }
      const props = await this.send("Runtime.getProperties", { objectId, ownProperties: true });
      const ids = (props?.result ?? []).filter((p) => /^\d+$/.test(p.name) && p.value?.objectId).map((p) => p.value.objectId);
      for (const id of ids) {
        const { nodeId } = await this.send("DOM.requestNode", { objectId: id });
        if (!nodeId) continue;
        await this.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover", "focus-within"] });
        this.held.push(nodeId);
      }
      await this.send("Runtime.releaseObject", { objectId }).catch(() => {});
    } catch (err) {
      this.hooks.log(`holding hover: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.hooks.changed();
    return this.held.length > 0;
  }

  async release() {
    const held = this.held;
    this.held = [];
    for (const nodeId of held) await this.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] }).catch(() => {});
  }

  /**
   * A pick from the script: numbered, given what only the debugger knows,
   * and pictured — after the pin has its number and the hover box is off,
   * so the crop shows the pin and nothing of the picking. Then the window is
   * told, to open the comment's popover at the pin.
   */
  async picked(msg) {
    if (this.marks.length >= MARKS_MAX) {
      this.note = `${MARKS_MAX} marks is the most one message takes. Send these, or remove one.`;
      // The script drew a pin for it; the pins main has are the ones it keeps.
      await this.sync();
      this.hooks.changed();
      return;
    }
    const elements = Array.isArray(msg.elements) ? msg.elements : [];
    /** @type {Mark} */
    const mark = {
      k: String(msg.k),
      n: this.marks.length + 1,
      kind: ["element", "region", "pen", "text"].includes(msg.kind) ? msg.kind : "element",
      elements,
      box: msg.box,
      pin: msg.pin || { fx: 0.5, fy: 0.5 },
      text: typeof msg.text === "string" ? msg.text : "",
      near: typeof msg.near === "string" ? msg.near : "",
      shape: msg.kind === "pen" ? msg.shape || "free" : "",
      pageBox: msg.kind === "region" || msg.kind === "pen" || elements.length === 0 ? msg.box : null,
      stroke: Array.isArray(msg.stroke) ? msg.stroke : null,
      url: typeof msg.url === "string" ? msg.url : this.contents.getURL(),
      comment: "",
      crop: "",
      lost: false,
    };
    this.marks.push(mark);
    this.note = null;
    await this.sync();
    for (let i = 0; i < elements.length; i++) await this.accessible(mark.k, i, elements[i]);
    await this.call("frame()", true).catch(() => {});
    mark.crop = await this.crop(msg.view, msg.viewport);
    this.hooks.changed();
    // Where the pin is in the view, for the popover: the view's CSS pixels
    // times its zoom are the window's device-independent ones.
    const zoom = this.contents.getZoomFactor() || 1;
    const view = msg.view || { x: 0, y: 0, width: 0, height: 0 };
    const at = { x: (view.x + view.width * mark.pin.fx) * zoom, y: (view.y + view.height * mark.pin.fy) * zoom };
    if (mark.kind === "region" || mark.kind === "pen") at.x = (view.x + view.width) * zoom;
    this.hooks.picked(mark.n, at);
  }

  /** The accessibility tree's role and name for a marked element, over the script's guess. */
  async accessible(k, i, element) {
    try {
      const handle = await this.send("Runtime.evaluate", { expression: `globalThis.__kururuMarks.node(${JSON.stringify(k)}, ${i})`, contextId: this.ctx });
      const objectId = handle?.result?.objectId;
      if (!objectId) return;
      const { node } = await this.send("DOM.describeNode", { objectId });
      await this.send("Runtime.releaseObject", { objectId }).catch(() => {});
      if (!node?.backendNodeId) return;
      const { nodes } = await this.send("Accessibility.getPartialAXTree", { backendNodeId: node.backendNodeId, fetchRelatives: false });
      const ax = (nodes || []).find((n) => n.backendDOMNodeId === node.backendNodeId) || (nodes || [])[0];
      if (!ax || ax.ignored) return;
      const role = ax.role?.value;
      const name = ax.name?.value;
      if (typeof role === "string" && role && role !== "generic" && role !== "none") element.role = role.slice(0, 60);
      if (typeof name === "string" && name.trim()) element.name = name.replace(/\s+/g, " ").trim().slice(0, 300);
    } catch {
      // The script's own reading stands.
    }
  }

  /**
   * A crop of the view around a box of it, as base64 PNG. The box is in the
   * page's CSS pixels; `capturePage` takes the view's own (device-independent)
   * ones, which are those times the page's zoom.
   */
  async crop(box, viewport) {
    if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) return "";
    const zoom = this.contents.getZoomFactor() || 1;
    const vw = Number.isFinite(viewport?.width) ? viewport.width : box.x + box.width + CROP_MARGIN;
    const vh = Number.isFinite(viewport?.height) ? viewport.height : box.y + box.height + CROP_MARGIN;
    const x = Math.max(0, Math.floor((box.x - CROP_MARGIN) * zoom));
    const y = Math.max(0, Math.floor((box.y - CROP_MARGIN) * zoom));
    const right = Math.min(Math.floor(vw * zoom), Math.ceil((box.x + box.width + CROP_MARGIN) * zoom));
    const bottom = Math.min(Math.floor(vh * zoom), Math.ceil((box.y + box.height + CROP_MARGIN) * zoom));
    if (right - x < 2 || bottom - y < 2) return "";
    try {
      const image = await this.contents.capturePage({ x, y, width: right - x, height: bottom - y }, { stayHidden: true });
      return image.isEmpty() ? "" : image.toPNG().toString("base64");
    } catch {
      return "";
    }
  }

  comment(n, text) {
    const mark = this.marks.find((m) => m.n === n);
    if (!mark) return false;
    mark.comment = String(text).slice(0, 4000);
    this.hooks.changed();
    return true;
  }

  /** A mark taken away: the others numbered again from 1, in the order made, and the page's pins with them. */
  async drop(n) {
    const before = this.marks.length;
    this.marks = this.marks.filter((m) => m.n !== n).map((m, i) => ({ ...m, n: i + 1 }));
    if (this.marks.length === before) return false;
    this.note = null;
    await this.sync();
    if (!this.mode && !this.marks.length) await this.dropWorld();
    this.hooks.changed();
    return true;
  }

  async clear() {
    this.marks = [];
    this.note = null;
    await this.release();
    this.mode = false;
    await this.sync();
    await this.dropWorld();
    this.hooks.changed();
  }

  /**
   * The set, for the window to post: every mark with its comment and crop,
   * the page, its console, and the view as it is now with the pins on it —
   * taken with the hover box off, and the mode put back after.
   */
  async bundle() {
    if (!this.marks.length) return { error: "There are no marks to send." };
    const was = this.mode;
    let view = "";
    try {
      if (this.ctx !== null) {
        await this.call("setMode(false)");
        await this.call("frame()", true);
      }
      const image = await this.contents.capturePage(undefined, { stayHidden: true });
      if (!image.isEmpty()) view = image.toPNG().toString("base64");
    } catch {
      view = "";
    }
    if (was && this.ctx !== null) await this.call(`setMode(true, ${JSON.stringify(this.tool)}, ${JSON.stringify(this.shape)})`).catch(() => {});
    return {
      v: 1,
      url: this.contents.getURL(),
      title: this.contents.getTitle(),
      viewport: await this.viewport(),
      marks: this.marks.map((m) => ({ n: m.n, kind: m.kind, comment: m.comment, elements: m.elements, box: m.box, pin: m.pin, text: m.text, near: m.near, shape: m.shape, crop: m.crop, lost: m.lost })),
      console: this.ring.slice(),
      view,
      at: Date.now(),
    };
  }

  async viewport() {
    try {
      const result = await this.send("Runtime.evaluate", { expression: "({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })", returnByValue: true, contextId: this.ctx ?? undefined });
      const v = result?.result?.value;
      if (v && Number.isFinite(v.width)) return v;
    } catch {
      // Below.
    }
    return { width: 0, height: 0, dpr: 1 };
  }

  /** What the tab's chrome draws: the mode, the tool, what is held, and the marks without their pictures. */
  state() {
    return {
      on: this.mode,
      tool: this.tool,
      shape: this.shape,
      holding: this.held.length > 0,
      ready: this.attached,
      note: this.note || (this.attached ? null : this.why),
      max: MARKS_MAX,
      marks: this.marks.map((m) => ({
        n: m.n,
        kind: m.kind,
        comment: m.comment,
        lost: m.lost,
        box: m.box,
        text: m.text.slice(0, 200),
        near: m.near,
        shape: m.shape,
        hasCrop: m.crop !== "",
        elements: m.elements.map((e) => ({ tag: e.tag, classes: (e.classes || []).slice(0, 2), name: e.name, text: (e.text || "").slice(0, 80), role: e.role })),
      })),
    };
  }

  /** A mark's crop, as a data URL, for the popover. */
  cropOf(n) {
    const mark = this.marks.find((m) => m.n === n);
    return mark && mark.crop ? `data:image/png;base64,${mark.crop}` : null;
  }
}

/** A console argument as words: its value, or what CDP previews of it. */
function previewOf(arg) {
  if (!arg) return "";
  if (arg.type === "string") return String(arg.value);
  if ("value" in arg) return JSON.stringify(arg.value);
  if (arg.description) return String(arg.description);
  return arg.type || "";
}

/**
 * @typedef {{ k: string, n: number, kind: string, elements: any[], box: any, pin: {fx: number, fy: number}, text: string, near: string,
 *   shape: string, pageBox: any, stroke: any, url: string, comment: string, crop: string, lost: boolean }} Mark
 */

module.exports = { TabMarks, MARKS_MAX };
