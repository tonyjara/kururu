/**
 * When an emulator paints — which ghostty-web's own answer to is "every frame,
 * for ever, whether or not anybody can see it".
 *
 * `open()` starts a `requestAnimationFrame` loop that calls the renderer sixty
 * or a hundred and twenty times a second for as long as the terminal exists.
 * That is a fair default for a page with one terminal on it, and it is the
 * wrong one for a pool: kururu keeps a dozen emulators warm, most of them in no
 * pane at all, and every one of them ran that loop. Each frame asks the WASM
 * about every row; with `cursorBlink` on — the default — each frame also draws
 * the cursor's row again, in every emulator, including the unfocused ones that
 * draw no cursor and the detached ones nobody can see; and drawing a row means
 * `getLine`, which in 0.4.0 copies and parses the *whole viewport* to hand back
 * one row of it. A drawn canvas is a dirty canvas, so the compositor never
 * idled either. Measured on 2026-10-11, twelve pooled emulators with nothing
 * printing cost a fifth of a core in the renderer and as much again in the GPU
 * process; six agents working took the renderer past half a core. That was the
 * fan.
 *
 * So the loop is stopped and replaced with one that asks first. An emulator
 * paints only while it is in a pane, and only on a frame where something it
 * would draw has changed: bytes arrived, the cursor moved or blinked, the
 * selection or a hovered link moved, the viewport scrolled, the scrollbar is
 * fading. Otherwise the frame is skipped and, once nothing has happened for a
 * moment, the loop is not even scheduled — an idle window wakes no CPU at all.
 * A detached emulator is still *fed* (see `announce` in `terminals.ts`), so the
 * WASM screen stays current; it is the picture of it that waits until a pane
 * borrows it again, and then it is drawn in full before the pane is painted.
 *
 * Polling a "changed?" question each frame was the alternative that needs no
 * wake-ups, and it is what this does while anything is happening. It is not
 * enough on its own: a loop that runs every frame to find nothing is still a
 * CPU woken at the display's rate, which on a laptop is most of the battery
 * the fix is for. Hence the waking: kururu's sink says when bytes land, the
 * blink timer says when it flips, and any input in the window keeps the
 * on-screen emulators looking for `GRACE_MS` — long enough for the things
 * ghostty-web does asynchronously off a pointer, like resolving a hovered
 * link, to land.
 *
 * Everything here leans on ghostty-web's private shape, the way `cursortext.ts`
 * and `boxdraw.ts` do, and `changed` mirrors the inputs of its `render` in
 * 0.4.0. If an upgrade renames what this reaches for, `install` declines and
 * the library's own loop is left running: slower, never frozen. If one adds a
 * new input to `render` that is not in `changed`, the symptom is a picture
 * that lags until the next byte — check here first.
 */
import type { Terminal } from "ghostty-web";

/**
 * How long input anywhere in the window keeps the on-screen emulators asking.
 *
 * A hovered link is resolved by an async provider and lands on a later frame
 * than the `mousemove` that asked for it, and a wheel starts a smooth scroll
 * that moves the viewport over several. A quarter of a second covers both with
 * room, and costs nothing while nothing changes: an awake frame with nothing
 * to draw is a handful of reads.
 */
const GRACE_MS = 250;

/** What this needs of a renderer. Private in the published types. */
interface Renderer {
  render(buffer: Buffer, forceAll: boolean, viewportY: number, provider: unknown, opacity?: number): void;
  startCursorBlink(): void;
  stopCursorBlink(): void;
  cursorBlinkInterval?: number;
  cursorBlink: boolean;
  cursorVisible: boolean;
  cursorStyle: string;
  theme: object;
  metrics: { width: number; height: number };
  devicePixelRatio: number;
  canvas: HTMLCanvasElement;
  hoveredHyperlinkId: number;
  previousHoveredHyperlinkId: number;
  hoveredLinkRange: unknown;
  previousHoveredLinkRange: unknown;
  selectionManager?: {
    hasSelection(): boolean;
    getSelectionCoords(): unknown;
    getDirtySelectionRows(): { size: number };
  };
}

