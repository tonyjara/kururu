/**
 * The project, as a tree down the right-hand side — and a door out of the
 * window for everything kururu should not be the one to open.
 *
 * Kururu is for watching and steering agents, not for writing code, and the
 * people it is for already have an editor they are not going to trade for one
 * drawn in a browser. So the tree splits files in two by what the window is
 * actually good at. Markdown it can draw, and does, in a reader. Everything
 * else goes to nvim: the one running in this workspace if there is one, a new
 * one in a tab if there is not. A code view in here would be a third editor
 * nobody asked for and a worse one than both of the others.
 *
 * It holds no files. It is a set of expanded directories, remembered per
 * project in this browser, and the listings of those directories, re-read on
 * a slow timer — agents create and delete files constantly and a tree that
 * only knew what was there when you opened it would be lying within a minute.
 * Every read goes through `files.ts`, rooted at a directory the server handed
 * over, and no path here is anything but a string relative to it.
 *
 * It also rearranges: new, rename, cut, copy, paste, drag, and the Trash —
 * everything that changes where a file is and nothing that changes what is in
 * it, which stays nvim's. Every edit is a verb sent to `fileops.ts` and the
 * tree then reads again, so it never believes a move happened that the disk
 * did not agree to. A drag is the desktop's way in; a phone cannot drag, so
 * a long-press opens the same menu and "Move to…" picks the folder from a list.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { basename } from "../../../shared/labels";
import type { WorkspaceProject } from "../../../shared/wire";
import { beginDrag, endDrag as endPaneDrag, fileId } from "../drag";
import { desktop } from "../desktop";
import { shortenPath } from "../labels";
import { canZoom, DEFAULT_ZOOM, resetZoom, zoomBy, zoomLabel, zoomStore } from "../zoom";
import type { DialogState } from "./Dialog";
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

/**
 * The root somebody picked from the header, per workspace, in this browser.
 * Only ever one of the server's `choices`, and only honoured while it still is
 * one — close the last tab in that folder and the tree goes back to the guess,
 * and comes back to the pick if a tab goes there again.
 */
const PICK_KEY = "kururu.files-root.";

/** A row being dragged, told apart from the tabs, panes and cards that also drag. */
const TREE_MIME = "application/x-kururu-tree";

/** How long a finger rests on a row before that is a right-click. */
const LONG_PRESS_MS = 500;
/** How long a drag hovers over a shut folder before it opens to be dropped into. */
const SPRING_MS = 700;

/** Cut or copied, waiting for a paste. Per tree, not the system clipboard: it names a path in this project. */
type Clip = { mode: "cut" | "copy"; path: string } | null;

type OpBody =
  | { op: "mkdir" | "touch"; dir: string; name: string }
  | { op: "rename"; path: string; name: string }
  | { op: "move" | "copy"; path: string; dir: string }
  | { op: "trash" | "reveal"; path: string };

/** The folder a path sits in, "" for the top. */
function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Is `path` this one or somewhere under it? */
function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

