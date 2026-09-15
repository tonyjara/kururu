/**
 * How a reader is pointed at a file by hand.
 *
 * The reader was built for the desktop, where the question is already answered:
 * nvim says which buffer it is on and the pane follows. A phone has no editor to
 * follow — it has one pane on screen and a thumb — so without this the reader is
 * a pane that can only ever show what some other machine happens to be editing,
 * which is most of a feature and none of the use for it.
 *
 * It is a search rather than a file tree, and the server's `findDocs` makes the
 * argument: the only thing this pane can draw is markdown, so offering anything
 * else would be offering rows that do nothing, and a tree is four taps to a file
 * a list gets to in one. Ordered by when each document was last written, which
 * on a phone watching an agent work is very nearly a list of what it has done.
 *
 * The project list is the second half and only appears when it has to. Roots are
 * the server's — an agent's cwd, a dev server's — so with one project there is
 * nothing to choose and the picker never mentions it; with several and no way to
 * guess, asking is honest, and it is the one question here kururu cannot answer
 * on somebody's behalf.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ago, matching, rows, type Doc } from "../docs";
import { shortenPath } from "../labels";
import * as api from "../session";
import { Icon } from "./Icon";

interface Answer {
  roots: string[];
  root: string;
  docs: Doc[];
  error?: string;
}

/**
 * `root` is where to open — the reader's own, when it has one. The picker keeps
 * its own copy from then on: moving between projects is a thing you do *inside*
 * the picker, and routing it through the server would mean re-pointing the pane
 * at a document in a project you were only looking at.
 */
export function DocPicker({
  paneId,
  root,
  onClose,
}: {
  paneId: string;
  root: string;
  onClose: (() => void) | null;
}) {
  const [at, setAt] = useState(root);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const abort = new AbortController();
    setAnswer(null);
    void fetch(`/api/docs?root=${encodeURIComponent(at)}`, { signal: abort.signal })
      .then((response) => response.json())
      .then((body: Answer) => {
        if (!abort.signal.aborted) setAnswer(body);
      })
      .catch(() => {
        if (!abort.signal.aborted) setAnswer({ roots: [], root: "", docs: [], error: "could not read that project" });
      });
    return () => abort.abort();
  }, [at]);

  /**
   * The clock is read once per render of the list rather than per row, so every
   * age in one list is measured from the same moment. Nothing ticks it: a list
   * you are picking from is on screen for seconds, and a re-render for the sake
   * of turning "59m" into "1h" would cost the focus in the filter box.
   */
  const now = Date.now();
  const all = useMemo(() => rows(answer?.docs ?? []), [answer]);
  const shown = useMemo(() => matching(all, query), [all, query]);

  /**
   * The filter takes the keyboard on a desktop and deliberately does not on a
   * phone: a soft keyboard sliding up over a list somebody came here to read is
   * the picker answering a question nobody asked. `hover: hover` is the same
   * test the stylesheet uses for "this window has a pointer".
   */
  useEffect(() => {
    if (window.matchMedia("(hover: hover)").matches) input.current?.focus();
  }, []);

  const projects = answer && !answer.root ? answer.roots : null;

  return (
    <div className="docs">
      <header className="docs-head">
        {projects ? (
          <span className="docs-title">Which project?</span>
        ) : (
          <input
            ref={input}
            className="docs-filter"
            type="search"
            value={query}
            placeholder={answer ? `Find in ${shortenPath(answer.root)}` : "Finding documents…"}
            onChange={(event) => setQuery(event.target.value)}
            /* Escape is the way out of a filter before it is the way out of the
               picker, which is what somebody with a full box means by it. */
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              if (query) setQuery("");
              else onClose?.();
            }}
          />
        )}
        {onClose && (
          <button className="pane-btn" onClick={onClose} title="Back to the document" aria-label="Close the picker">
            <Icon name="close" />
          </button>
        )}
      </header>

      {projects ? (
        <ul className="docs-list">
          {projects.map((project) => (
            <li key={project}>
              <button className="docs-row" onClick={() => setAt(project)}>
                <span className="docs-name">{project.split("/").pop()}</span>
                <span className="docs-dir">{shortenPath(project)}</span>
              </button>
            </li>
          ))}
          {projects.length === 0 && <li className="docs-none">Nothing to read yet — kururu learns a project from the terminals open in it.</li>}
        </ul>
      ) : (
        <ul className="docs-list">
          {shown.map((row) => (
            <li key={row.path}>
              <button
                className="docs-row"
                onClick={() => {
                  api.openDoc(paneId, answer?.root ?? at, row.path);
                  onClose?.();
                }}
              >
                <span className="docs-name">{row.name}</span>
                {row.dir && <span className="docs-dir">{row.dir}</span>}
                <span className="docs-age">{ago(row.mtime, now)}</span>
              </button>
            </li>
          ))}
          {answer && shown.length === 0 && (
            <li className="docs-none">
              {answer.error ?? (all.length === 0 ? "No markdown in this project." : "Nothing matches that.")}
            </li>
          )}
        </ul>
      )}

      {/* Only once there is somewhere else to go. A row saying "1 project" is a
          control that cannot do anything, and this is a phone's worth of width. */}
      {answer && answer.root && answer.roots.length > 1 && (
        <footer className="docs-foot">
          <button className="docs-elsewhere" onClick={() => setAt("")}>
            Another project…
          </button>
        </footer>
      )}
    </div>
  );
}
