/**
 * A pane that draws a document instead of a grid.
 *
 * This is the thing kururu was built for. A terminal cannot show you a rendered
 * file, so the answer was a frontend that can — and the shape it takes is a pane
 * like any other, because tiling is what makes "the file beside the editor" a
 * layout rather than a mode.
 *
 * It holds no markdown and parses nothing. The server renders (`markdown.ts`),
 * for the reason the plan gives: the phone should be sent markup rather than a
 * parser, a highlighter and every grammar either might turn out to need. So this
 * component is a fetch, a scroll container, and the decisions about *when* the
 * answer it has is stale.
 *
 * `dangerouslySetInnerHTML` is load-bearing and is not a shortcut around a
 * sanitizer. The markup comes from kururu's own renderer with markdown-it's raw
 * HTML passthrough switched off, so the only tags that can be in it are ones the
 * renderer emits — a `<script>` in a README arrives as the text `<script>`. The
 * check is on the writing side, where the rule can be one setting, rather than
 * here, where it would be a list of tags to keep in step with.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { readUrl } from "../disk";
import { fileRefOf } from "../filequote";
import { drawDiagrams } from "../mermaid";
import {
  anchorAt,
  fragmentOf,
  headingSlugs,
  keepPlace,
  lineTop,
  markupSig,
  onJump,
  placeKey,
  placeOf,
  resolvePlace,
  savedPlace,
  takeJump,
  topOf,
  type Anchor,
  type Place,
  type Span,
} from "../readerplace";
import { nodeNameOf, useProjectRoots } from "../session";
import { DocPicker } from "./DocPicker";
import { quotableFile } from "./Quote";

/**
 * The line each pane's reader is showing, asked for by its tab's "Open in
 * Neovim". A table here rather than the DOM queried from the strip, because
 * the reader is the one that knows which document is under it and the strip
 * should not learn its markup; one entry per pane, the one drawn now.
 */
const showing = new Map<string, { root: string; path: string; line: () => number | null }>();

/**
 * The line of `path` at the top of the reader in `paneId`, or null for the
 * top of the file — a reader not scrolled, a reader showing another document,
 * or none at all. Read off the `data-line` each block carries (`markdown.ts`):
 * the last block whose top is at or above the reader's, which is the one the
 * eye is in.
 */
export function readingLine(paneId: string, root: string, path: string): number | null {
  const entry = showing.get(paneId);
  return entry && entry.root === root && entry.path === path ? entry.line() : null;
}

function lineAtTop(scroller: HTMLElement): number | null {
  if (scroller.scrollTop < 1) return null;
  const top = scroller.getBoundingClientRect().top + 4;
  let line: number | null = null;
  for (const block of scroller.querySelectorAll<HTMLElement>("[data-line]")) {
    if (block.getBoundingClientRect().top > top) break;
    const n = Number(block.dataset.line);
    if (Number.isInteger(n) && n > 0) line = n;
  }
  return line;
}

interface Rendered {
  path: string;
  title: string;
  html: string;
}

/** A render, with the root it was asked for under — the key its place is kept by. */
interface Drawn extends Rendered {
  root: string;
}

/**
 * The blocks of the drawn document, measured: each one's line, its top within
 * the scrolled content rather than the window, and a heading's text. Measured
 * once per layout and reused by every scroll until something changes size.
 */
function measure(scroller: HTMLElement): Span[] {
  const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const spans: Span[] = [];
  for (const block of scroller.querySelectorAll<HTMLElement>("[data-line]")) {
    const line = Number(block.dataset.line);
    if (!Number.isInteger(line) || line < 1) continue;
    const heading = /^H[1-6]$/.test(block.tagName) ? (block.textContent ?? "").replace(/\s+/g, " ").trim() : null;
    spans.push({ line, top: block.getBoundingClientRect().top - origin, heading });
  }
  return spans;
}

/**
 * The last good render stays on screen while the next one is in flight.
 *
 * Which matters precisely because of what re-renders: a save. Blanking the pane
 * and filling it back in on every `:w` is a flash on the one action this feature
 * exists to respond to, and the document is almost always nearly identical to
 * the one already there.
 */
