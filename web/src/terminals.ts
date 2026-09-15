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
 * terminal path existed to make that survivable, and its only job was to paper
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
 *
 * What is *no longer* true is that a pane decides how big its terminal is. An
 * emulator here measures its box and proposes the grid; the server collects the
 * proposals, picks one, resizes the pty, and sends back the shape everybody is
 * to draw at. So the only places an emulator changes size are `sink.size` and
 * `sink.reset`, both of which are the server answering — and the pty and the
 * emulator can no longer hold two ideas of where a row ends, which is the
 * disagreement underneath every screen kururu has drawn wrong.
 */
import { FitAddon, init, Terminal } from "ghostty-web";
import {
  DEFAULT_APPEARANCE,
  themeFor,
  type CursorStyle,
  type TerminalAppearance,
  type TerminalTokens,
} from "../../shared/theme";
import { installBoxDrawing } from "./boxdraw";
import { usableGrid } from "./grid";
import { BUTTON_NONE, encodeMouse, type MouseModes, mouseModes, WHEEL_DOWN, WHEEL_UP } from "./mouse";
import { input, proposeSize, rebuild, subscribeOutput, warm } from "./session";

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

/**
 * How long a pane has to stop changing size before the server hears about it.
 *
 * The pty is still on the far end of that proposal, and every resize it gets is
 * a SIGWINCH that makes an agent TUI repaint completely — so dragging a divider
 * without this repaints the program on every frame of the drag.
 */
const RESIZE_SETTLE_MS = 60;

/**
 * What the emulator is currently painting with, and what it is set in.
 *
 * Module state rather than an argument, because an emulator is built at the
 * moment a pane first borrows it and that is nowhere near the moment a theme is
 * chosen: the pool builds terminals all afternoon and every one of them has to
 * come up wearing whatever is on. So the current values live here, `restyle`
 * writes them and walks the pool, and `create` reads them.
 *
 * Colours go to the emulator rather than to the stylesheet because it paints
 * into a canvas and CSS cannot reach any of it. That used to mean a second
 * palette kept in step with `styles.css` by hand; it does not now — both halves
 * come out of one `Theme` in `shared/theme.ts`, and this is simply the half that
 * is handed over as an object instead of being set as custom properties.
 */
let palette: TerminalTokens = themeFor(null).terminal;
let type: TerminalAppearance = DEFAULT_APPEARANCE.terminal;

/**
 * The cursor style an unfocused pane is given, which is not one of the three.
 *
 * ghostty-web has no idea what focus is. `renderCursor` fills a rectangle in
 * `theme.cursor` whenever the viewport is at the bottom and the terminal's own
 * cursor mode says visible, and nothing in the library — renderer or terminal —
 * asks whether anybody is typing into it. So a tiled window draws a solid
 * blinking block in *every* pane at once, and a pane whose terminal is sitting
 * at its home position draws it in the top-left corner, which is how this was
 * noticed: focus one pane and the others keep theirs.
 *
 * A real terminal draws a hollow box when it loses focus. This renderer cannot
 * — there is no outline path in it — so the choice is a solid cursor or none,
 * and none is right here: `pane-on` already marks where the keyboard is going,
 * and a cursor in every pane actively contradicts it.
 *
 * The mechanism is that `renderCursor` switches on the style and has **no
 * default case**, so a style it does not recognise draws nothing. That is being
 * leant on rather than merely observed, so it is worth saying what breaks it: a
 * future version of the library adding a `default:` to that switch puts every
 * cursor back, and the symptom is exactly the one described above — a cursor in
 * the corner of every pane you are not typing into. It is cosmetic and visible
 * immediately, which is why it is an acceptable thing to lean on; check that
 * switch in `node_modules/ghostty-web/dist/ghostty-web.js` before looking
 * anywhere else.
 *
 * The alternative was to keep a real style and tint the cursor to the
 * background for unfocused panes, which needs no unhandled case and was
 * rejected anyway — `renderCursor` paints its rectangle *over* the glyph and
 * never redraws it in `cursorAccent`, so a background-coloured block is an
 * erased character rather than an invisible cursor.
 */
