/**
 * The arrangement, on disk — tmux-resurrect's trick, with the guesswork removed.
 *
 * Quitting kururu takes every pty with it (that is the price of owning them, and
 * PLAN.md's principle 1 is where it is argued). It does not have to take the
 * *arrangement* with it, and those are different things: the panes take minutes
 * to fill and the layout around them can take longer than that to get right.
 *
 * So this writes the structure — profiles, workspace names and order, splits,
 * ratios, and the directory each pane was working in — and hands it back on the
 * next launch. What it deliberately does **not** do is restore processes. A
 * restored pane comes back empty, with its old cwd remembered so the terminal
 * you open in it starts where that pane was for. Spawning on restore would be
 * the wrong kind of clever: a snapshot with four agent tabs in it would launch
 * four agents, spend four context windows, and do it before anybody had asked
 * for one. This is the one place that does not open a terminal for you — a pane
 * being *made* gets one, but a pane being brought back is not being made.
 *
 * Written atomically (temp file, then rename) because the alternative is a
 * truncated JSON file where the layout used to be, and read defensively for the
 * same reason: anything that does not parse is ignored and kururu starts fresh
 * rather than refusing to start.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Profile, Workspace } from "../../shared/model";
import { adoptIdentity, isWorkspaceColor } from "../../shared/model";
import type { LayoutNode } from "../../shared/layout";
import { nextId } from "./workspaces";

/** Bumped when the shape below changes; an older file is ignored, not migrated. */
const VERSION = 1;

interface StoredPane {
  cwd?: string;
  /**
   * Where a reader pane was looking, and deliberately not *what* it was
   * following. A pane's shape is structure and survives; the editor it was
   * tracking is a process, and this file has no business remembering one. So a
   * restored reader comes back pinned to its last file — which is the honest
   * answer, because the nvim that was driving it is gone.
   */
  reader?: { root: string; path: string };
}
type StoredNode =
  | { type: "pane"; pane: StoredPane }
  | { type: "split"; dir: "row" | "col"; ratio: number; a: StoredNode; b: StoredNode };

interface StoredWorkspace {
  name: string;
  layout: StoredNode;
  /** Optional because sessions written before colours existed do not have one. */
  color?: string | null;
  /** Likewise: a session written before a workspace could pick a mascot. */
  mascotId?: string | null;
  /**
   * The profile whose accounts this workspace borrows, as an index into the
   * list above — `activeWorkspace`'s trick, and for its reason: profile ids are
   * regenerated on the way back in, so an id written here would name nothing
   * the moment it was read. A name would survive a reorder that an index does
   * not, and would not survive two profiles being called the same thing, which
   * is the likelier of the two accidents.
   */
  identityProfile?: number | null;
  /**
   * The last dev command this workspace had serving, and where it ran. Two
   * strings and no process — which is what makes it the one thing on a restored
   * layout that can bring an app back up, and why it is safe to keep when
   * nothing else about a running terminal is.
   */
  dev?: { command: string; cwd: string } | null;
}
interface StoredProfile {
  name: string;
  workspaces: StoredWorkspace[];
  /** Index rather than id: ids are regenerated on the way back in. */
  activeWorkspace: number;
  /**
   * Which accounts this profile opens terminals as. Kept, where every other
   * live thing here is stripped, because it is not a live thing: three paths a
   * person chose, which the rule against restoring processes has nothing to say
   * about. They are also the one part of a restored profile that still works
   * with no pty host in sight — an empty pane opened tomorrow gets the right
   * account without anybody being asked again.
   */
  identity?: unknown;
}
interface StoredSession {
  version: number;
  profiles: StoredProfile[];
  activeProfile: number;
}

/**
 * Where it goes. XDG's state directory, which is the one meant for things a
 * program wants back next time but which are not configuration and not a cache.
 */
