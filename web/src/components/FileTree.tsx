/**
 * The project, as a tree down the right-hand side — and a door out of the
 * window for everything kururu should not be the one to open.
 *
 * Kururu is for watching and steering agents, not for writing code, and the
 * people it is for already have an editor they are not going to trade for one
 * drawn in a browser. So the tree splits files in two by what the window is
 * actually good at. Markdown it can draw, and does, in a reader. Everything
 * else goes to nvim: the one running in this workspace if there is one, a new
 * one in a split if there is not. A code view in here would be a third editor
 * nobody asked for and a worse one than both of the others.
 *
 * It holds no files. It is a set of expanded directories, remembered per
 * project in this browser, and the listings of those directories, re-read on
 * a slow timer — agents create and delete files constantly and a tree that
 * only knew what was there when you opened it would be lying within a minute.
 * Every read goes through `files.ts`, rooted at a directory the server handed
 * over, and no path here is anything but a string relative to it.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { basename } from "../../../shared/labels";
import { shortenPath } from "../labels";
import { canZoom, DEFAULT_ZOOM, resetZoom, zoomBy, zoomLabel, zoomStore } from "../zoom";
import { Icon } from "./Icon";
import { Menu, type MenuAt, type MenuItem } from "./Menu";

interface Entry {
  name: string;
  /** Relative to the root, forward slashes. */
  path: string;
  dir: boolean;
}

/** What the reader can draw. The server's `EDITABLE`, and the picker's list. */
export const MARKDOWN = /\.(md|markdown|mdx)$/i;

/**
 * How often the open directories are read again.
 *
 * Slower than the git poll it resembles because nothing is waiting on it: a
 * file an agent has just written shows up within a few seconds, which is the
 * time it takes to look over at the tree. Only the directories that are open
 * are read, so the cost is a handful of `readdir`s however large the project.
 */
const REFRESH_MS = 4000;

const EXPANDED_KEY = "kururu.tree.";