const CURSOR_HIDDEN = "none" as CursorStyle;

/**
 * The face stack, with whatever the user named at the front of it.
 *
 * Prepended, and that is the point: the built-in stack below exists so an agent
 * TUI's devicons are not tofu, and somebody who types "Berkeley Mono" has said
 * nothing about wanting those to stop working. It does move the grid metrics,
 * since the cell is measured from the first face — which is exactly what
 * choosing a font means, and the reason the patched faces are appended rather
 * than prepended in the first place.
 */
function fontStack(): string {
  const chosen = type.fontFamily.trim();
  return chosen ? `"${chosen}", ${FONT_STACK}` : FONT_STACK;
}

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

/**
 * How many wheel notches one gesture may report.
 *
 * A mouse counts in notches and a macOS trackpad counts in pixels, and a hard
 * flick on the latter arrives as one event carrying several hundred of them.
 * Spending all of them hands the program a scroll it is still working through
 * long after the finger stopped, which reads as the terminal being stuck rather
 * than as the gesture having been enthusiastic.
 */
const MAX_NOTCHES = 8;

/**
 * Give the program the mouse when it has asked for one, and hand it back when
 * shift is held.
 *
 * A terminal cannot both paint a selection and report a drag, and which of them
 * gets the gesture has never been the terminal's decision — the program says, by
 * turning on the tracking modes in `mouse.ts`, and the answer every terminal
 * since xterm has given is that tracking wins and shift is the way back. Kururu
 * could not give that answer at all: ghostty-web has a selection manager and no
 * mouse reporting whatsoever, so an nvim in a pane could not be clicked into and
 * the browser painted its own selection over the top of one the editor already
 * had.
 *
 * Every listener is on the pooled element in the **capture** phase and
 * registered before `open()`, and both halves of that are load-bearing.
 * ghostty-web puts its own capture-phase `mousedown` and `wheel` on that same
 * node, and `stopPropagation` does nothing about another listener on the node an
 * event has already reached — only `stopImmediatePropagation` does, and only for
 * listeners registered after this one. If reporting ever starts fighting a
 * painted selection, that ordering is what broke.
 *
 * What is deliberately *not* claimed is `pointerdown`, which is how `Panes.tsx`
 * focuses the pane you clicked. It is a different event, so taking the mouse
 * ones leaves clicking into a pane working exactly as it did.
 */
