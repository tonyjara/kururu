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
import { useEffect, useRef, useState } from "react";
import type { ReaderState } from "../../../shared/layout";
import { drawDiagrams } from "../mermaid";
import { DocPicker } from "./DocPicker";

interface Rendered {
  path: string;
  title: string;
  html: string;
}

/**
 * The last good render stays on screen while the next one is in flight.
 *
 * Which matters precisely because of what re-renders: a save. Blanking the pane
 * and filling it back in on every `:w` is a flash on the one action this feature
 * exists to respond to, and the document is almost always nearly identical to
 * the one already there.
 */
export function ReaderView({ paneId, reader }: { paneId: string; reader: ReaderState }) {
  const [doc, setDoc] = useState<Rendered | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);

  const { root, path, rev } = reader;

  useEffect(() => {
    if (!path) {
      setDoc(null);
      setError(null);
      return;
    }
    const abort = new AbortController();
    const query = new URLSearchParams({ root, path });
    void fetch(`/api/markdown?${query}`, { signal: abort.signal })
      .then((response) => response.json())
      .then((body: Rendered & { error?: string }) => {
        if (abort.signal.aborted) return;
        if (body.error) {
          setError(body.error);
          return;
        }
        setError(null);
        setDoc(body);
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
   * are in a document with the theme's font on it.
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
   * A different file starts at the top; the same file written again does not.
   * Scroll position is the reader's own state, and losing it on every save would
   * make the pane unusable for exactly the document you are working on.
   */
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [root, path]);

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
    return <DocPicker paneId={paneId} root={root} onClose={null} />;
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
        />
      )}
    </div>
  );
}