/** And of the WASM terminal behind it. */
interface Buffer {
  getCursor(): { x: number; y: number; visible: boolean };
  getDimensions(): { cols: number; rows: number };
  getViewport(): object[];
  getLine(y: number): object[] | null;
  isDirty(): boolean;
  update(): unknown;
}

/** And of the `Terminal` itself. */
interface Internals {
  renderer?: Renderer;
  wasmTerm?: Buffer;
  viewportY: number;
  scrollbarOpacity: number;
  isDisposed: boolean;
  isOpen: boolean;
  animationFrameId?: number;
  startRenderLoop(): void;
  lastCursorY?: number;
  cursorMoveEmitter?: { fire(): void };
}

export interface Frames {
  /** It is in a pane now, or it is not. Shown, it is drawn before this returns. */
  show(on: boolean): void;
  /** Something it draws may have changed: bytes, a size. */
  wake(): void;
  dispose(): void;
}

const INERT: Frames = { show() {}, wake() {}, dispose() {} };

/**
 * Whether this is the ghostty-web this file was written against. Checked per
 * terminal rather than once, because the renderer and the WASM terminal only
 * exist after `open()`.
 */
function understood(t: Internals): t is Internals & { renderer: Renderer; wasmTerm: Buffer } {
  const r = t.renderer;
  const w = t.wasmTerm;
  return (
    typeof t.startRenderLoop === "function" &&
    typeof t.animationFrameId === "number" &&
    !!r &&
    !!w &&
    typeof r.render === "function" &&
    typeof r.startCursorBlink === "function" &&
    typeof r.stopCursorBlink === "function" &&
    typeof w.isDirty === "function" &&
    typeof w.getViewport === "function" &&
    typeof w.getLine === "function" &&
    typeof w.getDimensions === "function"
  );
}

// --- one row of the viewport, without the rest of it --------------------------

/**
 * The buffer the renderer is drawing right now, and its viewport once read.
 *
 * `getLine` copies every cell of the screen out of the WASM and parses them all
 * into objects, then keeps one row — so a frame that draws twenty rows parsed
 * the screen twenty times, and the cursor's glyph (`cursortext.ts`) parsed it
 * once more. Within one `render` call nothing writes to the terminal, so the
 * screen read for the first row is the screen for every row after it, and is
 * kept exactly that long. Outside a render the library's own `getLine` answers,
 * since outside one the screen can move between two calls.
 */
let drawing: Buffer | null = null;
let viewport: object[] | null = null;

const rowsCached = new WeakSet<Buffer>();
const rendersCached = new WeakSet<Renderer>();

/** Per buffer, because `reset()` builds a new WASM terminal and a new buffer. */
function cacheRows(buffer: Buffer): void {
  if (rowsCached.has(buffer)) return;
  rowsCached.add(buffer);
  const original = buffer.getLine.bind(buffer);
  buffer.getLine = (y: number) => {
    if (drawing !== buffer) return original(y);
    const { cols, rows } = buffer.getDimensions();
    if (y < 0 || y >= rows) return null;
    if (!viewport) {
      buffer.update();
      viewport = buffer.getViewport();
    }
    // A copy, as the original hands out: the pool behind `getViewport` is
    // reused by the next read, and a caller may hold on to a row.
    return viewport.slice(y * cols, y * cols + cols).map((cell) => ({ ...cell }));
  };
}

function cacheRenders(renderer: Renderer): void {
  if (rendersCached.has(renderer)) return;
  rendersCached.add(renderer);
  const original = renderer.render.bind(renderer);
  renderer.render = (buffer, forceAll, viewportY, provider, opacity) => {
    cacheRows(buffer);
    drawing = buffer;
    viewport = null;
    try {
      original(buffer, forceAll, viewportY, provider, opacity);
    } finally {
      drawing = null;
      viewport = null;
    }
  };
}