function wireMouse(
  element: HTMLElement,
  terminalOf: () => Terminal | null,
  send: (data: string) => void,
): () => void {
  /** The button a drag is dragging, or null when nothing is held. */
  let held: number | null = null;
  /** The last cell reported, so crossing one cell is one report and not forty. */
  let lastCell = "";
  /** Wheel travel that has not yet added up to a whole notch. */
  let scrolled = 0;

  /**
   * What the program is listening for, or null if it is not listening.
   *
   * A pane scrolled up into its history is refused here rather than clamped. A
   * report names a cell by where it is on the screen, and what is on screen is
   * then not the program's screen; scrolling back is something the *terminal* is
   * doing and the program should hear nothing whatever about it.
   */
  const modesNow = (): MouseModes | null => {
    const em = terminalOf();
    if (!em || em.viewportY > 0) return null;
    const modes = mouseModes((mode) => em.getMode(mode));
    return modes.tracking === "none" ? null : modes;
  };

  /**
   * Which cell the pointer is over — clamped to the grid rather than refused,
   * because a drag that leaves the pane should go on reporting the edge it left
   * by. That is what makes selecting to the end of a line work in the program's
   * own selection, and it is the same choice the emulator makes for its.
   */
  const cellOf = (event: MouseEvent): { col: number; row: number } | null => {
    const em = terminalOf();
    const canvas = em?.renderer?.getCanvas();
    const width = em?.renderer?.charWidth ?? 0;
    const height = em?.renderer?.charHeight ?? 0;
    if (!em || !canvas || width <= 0 || height <= 0) return null;
    const box = canvas.getBoundingClientRect();
    return {
      col: Math.max(0, Math.min(Math.floor((event.clientX - box.left) / width), em.cols - 1)),
      row: Math.max(0, Math.min(Math.floor((event.clientY - box.top) / height), em.rows - 1)),
    };
  };

  const claim = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const report = (
    modes: MouseModes,
    action: "press" | "release" | "move",
    button: number,
    cell: { col: number; row: number },
    event: MouseEvent,
  ) => {
    const data = encodeMouse(
      { action, button, col: cell.col, row: cell.row, shift: event.shiftKey, alt: event.altKey, ctrl: event.ctrlKey },
      modes,
    );
    if (data) send(data);
  };

  const onDrag = (event: MouseEvent) => {
    if (held === null) return;
    const modes = modesNow();
    const cell = modes && cellOf(event);
    if (!modes || !cell) return;
    const key = `${cell.col},${cell.row}`;
    if (key === lastCell) return;
    lastCell = key;
    report(modes, "move", held, cell, event);
  };

  const onUp = (event: MouseEvent) => {
    if (held === null || event.button !== held) return;
    const button = held;
    held = null;
    document.removeEventListener("mousemove", onDrag, true);
    document.removeEventListener("mouseup", onUp, true);
    const modes = modesNow();
    const cell = modes && cellOf(event);
    if (!modes || !cell) return;
    claim(event);
    report(modes, "release", button, cell, event);
  };

  const onDown = (event: MouseEvent) => {
    // Shift is consulted here and nowhere else. It is the way back to a
    // selection the browser paints — xterm's key for it, and Ghostty's — but
    // once a button is down the gesture belongs to the program until it comes
    // up, or the program is left believing it is still being held.
    if (event.shiftKey || event.button > 2) return;
    const modes = modesNow();
    const cell = modes && cellOf(event);
    if (!modes || !cell) return;
    claim(event);
    held = event.button;
    lastCell = `${cell.col},${cell.row}`;
    // Among the defaults `claim` just stopped was focusing the emulator's
    // textarea, and a pane you clicked that does not then take the keyboard is
    // worse than no mouse reporting at all.
    terminalOf()?.focus();
    report(modes, "press", event.button, cell, event);
    // On the document, so a drag that leaves the pane keeps reporting rather
    // than stopping at the divider — which is how a window resize in nvim, or a
    // selection dragged past the edge, is finished off.
    document.addEventListener("mousemove", onDrag, true);
    document.addEventListener("mouseup", onUp, true);
  };

  const onHover = (event: MouseEvent) => {
    if (held !== null || event.shiftKey) return;
    const modes = modesNow();
    if (!modes || modes.tracking !== "any") return;
    const cell = cellOf(event);
    if (!cell) return;
    const key = `${cell.col},${cell.row}`;
    if (key === lastCell) return;
    lastCell = key;
    // Not claimed, unlike everything else here: a hover report is information
    // and conflicts with nothing, and taking the event would stop the emulator
    // ever seeing a link to underline.
    report(modes, "move", BUTTON_NONE, cell, event);
  };

  const onWheel = (event: WheelEvent) => {
    if (event.shiftKey) return;
    const modes = modesNow();
    const cell = modes && cellOf(event);
    if (!modes || !cell) return;
    // Claimed before the arithmetic, and whatever the arithmetic decides: the
    // emulator must not scroll its own scrollback under a program that has
    // asked to be told about the wheel itself.
    claim(event);
    const step = event.deltaMode === 0 ? (terminalOf()?.renderer?.charHeight ?? 16) : 1;
    // A reversal spends the bank rather than paying into it, or the first notch
    // back the other way is eaten by what the last one left behind.
    if (scrolled !== 0 && Math.sign(event.deltaY) !== Math.sign(scrolled)) scrolled = 0;
    scrolled += event.deltaY / step;
    const whole = Math.trunc(scrolled);
    if (whole === 0) return;
    scrolled -= whole;
    const button = whole > 0 ? WHEEL_DOWN : WHEEL_UP;
    for (let notch = Math.min(Math.abs(whole), MAX_NOTCHES); notch > 0; notch--) {
      report(modes, "press", button, cell, event);
    }
  };

  /**
   * The emulator's own answers to these — a context menu, and a word selected by
   * double-click — are exactly the gestures a program with tracking on has asked
   * to handle itself. The press underneath each was already reported by
   * `onDown`; this only stops the second answer arriving on top of it.
   */
  const onSuppress = (event: Event) => {
    if (modesNow()) claim(event);
  };

  element.addEventListener("mousedown", onDown, true);
  element.addEventListener("mousemove", onHover, true);
  element.addEventListener("wheel", onWheel, { capture: true, passive: false });
  element.addEventListener("contextmenu", onSuppress, true);
  element.addEventListener("dblclick", onSuppress, true);

  return () => {
    element.removeEventListener("mousedown", onDown, true);
    element.removeEventListener("mousemove", onHover, true);
    element.removeEventListener("wheel", onWheel, true);
    element.removeEventListener("contextmenu", onSuppress, true);
    element.removeEventListener("dblclick", onSuppress, true);
    document.removeEventListener("mousemove", onDrag, true);
    document.removeEventListener("mouseup", onUp, true);
  };
}

