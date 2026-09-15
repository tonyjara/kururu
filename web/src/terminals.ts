/**
 * Every terminal's emulator, kept for as long as its terminal exists — and moved
 * between panes rather than rebuilt.
 *
 * Kururu used to tie an emulator's lifetime to the view that drew it. A tab
 * switch, a workspace change, a profile swap or a pane rebuild threw one away
 * and built another, which then had to be refilled from a screen the server
 * serialized on demand, at a width the client named in the request, because a
 * serialized screen is laid out at a width and reconstructing it at any other
 * one wraps every row and never recovers. Almost everything expensive in the
 * terminal path exists to make that survivable, and its only job is to paper
 * over the rebuild.
 *
 * Nobody else does it that way, including the people who wrote this emulator:
 * coder/mux keeps its terminal alive while hidden *"so we don't lose
 * frontend-only state"*, rcarmo/webterm disposes only when the element leaves
 * the document, and VS Code has re-parented the same wrapper element between
 * containers since the beginning. The WebGL blackouts that cost us xterm.js
 * belong to the same root: a page gets about sixteen contexts, and sixteen is
 * only a budget you can exhaust if you are building emulators continuously.
 *
 * So an emulator is pooled by agent id. A pane does not create one, it
 * **borrows** one: `TerminalView` renders an empty mount and the pooled host
 * element is appended into it imperatively. React must never render that element
 * as a child of anything — it would try to remove it on the next commit — which
 * is exactly what makes a tab switch, a workspace change and a drag a DOM move
 * instead of a rebuild.
 *
 * `open()` throws on a second call, and that is no obstacle: the element is
 * moved, never re-opened.
 *
 * What stays true is who is allowed to ask for a backlog. A genuinely new
 * emulator asks — a first borrow, one that was evicted and came back, one whose
 * socket dropped while it was off screen. Ordinary navigation asks for nothing,
 * because there is nothing to rebuild.
 */
import { FitAddon, init, Terminal } from "ghostty-web";
import { usableGrid } from "./grid";
import { input, rebuild, resize, subscribeOutput, warm } from "./session";

/**
 * How many emulators are kept.
 *
 * Twelve is more terminals than a window tiles and fewer than an afternoon
 * accumulates, so ordinary navigation never evicts and a session that has opened
 * fifty does not hold fifty canvases. An entry that falls off the end is exactly
 * the cold case the backlog path still exists for, so nothing is lost by being
 * evicted — it simply stops happening while you work.
 *
 * A terminal that is *on screen* is never evicted, whatever the count says: a
 * window tiled into more panes than this would otherwise start throwing away the
 * emulators it is currently drawing, which is the failure the pool exists to
 * remove. The cap yields rather than the picture.
 */
const POOL_MAX = 12;

/** How long a pane has to stop changing size before the pty is told about it. */
const RESIZE_SETTLE_MS = 60;

/**
 * Colours, given to the emulator rather than the stylesheet — it paints into a
 * canvas, so CSS cannot reach any of this. Kept in step with styles.css by hand,
 * which is the trade for not rendering a thousand DOM nodes a frame.
 */
const THEME = {
  background: "#0d0f0e",
  foreground: "#d7dbd8",
  cursor: "#7fd6a2",
  cursorAccent: "#0d0f0e",
  selectionBackground: "#2b3a33",
  black: "#1b1f1d",
  red: "#e57373",
  green: "#7fd6a2",
  yellow: "#e3c46a",
  blue: "#7aa6da",
  magenta: "#c28fd8",
  cyan: "#77c8c8",
  white: "#c8cec9",
  brightBlack: "#5a635e",
  brightRed: "#ff8a80",
  brightGreen: "#9bf0bd",
  brightYellow: "#ffdd8a",
  brightBlue: "#9cc3f0",
  brightMagenta: "#dbabef",
  brightCyan: "#96e5e5",
  brightWhite: "#f0f3f1",
};

