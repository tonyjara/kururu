/**
 * One pane, one terminal, one emulator.
 *
 * This is the thing the old UI was pretending to be. A `<pre>` of the current
 * screen could show you what an agent had drawn, but it could not be typed into,
 * scrolled back through, selected out of, or coloured — and an agent TUI is all
 * four of those. A real emulator is what stops the pane being a picture of a
 * terminal and makes it one.
 *
 * The emulator is Ghostty's, compiled to WASM and rendering to a 2D canvas. It
 * replaced xterm.js, and the reason was not speed — it was that xterm's renderer
 * wanted a WebGL context per pane and a page gets about sixteen. Kururu builds a
 * fresh emulator on every tab switch, workspace change, profile swap and pane
 * rebuild, so the dead ones piled up holding contexts they would never draw with
 * again; past sixteen Chromium does not refuse the new one, it kills the
 * *oldest*, which is never a corpse but the pane you have had open longest. Every
 * visible terminal would go black at once, for three seconds, several times an
 * afternoon, with nothing wrong anywhere — which is exactly why it read as
 * inexplicable. There is no context budget behind a 2D canvas, so that entire
 * class of bug is not managed here any more, it is absent. What was
 * `releaseWebglContexts` is gone with it, and nothing replaced it.
 *
 * The emulator is created once and lives in a ref, deliberately outside React's
 * knowledge. Output arrives sixty times a second; React must never see it. What
 * React owns here is which agent this pane points at and whether it has focus,
 * both of which change when a human does something.
 *
 * Sizing runs the other way from everything else: the pane measures itself, and
 * the *pty* is told to match. That is why a terminal here is not clipped or
 * scaled — the program inside it genuinely redraws at the size of the box it is
 * in, which is what SIGWINCH is for.
 */
import { useEffect, useRef } from "react";
import { FitAddon, init, Terminal } from "ghostty-web";
import { isFileDrag, textForDrop } from "../drop";
import { usableGrid } from "../grid";
import { input, resize, subscribeOutput } from "../session";

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

/** How long a pane has to stop changing size before the pty is told about it. */
const RESIZE_SETTLE_MS = 60;

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

interface Props {
  agentId: string;
  /** Focused panes get the keyboard. Only one does. */
  focused: boolean;
}

