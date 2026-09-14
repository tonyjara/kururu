/**
 * One pane, one terminal, one emulator.
 *
 * This is the thing the old UI was pretending to be. A `<pre>` of the current
 * screen could show you what an agent had drawn, but it could not be typed into,
 * scrolled back through, selected out of, or coloured — and an agent TUI is all
 * four of those. xterm.js is a real emulator, so the pane stops being a picture
 * of a terminal and becomes one.
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
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { isFileDrag, textForDrop } from "../drop";
import { input, resize, subscribeOutput } from "../session";

/**
 * Colours, given to the emulator rather than the stylesheet — xterm paints into
 * a canvas, so CSS cannot reach any of this. Kept in step with styles.css by
 * hand, which is the trade for not rendering a thousand DOM nodes a frame.
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

interface Props {
  agentId: string;
  /** Focused panes get the keyboard. Only one does. */
  focused: boolean;
}

export function TerminalView({ agentId, focused }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    const terminal = new Terminal({
      theme: THEME,
      /**
       * The Nerd Font faces are in this stack for their glyphs, not their
       * letterforms. An agent TUI — or an nvim opened inside one — draws
       * devicons and powerline separators out of the private use area, and SF
       * Mono contains none of them, so the browser has nothing to fall back to
       * and paints tofu. Ghostty does not have this problem because it compiles
       * Symbols Nerd Font Mono into its own binary and falls back to it
       * silently; in a browser the fallback has to be named out loud, and the
       * name has to be one the system actually has. Ghostty's copy is not
       * installed anywhere, so naming it buys nothing on its own — it is kept
       * only for the machine that has installed it properly.
       *
       * Two generations of patched font are named because no single one covers
       * both. Nerd Fonts v3 moved Material Design Icons from U+F500–FD46 to
       * U+F0001–F1AF0 and dropped the old range, so a dotfile written against
       * v2 — which is most of them, since they get carried forward rather than
       * rewritten — asks for codepoints a freshly patched font no longer has.
       * MesloLGS NF is the v2-era build powerlevel10k ships, and it goes last
       * precisely so it answers only what the v3 faces ahead of it cannot.
       *
       * They all stay *after* SF Mono deliberately: xterm measures the cell
       * from the first face in the stack, so appending rather than prepending
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
      lineHeight: 1.2,
      cursorBlink: true,
      /**
       * Option-drag selects, even while the program is grabbing the mouse.
       *
       * Claude Code turns on every mouse mode there is — `?1000h ?1002h ?1003h
       * ?1006h`, which is click, drag, *all motion*, and SGR coordinates — so
       * from then on every press, release and movement is an escape sequence
       * sent to the agent rather than a gesture for the terminal, and dragging
       * across the screen selects nothing. That is correct behaviour and every
       * terminal does it; what every terminal also has is a modifier that says
       * "this one is mine", and xterm.js ships that switched off.
       *
       * Option rather than shift because it is the only one xterm.js offers on
       * macOS, and it is iTerm's default for the same job. Without it a terminal
       * running an agent is one you cannot copy an error message out of, which
       * is most of what reading an agent's output is for.
       */
      macOptionClickForcesSelection: true,
      // History lives on the server too, but only what it has been asked for is
      // sent; this is what the pane itself keeps once it is open.
      scrollback: 10000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);

    /**
     * WebGL because an agent mid-stream repaints the whole grid many times a
     * second and the DOM renderer spends it all in layout. It is allowed to
     * fail — a machine with no GL context, or too many live ones — and the
     * fallback renderer is correct, just slower, so this is not worth an error.
     */
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl?.dispose());
      terminal.loadAddon(webgl);
    } catch {
      // DOM renderer it is.
      webgl = null;
    }

    term.current = terminal;

    /**
     * Fit to the box, then tell the pty what shape it is now.
     *
     * Debounced, because the box changes continuously and the pty does not want
     * to hear about every frame of it: dragging a divider fires this on every
     * pointer move, and a pane sliding to a new position fires it for the whole
     * animation. Each one is a SIGWINCH, and a program that redraws itself
     * completely on every SIGWINCH — which is every agent TUI — would spend the
     * drag repainting. So the emulator follows the box immediately and the pty
     * hears the answer once the box has stopped moving.
     */
    let settle: ReturnType<typeof setTimeout> | null = null;
    /**
     * Nothing is asked for until the grid is the pane's.
     *
     * An xterm built without `cols`/`rows` is 80x24, and it stays 80x24 until a
     * fit lands — which cannot happen on the frame after a split, when the box
     * has no size yet, nor before the renderer has measured a character. The
     * backlog is a screen *serialized at the size the server thinks it is*, so
     * writing it into an 80-column grid wraps every line of it at 80 and leaves
     * it wrapped; the later resize unwraps the text but not the damage, and what
     * is left is a screen the agent believes it has already drawn correctly and
     * will never repaint. Asking a frame later costs nothing and cannot land in
     * the wrong shape.
     *
     * `proposeDimensions` rather than catching a throw from `fit`: fit does not
     * throw when the renderer has no cell size yet, it quietly does nothing, so
     * a try/catch cannot tell "fitted" from "silently skipped".
     */
    let opened = false;
    let unsubscribe = () => {};
    // Annotated because the backlog's callback calls it, and a function that
    // appears in its own initializer has no inferable type.
    const push: () => void = () => {
      const dims = fit.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
      fit.fit();
      if (!opened) {
        opened = true;
        unsubscribe = subscribeOutput(agentId, {
          write: (data) => terminal.write(data),
          /**
           * The shape this emulator is drawing at, asked for rather than
           * remembered: the pane is resizable, and a reconnect asks again on
           * behalf of an emulator that has been sitting here for an hour.
           */
          grid: () => ({ cols: terminal.cols, rows: terminal.rows }),
          /**
           * A backlog replaces the whole screen, so the whole screen has to be
           * painted again — which does not follow from writing it.
           *
           * xterm repaints the rows it knows changed, and after a `reset` plus a
           * reconstruction its idea of what changed does not cover cells the
           * renderer is still holding from before. The buffer is then right and
           * the picture is wrong, and it stays wrong exactly where the agent
           * never writes again: an agent redraws differentially, so a cell it
           * believes is already correct is one it will never send. That is how a
           * shell prompt from before the agent started ends up sitting inside
           * its input box, visible until something forces a full repaint —
           * resizing the window, which is what made it "go away".
           *
           * The atlas goes too. It caches rasterized glyphs against the cells
           * that asked for them, and a screen that has just been replaced
           * wholesale is the one moment that cache is describing a screen that
           * no longer exists.
           */
          reset: (data, cols, rows) => {
            /**
             * The grid before the bytes. A backlog is a screen serialized at a
             * width, and this is the width it was serialized at — normally the
             * one this emulator asked for, and something else only if the pane
             * moved while the answer was being prepared. Written into any other
             * shape, every row longer than the target wraps, everything below it
             * slides down, and the top scrolls away.
             */
            if (cols >= 2 && rows >= 2 && (cols !== terminal.cols || rows !== terminal.rows)) {
              terminal.resize(cols, rows);
            }
            terminal.reset();
            terminal.write(data, () => {
              webgl?.clearTextureAtlas();
              terminal.refresh(0, terminal.rows - 1);
              /**
               * And back to the box, in the case where that was not already the
               * shape of it. Reflowing a correct screen is what xterm does for
               * every window resize; reflowing a wrapped one would be reflowing
               * damage.
               */
              push();
            });
          },
        });
      }
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => resize(agentId, terminal.cols, terminal.rows), RESIZE_SETTLE_MS);
    };
    push();

    const observer = new ResizeObserver(push);
    observer.observe(element);

    const typed = terminal.onData((data) => input(agentId, data));
    // Mouse reporting and bracketed paste arrive here instead, already encoded.
    const binary = terminal.onBinary((data) => input(agentId, data));

    return () => {
      if (settle) clearTimeout(settle);
      unsubscribe();
      typed.dispose();
      binary.dispose();
      observer.disconnect();
      terminal.dispose();
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