export function ReaderView({
  paneId,
  root,
  path,
  rev,
  node = null,
}: {
  paneId: string;
  /**
   * The document's root — or, with no `path`, the project the picker opens
   * on. Another node's root arrives qualified and is read from that node
   * (`disk.ts`); the markup is that node's render of its own file.
   */
  root: string;
  /** Empty for a reader with nothing to show yet, which draws the picker. */
  path: string;
  rev: number;
  /** The node whose pane this is, for a picker that has no root yet to say so; null for this node's. */
  node?: string | null;
}) {
  const [doc, setDoc] = useState<Drawn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  /**
   * What a passage selected here is quoted to Kuru as (`Quote.tsx`): the file,
   * named the way its tab's "Reference in Kuru" names it. The whole document
   * is one quotable part, since a file has no title apart from its text.
   */
  const roots = useProjectRoots();
  const marks = useMemo(() => (path ? quotableFile(fileRefOf(root, path, roots, nodeNameOf)) : null), [root, path, roots]);

  useEffect(() => {
    if (!path) {
      setDoc(null);
      setError(null);
      return;
    }
    const abort = new AbortController();
    void fetch(readUrl("markdown", { root, path }), { signal: abort.signal })
      .then((response) => response.json())
      .then((body: Rendered & { error?: string }) => {
        if (abort.signal.aborted) return;
        if (body.error) {
          setError(body.error);
          return;
        }
        setError(null);
        setDoc({ ...body, root });
      })
      .catch(() => {
        // An aborted fetch is the normal way this ends — the file changed again
        // before the last answer arrived — and is not worth showing anybody.
        if (!abort.signal.aborted) setError("could not read that file");
      });
    return () => abort.abort();
    // `rev` is in here and unused in the body on purpose: it is the server
    // saying the file was written, and re-running this is the entire response.
  }, [root, path, rev]);

  /**
   * Mermaid fences arrive as source and are drawn here, which is the one thing
   * in this pane the server did not render — `web/src/mermaid.ts` says why. It
   * runs after the commit that put the markup in, because the layout engine
   * measures the text it is about to draw and can only do that once the nodes
   * are in a document with the page's font on it.
   *
   * Keyed on `doc` rather than on `path`, so a save redraws: the fetch hands
   * back a new object every time and the markup under this node has just been
   * replaced along with it. The abort is the same guarantee the fetch has — a
   * document swapped out while its diagrams were still being laid out must not
   * have the old ones land in the new one.
   */
  useEffect(() => {
    const node = article.current;
    if (!node || !doc) return;
    const abort = new AbortController();
    void drawDiagrams(node, abort.signal);
    return () => abort.abort();
  }, [doc]);

  /**
   * Where the reader is in the document it is drawing, and keeping it there.
   *
   * The place is `readerplace.ts`'s — a block and how far into it — and this
   * is the half that measures and scrolls. Three things move it. The user
   * scrolling, which is taken as the new place and kept for the document. A
   * document drawn — another one, the same one back from a tab switch, the
   * same one written again — which goes to a line a link asked for, else the
   * place kept for it, else the top. And the content changing size under it —
   * the zoom, a pane made narrower, an image or a diagram arriving — which puts
   * the same place back at its new height, so none of those is a scroll.
   *
   * A scroll this did itself comes back as a scroll event, and is told apart by
   * landing exactly where it was put: taking it as the user's would turn a place
   * the browser had to clamp, in a document whose images are still loading, into
   * the bottom of what had loaded so far.
   */
  const sig = useMemo(() => (doc ? markupSig(doc.html) : ""), [doc]);
  const drawnKey = doc ? placeKey(doc.root, doc.path) : null;
  const here = useRef<{ key: string | null; place: Place | null; anchor: Anchor | null; spans: Span[] | null; put: number | null }>({
    key: null,
    place: null,
    anchor: null,
    spans: null,
    put: null,
  });

  useLayoutEffect(() => {
    const el = scroller.current;
    const body = article.current;
    const state = here.current;
    // The same document drawn again — written on disk while it was showing —
    // goes back to this pane's own place, which another pane showing the file
    // may have saved over since.
    const again = state.key !== null && state.key === drawnKey;
    state.key = drawnKey;
    state.spans = null;
    if (!el || !body || !drawnKey) return;

    const spans = () => (state.spans ??= measure(el));
    const end = () => el.scrollHeight;
    const scrollable = () => Math.max(0, el.scrollHeight - el.clientHeight);
    const put = (top: number) => {
      el.scrollTop = top;
      state.put = el.scrollTop;
    };
    // `top` is where the place is meant to be, which a jump into a document
    // still growing can be further down than the browser could scroll yet.
    const remember = (top = el.scrollTop) => {
      state.place = placeOf(spans(), top, end(), scrollable(), sig, Date.now());
      keepPlace(drawnKey, state.place);
    };
    const goToLine = (line: number) => {
      const top = lineTop(spans(), line);
      put(top);
      state.anchor = anchorAt(spans(), top, end());
      remember(top);
    };

    const asked = takeJump(drawnKey);
    if (asked !== null) {
      goToLine(asked);
    } else {
      const kept = again ? state.place : savedPlace(drawnKey);
      state.place = kept;
      state.anchor = kept ? resolvePlace(kept, spans(), sig, end(), scrollable()) : null;
      put(topOf(spans(), state.anchor, end()));
    }

    let frame = 0;
    const onScroll = () => {
      if (state.put !== null && Math.abs(el.scrollTop - state.put) < 1) {
        state.put = null;
        return;
      }
      state.put = null;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        state.anchor = anchorAt(spans(), el.scrollTop, end());
        remember();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    const resized = new ResizeObserver(() => {
      state.spans = null;
      put(topOf(spans(), state.anchor, end()));
    });
    resized.observe(body);

    // A link to a heading in this document. The renderer gives headings no
    // ids, so the browser's own fragment navigation finds nothing — and would
    // write the fragment into the page's own URL, which is the app's.
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.("a");
      const fragment = link && body.contains(link) ? fragmentOf(link.getAttribute("href")) : null;
      if (fragment === null) return;
      event.preventDefault();
      const headings = [...body.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")];
      const slugs = headingSlugs(headings.map((h) => (h.textContent ?? "").replace(/\s+/g, " ")));
      const want = fragment.toLowerCase();
      const at = slugs.findIndex((slug) => slug === fragment || slug === want);
      const target = at >= 0 ? headings[at]! : body.querySelector<HTMLElement>(`[id="${CSS.escape(fragment)}"]`);
      if (!target) return;
      const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      put(top);
      state.anchor = anchorAt(spans(), top, end());
      remember(top);
    };
    body.addEventListener("click", onClick);

    // The same document asked to open at a line while it is already drawn here.
    const stopJump = onJump(() => {
      const line = takeJump(drawnKey);
      if (line !== null) goToLine(line);
    });

    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
      body.removeEventListener("click", onClick);
      resized.disconnect();
      stopJump();
    };
  }, [doc, drawnKey, sig]);

  useEffect(() => {
    if (!path) return;
    const entry = { root, path, line: () => (scroller.current ? lineAtTop(scroller.current) : null) };
    showing.set(paneId, entry);
    return () => {
      if (showing.get(paneId) === entry) showing.delete(paneId);
    };
  }, [paneId, root, path]);

  /**
   * A reader with nothing in it *is* the picker, rather than a message about
   * where documents come from. It used to say "open a .md in the editor next
   * door", which is true on a desktop and is advice you cannot take on a phone —
   * the one place this pane is most of the point. Same argument the empty pane
   * makes: where there is exactly one thing to do, the space is the button.
   *
   * Only for a reader with nothing in it — one opened to follow an editor that
   * has not opened a markdown file yet. Once there is a document the tree is
   * the way to another one, and it opens as a tab beside this.
   */
  if (!path) {
    return <DocPicker paneId={paneId} root={root} node={node} onClose={null} />;
  }

  return (
    <div className="reader" ref={scroller}>
      {error && !doc ? (
        <p className="reader-error">{error}</p>
      ) : (
        // Keyed by path so React replaces the subtree when the document does,
        // rather than trying to reconcile one file's headings into another's.
        <article
          key={doc?.path ?? path}
          ref={article}
          className="md"
          dangerouslySetInnerHTML={{ __html: doc?.html ?? "" }}
          {...marks}
        />
      )}
    </div>
  );
}