export function TerminalView({ agentId, focused }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  /**
   * The focus effect below cannot reach an emulator that does not exist yet, and
   * the first one on a page waits for the WASM. A pane that mounts already
   * focused — which is every pane a split or a tab switch creates — would
   * otherwise come up without the keyboard, because the only thing that would
   * have given it focus ran before there was anything to give it to.
   */
  const wanted = useRef(focused);
  wanted.current = focused;

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    /**
     * Torn down before it was ready is the normal case, not the edge one:
     * StrictMode mounts, unmounts and mounts again on every pane in development,
     * and the very first pane of a session waits on the WASM besides. An
     * emulator built after that would be building into a host element React has
     * already taken back.
     */
    let disposed = false;
    let terminal: Terminal | null = null;
    let settle: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe = () => {};
    let typed: { dispose(): void } | null = null;
    let observer: ResizeObserver | null = null;

    void ready.then((ok) => {
      if (!ok || disposed) return;

      terminal = new Terminal({
        theme: THEME,
        /**
         * The Nerd Font faces are in this stack for their glyphs, not their
         * letterforms. An agent TUI — or an nvim opened inside one — draws
         * devicons and powerline separators out of the private use area, and SF
         * Mono contains none of them, so the browser has nothing to fall back to
         * and paints tofu. Ghostty's *native* app does not have this problem
         * because it compiles Symbols Nerd Font Mono into its own binary and
         * falls back to it silently; the WASM build has no font of its own and
         * takes what the page names, so the fallback has to be spelled out here
         * and has to name a face the system actually has.
         *
         * Two generations of patched font are named because no single one covers
         * both. Nerd Fonts v3 moved Material Design Icons from U+F500–FD46 to
         * U+F0001–F1AF0 and dropped the old range, so a dotfile written against
         * v2 — which is most of them, since they get carried forward rather than
         * rewritten — asks for codepoints a freshly patched font no longer has.
         * MesloLGS NF is the v2-era build powerlevel10k ships, and it goes last
         * precisely so it answers only what the v3 faces ahead of it cannot.
         *
         * They all stay *after* SF Mono deliberately: the cell is measured from
         * the first face in the stack, so appending rather than prepending
         * leaves the grid metrics exactly as they were. The "Mono" variants are
         * the ones whose glyphs are a single cell wide, which is the only kind
         * that can land in a grid without overhanging the next column.
         *
         * This fixes the machine that has the fonts installed, which is the
         * desktop. A phone over Tailscale has none of them and will keep showing
         * tofu until one is served as a webfont.
         */
        fontFamily:
          '"SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", ' +
          '"FiraCode Nerd Font Mono", "JetBrainsMono Nerd Font Mono", ' +
          '"Symbols Nerd Font Mono", "MesloLGS NF", monospace',
        fontSize: 12,
        cursorBlink: true,
        // History lives on the server too, but only what it has been asked for
        // is sent; this is what the pane itself keeps once it is open.
        scrollback: 10000,
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(element);
      term.current = terminal;
      if (wanted.current) terminal.focus();

      // Captured so the closures below do not have to re-narrow a variable the
      // cleanup is allowed to null out.
      const em = terminal;

      /**
       * Fit to the box, then tell the pty what shape it is now.
       *
       * Debounced, because the box changes continuously and the pty does not
       * want to hear about every frame of it: dragging a divider fires this on
       * every pointer move, and a pane sliding to a new position fires it for
       * the whole animation. Each one is a SIGWINCH, and a program that redraws
       * itself completely on every SIGWINCH — which is every agent TUI — would
       * spend the drag repainting. So the emulator follows the box immediately
       * and the pty hears the answer once the box has stopped moving.
       */
      let opened = false;
      /**
       * Nothing is subscribed until the grid is the pane's.
       *
       * An emulator built without `cols`/`rows` is 80x24, and it stays 80x24
       * until a fit lands — which cannot happen on the frame after a split, when
       * the box has no size yet, nor before the renderer has measured a
       * character. The backlog is a screen *serialized at the size the server
       * thinks it is*, so writing it into an 80-column grid wraps every line of
       * it at 80 and leaves it wrapped; the later resize unwraps the text but
       * not the damage, and what is left is a screen the agent believes it has
       * already drawn correctly and will never repaint. Asking a frame later
       * costs nothing and cannot land in the wrong shape.
       *
       * `proposeDimensions` rather than catching a throw from `fit`: fit does
       * not throw when the renderer has no cell size yet, it quietly does
       * nothing, so a try/catch cannot tell "fitted" from "silently skipped".
       *
       * And its answer is put through `usableGrid` rather than merely checked
       * for being a number, because this addon does not decline to measure an
       * unlaid-out box — it clamps, and answers `2x1`. That is finite, positive
       * and catastrophic: it fits the emulator to two columns, asks for a
       * backlog serialized at two columns, and tells the server to SIGWINCH the
       * pty, at which point the agent redraws itself into it. A pane is
       * momentarily exactly that shape every time one is dragged.
       */
      // Annotated because the backlog's callback calls it, and a function that
      // appears in its own initializer has no inferable type.
      const push: () => void = () => {
        if (disposed) return;
        if (!usableGrid(fit.proposeDimensions())) return;
        fit.fit();
        if (!opened) {
          opened = true;
          unsubscribe = subscribeOutput(agentId, {
            /**
             * Guarded, and not out of caution. Where xterm quietly ignored a
             * write to a terminal that had gone, every one of these throws
             * `Terminal has been disposed` — and a sink that throws is a sink
             * that throws inside the socket's message loop, which is the one
             * place in the client a single dead pane could take everything else
             * with it. `session.ts` now catches that too; this is the half that
             * stops it being raised in the first place.
             */
            write: (data) => {
              if (!disposed) em.write(data);
            },
            /**
             * The shape this emulator is drawing at, asked for rather than
             * remembered: the pane is resizable, and a reconnect asks again on
             * behalf of an emulator that has been sitting here for an hour.
             */
            grid: () => ({ cols: em.cols, rows: em.rows }),
            /**
             * A backlog replaces the whole screen, and nothing has to be done to
             * make that stick — which is worth saying, because under the old
             * emulator it did.
             *
             * xterm repainted only the rows it believed had changed, so after a
             * reset and a reconstruction its idea of what changed did not cover
             * cells the renderer was still holding: the buffer was right and the
             * picture was wrong, and it stayed wrong exactly where the agent
             * never wrote again, since an agent redraws differentially and never
             * resends a cell it believes is correct. That was the shell prompt
             * sitting inside Claude Code's input box until a window resize
             * forced a full repaint. It needed the texture atlas thrown away and
             * an explicit `refresh` of every row.
             *
             * This renderer draws the viewport from the WASM buffer on its own
             * loop rather than from a record of which cells it thinks are dirty,
             * so a screen that has been replaced wholesale is simply the screen
             * it draws next. If a backlog ever does land looking half-painted,
             * this paragraph is the assumption that was wrong.
             */
            reset: (data, cols, rows) => {
              if (disposed) return;
              /**
               * The grid before the bytes. A backlog is a screen serialized at a
               * width, and this is the width it was serialized at — normally the
               * one this emulator asked for, and something else only if the pane
               * moved while the answer was being prepared. Written into any
               * other shape, every row longer than the target wraps, everything
               * below it slides down, and the top scrolls away.
               */
              if (cols >= 2 && rows >= 2 && (cols !== em.cols || rows !== em.rows)) {
                em.resize(cols, rows);
              }
              em.reset();
              em.write(data, () => {
                /**
                 * And back to the box, in the case where that was not already
                 * the shape of it. Reflowing a correct screen is what an
                 * emulator does for every window resize; reflowing a wrapped one
                 * would be reflowing damage.
                 */
                push();
              });
            },
          });
        }
        if (settle) clearTimeout(settle);
        settle = setTimeout(() => resize(agentId, em.cols, em.rows), RESIZE_SETTLE_MS);
      };
      push();

      observer = new ResizeObserver(push);
      observer.observe(element);

      /**
       * One channel, unlike xterm's two: mouse reports and bracketed paste
       * arrive here already encoded rather than on a separate binary event. If
       * mouse reporting ever looks wrong, that difference is where to start.
       */
      typed = em.onData((data) => input(agentId, data));
    });

    return () => {
      disposed = true;
      if (settle) clearTimeout(settle);
      unsubscribe();
      typed?.dispose();
      observer?.disconnect();
      terminal?.dispose();
      term.current = null;
    };
  }, [agentId]);

  // Focus follows the pane, so ⌘] and a click land in the same place.
  useEffect(() => {
    if (focused) term.current?.focus();
  }, [focused]);

  /**
   * A file dropped from the Finder is typed in, escaped, exactly as every other
   * terminal has done it for thirty years — which is how you hand a screenshot
   * to an agent that only takes text.
   *
   * It goes to *this* terminal rather than the focused one, because the pane you
   * dropped on is the one you were pointing at, and a drop that landed somewhere
   * other than where it was aimed would be worse than no drop at all.
   *
   * `dragover` has to preventDefault or `drop` never fires, and it checks the
   * types rather than the payload because the payload is unreadable until the
   * drop — the same restriction `drag.ts` exists to work around. Kururu's own
   * tab and pane drags carry custom MIME types, not `Files`, so they fall
   * straight through this to the drop zones that handle them.
   */
  return (
    <div
      className="term"
      ref={host}
      onDragOver={(event) => {
        if (!isFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (!isFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        const text = textForDrop(event.dataTransfer);
        if (text) input(agentId, text);
      }}
    />
  );
}
