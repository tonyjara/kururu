/**
 * The one thing the reader draws for itself.
 *
 * `server/src/markdown.ts` renders everything else, and the argument for that is
 * still right: a phone should be sent markup rather than a parser, a highlighter
 * and every grammar either might turn out to need. A mermaid fence is the
 * exception, and not because nobody got round to it. Mermaid lays a graph out by
 * **measuring text in a DOM** — how wide a node is comes from how wide its label
 * actually renders in the font it ends up in. Under jsdom that measurement is a
 * guess, so the SVG comes back with boxes the wrong size for the words inside
 * them, and a diagram that is subtly wrong is worse than the code block it
 * replaced: the block is honest about being source, and the bad diagram is not.
 *
 * So the server marks the fence and this draws it. Which makes the bundle bigger
 * — mermaid is half a megabyte — and the import is therefore dynamic and reached
 * only by a document that actually contains a diagram. A reader full of prose
 * pays nothing, and the first diagram of a session pays once.
 *
 * **The palette is read out of the page, never written down here.** Kururu has
 * one palette and `web/src/theme.ts` has already put it on `<html>` as custom
 * properties by the time anything is drawn, so `getComputedStyle` is the same
 * source the stylesheet is reading and there is no second copy to fall out of
 * step — the thing `web/test/theme.test.ts` exists to prevent. A diagram is
 * therefore themed at the moment it is drawn and re-themed the next time the
 * document renders, which is exactly what a Shiki block already does.
 */
import type { MermaidConfig } from "mermaid";

/**
 * Loaded once per page and shared, on `markdown.ts`'s reasoning about the
 * highlighter: the promise is the value rather than the module, so two panes
 * opening a diagram in the same frame await one download instead of two.
 */
let loading: Promise<typeof import("mermaid").default> | null = null;

function mermaid(): Promise<typeof import("mermaid").default> {
  return (loading ??= import("mermaid").then((m) => m.default));
}

/** A custom property as the cascade currently answers it, or a stated fallback. */
function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

/**
 * Kururu's tokens in the names mermaid's `base` theme knows them by.
 *
 * `base` is the only built-in theme that takes variables at all — the others
 * are fixed palettes, and picking one would put a rectangle of somebody else's
 * colour scheme inside a pane that already has one, which is the bug the CSS
 * token sweep existed to remove.
 */
function themeVariables(): MermaidConfig["themeVariables"] {
  const style = getComputedStyle(document.documentElement);
  const bg = token(style, "--bg", "#1e1e2e");
  const chrome = token(style, "--chrome", "#181825");
  const chromeHigh = token(style, "--chrome-high", "#313244");
  const line = token(style, "--line", "#45475a");
  const text = token(style, "--text", "#cdd6f4");
  const dim = token(style, "--dim", "#a6adc8");

  return {
    background: bg,
    // A node: chrome's fill, the accent's edge, the document's own text. Nodes
    // are the thing you read, so they sit a step off the page the way a code
    // block does rather than being a second background colour.
    primaryColor: chromeHigh,
    primaryTextColor: text,
    primaryBorderColor: token(style, "--line-high", "#585b70"),
    secondaryColor: chrome,
    secondaryTextColor: text,
    secondaryBorderColor: line,
    tertiaryColor: bg,
    tertiaryTextColor: dim,
    tertiaryBorderColor: line,
    // Edges and their labels. `--dim` rather than `--text`: an arrow is
    // structure and should not compete with the words it connects.
    lineColor: dim,
    textColor: text,
    mainBkg: chromeHigh,
    nodeBorder: token(style, "--line-high", "#585b70"),
    clusterBkg: chrome,
    clusterBorder: line,
    titleColor: text,
    edgeLabelBackground: bg,
    noteBkgColor: chrome,
    noteTextColor: text,
    noteBorderColor: line,
    fontFamily: token(style, "--ui", "system-ui, sans-serif"),
    fontSize: "13px",
  };
}