/**
 * The Nerd Font faces are in this stack for their glyphs, not their letterforms.
 * An agent TUI — or an nvim opened inside one — draws devicons and powerline
 * separators out of the private use area, and SF Mono contains none of them, so
 * the browser has nothing to fall back to and paints tofu. Ghostty's *native*
 * app does not have this problem because it compiles Symbols Nerd Font Mono into
 * its own binary and falls back to it silently; the WASM build has no font of
 * its own and takes what the page names, so the fallback has to be spelled out
 * here and has to name a face the system actually has.
 *
 * Two generations of patched font are named because no single one covers both.
 * Nerd Fonts v3 moved Material Design Icons from U+F500–FD46 to U+F0001–F1AF0
 * and dropped the old range, so a dotfile written against v2 — which is most of
 * them, since they get carried forward rather than rewritten — asks for
 * codepoints a freshly patched font no longer has. MesloLGS NF is the v2-era
 * build powerlevel10k ships, and it goes last precisely so it answers only what
 * the v3 faces ahead of it cannot.
 *
 * They all stay *after* SF Mono deliberately: the cell is measured from the
 * first face in the stack, so appending rather than prepending leaves the grid
 * metrics exactly as they were. The "Mono" variants are the ones whose glyphs
 * are a single cell wide, which is the only kind that can land in a grid without
 * overhanging the next column.
 *
 * This fixes the machine that has the fonts installed, which is the desktop. A
 * phone over Tailscale has none of them and will keep showing tofu until one is
 * served as a webfont.
 */
const FONT_STACK =
  '"SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", ' +
  '"FiraCode Nerd Font Mono", "JetBrainsMono Nerd Font Mono", ' +
  '"Symbols Nerd Font Mono", "MesloLGS NF", monospace';

/**
 * The WASM module, started when this module is imported rather than when the
 * first pane asks for it.
 *
 * Instantiating it is the one part of building a terminal that is not instant,
 * and a page that is about to draw four of them would otherwise do that work on
 * the frame the panes appear. Starting here overlaps it with the websocket
 * connecting, which is dead time anyway. The module carries its own wasm inline
 * as a data URL, so there is no request to fail and nothing to serve alongside
 * the bundle.
 *
 * It resolves to whether it worked rather than rejecting, because a rejection
 * nobody is listening for yet is an unhandled one — no pane has mounted at this
 * point. A machine that cannot run it gets empty panes and one line saying so,
 * which is the failure that can be read; a thrown error inside an effect is the
 * one that takes the window with it.
 */
const ready: Promise<boolean> = init().then(
  () => true,
  (err) => {
    console.error("kururu: the terminal emulator could not start —", err);
    return false;
  },
);

interface Pooled {
  readonly agentId: string;
  /** The element `open()` was called on. This is what moves between panes. */
  readonly element: HTMLDivElement;
  /** A pane has it right now, which is what makes it ineligible for eviction. */
  attached: boolean;
  /** The pane holding it has the keyboard. Remembered, because `open()` is late. */
  wantsFocus: boolean;
  /**
   * The socket dropped while this was off screen, so what it holds is missing
   * whatever arrived in the gap. Nothing is done about it until it is borrowed:
   * a rebuild is a screen at a size, and a detached emulator has no size worth
   * asking at.
   */
  stale: boolean;
  /** Bumped on every borrow. The LRU end of this is what eviction takes. */
  usedAt: number;
  /**
   * Fit to whatever box the element is in now, and follow through: subscribe if
   * this is the first believable measurement, rebuild if a reconnect left this
   * one behind, and tell the pty the shape once it has stopped moving. A no-op
   * while the element is detached, which is how being in the pool costs nothing.
   */
  measure(): void;
  /** Hand it the keyboard, if it exists yet. See `setFocused`. */
  focus(): void;
  dispose(): void;
}

const pool = new Map<string, Pooled>();

/** Bumped rather than timestamped: two borrows in one millisecond still order. */
let clock = 0;

/**
 * Tell the server what this client is keeping an emulator for.
 *
 * A pooled emulator has to be fed whether or not it is on screen, or it goes
 * stale and we are back to reconstructing it — which is the thing the pool
 * exists to stop. So *warm* is sent alongside *visible*, and the server streams
 * the union. The two stay separate messages' worth of meaning because only one
 * of them says what a human can see, and the unread mark is about exactly that.
 */
function announce(): void {
  warm(pool.keys());
}