interface Pooled {
  readonly agentId: string;
  /** The element `open()` was called on. This is what moves between panes. */
  readonly element: HTMLDivElement;
  /** A pane has it right now, which is what makes it ineligible for eviction. */
  attached: boolean;
  /**
   * It should be holding the DOM focus. Remembered, because `open()` is late.
   *
   * Not the same question as `showsCursor` below, and conflating them was a bug
   * for about ten minutes: this one is false while a dialog is up, because keys
   * typed into Settings must not reach a pty.
   */
  wantsFocus: boolean;
  /**
   * Its pane is the focused one, which is the question the *cursor* answers to.
   *
   * Deliberately not `wantsFocus`. A dialog takes the keyboard without moving
   * where the keyboard will go back to — `Panes.tsx` keeps drawing `pane-on`
   * through one for exactly that reason — so a cursor keyed on the DOM focus
   * would vanish from every pane the moment Settings opened, which is the one
   * moment somebody is looking at a cursor on purpose.
   */
  showsCursor: boolean;
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
  /**
   * Wear whatever `palette` and `type` now say. A no-op until the emulator
   * exists, which costs nothing: one built after a theme change reads the same
   * two module variables in its constructor and comes up already wearing it.
   */
  restyle(remeasure: boolean): void;
  /**
   * Draw a cursor, or stop: this pane has the keyboard, or it does not. A no-op
   * until the emulator exists, which is fine — one built later reads
   * `wantsFocus` for itself.
   */
  applyCursor(): void;
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

  // Registered now rather than after `open()`, because being the first capture
  // listener on this node is the only thing that lets it take a gesture off the
  // emulator's own handlers. See `wireMouse`.
  const unwireMouse = wireMouse(element, () => terminal, (data) => input(agentId, data));

  const entry: Pooled = {
    agentId,
    element,
    attached: false,
    wantsFocus: false,
    showsCursor: false,
    stale: false,
    usedAt: ++clock,
    // Replaced once the emulator exists. Until then there is nothing to measure,
    // nothing that could be told a size, and nothing wearing the wrong colours.
    measure: () => {},
    restyle: () => {},
    applyCursor: () => {},
    focus: () => terminal?.focus(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (settle) clearTimeout(settle);
      unwireMouse();
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
      theme: palette,
      fontFamily: fontStack(),
      fontSize: type.fontSize,
      // Right from the start rather than corrected a beat later: a pane that is
      // not the focused one must never paint a cursor, not even for a frame.
      cursorStyle: entry.showsCursor ? type.cursorStyle : CURSOR_HIDDEN,
      cursorBlink: type.cursorBlink,
      // History lives on the server too, but only what it has been asked for is
      // sent; this is what the emulator itself keeps once it is open.
      scrollback: 10000,
    });
    const fit = new FitAddon();
    em.loadAddon(fit);
    em.open(element);
    terminal = em;
    // Has to come after `open`, which is where the renderer and its canvas are
    // built; there is nothing to point at before that.
    if (em.renderer) installBoxDrawing(em.renderer);
    if (entry.wantsFocus) em.focus();