function config(): MermaidConfig {
  return {
    startOnLoad: false,
    /**
     * Strict is mermaid's default and it is load-bearing here rather than
     * incidental. The reader's contract is that the markup it injects can only
     * be its own renderer's constructs (`html: false` on the server side), and
     * an SVG built here is the one thing arriving that the server did not write.
     * Strict runs the output through DOMPurify and refuses the `click`
     * directives that would otherwise let a diagram carry a URL — which is the
     * right answer twice over, since a markdown file in a project is
     * increasingly something an *agent* wrote and kururu answers to the tailnet.
     */
    securityLevel: "strict",
    theme: "base",
    themeVariables: themeVariables(),
    /**
     * `dataset.theme` is set by `applyTheme`, but what mermaid wants is which
     * way round the theme is rather than which one it is, and `colorScheme` is
     * the token that already says so for every theme including ones added later.
     */
    darkMode: document.documentElement.style.colorScheme !== "light",
    /**
     * A ceiling, because a document is a file on disk and a file on disk can be
     * a generated graph with ten thousand edges in it. Mermaid's layout is
     * synchronous, so one of those is a frozen window rather than a slow one —
     * and the whole pane is the application. Past the cap it declines, which
     * lands in the same place a syntax error does: the source, visible, with a
     * line saying why.
     */
    maxTextSize: 100_000,
    maxEdges: 800,
  };
}

/**
 * Every diagram in a rendered document, drawn in place.
 *
 * Takes the article rather than searching the page, because two reader panes can
 * be open on two documents and each answers for its own. The `signal` is the
 * same one the fetch uses: a document replaced while its diagrams were still
 * being laid out must not have the old ones land in the new one's markup.
 */
export async function drawDiagrams(root: HTMLElement, signal: AbortSignal): Promise<void> {
  const blocks = root.querySelectorAll<HTMLElement>("pre.mermaid");
  if (blocks.length === 0) return;

  let mm: typeof import("mermaid").default;
  try {
    mm = await mermaid();
  } catch {
    // The chunk did not load — offline, or a stale service worker. The source is
    // already on screen and saying so in every diagram would be noise.
    return;
  }
  if (signal.aborted) return;
  mm.initialize(config());

  for (const [index, block] of [...blocks].entries()) {
    if (signal.aborted) return;
    // `textContent` rather than `innerHTML`: the server escaped the fence on the
    // way out, and this is what un-escapes it back to what was typed.
    const source = block.textContent ?? "";
    // Ids have to be unique across the page, not just this document, because
    // mermaid builds each diagram in a detached element keyed by one and two
    // panes rendering at once would otherwise collide.
    const id = `mmd-${Date.now().toString(36)}-${index}`;
    try {
      // Parsing first, with errors suppressed, is what keeps a bad diagram from
      // becoming mermaid's own error graphic — which it appends to the document
      // itself, outside this pane, where nothing here can clean it up.
      if (!(await mm.parse(source, { suppressErrors: true }))) {
        fail(block, "not valid mermaid");
        continue;
      }
      const { svg } = await mm.render(id, source);
      if (signal.aborted) return;
      const figure = document.createElement("figure");
      figure.className = "mermaid-figure";
      figure.innerHTML = svg;
      block.replaceWith(figure);
    } catch (error) {
      if (signal.aborted) return;
      fail(block, error instanceof Error ? error.message : "could not draw that diagram");
    }
  }
}

/**
 * A diagram that could not be drawn stays a code block, and says why.
 *
 * Leaving the source is the whole point: it is what the reader showed before
 * this module existed, and a pane that went blank where a diagram should be
 * would read as the feature being broken rather than the diagram being wrong.
 * `textContent` for the message, because it came from a parser and is the one
 * string in here that is neither kururu's markup nor mermaid's sanitized output.
 */
function fail(block: HTMLElement, message: string): void {
  if (block.querySelector(".mermaid-error")) return;
  block.classList.add("mermaid-failed");
  const note = document.createElement("div");
  note.className = "mermaid-error";
  note.textContent = message;
  block.append(note);
}