function create(agentId: string): Pooled {
  const element = document.createElement("div");
  element.className = "term";

  let terminal: Terminal | null = null;
  let disposed = false;
  let subscribed = false;
  let unsubscribe = () => {};
  let typed: { dispose(): void } | null = null;
  let observer: ResizeObserver | null = null;
  let settle: ReturnType<typeof setTimeout> | null = null;

  const entry: Pooled = {
    agentId,
    element,
    attached: false,
    wantsFocus: false,
    stale: false,
    usedAt: ++clock,
    // Replaced once the emulator exists. Until then there is nothing to measure
    // and nothing that could be told a size.
    measure: () => {},
    focus: () => terminal?.focus(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (settle) clearTimeout(settle);
      unsubscribe();
      typed?.dispose();
      observer?.disconnect();
      terminal?.dispose();
      terminal = null;
      element.remove();
    },
  };

  void ready.then((ok) => {
    if (!ok || disposed) return;

    const em = new Terminal({
      theme: THEME,
      fontFamily: FONT_STACK,
      fontSize: 12,
      cursorBlink: true,
      // History lives on the server too, but only what it has been asked for is
      // sent; this is what the emulator itself keeps once it is open.
      scrollback: 10000,
    });
    const fit = new FitAddon();
    em.loadAddon(fit);
    em.open(element);
    terminal = em;
    if (entry.wantsFocus) em.focus();

    /**
     * Nothing is subscribed until the grid is the pane's.
     *
     * An emulator built without `cols`/`rows` is 80x24, and it stays 80x24 until
     * a fit lands — which cannot happen on the frame after a split, when the box
     * has no size yet, nor before the renderer has measured a character. A
     * backlog is a screen *serialized at the size the server thinks it is*, so
     * writing one into an 80-column grid wraps every line of it at 80 and leaves
     * it wrapped; the later resize unwraps the text but not the damage, and what
     * is left is a screen the agent believes it has already drawn correctly and
     * will never repaint. Asking a frame later costs nothing and cannot land in
     * the wrong shape.
     *
     * `proposeDimensions` rather than catching a throw from `fit`: fit does not
     * throw when the renderer has no cell size yet, it quietly does nothing, so
     * a try/catch cannot tell "fitted" from "silently skipped". And its answer
     * goes through `usableGrid` rather than merely being checked for being a
     * number, because this addon does not decline to measure an unlaid-out box —
     * it clamps, and answers `2x1`, which is finite, positive and catastrophic.
     *
     * A detached element is the same question with a different cause and the
     * same right answer: it reports no width, so the measurement is refused, the
     * emulator keeps the shape it was last drawn at, and the pty hears nothing
     * about a pane that no longer exists.
     */
    const measure = () => {
      if (disposed) return;
      if (!usableGrid(fit.proposeDimensions())) return;
      fit.fit();
      if (!subscribed) {
        subscribed = true;
        unsubscribe = subscribeOutput(agentId, sink);
      } else if (entry.stale) {
        // A reconnect happened while this was off screen. Now that it is in a
        // box again, it can say what shape to rebuild it at.
        entry.stale = false;
        rebuild(agentId, sink);
      }
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => resize(agentId, em.cols, em.rows), RESIZE_SETTLE_MS);
    };

    const sink = {
      /**
       * Guarded, and not out of caution. Where xterm quietly ignored a write to
       * a terminal that had gone, every one of these throws `Terminal has been
       * disposed` — and a sink that throws is a sink that throws inside the
       * socket's message loop, which is the one place in the client a single
       * dead pane could take everything else with it. `session.ts` catches that
       * too; this is the half that stops it being raised in the first place.
       */
      write: (data: string) => {
        if (!disposed) em.write(data);
      },
      /**
       * The shape this emulator is drawing at, asked for rather than remembered:
       * the pane is resizable, and a reconnect asks again on behalf of an
       * emulator that has been sitting here for an hour.
       */
      grid: () => ({ cols: em.cols, rows: em.rows }),
      /**
       * The socket came back while this was off screen. It cannot be rebuilt
       * here — a backlog is a screen at a width and a detached element has none
       * — so it is noted and `measure` picks it up the moment a pane borrows it.
       */
      stale: () => {
        entry.stale = true;
      },
      /**
       * A backlog replaces the whole screen, and nothing has to be done to make
       * that stick — which is worth saying, because under the old emulator it
       * did. xterm repainted only the rows it believed had changed, so after a
       * reset its idea of what changed did not cover cells the renderer was
       * still holding, and the picture stayed wrong exactly where the agent
       * never writes again. This renderer draws the viewport from the WASM
       * buffer on its own loop rather than from a record of which cells it
       * thinks are dirty, so a screen replaced wholesale is simply the screen it
       * draws next. If a backlog ever does land looking half-painted, this
       * paragraph is the assumption that was wrong.
       */
      reset: (data: string, cols: number, rows: number) => {
        if (disposed) return;
        /**
         * The grid before the bytes. A backlog is a screen serialized at a
         * width, and this is the width it was serialized at. Written into any
         * other shape, every row longer than the target wraps, everything below
         * it slides down, and the top scrolls away.
         */
        if (cols >= 2 && rows >= 2 && (cols !== em.cols || rows !== em.rows)) {
          em.resize(cols, rows);
        }
        em.reset();
        em.write(data, () => {
          /**
           * And back to the box, in the case where that was not already the
           * shape of it. Reflowing a correct screen is what an emulator does for
           * every window resize; reflowing a wrapped one would be reflowing
           * damage.
           */
          measure();
        });
      },
    };

    entry.measure = measure;
    measure();

    observer = new ResizeObserver(measure);
    observer.observe(element);

    /**
     * One channel, unlike xterm's two: mouse reports and bracketed paste arrive
     * here already encoded rather than on a separate binary event. If mouse
     * reporting ever looks wrong, that difference is where to start.
     */
    typed = em.onData((data) => input(agentId, data));
  });

  return entry;
}