export function FileTree({
  root,
  current,
  overlay,
  onOpen,
  onOpenInEditor,
  onClose,
  onResize,
  onResetWidth,
}: {
  /** The project, or null while the server has not said which one it is. */
  root: string | null;
  /** The file the reader in this workspace is showing, to mark its row. */
  current: string | null;
  overlay: boolean;
  /** A click. Whether that reads or edits is the caller's decision. */
  onOpen: (root: string, path: string) => void;
  /** Straight to nvim, for a markdown file you want to edit rather than read. */
  onOpenInEditor: (root: string, path: string) => void;
  onClose: () => void;
  onResize: (px: number) => void;
  onResetWidth: () => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => storedExpanded(root));
  const [listings, setListings] = useState<Map<string, Entry[] | string>>(new Map());
  const [menu, setMenu] = useState<{ at: MenuAt; entry: Entry } | null>(null);

  /**
   * A different project is a different tree: what was open, and what was read,
   * belong to the one that was showing. Reset during render rather than in an
   * effect so the first paint of the new root is not the old root's rows.
   */
  const [shownRoot, setShownRoot] = useState(root);
  if (shownRoot !== root) {
    setShownRoot(root);
    setExpanded(storedExpanded(root));
    setListings(new Map());
  }

  const load = useCallback(
    async (dir: string, signal?: AbortSignal) => {
      if (!root) return;
      const query = new URLSearchParams({ root, path: dir });
      try {
        const response = await fetch(`/api/ls?${query}`, { signal });
        const body = (await response.json()) as { entries?: Entry[]; error?: string };
        const next = body.entries ?? body.error ?? "could not list this directory";
        setListings((had) => {
          // The same listing as last time is no change, and a new Map for it
          // would redraw the whole tree every four seconds for nothing.
          const before = had.get(dir);
          if (before !== undefined && JSON.stringify(before) === JSON.stringify(next)) return had;
          return new Map(had).set(dir, next);
        });
      } catch {
        // Aborted by a newer read of the same tree, or the server restarting —
        // the next tick asks again either way.
      }
    },
    [root],
  );

  /**
   * Read the root and everything open, now and then on the timer. Paused while
   * the page is hidden: a phone in a pocket has no use for a fresh listing.
   */
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  useEffect(() => {
    if (!root) return;
    const abort = new AbortController();
    const sweep = () => {
      if (document.visibilityState === "hidden") return;
      void load("", abort.signal);
      for (const dir of expandedRef.current) void load(dir, abort.signal);
    };
    sweep();
    const timer = window.setInterval(sweep, REFRESH_MS);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, [root, load]);

  useEffect(() => {
    if (!root) return;
    try {
      localStorage.setItem(EXPANDED_KEY + root, JSON.stringify([...expanded]));
    } catch {
      // A tree that forgets what was open is a tree, not an error.
    }
  }, [root, expanded]);

  const toggle = (entry: Entry) => {
    const opening = !expanded.has(entry.path);
    if (opening && !listings.has(entry.path)) void load(entry.path);
    setExpanded((had) => {
      const next = new Set(had);
      if (!opening) {
        // Closing a directory closes what was open inside it, or reopening it
        // later would unfold a tree you had long since stopped looking at.
        for (const path of had) if (path === entry.path || path.startsWith(`${entry.path}/`)) next.delete(path);
      } else {
        next.add(entry.path);
      }
      return next;
    });
  };

  const openMenu = (event: React.MouseEvent, entry: Entry) => {
    event.preventDefault();
    setMenu({ at: { x: event.clientX, y: event.clientY }, entry });
  };

  const menuItems = (entry: Entry): MenuItem[] => {
    if (!root) return [];
    const items: MenuItem[] = [];
    if (MARKDOWN.test(entry.path)) items.push({ label: "Read", run: () => onOpen(root, entry.path) });
    items.push({ label: "Open in nvim…", run: () => onOpenInEditor(root, entry.path) });
    items.push({
      label: "Copy path",
      sep: true,
      run: () => void navigator.clipboard?.writeText(`${root}/${entry.path}`).catch(() => {}),
    });
    return items;
  };

  const rows = (dir: string, depth: number): React.ReactNode => {
    const listing = listings.get(dir);
    if (listing === undefined) return depth === 0 ? <p className="tree-note">Reading…</p> : null;
    if (typeof listing === "string") return <p className="tree-note" style={indent(depth)}>{listing}</p>;
    if (listing.length === 0 && depth === 0) return <p className="tree-note">Nothing here.</p>;
    return listing.map((entry) => {
      const open = entry.dir && expanded.has(entry.path);
      const doc = !entry.dir && MARKDOWN.test(entry.name);
      return (
        <div key={entry.path} role="none">
          <button
            className={`tree-row ${entry.dir ? "tree-dir" : ""} ${doc ? "tree-doc" : ""} ${
              entry.path === current ? "tree-on" : ""
            }`}
            style={indent(depth)}
            role="treeitem"
            aria-expanded={entry.dir ? open : undefined}
            title={entry.dir ? entry.path : doc ? `${entry.path}\nClick to read` : `${entry.path}\nClick to open in nvim`}
            onClick={() => (entry.dir ? toggle(entry) : root && onOpen(root, entry.path))}
            onContextMenu={entry.dir ? undefined : (event) => openMenu(event, entry)}
          >
            {entry.dir ? (
              <Icon name="caret" className={`tree-caret ${open ? "" : "tree-caret-shut"}`} />
            ) : (
              <span className="tree-caret" aria-hidden="true" />
            )}
            <span className="tree-name">{entry.name}</span>
          </button>
          {open && rows(entry.path, depth + 1)}
        </div>
      );
    });
  };

  return (
    <aside className={`files ${overlay ? "files-overlay" : ""}`} aria-label="Files">
      <div className="files-head">
        <span className="files-root" title={root ?? undefined}>
          {root ? basename(root) : "files"}
        </span>
        {root && <span className="files-path">{shortenPath(root)}</span>}
        <Zoom />
        <button className="sidebar-close files-close" onClick={onClose} aria-label="Hide the file tree" title="Hide (C-a e)">
          <Icon name="close" />
        </button>
      </div>
      <div className="files-list" role="tree">
        {root ? rows("", 0) : <p className="tree-note">Waiting for a terminal to say where this workspace is.</p>}
      </div>
      {!overlay && <Grip onResize={onResize} onReset={onResetWidth} />}
      {menu && <Menu at={menu.at} items={menuItems(menu.entry)} onClose={() => setMenu(null)} />}
    </aside>
  );
}

/**
 * The reader's text size, which lived in every reader's strip until that strip
 * became a row of tabs and ran out of room for it.
 *
 * Here because it is one setting for every reader in the window (`zoom.ts`),
 * not a fact about any one of them, so a place beside the documents rather than
 * inside each is where it always belonged. The keys still work in a reader that
 * has the keyboard; this is the door for a pointer and for a phone.
 */
function Zoom() {
  const zoom = useSyncExternalStore(zoomStore.subscribe, zoomStore.getSnapshot, zoomStore.getSnapshot);
  return (
    <span className="files-zoom" role="group" aria-label="Reader text size">
      <button
        className="pane-btn"
        onClick={() => zoomBy(-1)}
        disabled={!canZoom(zoom, -1)}
        aria-label="Smaller text"
        title="Smaller text in the reader — or - while a reader has the keyboard"
      >
        −
      </button>
      <button
        className="reader-zoom"
        onClick={resetZoom}
        disabled={zoom === DEFAULT_ZOOM}
        title={zoom === DEFAULT_ZOOM ? "The reader's text size" : "Back to 100% — or 0 while a reader has the keyboard"}
      >
        {zoomLabel(zoom)}
      </button>
      <button
        className="pane-btn"
        onClick={() => zoomBy(1)}
        disabled={!canZoom(zoom, 1)}
        aria-label="Larger text"
        title="Larger text in the reader — or + while a reader has the keyboard"
      >
        +
      </button>
    </span>
  );
}

/** The depth as a custom property, so the stylesheet decides how far that is. */
function indent(depth: number): React.CSSProperties {
  return { "--depth": depth } as React.CSSProperties;
}

function storedExpanded(root: string | null): Set<string> {
  if (!root) return new Set();
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY + root) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((p): p is string => typeof p === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * The left edge, as something to take hold of. The sidebar's grip mirrored:
 * the tree grows leftwards, so its width is measured from the right edge of the
 * box rather than from the left.
 */
function Grip({ onResize, onReset }: { onResize: (px: number) => void; onReset: () => void }) {
  return (
    <div
      className="files-grip"
      aria-hidden="true"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const box = event.currentTarget.parentElement?.getBoundingClientRect();
        if (box) onResize(box.right - event.clientX);
      }}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      onDoubleClick={onReset}
    />
  );
}