    /**
     * Measure the box and say so — and do nothing else, which is the change.
     *
     * The emulator used to fit itself here and tell the pty what it had become.
     * That made the size whichever pane resized last, so a second client of
     * another width made the first one ragged, and it let this emulator and the
     * pty believe different things about where a row ends, which is the
     * disagreement underneath every screen kururu has drawn wrong. So the box
     * is measured, the measurement is *proposed*, and the emulator changes
     * shape only when the server answers with one — in `sink.size`, and in
     * `sink.reset`, which is the same answer arriving on the message that
     * depends on it.
     *
     * Nothing is proposed, and nothing subscribed, until the measurement is the
     * pane's. `proposeDimensions` rather than catching a throw from `fit`: fit
     * does not throw when the renderer has no cell size yet, it quietly does
     * nothing, so a try/catch cannot tell "fitted" from "silently skipped". And
     * its answer goes through `usableGrid` rather than merely being checked for
     * being a number, because this addon does not decline to measure an
     * unlaid-out box — it clamps, and answers `2x1`, which is finite, positive
     * and catastrophic: the smallest proposal is the one the server takes, so a
     * bad small one is the worst input this could possibly send.
     *
     * A detached element is the same question with a different cause and the
     * same right answer: it reports no width, so the measurement is refused,
     * the emulator keeps the shape it was last told, and a terminal nobody can
     * see says nothing about how big it would like to be.
     *
     * Three cases, and only the last of them is a box moving. A first
     * measurement subscribes; one that a reconnect left behind asks for the
     * screen it missed; both of those are a pane *arriving*, so their proposal
     * goes immediately — `askBacklog` sends it, because the history about to
     * come back is laid out in whatever shape the server settles on. Everything
     * after that is a divider being dragged or a window being resized, and that
     * waits for the box to stop moving: every resize is a SIGWINCH and every
     * agent TUI repaints completely on one.
     */
    const measure = () => {
      if (disposed) return;
      const grid = usableGrid(fit.proposeDimensions());
      if (!grid) return;
      if (!subscribed) {
        subscribed = true;
        unsubscribe = subscribeOutput(agentId, sink, grid);
        return;
      }
      if (entry.stale) {
        entry.stale = false;
        rebuild(agentId, grid);
        return;
      }
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => proposeSize(agentId, grid.cols, grid.rows), RESIZE_SETTLE_MS);
    };

    const sink = {
      /**
       * Guarded, and not out of caution. Where xterm quietly ignored a write to
       * a terminal that had gone, every one of these throws `Terminal has been
       * disposed` — and a sink that throws is a sink that throws inside the
       * socket's message loop, which is the one place in the client a single
       * dead pane could take everything else with it. `session.ts` catches that
       * too; this is the half that stops it being raised in the first place.
       *
       * Nothing is the other thing that throws, and it took a black pane to
       * find. `write("")` in ghostty-web 0.4.0 asks WASM for a zero-length
       * array, gets back the dangling pointer Zig hands out for one, and
       * `Uint8Array.set` rejects that offset before it ever notices there are no
       * bytes to copy. Empty is not a corner case in here either: the backlog of
       * a terminal that has not printed anything yet is exactly zero bytes, so
       * every new tab raised one.
       */
      write: (data: string) => {
        if (!disposed && data) em.write(data);
      },
      /**
       * The shape the server says this terminal is. The one place a pooled
       * emulator changes size, other than the backlog that carries the same
       * answer on the message whose correctness depends on it.
       *
       * It applies while detached, and has to. A warm emulator goes on being
       * fed bytes an agent laid out for the pty's grid, so one left at the old
       * shape would wrap every line of them — and it would then hand that
       * damage to the next pane that borrows it, having asked for nothing,
       * because there is nothing about a tab switch that says a rebuild is
       * needed.
       */
      size: (cols: number, rows: number) => {
        if (disposed) return;
        if (cols < 2 || rows < 2) return;
        if (cols === em.cols && rows === em.rows) return;
        em.resize(cols, rows);
      },
      /**
       * The socket came back. What that costs depends on whether anybody can
       * see this, and the element is what knows: `measure` refuses a detached
       * box, so a pooled emulator off screen simply stays marked and is picked
       * up the moment a pane borrows it, while one in a pane proposes its size
       * and asks for the screen it missed on this very call.
       */
      stale: () => {
        entry.stale = true;
        measure();
      },
      /**
       * A backlog replaces the whole screen, and nothing has to be done to make
       * that stick — which is worth saying, because under the old emulator it
       * did. xterm repainted only the rows it believed had changed, so after a
       * reset its idea of what changed did not cover cells the renderer was
       * still holding, and the picture stayed wrong exactly where the agent
       * never writes again. This renderer draws the viewport from the WASM
       * buffer on a loop of its own. It does track dirty rows — the loop passes
       * `forceAll = false` — but replacing a whole screen dirties a whole
       * screen, so the repaint follows from the write rather than having to be
       * asked for. If a backlog ever does land looking half-painted, that is the
       * assumption that was wrong, and `restyle` next door is the worked example
       * of the case where it does not hold.
       */
      reset: (data: string, cols: number, rows: number) => {
        if (disposed) return;
        /**
         * The grid before the bytes. A backlog is a screen serialized at a
         * width, and this is the width it was serialized at. Written into any
         * other shape, every row longer than the target wraps, everything below
         * it slides down, and the top scrolls away.
         *
         * It is almost always the shape this already is — the server settled on
         * it before serializing, and said so. Almost, because a resize can be
         * decided while a screen is being built, and then the answer names the
         * grid the *host* used and a `grid` follows it. Which is why this
         * applies the size it was given rather than trusting that it matches:
         * the screen and the shape it is laid out in travel together, and that
         * is the only way the two can never be out of step.
         */
        if (cols >= 2 && rows >= 2 && (cols !== em.cols || rows !== em.rows)) {
          em.resize(cols, rows);
        }
        em.reset();
        // Nothing to write is nothing to do, and would throw — see `write`.
        if (data) em.write(data);
        /**
         * And nothing afterwards. This used to fit back to the box, because the
         * emulator owned its own size and a backlog had just overwritten it
         * with the server's idea of one. There is one idea now; the box's shape
         * was proposed in the same breath as the request that produced this,
         * and if it has moved since, the ResizeObserver has already said so.
         */
      },
    };

    /**
     * Colours go straight to the renderer rather than through `em.options.theme`.
     *
     * Setting that option is the documented route and it warns that "theme
     * changes after open() are not yet fully supported", which is true of the
     * half it cannot reach: the palette is also handed to the WASM terminal when
     * it is built, and nothing updates it there. That half only answers colour
     * *queries* — a program asking what the background is — and it is right
     * again the moment this emulator is rebuilt, whereas the renderer's copy is
     * what every cell on screen is actually drawn from. So the renderer is set
     * directly, the warning is not earned, and the one thing left stale is a
     * question almost nothing asks.
     *
     * The repaint afterwards is not optional, and finding that out is what this
     * comment is for. The render loop is self-rescheduling, so it was tempting
     * to assume the next frame would simply be the new palette — but it renders
     * with `forceAll = false` and the renderer redraws only the rows the buffer
     * reports dirty. An agent redraws differentially and a settled one reports
     * nothing dirty at all, so a theme change would repaint the line under the
     * cursor and leave the rest of the screen in the colours it had, for as long
     * as the agent had nothing to say. `forceAll` is reachable only by calling
     * the renderer directly, which is why this reaches past `em` for the one
     * call in kururu that does.
     *
     * The font is the opposite case and goes through `options` on purpose:
     * assigning `fontSize` or `fontFamily` is what makes the emulator remeasure
     * its cell and resize its canvas, and doing that by hand would be
     * reimplementing `handleFontChange` from the outside.
     */
    entry.applyCursor = () => {
      if (disposed) return;
      const want = entry.showsCursor ? type.cursorStyle : CURSOR_HIDDEN;
      if (em.options.cursorStyle === want) return;
      em.options.cursorStyle = want;
      /**
       * And repaint, because the loop will not do it on its own. It renders
       * dirty rows only, and the row the cursor is on is redrawn just when the
       * cursor *moved* or is blinking — so with `cursorBlink` switched off, a
       * pane that lost the keyboard would keep the cursor it had until the
       * agent next wrote to that line, which for an idle agent is never.
       */
      if (em.renderer && em.wasmTerm) em.renderer.render(em.wasmTerm, true, em.viewportY, em);
    };

    entry.restyle = (remeasure: boolean) => {
      if (disposed) return;
      em.renderer?.setTheme(palette);
      if (em.renderer && em.wasmTerm) {
        em.renderer.render(em.wasmTerm, true, em.viewportY, em);
      }
      entry.applyCursor();
      em.options.cursorBlink = type.cursorBlink;
      em.options.fontSize = type.fontSize;
      em.options.fontFamily = fontStack();
      // A cell that changed size is a different grid in the same box, and the
      // server is the only thing allowed to act on that — so this proposes, the
      // way a dragged divider does, and waits out the settle for the same
      // reason: a slider is dragged, and every step of it would otherwise be a
      // SIGWINCH into every agent watching.
      if (remeasure) measure();
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
/**
 * Which pane this terminal is in, and whether keys may reach a pty at all.
 *
 * Two arguments because the emulator wants two different answers out of them.
 * The DOM focus follows both — a dialog is up, so nothing typed should arrive
 * in a terminal — while the cursor follows only the first, because a dialog
 * does not move where the keyboard will go back to.
 */
export function setFocused(agentId: string, focused: boolean, keyboard: boolean): void {
  const entry = pool.get(agentId);
  if (!entry) return;
  entry.wantsFocus = focused && keyboard;
  entry.showsCursor = focused;
  // Both directions, unlike the focus call below it: losing the keyboard is
  // exactly when a pane has to stop drawing a cursor, and it is the half that
  // nothing else would do.
  entry.applyCursor();
  if (entry.wantsFocus) entry.focus();
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
    /**
     * Except one a pane is holding, which is never gone whatever the list says
     * — and the asymmetry is not caution, it is that the two mistakes cost
     * different things. Keeping an emulator a moment too long costs a canvas
     * until the next snapshot. Disposing one a pane has *borrowed* empties that
     * pane for good: borrowing happens in an effect keyed on the agent id, and
     * the id has not changed, so nothing will ever ask for a second one. That
     * was the black pane on a new tab — the server pushed the layout with the
     * new terminal in it one microtask before the agent list caught up (see
     * `HostLink.create`), and this disposed the emulator the pane had just
     * built.
     *
     * It costs nothing to skip: a terminal that really has ended loses its tab
     * in the same snapshot, the pane releases the element while React is still
     * committing, and this effect runs afterwards to find it detached.
     */
    if (entry.attached) continue;
    pool.delete(agentId);
    entry.dispose();
    changed = true;
  }
  if (changed) announce();
}