/**
 * Make room, and never at the expense of something on screen.
 *
 * Least recently *borrowed* rather than least recently written to: what makes an
 * emulator worth keeping is that somebody is likely to look at it again, and
 * output is the poorest possible evidence of that — a chatty agent in a
 * workspace nobody has opened for an hour would otherwise keep itself alive by
 * talking.
 */
function evict(): void {
  while (pool.size > POOL_MAX) {
    let oldest: Pooled | null = null;
    for (const entry of pool.values()) {
      if (entry.attached) continue;
      if (!oldest || entry.usedAt < oldest.usedAt) oldest = entry;
    }
    // Every one of them is in a pane. The cap is a budget, not a promise.
    if (!oldest) return;
    pool.delete(oldest.agentId);
    oldest.dispose();
  }
}

/**
 * Put this terminal's emulator in this pane, building it if this is the first
 * time anybody has asked.
 *
 * `appendChild` of an element that is already somewhere else moves it, which is
 * the whole mechanism: the canvas, its scrollback, its selection and its scroll
 * position come across because they were never anywhere else.
 */
export function borrow(agentId: string, mount: HTMLElement): void {
  let entry = pool.get(agentId);
  const fresh = !entry;
  if (!entry) pool.set(agentId, (entry = create(agentId)));
  entry.usedAt = ++clock;
  // Before `evict`, and that order matters: a window tiled into more panes than
  // the cap would otherwise build the thirteenth pane's emulator and throw it
  // away in the same breath, because nothing had yet said it was on screen.
  entry.attached = true;
  if (entry.element.parentNode !== mount) mount.appendChild(entry.element);
  if (fresh) {
    evict();
    announce();
  }
  // The box is real as of this call — a layout effect runs with the DOM
  // committed — so the fit can happen now rather than waiting for the observer.
  entry.measure();
}

/**
 * This pane is done with it. The emulator stays; only the element comes out.
 *
 * Checked against the mount rather than done unconditionally, because React
 * runs every cleanup before every effect but a moved tab is still two panes
 * touching one element: whoever has it now is the one entitled to say where it
 * goes, and a pane tidying up after itself must not take it off them.
 */
export function release(agentId: string, mount: HTMLElement): void {
  const entry = pool.get(agentId);
  if (!entry || entry.element.parentNode !== mount) return;
  entry.element.remove();
  entry.attached = false;
}

/**
 * Whether this terminal is the one the keyboard belongs to. Remembered rather
 * than only applied, because the first emulator of a session is still waiting on
 * the WASM when the pane that would focus it mounts.
 */
export function setFocused(agentId: string, focused: boolean): void {
  const entry = pool.get(agentId);
  if (!entry) return;
  entry.wantsFocus = focused;
  if (focused) entry.focus();
}

/**
 * Dispose the emulators of terminals that no longer exist.
 *
 * An emulator for an agent that is gone is a leak with a canvas in it, and the
 * client is only ever told about it by omission — a killed terminal, a closed
 * tab and a deleted workspace all arrive as an agent that is simply no longer in
 * the snapshot.
 *
 * Which means this also fires on a profile switch, since a snapshot lists one
 * profile's agents and not the others'. That is a real cost and it is the
 * honest one: the server does not say whether an id it has stopped mentioning is
 * dead or merely elsewhere, and keeping an emulator on the guess that it is
 * elsewhere is how you keep one for a terminal that ended an hour ago. Switching
 * *workspaces* — the move this pool is mostly for — keeps everything, because a
 * profile's snapshot spans all of them.
 */
export function retain(liveIds: ReadonlySet<string>): void {
  let changed = false;
  for (const [agentId, entry] of pool) {
    if (liveIds.has(agentId)) continue;
    pool.delete(agentId);
    entry.dispose();
    changed = true;
  }
  if (changed) announce();
}
