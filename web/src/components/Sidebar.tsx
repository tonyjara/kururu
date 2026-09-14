import { useEffect, useState } from "react";
import type { DevServer } from "../../../shared/wire";
import type { OpenFile } from "../App";
import { selectSession, useKururu } from "../session";

interface Props {
  open: boolean;
  onClose: () => void;
  devServers: DevServer[];
  devPort: number | null;
  onDevPort: (port: number) => void;
  onOpenFile: (file: OpenFile) => void;
}

interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
}

/**
 * Profiles, dev servers, and the file tree of whichever project you picked.
 *
 * An overlay on a phone and a column on a wide screen — the same component
 * either way; only the CSS decides. Directories are fetched when opened rather
 * than walked up front, because a phone on a tailnet should not pay for a tree
 * nobody expanded.
 */
export function Sidebar({ open, onClose, devServers, devPort, onDevPort, onOpenFile }: Props) {
  const { sessions, activeSession } = useKururu();
  const [roots, setRoots] = useState<string[]>([]);
  const [root, setRoot] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    fetch("/api/roots")
      .then((res) => res.json())
      .then((body: { roots: string[] }) => setRoots(body.roots ?? []))
      .catch(() => setRoots([]));
  }, [open]);

  // Default to the project the selected dev server is running in — nearly
  // always the one you want to read.
  useEffect(() => {
    if (root && roots.includes(root)) return;
    const devCwd = devServers.find((d) => d.port === devPort)?.cwd;
    setRoot(devCwd && roots.includes(devCwd) ? devCwd : (roots[0] ?? null));
  }, [roots, devServers, devPort, root]);

  return (
    <>
      <div className={`scrim ${open ? "scrim-on" : ""}`} onClick={onClose} aria-hidden={!open} />
      <aside className={`sidebar ${open ? "sidebar-on" : ""}`} aria-hidden={!open}>
        {sessions.length > 1 && (
          <section className="side-section">
            <h3>Profile</h3>
            <div className="chips">
              {sessions.map((session) => (
                <button
                  key={session}
                  className={`chip ${session === activeSession ? "chip-on" : ""}`}
                  onClick={() => selectSession(session)}
                >
                  {session}
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="side-section">
          <h3>Dev servers</h3>
          {devServers.length === 0 && <p className="muted">None listening.</p>}
          {devServers.map((server) => (
            <button
              key={server.port}
              className={`row ${server.port === devPort ? "row-on" : ""}`}
              onClick={() => onDevPort(server.port)}
            >
              <span className="row-main">:{server.port}</span>
              <span className="row-sub">{server.program}</span>
              {server.cwd && <span className="row-dim">{shortenPath(server.cwd)}</span>}
            </button>
          ))}
        </section>

        <section className="side-section side-files">
          <h3>Files</h3>
          {roots.length > 1 && (
            <select className="select" value={root ?? ""} onChange={(e) => setRoot(e.target.value)}>
              {roots.map((r) => (
                <option key={r} value={r}>
                  {shortenPath(r)}
                </option>
              ))}
            </select>
          )}
          {root ? (
            <Tree root={root} path="" onOpenFile={onOpenFile} />
          ) : (
            <p className="muted">
              Nothing to browse yet. Kururu reads the project a dev server is running in; start one,
              or pass <code>KURURU_ROOTS</code>.
            </p>
          )}
        </section>
      </aside>
    </>
  );
}

/** One directory level, expanded in place. */
function Tree({ root, path, onOpenFile }: { root: string; path: string; onOpenFile: (f: OpenFile) => void }) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({ root, path });
    fetch(`/api/ls?${params}`)
      .then((res) => res.json())
      .then((body: { entries?: DirEntry[] }) => live && setEntries(body.entries ?? []))
      .catch(() => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [root, path]);

  if (entries === null) return <p className="muted">…</p>;

  return (
    <ul className="tree">
      {entries.map((entry) => (
        <li key={entry.path}>
          <button
            className="tree-row"
            onClick={() => {
              if (!entry.dir) return onOpenFile({ root, path: entry.path });
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(entry.path)) next.delete(entry.path);
                else next.add(entry.path);
                return next;
              });
            }}
          >
            <span className="tree-icon">{entry.dir ? (expanded.has(entry.path) ? "▾" : "▸") : ""}</span>
            <span className={entry.dir ? "tree-dir" : "tree-file"}>{entry.name}</span>
          </button>
          {entry.dir && expanded.has(entry.path) && (
            <div className="tree-nest">
              <Tree root={root} path={entry.path} onOpenFile={onOpenFile} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** `/Users/me/Desktop/Nyto/kururu` → `~/…/Nyto/kururu`. Enough to tell projects apart. */
function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}