/**
 * Put every emulator — the ones on screen and the ones being kept warm — into
 * this theme and this type.
 *
 * Called from the snapshot rather than from Settings, which is what makes a
 * theme picked on the phone land on the desktop: the verb goes to the server,
 * the server writes it down and pushes a snapshot, and every client restyles
 * because its snapshot changed. Nothing here knows a dialog exists.
 *
 * It restyles rather than rebuilding, and that is the whole reason this is three
 * lines instead of a page. A rebuild would be correct and ruinous — every
 * visible terminal would ask for a backlog, every warm one would lose its
 * scrollback and its scroll position, and the pool exists precisely so that the
 * things which look like they ought to rebuild an emulator do not.
 *
 * A re-measure is asked for only when the *font* moved. Colours do not change
 * the cell, so a theme swap must not propose anything: a proposal is a pty
 * resize and a SIGWINCH into every agent, and paying that to go from Mocha to
 * Macchiato would make choosing a colour scheme repaint everybody's work.
 */
export function applyTerminalAppearance(tokens: TerminalTokens, next: TerminalAppearance): void {
  const remeasure = next.fontFamily !== type.fontFamily || next.fontSize !== type.fontSize;
  palette = tokens;
  type = next;
  for (const entry of pool.values()) entry.restyle(remeasure);
}