export function FileTree({
  workspaceId,
  project,
  runsOn,
  current,
  overlay,
  onOpen,
  onOpenInEditor,
  onPrompt,
  onClose,
  onResize,
  onResetWidth,
}: {
  workspaceId: string;
  /** Where this workspace is, or null while the server has not said. */
  project: WorkspaceProject | null;
  /**
   * The machine this workspace's shells run on, or null for this Mac. The
   * tree only ever reads this disk, so a pinned workspace with no terminal
   * here has nothing to draw, and says why rather than waiting forever.
   */
  runsOn: string | null;
  /** The file the reader in this workspace is showing, to mark its row. */
  current: string | null;
  overlay: boolean;
  /** A click. Whether that reads or edits is the caller's decision. */
  onOpen: (root: string, path: string) => void;
  /** Straight to nvim, for a markdown file you want to edit rather than read. */
  onOpenInEditor: (root: string, path: string) => void;
  /** The window's one modal: names, "are you sure", and the folder picker. */
  onPrompt: (state: DialogState) => void;
  onClose: () => void;
  onResize: (px: number) => void;
  onResetWidth: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(() => storedPick(workspaceId));
  const [pickedFor, setPickedFor] = useState(workspaceId);
  if (pickedFor !== workspaceId) {
    setPickedFor(workspaceId);
    setPicked(storedPick(workspaceId));
  }
  const choices = project?.choices ?? [];
  const root = picked && choices.includes(picked) ? picked : (project?.root ?? null);
  const pick = (dir: string | null) => {
    setPicked(dir);
    try {
      if (dir) localStorage.setItem(PICK_KEY + workspaceId, dir);
      else localStorage.removeItem(PICK_KEY + workspaceId);
    } catch {
      // Private mode: the pick lasts as long as the tree does.
    }
  };
  const [rootMenu, setRootMenu] = useState<MenuAt | null>(null);

  const [expanded, setExpanded] = useState<Set<string>>(() => storedExpanded(root));
  const [listings, setListings] = useState<Map<string, Entry[] | string>>(new Map());
  const [menu, setMenu] = useState<{ at: MenuAt; entry: Entry | null } | null>(null);
  const [clip, setClip] = useState<Clip>(null);
  /** The last edit the disk refused, said until the next one. */
  const [error, setError] = useState<string | null>(null);
  /** The folder a drag would land in right now — "" is the top of the tree. */
  const [dropAt, setDropAt] = useState<string | null>(null);

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
    setClip(null);
    setError(null);
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

  const expand = (dir: string) => {
    if (!dir || expandedRef.current.has(dir)) return;
    void load(dir);
    // Its ancestors too: a folder open inside a shut one is not a folder you can see.
    setExpanded((had) => {
      const next = new Set(had);
      for (let at = dir; at; at = parentOf(at)) next.add(at);
      return next;
    });
  };

  /**
   * One edit, sent and then read back. On success the folders it touched are
   * listed again at once rather than on the next tick — the row you just moved
   * should be where you put it before your eye gets there.
   */
  const run = async (body: OpBody, touched: string[]): Promise<string | null> => {
    if (!root) return null;
    let result: { ok?: boolean; path?: string; error?: string };
    try {
      const response = await fetch("/api/fs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, root }),
      });
      result = (await response.json()) as typeof result;
    } catch {
      result = { error: "the server did not answer" };
    }
    for (const dir of new Set(touched)) void load(dir);
    if (!result.ok) {
      setError(result.error ?? "that did not work");
      return null;
    }
    setError(null);
    return result.path ?? "";
  };

  /**
   * A folder that moved takes what was open inside it along, so a rename does
   * not fold up the part of the tree you were working in.
   */
  const follow = (from: string, to: string | null) => {
    setExpanded((had) => {
      if (![...had].some((path) => within(path, from))) return had;
      const next = new Set<string>();
      for (const path of had) {
        if (!within(path, from)) next.add(path);
        else if (to !== null) next.add(to + path.slice(from.length));
      }
      return next;
    });
    setClip((had) => (had && within(had.path, from) ? null : had));
  };

  const place = (dir: string) => (dir ? `in ${dir}` : `at the top of ${root ? basename(root) : "the project"}`);

  const create = (dir: string, kind: "touch" | "mkdir") =>
    onPrompt({
      kind: "prompt",
      title: kind === "touch" ? "New file" : "New folder",
      hint: place(dir),
      value: "",
      submitLabel: "Create",
      onSubmit: (name) =>
        void run({ op: kind, dir, name }, [dir]).then((made) => {
          if (made === null) return;
          expand(dir);
          // A file made here is a file you are about to write, and writing is nvim's.
          if (kind === "touch" && root) onOpenInEditor(root, made);
        }),
    });

  const rename = (entry: Entry) =>
    onPrompt({
      kind: "prompt",
      title: `Rename ${entry.dir ? "folder" : "file"}`,
      hint: entry.path,
      value: entry.name,
      submitLabel: "Rename",
      onSubmit: (name) =>
        void run({ op: "rename", path: entry.path, name }, [parentOf(entry.path)]).then((to) => {
          if (to !== null && entry.dir) follow(entry.path, to);
        }),
    });

  const move = async (path: string, dir: string, copy: boolean) => {
    if (!copy && parentOf(path) === dir) return;
    const to = await run({ op: copy ? "copy" : "move", path, dir }, [parentOf(path), dir]);
    if (to === null) return;
    expand(dir);
    if (!copy) follow(path, to);
  };

  const paste = (dir: string) => {
    if (!clip) return;
    void move(clip.path, dir, clip.mode === "copy");
    // A cut is spent by its paste; a copy can be pasted again.
    if (clip.mode === "cut") setClip(null);
  };

  const moveTo = async (entry: Entry) => {
    if (!root) return;
    let dirs: string[] = [];
    try {
      const response = await fetch(`/api/dirs?${new URLSearchParams({ root })}`);
      dirs = ((await response.json()) as { dirs?: string[] }).dirs ?? [];
    } catch {
      return setError("could not list the folders");
    }
    const from = parentOf(entry.path);
    onPrompt({
      kind: "pick",
      title: `Move ${entry.name} to…`,
      hint: `now ${place(from)}`,
      items: [
        ...(from ? [{ id: "", label: `${basename(root)}/`, hint: "the top" }] : []),
        ...dirs
          .filter((dir) => dir !== from && !(entry.dir && within(dir, entry.path)))
          .sort((a, b) => a.localeCompare(b))
          .map((dir) => ({ id: dir, label: `${dir}/` })),
      ],
      onPick: (dir) => void move(entry.path, dir, false),
    });
  };

  const trash = (entry: Entry) =>
    onPrompt({
      kind: "confirm",
      title: `Move ${entry.name} to the Trash?`,
      hint: `${entry.dir ? "The folder and everything in it. " : ""}It can be put back from the Trash.`,
      confirmLabel: "Move to Trash",
      onConfirm: () =>
        void run({ op: "trash", path: entry.path }, [parentOf(entry.path)]).then((done) => {
          if (done !== null) follow(entry.path, null);
        }),
    });

  const openMenu = (event: React.MouseEvent, entry: Entry | null) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ at: { x: event.clientX, y: event.clientY }, entry });
  };

  /**
   * The right-click a finger does not have. iOS never fires `contextmenu` on a
   * long press, so the tree times one itself: held still for half a second is
   * a menu, and the click that the lift would otherwise deliver is swallowed so
   * the file does not also open underneath it.
   */
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const pressed = useRef(false);
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  const longPress = (entry: Entry | null) => ({
    onPointerDown: (event: React.PointerEvent) => {
      if (event.pointerType !== "touch") return;
      event.stopPropagation();
      cancelPress();
      const { clientX: x, clientY: y } = event;
      press.current = {
        x,
        y,
        timer: window.setTimeout(() => {
          press.current = null;
          // Only a row has a click to swallow; the empty tree below the rows
          // has none, and a flag left up would eat the next real tap.
          pressed.current = entry !== null;
          setMenu({ at: { x, y }, entry });
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (event: React.PointerEvent) => {
      const at = press.current;
      if (at && Math.hypot(event.clientX - at.x, event.clientY - at.y) > 10) cancelPress();
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
  });
  const swallowed = () => {
    if (!pressed.current) return false;
    pressed.current = false;
    return true;
  };

  /**
   * Hovering a drag over a shut folder opens it, as Finder does, so a file can
   * be dropped deeper than what happened to be open when the drag began.
   */
  const spring = useRef<{ dir: string; timer: number } | null>(null);
  const springTo = (dir: string | null) => {
    if (spring.current?.dir === dir) return;
    if (spring.current) window.clearTimeout(spring.current.timer);
    spring.current = dir ? { dir, timer: window.setTimeout(() => expand(dir), SPRING_MS) } : null;
  };
  const endDrag = () => {
    springTo(null);
    setDropAt(null);
  };

  /** Drop handlers for a place things land in: a folder row, a file's folder, or the top. */
  const dropInto = (dir: string, row?: Entry) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes(TREE_MIME)) return;
      event.preventDefault();
      event.stopPropagation();
      // Option copies, as it does in Finder; a plain drag moves.
      event.dataTransfer.dropEffect = event.altKey ? "copy" : "move";
      setDropAt(dir);
      springTo(row?.dir && !expanded.has(row.path) ? row.path : null);
    },
    onDrop: (event: React.DragEvent) => {
      const path = event.dataTransfer.getData(TREE_MIME);
      if (!path) return;
      event.preventDefault();
      event.stopPropagation();
      endDrag();
      void move(path, dir, event.altKey);
    },
  });

  const menuItems = (entry: Entry | null): MenuItem[] => {
    if (!root) return [];
    const items: MenuItem[] = [];
    // The folder a "new" or a paste lands in: the row's own if it is one, else
    // the one it sits in — right-clicking a file to make its sibling is the
    // common case, not a mistake.
    const dir = entry ? (entry.dir ? entry.path : parentOf(entry.path)) : "";
    if (entry && !entry.dir) {
      if (MARKDOWN.test(entry.path)) items.push({ label: "Read", run: () => onOpen(root, entry.path) });
      items.push({ label: "Open in nvim…", run: () => onOpenInEditor(root, entry.path) });
    }
    items.push({ label: "New file…", sep: items.length > 0, run: () => create(dir, "touch") });
    items.push({ label: "New folder…", run: () => create(dir, "mkdir") });
    if (clip) {
      items.push({
        label: `Paste ${basename(clip.path)}`,
        hint: clip.mode === "cut" ? "move" : "copy",
        run: () => paste(dir),
      });
    }
    // Only in the window: Finder opens on the machine the server runs on, and
    // from a phone that is a desk nobody is sitting at.
    const reveal = desktop()
      ? { label: "Open in Finder", sep: true, run: () => void run({ op: "reveal", path: entry?.path ?? "" }, []) }
      : null;
    if (!entry) {
      if (reveal) items.push(reveal);
      return items;
    }
    items.push({ label: "Rename…", sep: true, hint: "F2", run: () => rename(entry) });
    items.push({ label: "Duplicate", run: () => void move(entry.path, parentOf(entry.path), true) });
    items.push({ label: "Cut", hint: "⌘X", run: () => setClip({ mode: "cut", path: entry.path }) });
    items.push({ label: "Copy", hint: "⌘C", run: () => setClip({ mode: "copy", path: entry.path }) });
    items.push({ label: "Move to…", run: () => void moveTo(entry) });
    items.push({
      label: "Copy path",
      sep: true,
      run: () => void navigator.clipboard?.writeText(`${root}/${entry.path}`).catch(() => {}),
    });
    if (reveal) items.push({ ...reveal, sep: false });
    items.push({ label: "Move to Trash", sep: true, danger: true, hint: "⌘⌫", run: () => trash(entry) });
    return items;
  };

  /**
   * The keys a file manager has, on the row that has focus. They are only
   * heard here, on a focused tree row, so none of them can be mistaken for a
   * keystroke meant for a terminal — the row is a button and a pty never sees
   * what a button was sent.
   */
  const rowKeys = (event: React.KeyboardEvent, entry: Entry) => {
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    const act = (fn: () => void) => {
      event.preventDefault();
      event.stopPropagation();
      fn();
    };
    if (event.key === "F2") return act(() => rename(entry));
    if (mod && event.key === "Backspace") return act(() => trash(entry));
    if (mod && key === "x") return act(() => setClip({ mode: "cut", path: entry.path }));
    if (mod && key === "c") return act(() => setClip({ mode: "copy", path: entry.path }));
    if (mod && key === "v" && clip) return act(() => paste(entry.dir ? entry.path : parentOf(entry.path)));
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
            } ${entry.dir && dropAt === entry.path ? "tree-drop" : ""} ${
              clip?.mode === "cut" && clip.path === entry.path ? "tree-cut" : ""
            }`}
            style={indent(depth)}
            role="treeitem"
            aria-expanded={entry.dir ? open : undefined}
            title={entry.dir ? entry.path : doc ? `${entry.path}\nClick to read` : `${entry.path}\nClick to open in nvim`}
            onClick={() => {
              if (swallowed()) return;
              if (entry.dir) toggle(entry);
              else if (root) onOpen(root, entry.path);
            }}
            onContextMenu={(event) => openMenu(event, entry)}
            onKeyDown={(event) => rowKeys(event, entry)}
            draggable
            onDragStart={(event) => {
              cancelPress();
              // A markdown file can also be dropped on a pane, as a tab — so it
              // announces itself to the panes too, which light up for it.
              if (doc && root) beginDrag(event, "file", fileId(root, entry.path));
              event.dataTransfer.setData(TREE_MIME, entry.path);
              event.dataTransfer.effectAllowed = "copyMove";
            }}
            onDragEnd={() => {
              endDrag();
              endPaneDrag();
            }}
            {...longPress(entry)}
            {...dropInto(entry.dir ? entry.path : parentOf(entry.path), entry)}
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
        {/* A picker only when there is something to pick: a workspace whose
            tabs are all in one place has one root and a plain title. */}
        {choices.length > 1 ? (
          <button
            className="files-root files-root-pick"
            title={`${root ?? ""} — pick another folder this workspace's tabs are in`}
            aria-haspopup="menu"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setRootMenu({ x: box.left, y: box.bottom + 4 });
            }}
          >
            {root ? basename(root) : "files"}
            <Icon name="caret" />
          </button>
        ) : (
          <span className="files-root" title={root ?? undefined}>
            {root ? basename(root) : "files"}
          </span>
        )}
        {root && <span className="files-path">{shortenPath(root)}</span>}
        <Zoom />
        {/* On a wide window the tree's own way back to the edge, beside the
            status bar's; on a sheet, the way out of it, which is a close. */}
        {overlay ? (
          <button className="sidebar-close files-close" onClick={onClose} aria-label="Hide the file tree" title="Hide (C-a e)">
            <Icon name="close" />
          </button>
        ) : (
          <button className="pane-btn files-close" onClick={onClose} aria-label="Hide the file tree" title="Hide (C-a e)">
            <Icon name="panel" />
          </button>
        )}
      </div>
      {error && (
        <p className="tree-error" role="alert" onClick={() => setError(null)} title="Dismiss">
          {error}
        </p>
      )}
      <div
        className={`files-list ${dropAt === "" ? "files-list-drop" : ""}`}
        role="tree"
        onContextMenu={root ? (event) => openMenu(event, null) : undefined}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) endDrag();
        }}
        {...longPress(null)}
        {...dropInto("")}
      >
        {root ? (
          rows("", 0)
        ) : runsOn ? (
          <p className="tree-note">
            This workspace's shells run on {runsOn}, and the tree only reads this Mac. A terminal opened here — the
            + menu's "Terminal on this Mac" — gives it a folder to show.
          </p>
        ) : (
          <p className="tree-note">Waiting for a terminal to say where this workspace is.</p>
        )}
      </div>
      {!overlay && <Grip onResize={onResize} onReset={onResetWidth} />}
      {menu && <Menu at={menu.at} items={menuItems(menu.entry)} onClose={() => setMenu(null)} />}
      {rootMenu && project && (
        <Menu
          at={rootMenu}
          items={[
            // The guess follows focus, so it is its own row rather than
            // whichever folder it happens to name right now: picking that
            // folder would pin it, and this is the way back to not pinning.
            {
              label: "Follow the focused tab",
              hint: basename(project.root),
              mark: !picked || !choices.includes(picked),
              run: () => pick(null),
            },
            ...choices.map((dir, at) => ({
              label: basename(dir) || dir,
              hint: shortenPath(dir),
              sep: at === 0,
              mark: picked === dir,
              run: () => pick(dir),
            })),
          ]}
          onClose={() => setRootMenu(null)}
        />
      )}
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

function storedPick(workspaceId: string): string | null {
  try {
    return localStorage.getItem(PICK_KEY + workspaceId);
  } catch {
    return null;
  }
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