// --- the shared loop ----------------------------------------------------------

/** Every emulator that is in a pane. Input wakes these and no others. */
const shown = new Set<Painter>();
/** The ones that may have something to draw on the next frame. */
const awake = new Set<Painter>();
let frame = 0;
/**
 * A button is down somewhere in the window. A selection drag runs its own
 * autoscroll timer and leaves the element, so for as long as it lasts the
 * on-screen emulators keep asking rather than waiting to be told.
 */
let held = false;

function schedule(): void {
  if (!frame) frame = requestAnimationFrame(tick);
}

function tick(): void {
  frame = 0;
  const now = performance.now();
  for (const painter of awake) {
    // A frame that drew keeps it for one more, which is what follows a smooth
    // scroll or a fade to its end without anything having to say so.
    if (!painter.paint() && !held && now >= painter.until) awake.delete(painter);
  }
  if (awake.size) schedule();
}

function wakeShown(): void {
  for (const painter of shown) painter.wakeFor(GRACE_MS);
}

/**
 * Input, anywhere in the window, on the capturing side.
 *
 * On `window` rather than on each emulator's element because `wirePointer` in
 * `terminals.ts` has to be the first capturing listener *on* the element, and
 * takes gestures off it — one that took a wheel would have taken this with it.
 * Waking every on-screen emulator for one key is no waste: there are a few,
 * and one with nothing to draw costs a few reads a frame for a quarter-second.
 *
 * Touch as well as pointer events, because a finger dragged over a terminal is
 * a scroll `wirePointer` performs itself on `touchmove`, and a browser that
 * decided the gesture was a pan has already sent `pointercancel` and nothing
 * after it.
 */
const INPUT = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "touchstart",
  "touchmove",
  "touchend",
  "wheel",
  "keydown",
  "keyup",
  "compositionupdate",
  "compositionend",
  "paste",
  "focusin",
  "focusout",
] as const;

if (typeof window !== "undefined") {
  for (const type of INPUT) window.addEventListener(type, wakeShown, { capture: true, passive: true });
  window.addEventListener("pointerdown", () => (held = true), { capture: true, passive: true });
  const letGo = () => {
    held = false;
    wakeShown();
  };
  for (const type of ["pointerup", "pointercancel", "mouseup", "dragend", "blur"] as const) {
    window.addEventListener(type, letGo, { capture: true, passive: true });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) held = false;
    else wakeShown();
  });
}

// --- one emulator ---------------------------------------------------------------

class Painter {
  until = 0;
  private on = false;
  private full = false;
  private last = "";

  constructor(
    private readonly t: Internals & { renderer: Renderer; wasmTerm: Buffer },
  ) {}

  wakeFor(ms: number): void {
    if (!this.on) return;
    this.until = Math.max(this.until, performance.now() + ms);
    awake.add(this);
    schedule();
  }

  show(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    if (!on) {
      shown.delete(this);
      awake.delete(this);
      return;
    }
    shown.add(this);
    /**
     * Drawn in full, and now rather than on the next frame. Now, because
     * `borrow` runs in a layout effect and the browser paints straight after:
     * a frame later would show the screen as it was when the pane let go of
     * it. In full, because a canvas that has been in no pane for an hour is
     * owed everything that happened in that hour, and the WASM's dirty rows
     * are a promise about one frame to the next rather than about an hour.
     */
    this.full = true;
    this.paint();
    this.wakeFor(0);
  }

  /**
   * One frame of ghostty-web's loop, if anything in it would change.
   *
   * @returns whether it drew.
   */
  paint(): boolean {
    const t = this.t;
    if (t.isDisposed || !t.isOpen) return false;
    const r = t.renderer;
    // Read each frame rather than kept: `reset()` builds a new one.
    const w = t.wasmTerm;
    if (!r || !w) return false;
    const full = this.full;
    if (!full && !this.changed(r, w)) return false;
    this.full = false;
    r.render(w, full, t.viewportY, t, t.scrollbarOpacity);
    // After, not before: `render` resizes the canvas itself when the grid moved.
    this.last = this.snapshot(r, w);
    // The other half of the library's loop body: `onCursorMove` fires from it.
    const y = w.getCursor().y;
    if (y !== t.lastCursorY) {
      t.lastCursorY = y;
      t.cursorMoveEmitter?.fire();
    }
    return true;
  }