export function snapshotPath(): string {
  const dir =
    process.env.KURURU_STATE_DIR ||
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kururu");
  return join(dir, "session.json");
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function strip(node: LayoutNode): StoredNode {
  if (node.type === "pane") {
    const { cwd, reader } = node.pane;
    return {
      type: "pane",
      pane: {
        ...(cwd ? { cwd } : {}),
        ...(reader?.path ? { reader: { root: reader.root, path: reader.path } } : {}),
      },
    };
  }
  return { type: "split", dir: node.dir, ratio: node.ratio, a: strip(node.a), b: strip(node.b) };
}

export function writeSnapshot(profiles: Profile[], activeProfileId: string): void {
  /**
   * A borrowed profile, as the file names one. Null for a workspace that has
   * borrowed nobody and also for one pointing at a profile that has since been
   * deleted — the live side reads that as "my own profile" already, so this is
   * where the dead pointer stops being written down rather than a repair.
   */
  const profileIndexOf = (profileId: string | null): number | null => {
    if (!profileId) return null;
    const at = profiles.findIndex((p) => p.id === profileId);
    return at === -1 ? null : at;
  };

  const session: StoredSession = {
    version: VERSION,
    activeProfile: Math.max(0, profiles.findIndex((p) => p.id === activeProfileId)),
    profiles: profiles.map((profile) => ({
      name: profile.name,
      identity: profile.identity,
      activeWorkspace: Math.max(
        0,
        profile.workspaces.findIndex((w) => w.id === profile.activeWorkspaceId),
      ),
      workspaces: profile.workspaces.map((workspace) => ({
        name: workspace.name,
        color: workspace.color,
        mascotId: workspace.mascotId,
        identityProfile: profileIndexOf(workspace.identityProfileId),
        // The terminal it ran in is deliberately dropped: agent ids belong to a
        // pty host that will not be there next launch, and a button that reused
        // a recycled id would type a command into a stranger.
        dev: workspace.dev ? { command: workspace.dev.command, cwd: workspace.dev.cwd } : null,
        layout: strip(workspace.layout),
      })),
    })),
  };

  const path = snapshotPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Same directory, so the rename is atomic; a crash mid-write leaves the
    // previous snapshot intact rather than half of this one.
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(session, null, 2), "utf8");
    renameSync(temp, path);
  } catch {
    // A layout that could not be saved is not worth failing a launch over.
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Rebuild a live tree from a stored one, with fresh ids and no processes. */
function revive(node: StoredNode): LayoutNode {
  if (node.type === "pane") {
    const cwd = typeof node.pane?.cwd === "string" ? node.pane.cwd : undefined;
    const stored = node.pane?.reader;
    const reader =
      stored && typeof stored.root === "string" && typeof stored.path === "string"
        ? { root: stored.root, path: stored.path, follow: null, rev: 0 }
        : undefined;
    return { type: "pane", pane: { id: nextId("n"), agentIds: [], activeIdx: 0, cwd, reader } };
  }
  const ratio = typeof node.ratio === "number" && node.ratio > 0 && node.ratio < 1 ? node.ratio : 0.5;
  return {
    type: "split",
    id: nextId("s"),
    dir: node.dir === "col" ? "col" : "row",
    ratio,
    a: revive(node.a),
    b: revive(node.b),
  };
}

function looksLikeNode(value: unknown): value is StoredNode {
  if (!value || typeof value !== "object") return false;
  const node = value as StoredNode;
  if (node.type === "pane") return true;
  return node.type === "split" && looksLikeNode(node.a) && looksLikeNode(node.b);
}

/**
 * What was arranged last time, or null for a fresh start. Null is the normal
 * case on a first run and is never an error.
 */
export function readSnapshot(): { profiles: Profile[]; activeProfileId: string } | null {
  const path = snapshotPath();
  if (!existsSync(path)) return null;
  let session: StoredSession;
  try {
    session = JSON.parse(readFileSync(path, "utf8")) as StoredSession;
  } catch {
    return null;
  }
  if (session?.version !== VERSION || !Array.isArray(session.profiles)) return null;

  const profiles: Profile[] = [];
  /**
   * Which restored profile each *stored* index turned out to be. Not the same
   * as the position in `profiles`, because a stored profile with nothing
   * readable in it is skipped — so the borrowed-identity pointers below are
   * resolved through this rather than by counting, and a skip shifts nobody's
   * accounts onto the wrong profile.
   */
  const byStored = new Map<number, string>();
  /** Workspaces whose pointer names a profile the loop has not reached yet. */
  const borrowing: { workspace: Workspace; profile: number }[] = [];
  for (const [storedAt, stored] of session.profiles.entries()) {
    if (!stored || typeof stored.name !== "string" || !Array.isArray(stored.workspaces)) continue;
    const workspaces: Workspace[] = [];
    for (const w of stored.workspaces) {
      if (!w || typeof w.name !== "string" || !looksLikeNode(w.layout)) continue;
      const layout = revive(w.layout);
      const first = layout.type === "pane" ? layout.pane.id : firstPaneId(layout);
      // Read as defensively as everything else here: a colour the palette has
      // since dropped comes back as untagged rather than as a dead style.
      const color = isWorkspaceColor(w.color) ? w.color : null;
      // The mascot is a plain id and is not checked against anything here: one
      // that names nothing draws the default, so a file naming a mascot since
      // deleted needs no repair.
      const mascotId = typeof w.mascotId === "string" ? w.mascotId : null;
      // Read as defensively as the rest, and with no terminal attached: the
      // panes come back empty, so the first press of ▸ opens a tab for it.
      const dev =
        w.dev && typeof w.dev.command === "string" && w.dev.command.trim()
          ? { command: w.dev.command, cwd: typeof w.dev.cwd === "string" ? w.dev.cwd : "", agentId: null }
          : null;
      const workspace: Workspace = {
        id: nextId("w"),
        name: w.name,
        layout,
        focusedPaneId: first,
        // Nowhere to go back to: focus itself is reset to the first pane on the
        // way in, so a remembered second one would be a memory of a move nobody
        // in this session made.
        lastPaneId: null,
        color,
        mascotId,
        // Filled in below, once every profile has an id again. It cannot be
        // resolved here: the profile this points at may be one the loop has
        // not built yet, and on a first run through it is usually exactly that.
        identityProfileId: null,
        dev,
      };
      if (typeof w.identityProfile === "number") {
        borrowing.push({ workspace, profile: w.identityProfile });
      }
      workspaces.push(workspace);
    }
    if (workspaces.length === 0) continue;
    const at = Math.min(Math.max(0, stored.activeWorkspace ?? 0), workspaces.length - 1);
    const profileId = nextId("p");
    byStored.set(storedAt, profileId);
    profiles.push({
      id: profileId,
      name: stored.name,
      workspaces,
      activeWorkspaceId: workspaces[at]!.id,
      lastWorkspaceId: null,
      // Read as defensively as the colour above: a file written before this
      // version has no identity at all, and one with a path that is no longer
      // absolute comes back as untagged rather than as a directory that would
      // resolve differently in every pane.
      identity: adoptIdentity(stored.identity),
      // Empty, and not because the file is old: the order is a list of agent
      // ids, agent ids are processes, and this file restores structure and
      // never processes. A cold start has nothing to put in an order.
      agentOrder: [],
    });
  }
  if (profiles.length === 0) return null;
  // A pointer at a profile that did not survive the read is left as null, which
  // is the workspace's own profile — the same answer a deleted one gives.
  for (const { workspace, profile } of borrowing) {
    workspace.identityProfileId = byStored.get(profile) ?? null;
  }
  const at = Math.min(Math.max(0, session.activeProfile ?? 0), profiles.length - 1);
  return { profiles, activeProfileId: profiles[at]!.id };
}

function firstPaneId(node: LayoutNode): string {
  return node.type === "pane" ? node.pane.id : firstPaneId(node.a);
}