  /**
   * Whether `render` would draw anything that is not already on the canvas.
   *
   * Dirt first: rows the WASM reports, and rows a selection left behind. Then
   * the two hover comparisons `render` itself makes, in the same terms —
   * `JSON.stringify` for the link range, as it does, because a range set again
   * to an equal object is not a change and comparing by reference would draw
   * it every frame for ever. Then everything else it reads, by value.
   */
  private changed(r: Renderer, w: Buffer): boolean {
    if (w.isDirty()) return true;
    if (r.selectionManager && r.selectionManager.getDirtySelectionRows().size > 0) return true;
    if (r.hoveredHyperlinkId !== r.previousHoveredHyperlinkId) return true;
    if (JSON.stringify(r.hoveredLinkRange) !== JSON.stringify(r.previousHoveredLinkRange)) return true;
    return this.snapshot(r, w) !== this.last;
  }

  private snapshot(r: Renderer, w: Buffer): string {
    const t = this.t;
    const cursor = w.getCursor();
    const { cols, rows } = w.getDimensions();
    const selection = r.selectionManager?.hasSelection() ? JSON.stringify(r.selectionManager.getSelectionCoords()) : "";
    return [
      cursor.x,
      cursor.y,
      cursor.visible,
      r.cursorVisible,
      r.cursorStyle,
      themeId(r.theme),
      cols,
      rows,
      r.canvas.width,
      r.canvas.height,
      r.metrics.width,
      r.metrics.height,
      r.devicePixelRatio,
      t.viewportY,
      t.scrollbarOpacity,
      selection,
    ].join("|");
  }
}

/** A theme by identity: `setTheme` replaces the object, it never edits one. */
const themes = new WeakMap<object, number>();
let themeCount = 0;
function themeId(theme: object): number {
  let id = themes.get(theme);
  if (id === undefined) themes.set(theme, (id = ++themeCount));
  return id;
}

/**
 * Take over when this emulator paints. Call once, straight after `open()`.
 *
 * It starts hidden: `show(true)` is what puts it on the loop, and `borrow` is
 * what says so.
 */
export function installFrames(term: Terminal): Frames {
  const t = term as unknown as Internals;
  if (!understood(t)) {
    console.warn("kururu: ghostty-web is not the version frames.ts knows; its own render loop stays on");
    return INERT;
  }
  cancelAnimationFrame(t.animationFrameId!);
  t.animationFrameId = undefined;
  // `open()` is the only caller in 0.4.0, and it throws on a second call — but
  // a loop that came back would undo all of this without a sound.
  t.startRenderLoop = () => {};
  cacheRenders(t.renderer);

  const painter = new Painter(t);

  /**
   * The blink is a timer of the renderer's that flips a boolean and waits for
   * the loop to notice. There is no loop to notice now, so the flip says so.
   * Restarted if it is already running, since the constructor starts it before
   * there was anything here to patch.
   */
  const r = t.renderer;
  r.startCursorBlink = () => {
    if (r.cursorBlinkInterval !== undefined) clearInterval(r.cursorBlinkInterval);
    r.cursorBlinkInterval = window.setInterval(() => {
      r.cursorVisible = !r.cursorVisible;
      painter.wakeFor(0);
    }, 530);
  };
  if (r.cursorBlinkInterval !== undefined) {
    r.stopCursorBlink();
    r.startCursorBlink();
  }

  return {
    show: (on) => painter.show(on),
    wake: () => painter.wakeFor(0),
    dispose: () => painter.show(false),
  };
}
