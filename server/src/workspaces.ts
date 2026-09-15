/**
 * Profiles, workspaces, panes and tabs — the arrangement, owned by the server.
 *
 * It used to live in the browser as React state, which is the obvious place for
 * it right up until you reload the window and your afternoon's arrangement is
 * gone while every process it described is still running. A layout is organized
 * work: it takes longer to arrange than the panes take to fill. So it lives
 * where the ptys live, next to the thing it is an arrangement *of*, and the
 * browser draws what it is told.
 *
 * Three consequences worth naming, because they are what the design buys:
 *
 *  - A window reload costs a repaint. The agents were never the browser's, and
 *    now neither is the layout it drew them in.
 *  - A second client sees the same window. Two browsers on one server are two
 *    views of one session, the way two clients attached to a multiplexer are.
 *  - It can be written to disk, which `persist.ts` does — the structure only,
 *    never the processes.
 *
 * Everything in here is the bookkeeping around `shared/layout.ts`, which does
 * the tree work and is pure. This file adds the two levels above a tree (a
 * workspace has a name and a focus; a profile is a list of workspaces) and the
 * invariants that a tree cannot hold on its own: there is always an active
 * profile, it always has at least one workspace, that workspace always has at
 * least one pane, and the focused pane always exists.
 */
import type { Profile, ProfileIdentity, ProfileSummary, Workspace, WorkspaceDev } from "../../shared/model";
import { adoptIdentity, blankIdentity, isWorkspaceColor } from "../../shared/model";
import {
  addTab,
  closePane,
  cycleTab,
  findPane,
  makePane,
  mergePanes,
  movePaneTo,
  moveTabTo,
  nudge,
  paneInDirection,
  paneWithAgent,
  panes,
  removeTab,
  selectTab,
  setRatio,
  split,
  splitWith,
  stepPane,
  swapPanes,
  updatePane,
  visibleAgents,
  type Direction,
  type LayoutNode,
  type PaneState,
} from "../../shared/layout";

let seq = 0;
/**
 * One counter for every id the arrangement contains, shared with `persist.ts`
 * so a restored layout and a pane split a minute later cannot collide.
 */
export function nextId(prefix: string): string {
  return `${prefix}${++seq}`;
}
const id = nextId;

/**
 * Called after anything here changes. The server pushes a snapshot; `persist.ts`
 * writes the structure. Both are debounced by their own callers — this fires on
 * every mutation and does not care how often that is.
 */
/**
 * Make a restored profile match what the types here promise.
 *
 * What comes back is not necessarily what this version of the server wrote. The
 * host's blob is the arrangement as the *previous* server left it, and across a
 * rebuild that may be a previous version — which is the whole point of the blob
 * being opaque to the host, and the cost of it. A field added since is simply
 * absent, so `color` arrives as `undefined` where the type says `null`, and the
 * difference is invisible right up until something compares against null and
 * gets a different answer than it would have a restart earlier.
 *
 * Only the fields that can be missing are touched; anything structural that is
 * wrong is somebody else's problem, and index.ts already drops tabs pointing at
 * terminals the host does not have.
 */
function adopt(profile: Profile): Profile {
  return {
    ...profile,
    // Three paths a blob written before this version simply does not have, and
    // an absent identity is the same answer as an empty one: every tool as the
    // machine has it. Adopted rather than spread through, because a path that
    // has stopped being absolute is a path that would mean a different
    // directory in every pane it opened a terminal in.
    identity: adoptIdentity(profile.identity),
    workspaces: profile.workspaces.map((workspace) => ({
      ...workspace,
      color: isWorkspaceColor(workspace.color) ? workspace.color : null,
      // A field this version has and the blob may not, like the three below.
      // It is deliberately not checked against the layout: a pane that has gone
      // reads as "nowhere to go back to" where it is used.
      lastPaneId: typeof workspace.lastPaneId === "string" ? workspace.lastPaneId : null,
      // A field this version has and the one that wrote the blob did not. An
      // `undefined` where the type promises `null` is invisible until something
      // compares against null and gets a different answer than it did a restart
      // ago — which is the whole reason this function exists.
      mascotId: typeof workspace.mascotId === "string" ? workspace.mascotId : null,
      // Likewise, and nothing checks that the profile it names still exists:
      // `identityForWorkspace` falls back to the workspace's own profile for an
      // id that resolves to nothing, so a check here would buy a refusal where
      // the fallback is already the same answer.
      identityProfileId:
        typeof workspace.identityProfileId === "string" ? workspace.identityProfileId : null,
      // Likewise. The agent id inside it is *not* repaired against the host's
      // list here: index.ts already drops tabs pointing at terminals that are
      // gone, and a stale one costs nothing — `runDev` checks the terminal is
      // still there and still idle before it types into it.
      dev: adoptDev(workspace.dev),
    })),
  };
}

/** A remembered dev command out of a blob an older server wrote, or nothing. */
function adoptDev(value: unknown): WorkspaceDev | null {
  const raw = (value ?? {}) as Record<string, unknown>;
  if (typeof raw.command !== "string" || !raw.command.trim()) return null;
  return {
    command: raw.command,
    cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    agentId: typeof raw.agentId === "string" ? raw.agentId : null,
  };
}

export type ChangeHandler = () => void;

export class Workspaces {
  private profiles: Profile[] = [];
  private activeId: string;

  onChange: ChangeHandler = () => {};

  constructor(restored?: Profile[]) {
    this.profiles = restored?.length ? restored.map(adopt) : [this.blankProfile("main")];
    this.activeId = this.profiles[0]!.id;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  get active(): Profile {
    return this.profiles.find((p) => p.id === this.activeId) ?? this.profiles[0]!;
  }

  get activeWorkspace(): Workspace {
    const profile = this.active;
    return profile.workspaces.find((w) => w.id === profile.activeWorkspaceId) ?? profile.workspaces[0]!;
  }

  all(): Profile[] {
    return this.profiles;
  }

  /** For the switcher: every profile, with enough to draw a row. */
  summaries(liveAgents: (profileId: string) => number): ProfileSummary[] {
    return this.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      workspaces: profile.workspaces.length,
      agents: liveAgents(profile.id),
      identity: profile.identity,
    }));
  }

  /** Every agent in a profile, wherever in it they are. */
  agentsIn(profileId: string): string[] {
    const profile = this.profiles.find((p) => p.id === profileId);
    if (!profile) return [];
    const ids: string[] = [];
    for (const workspace of profile.workspaces) {
      for (const pane of panes(workspace.layout)) ids.push(...pane.agentIds);
    }
    return ids;
  }

  /** Every terminal in every profile — what a fresh server reconciles against. */
  allAgents(): string[] {
    return this.profiles.flatMap((profile) => this.agentsIn(profile.id));
  }

  /** Which profile a terminal belongs to — the question the sidebar asks. */
  profileOf(agentId: string): string | null {
    for (const profile of this.profiles) {
      for (const workspace of profile.workspaces) {
        if (paneWithAgent(workspace.layout, agentId)) return profile.id;
      }
    }
    return null;
  }

  /**
   * Terminals whose tab is showing, across the active profile's *active*
   * workspace only. A workspace you are not in is not on screen, so its
   * terminals are not being watched — which is what keeps the server from
   * rendering and pushing output nobody can see.
   */
  visible(): string[] {
    return visibleAgents(this.activeWorkspace.layout);
  }

  /**
   * Whether a pane is still there. Asked after a round trip to the pty host, by
   * the one thing that has to survive the pane it was opening for being closed
   * while it waited.
   */
  hasPane(paneId: string): boolean {
    return findPane(this.activeWorkspace.layout, paneId) !== null;
  }

  /** Where a new tab in this pane should start, as far as the layout knows. */
  cwdFor(paneId: string): string | undefined {
    return findPane(this.activeWorkspace.layout, paneId)?.cwd;
  }

  /**
   * Every terminal in the workspace you are in, wherever in it it is.
   *
   * Asked by the thing that decides where a new tab starts: a workspace is one
   * piece of work, so the directory the last terminal in it went to is a better
   * guess than a home directory nobody is working in.
   */
  agentsHere(): string[] {
    return panes(this.activeWorkspace.layout).flatMap((pane) => pane.agentIds);
  }

  // -------------------------------------------------------------------------
  // Panes and tabs
  // -------------------------------------------------------------------------

  /** The pane every "do it here" action means. */
  get focusedPaneId(): string {
    return this.activeWorkspace.focusedPaneId;
  }

  focusPane(paneId: string): void {
    const workspace = this.activeWorkspace;
    if (!findPane(workspace.layout, paneId) || workspace.focusedPaneId === paneId) return;
    // Where you were, so that `lastPane` can be the way back. Recorded here
    // rather than in each of the four callers, because every one of them is a
    // move of the focus and the memory is a property of the move.
    this.mutateWorkspace(workspace.id, (w) => ({
      ...w,
      focusedPaneId: paneId,
      lastPaneId: w.focusedPaneId,
    }));
  }

  /**
   * The other pane: back where focus came from, or onwards when there is no
   * back yet.
   *
   * With two panes the two answers are the same one, which is the case this
   * exists for — a phone draws one pane at a time and two is what somebody
   * watching a pair of agents has. With more, the memory is what makes it a
   * toggle rather than a cycle: you go between the two you are working in and
   * the third is left where it is. A pane the memory names that has since been
   * closed falls through to the step, because a button that does nothing when
   * pressed is worse than one that goes somewhere predictable.
   *
   * Nothing happens with one pane. The client draws the button disabled — it
   * can count panes itself — and this refuses as well, since a snapshot a
   * gesture behind is not a reason to focus a pane that is not there.
   */
  lastPane(): void {
    const workspace = this.activeWorkspace;
    const all = panes(workspace.layout);
    if (all.length < 2) return;
    const remembered =
      workspace.lastPaneId &&
      workspace.lastPaneId !== workspace.focusedPaneId &&
      all.some((pane) => pane.id === workspace.lastPaneId)
        ? workspace.lastPaneId
        : null;
    const next = remembered ?? stepPane(workspace.layout, workspace.focusedPaneId, 1);
    if (next) this.focusPane(next);
  }

  /** prefix+hjkl. Returns false when there is nothing that way — the client
   * turns that into focusing the sidebar. */
  focusDirection(dir: Direction): boolean {
    const workspace = this.activeWorkspace;
    const next = paneInDirection(workspace.layout, workspace.focusedPaneId, dir);
    if (!next) return false;
    this.focusPane(next);
    return true;
  }

  stepFocus(delta: number): void {
    const workspace = this.activeWorkspace;
    const next = stepPane(workspace.layout, workspace.focusedPaneId, delta);
    if (next) this.focusPane(next);
  }

  /**
   * Divide a pane, and say which pane appeared. Null when there was no such pane
   * to divide — a client whose snapshot is a workspace behind can ask for one,
   * and the caller opens a terminal in what comes back, which must not be a pane
   * id that was never put in the tree.
   */
  split(dir: "row" | "col", paneId = this.focusedPaneId): string | null {
    if (!findPane(this.activeWorkspace.layout, paneId)) return null;
    const fresh = makePane(id("n"));
    this.mutateWorkspace(this.activeWorkspace.id, (w) => ({
      ...w,
      layout: split(w.layout, paneId, dir, id("s"), fresh),
      focusedPaneId: fresh.pane.id,
      // The half you split is where "back" means, the same as if you had
      // focused the new pane yourself — which on a phone is the whole gesture:
      // split, and then flip between the two.
      lastPaneId: paneId,
    }));
    return fresh.pane.id;
  }

  /** prefix+r then hjkl: move the divider the focused pane's edge sits against. */
  nudge(dir: Direction, delta: number): void {
    const workspace = this.activeWorkspace;
    this.mutateWorkspace(workspace.id, (w) => ({
      ...w,
      layout: nudge(w.layout, w.focusedPaneId, dir, delta),
    }));
  }

  setRatio(splitId: string, ratio: number): void {
    this.mutateWorkspace(this.activeWorkspace.id, (w) => ({
      ...w,
      layout: setRatio(w.layout, splitId, ratio),
    }));
  }

  /**
   * Close a pane, and say which terminals went with it.
   *
   * A pane is where its tabs live, so closing one ends them — that is what makes
   * a tab a tab rather than a bookmark. The caller kills what comes back; this
   * file never touches a pty.
   */
  closePane(paneId = this.focusedPaneId): string[] {
    const workspace = this.activeWorkspace;
    const pane = findPane(workspace.layout, paneId);
    if (!pane) return [];
    const next = closePane(workspace.layout, paneId);
    // The last pane of a workspace is emptied rather than removed: a workspace
    // with no panes has nothing to focus and nothing to aim an action at.
    if (next === null) {
      this.mutateWorkspace(workspace.id, (w) => ({
        ...w,
        layout: updatePane(w.layout, paneId, (p) => ({ ...p, agentIds: [], activeIdx: 0 })),
      }));
      return pane.agentIds;
    }
    this.mutateWorkspace(workspace.id, (w) => ({
      ...w,
      layout: next,
      focusedPaneId: w.focusedPaneId === paneId ? panes(next)[0]!.id : w.focusedPaneId,
    }));
    return pane.agentIds;
  }

  addTab(agentId: string, cwd: string, paneId = this.focusedPaneId): void {
    this.mutateWorkspace(this.activeWorkspace.id, (w) => ({
      ...w,
      layout: addTab(w.layout, paneId, agentId, cwd),
    }));
  }

  /**
   * Take a terminal out of the layout, wherever it is — including a workspace
   * or profile you are not looking at, which is where an agent that exited on
   * its own has to be reachable from.
   */
  removeTab(agentId: string): void {
    for (const profile of this.profiles) {
      for (const workspace of profile.workspaces) {
        if (!paneWithAgent(workspace.layout, agentId)) continue;
        this.mutate(profile.id, workspace.id, (w) => ({ ...w, layout: removeTab(w.layout, agentId) }));
      }
    }
  }

  selectTab(paneId: string, index: number): void {
    this.mutateWorkspace(this.activeWorkspace.id, (w) => ({
      ...w,
      layout: selectTab(w.layout, paneId, index),
    }));
  }

  cycleTab(delta: number, paneId = this.focusedPaneId): void {
    this.mutateWorkspace(this.activeWorkspace.id, (w) => ({
      ...w,
      layout: cycleTab(w.layout, paneId, delta),
    }));
  }

  /**
   * Put a terminal in a pane — the same call whether it came from that pane's
   * own strip, the pane next door, another workspace entirely, or the sidebar.
   *
   * A pane emptied by the move is closed, unless it is the only one left. That
   * is what makes dragging feel like rearranging rather than like leaving holes:
   * a pane you have just taken the last tab out of is not a place, it is a gap.
   * An empty pane you made *deliberately* — a fresh split — is untouched, which
   * is why this is here and not a general sweep of the tree.
   */
  moveTab(agentId: string, toPaneId: string, index?: number): void {
    const workspace = this.activeWorkspace;
    if (!findPane(workspace.layout, toPaneId)) return;
    const source = paneWithAgent(workspace.layout, agentId);

    if (source) {
      this.mutateWorkspace(workspace.id, (w) => ({
        ...w,
        layout: moveTabTo(w.layout, agentId, toPaneId, index),
      }));
    } else {
      // It was somewhere else in this profile; take it out of there first.
      this.removeTab(agentId);
      this.mutateWorkspace(workspace.id, (w) => ({
        ...w,
        layout: addTab(w.layout, toPaneId, agentId),
      }));
      if (index !== undefined) {
        const pane = findPane(this.activeWorkspace.layout, toPaneId);
        if (pane) this.mutateWorkspace(this.activeWorkspace.id, (w) => ({
          ...w,
          layout: moveTabTo(w.layout, agentId, toPaneId, index),
        }));
      }
    }
    this.pruneEmptied(source?.id, toPaneId);
    this.focusPane(toPaneId);
  }

  /** Two panes change places, contents and all. The focus goes with the pane. */
  swapPanes(paneId: string, withPaneId: string): void {
    this.mutateWorkspace(this.activeWorkspace.id, (w) => ({
      ...w,
      layout: swapPanes(w.layout, paneId, withPaneId),
    }));
  }

  /** A whole pane, dropped on another pane's edge: it moves to that side of it. */
  movePane(paneId: string, toPaneId: string, dir: "row" | "col", before: boolean): void {
    this.mutateWorkspace(this.activeWorkspace.id, (w) => ({
      ...w,
      layout: movePaneTo(w.layout, paneId, toPaneId, dir, before, nextId("s")),
      focusedPaneId: paneId,
    }));
  }

  /** A whole pane, dropped on another pane's tab strip: its tabs go in there. */
  mergePanes(paneId: string, intoPaneId: string): void {
    this.mutateWorkspace(this.activeWorkspace.id, (w) => ({
      ...w,
      layout: mergePanes(w.layout, paneId, intoPaneId),
      focusedPaneId: intoPaneId,
    }));
  }

  /** Drop on a pane's edge: divide it and put the terminal in the new half. */
  splitWith(agentId: string, paneId: string, dir: "row" | "col", before: boolean): void {
    const workspace = this.activeWorkspace;
    if (!findPane(workspace.layout, paneId)) return;
    const source = paneWithAgent(workspace.layout, agentId);
    const fresh = makePane(nextId("n"));

    if (!source) {
      // From another workspace: it has to be in this tree before it can be split out.
      this.removeTab(agentId);
      this.mutateWorkspace(workspace.id, (w) => ({
        ...w,
        layout: addTab(w.layout, paneId, agentId),
      }));
    }
    this.mutateWorkspace(this.activeWorkspace.id, (w) => ({
      ...w,
      layout: splitWith(w.layout, agentId, paneId, dir, before, nextId("s"), fresh),
      focusedPaneId: fresh.pane.id,
    }));
    this.pruneEmptied(source?.id, fresh.pane.id);
  }

  /** Send a terminal to another workspace, into whatever pane has focus there. */
  moveTabToWorkspace(agentId: string, workspaceId: string): void {
    const profile = this.active;
    const target = profile.workspaces.find((w) => w.id === workspaceId);
    if (!target || paneWithAgent(target.layout, agentId)) return;
    const source = this.activeWorkspace;
    const from = paneWithAgent(source.layout, agentId);

    this.removeTab(agentId);
    this.mutate(profile.id, workspaceId, (w) => ({
      ...w,
      layout: addTab(w.layout, w.focusedPaneId, agentId),
    }));
    if (from) this.pruneEmptied(from.id, undefined);
  }

  /**
   * Close a pane a move has just emptied. Never the one that was dropped into,
   * and never the last pane in the workspace — an empty workspace has nothing to
   * focus and nothing to aim an action at.
   */
  private pruneEmptied(paneId: string | undefined, keep: string | undefined): void {
    if (!paneId || paneId === keep) return;
    const workspace = this.activeWorkspace;
    const pane = findPane(workspace.layout, paneId);
    // A reader holds no terminals and is not therefore a hole: it is a pane
    // somebody asked for, showing something, and closing it because a tab left
    // the pane next door would be the opposite of what the drag meant.
    if (!pane || pane.reader || pane.agentIds.length > 0) return;
    if (panes(workspace.layout).length < 2) return;
    this.closePane(paneId);
  }

  // -------------------------------------------------------------------------
  // The reader
  // -------------------------------------------------------------------------

  /**
   * Put a reader beside this pane, following this terminal's editor.
   *
   * It splits rather than taking the pane over, because the pane you asked from
   * is the one with the editor in it. Focus is handed back to where it was
   * afterwards — `split` moves it to what it made, which is right for a split
   * you are going to type into and wrong for one you are going to read.
   *
   * Asking twice finds the reader you already have rather than making a second
   * one. A key that makes a pane has to be safe to lean on, and two readers of
   * one editor would both be correct and both be in the way.
   */
  openReader(paneId: string, agentId: string | null, root = ""): string | null {
    if (agentId) {
      const existing = panes(this.activeWorkspace.layout).find((pane) => pane.reader?.follow === agentId);
      if (existing) {
        this.focusPane(existing.id);
        return existing.id;
      }
    }
    const source = findPane(this.activeWorkspace.layout, paneId);
    if (!source) return null;
    if (source.reader) {
      this.setReaderFollow(source.id, agentId);
      return source.id;
    }
    const made = this.split("row", paneId);
    if (!made) return null;
    this.mutateWorkspace(this.activeWorkspace.id, (w) => ({
      ...w,
      layout: updatePane(w.layout, made, (pane) => ({
        ...pane,
        /**
         * The root is carried in at birth, empty and meaning "not known yet"
         * when the caller could not work one out. It is what the picker opens
         * on, and a reader that knows which project it is for before it knows
         * which file is the difference between one tap and two. Nothing here
         * learns what a root *is* — this stores the string it was handed, the
         * way `setReaderTarget` already does.
         */
        reader: { root, path: "", follow: agentId, rev: 0 },
      })),
      focusedPaneId: paneId,
    }));
    return made;
  }

  private setReaderFollow(paneId: string, agentId: string | null): void {
    this.mutateWorkspace(this.activeWorkspace.id, (w) => ({
      ...w,
      layout: updatePane(w.layout, paneId, (pane) =>
        pane.reader ? { ...pane, reader: { ...pane.reader, follow: agentId } } : pane,
      ),
    }));
  }

  /**
   * Stop following, or start again. Pinning keeps the file that is showing;
   * unpinning takes whatever the editor says next.
   */
  pinReader(paneId: string, follow: boolean): void {
    const pane = findPane(this.activeWorkspace.layout, paneId);
    if (!pane?.reader) return;
    this.setReaderFollow(paneId, follow ? (pane.reader.follow ?? null) : null);
  }

  /**
   * Point a reader at a file somebody picked, and stop following.
   *
   * The two halves are one gesture rather than two calls a caller could make
   * separately, because a hand-picked file that an editor can still replace is
   * the bug this exists to avoid, not a configuration. In the active workspace
   * only: a pick comes from a pane on somebody's screen, unlike an editor's
   * report, which arrives for whatever workspace the reader happens to be in.
   */
  openDoc(paneId: string, root: string, path: string): boolean {
    if (!this.setReaderTarget(this.activeWorkspace.id, paneId, root, path)) return false;
    this.setReaderFollow(paneId, null);
    return true;
  }

  /**
   * Every reader following this terminal, anywhere.
   *
   * Across all profiles and all workspaces, not just the one on screen. An
   * editor goes on saying where it is whether or not you are looking at the
   * workspace its reader is in, and a reader that only kept up while visible
   * would be showing the wrong file the moment you came back to it.
   */
  readersFollowing(agentId: string): { workspaceId: string; paneId: string }[] {
    const found: { workspaceId: string; paneId: string }[] = [];
    for (const profile of this.profiles) {
      for (const workspace of profile.workspaces) {
        for (const pane of panes(workspace.layout)) {
          if (pane.reader?.follow === agentId) found.push({ workspaceId: workspace.id, paneId: pane.id });
        }
      }
    }
    return found;
  }

  /**
   * Point a reader at a file, and say the file moved on.
   *
   * `rev` only advances when the target is unchanged, because it means "what you
   * have is stale" and a client that is being handed a different path already
   * knows that. Re-pointing at the same file is what a save looks like from
   * here, and it is the only reason this counts at all.
   */
  setReaderTarget(workspaceId: string, paneId: string, root: string, path: string): boolean {
    let changed = false;
    this.mutateWorkspace(workspaceId, (w) => ({
      ...w,
      layout: updatePane(w.layout, paneId, (pane) => {
        if (!pane.reader) return pane;
        const same = pane.reader.root === root && pane.reader.path === path;
        changed = true;
        return { ...pane, reader: { ...pane.reader, root, path, rev: same ? pane.reader.rev + 1 : 0 } };
      }),
    }));
    return changed;
  }

  /** The terminal a pane is showing, if any. */
  activeAgentIn(paneId: string): string | null {
    const pane = findPane(this.activeWorkspace.layout, paneId);
    return pane ? (pane.agentIds[pane.activeIdx] ?? null) : null;
  }

  /** The terminal the focused pane is showing, if any. */
  focusedAgent(): string | null {
    return this.activeAgentIn(this.focusedPaneId);
  }

  // -------------------------------------------------------------------------
  // Workspaces
  // -------------------------------------------------------------------------

  newWorkspace(name?: string): string {
    const profile = this.active;
    const workspace = this.blankWorkspace(name ?? `ws${profile.workspaces.length + 1}`);
    this.replaceProfile(profile.id, (p) => ({
      ...p,
      workspaces: [...p.workspaces, workspace],
      lastWorkspaceId: p.activeWorkspaceId,
      activeWorkspaceId: workspace.id,
    }));
    return workspace.id;
  }

  switchWorkspace(workspaceId: string): void {
    const profile = this.active;
    if (profile.activeWorkspaceId === workspaceId) return;
    if (!profile.workspaces.some((w) => w.id === workspaceId)) return;
    this.replaceProfile(profile.id, (p) => ({
      ...p,
      lastWorkspaceId: p.activeWorkspaceId,
      activeWorkspaceId: workspaceId,
    }));
  }

  /** prefix+z: back to where you came from, which makes it a toggle. */
  lastWorkspace(): void {
    const last = this.active.lastWorkspaceId;
    if (last) this.switchWorkspace(last);
  }

  /** prefix+N / prefix+P: along the list, wrapping. */
  stepWorkspace(delta: number): void {
    const profile = this.active;
    const at = profile.workspaces.findIndex((w) => w.id === profile.activeWorkspaceId);
    const next = profile.workspaces[(at + delta + profile.workspaces.length) % profile.workspaces.length];
    if (next) this.switchWorkspace(next.id);
  }

  /** prefix+1..9: the number the sidebar prints beside each workspace. */
  switchWorkspaceByIndex(index: number): void {
    const workspace = this.active.workspaces[index];
    if (workspace) this.switchWorkspace(workspace.id);
  }

  renameWorkspace(workspaceId: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.mutate(this.activeId, workspaceId, (w) => ({ ...w, name: trimmed }));
  }

  /**
   * Tag it, or untag it with null. Anything that is not a name from the palette
   * is dropped rather than stored: the value is written into a style attribute
   * at the other end, and the only thing standing between that and a client on
   * the tailnet is this check.
   */
  setWorkspaceColor(workspaceId: string, color: unknown): void {
    if (color !== null && !isWorkspaceColor(color)) return;
    this.mutate(this.activeId, workspaceId, (w) => ({ ...w, color }));
  }

  /**
   * A workspace of the active profile, by id. For the verbs that act on a row
   * of the sidebar rather than on wherever the focus is.
   */
  workspaceById(workspaceId: string): Workspace | null {
    return this.active.workspaces.find((w) => w.id === workspaceId) ?? null;
  }

  /** Every terminal in a named workspace of the active profile. */
  agentsInWorkspace(workspaceId: string): string[] {
    const workspace = this.workspaceById(workspaceId);
    return workspace ? panes(workspace.layout).flatMap((pane) => pane.agentIds) : [];
  }

  /**
   * Put a terminal in a named workspace, in whatever pane has focus there —
   * `moveTabToWorkspace` without the moving, for a tab that has just been
   * opened. It does not switch workspace: this is how a dev server comes back up
   * somewhere you are not looking.
   */
  addTabTo(workspaceId: string, agentId: string, cwd: string): void {
    const profile = this.active;
    if (!profile.workspaces.some((w) => w.id === workspaceId)) return;
    this.mutate(profile.id, workspaceId, (w) => ({
      ...w,
      layout: addTab(w.layout, w.focusedPaneId, agentId, cwd),
    }));
  }

  /**
   * Note what a terminal is serving, on the workspace it is in — wherever that
   * is, including a profile nobody is looking at.
   *
   * Called from the dev-server scan, which runs every three seconds, so it
   * compares before it writes: every mutation here pushes a snapshot to every
   * client and schedules a write to disk, and re-noting the same command twenty
   * times a minute would do both for nothing.
   */
  rememberDev(agentId: string, dev: WorkspaceDev): void {
    for (const profile of this.profiles) {
      for (const workspace of profile.workspaces) {
        if (!paneWithAgent(workspace.layout, agentId)) continue;
        const had = workspace.dev;
        if (had && had.command === dev.command && had.cwd === dev.cwd && had.agentId === dev.agentId) {
          return;
        }
        this.mutate(profile.id, workspace.id, (w) => ({ ...w, dev }));
        return;
      }
    }
  }

  /**
   * Point a workspace at one of the saved mascots, or at nothing, which means
   * the default.
   *
   * Nothing checks that the id names a mascot, and that is deliberate rather
   * than lax: this module knows about layouts, not about sprite sheets, and an
   * id that names nothing already draws the default — so a check here would buy
   * a refusal where the fallback is the same answer, and would need this file to
   * learn about a second subject to do it.
   */
  setWorkspaceMascot(workspaceId: string, mascotId: string | null): void {
    const id = typeof mascotId === "string" && mascotId ? mascotId : null;
    this.mutate(this.activeId, workspaceId, (w) => ({ ...w, mascotId: id }));
  }

  /**
   * Borrow another profile's accounts for this workspace, or null to hand it
   * back to the profile it lives in.
   *
   * The one check is that the profile exists *now*, and it is not the check the
   * fallback relies on — a profile deleted afterwards leaves an id that resolves
   * to nothing and reads as null, which is the same answer. It is here because
   * an id that named nothing on arrival is a client with a stale list, and
   * storing it would draw a badge in the sidebar for a profile that is gone.
   */
  setWorkspaceIdentity(workspaceId: string, profileId: string | null): void {
    if (profileId !== null && !this.profiles.some((p) => p.id === profileId)) return;
    this.mutate(this.activeId, workspaceId, (w) => ({ ...w, identityProfileId: profileId }));
  }

  /**
   * Whose accounts a terminal opened in this workspace belongs to.
   *
   * The active profile's, unless the workspace has borrowed somebody else's —
   * which is the whole of the mixing feature, and it is one lookup because the
   * override is a pointer rather than a copy. Both fallbacks land on the same
   * place: a workspace nobody has heard of and one naming a profile that has
   * since been deleted are both "the profile you are in", which is what kururu
   * did before any of this existed.
   */
  identityForWorkspace(workspaceId: string): ProfileIdentity {
    const borrowed = this.workspaceById(workspaceId)?.identityProfileId;
    if (!borrowed) return this.active.identity;
    return this.profiles.find((p) => p.id === borrowed)?.identity ?? this.active.identity;
  }

  /** Deletes it and says what was inside. The last workspace cannot be deleted. */
  deleteWorkspace(workspaceId: string): string[] {
    const profile = this.active;
    if (profile.workspaces.length < 2) return [];
    const doomed = profile.workspaces.find((w) => w.id === workspaceId);
    if (!doomed) return [];
    const agents = panes(doomed.layout).flatMap((pane) => pane.agentIds);
    const workspaces = profile.workspaces.filter((w) => w.id !== workspaceId);
    this.replaceProfile(profile.id, (p) => ({
      ...p,
      workspaces,
      activeWorkspaceId: p.activeWorkspaceId === workspaceId ? workspaces[0]!.id : p.activeWorkspaceId,
      lastWorkspaceId: p.lastWorkspaceId === workspaceId ? null : p.lastWorkspaceId,
    }));
    return agents;
  }

  /** Dragged up or down the sidebar list, to a position rather than by a step. */
  moveWorkspace(workspaceId: string, index: number): void {
    const profile = this.active;
    const at = profile.workspaces.findIndex((w) => w.id === workspaceId);
    const to = Math.max(0, Math.min(index, profile.workspaces.length - 1));
    if (at === -1 || at === to) return;
    const workspaces = [...profile.workspaces];
    const [moved] = workspaces.splice(at, 1);
    workspaces.splice(to, 0, moved!);
    this.replaceProfile(profile.id, (p) => ({ ...p, workspaces }));
  }

  // -------------------------------------------------------------------------
  // Profiles
  // -------------------------------------------------------------------------

  newProfile(name: string): string {
    const profile = this.blankProfile(name.trim() || `profile ${this.profiles.length + 1}`);
    this.profiles = [...this.profiles, profile];
    this.activeId = profile.id;
    this.onChange();
    return profile.id;
  }

  switchProfile(profileId: string): void {
    if (profileId === this.activeId) return;
    if (!this.profiles.some((p) => p.id === profileId)) return;
    this.activeId = profileId;
    this.onChange();
  }

  renameProfile(profileId: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.profiles = this.profiles.map((p) => (p.id === profileId ? { ...p, name: trimmed } : p));
    this.onChange();
  }

  /**
   * Point a profile's terminals at a different set of accounts.
   *
   * Any profile, not just the active one — Settings shows them all at once, and
   * having to switch profile to describe one would make filling in a form a
   * thing you do by standing somewhere. It touches nothing that is running:
   * `ProfileIdentity` is read when a pty is spawned, so this is a statement
   * about the next terminal.
   */
  setProfileIdentity(profileId: string, identity: ProfileIdentity): void {
    if (!this.profiles.some((p) => p.id === profileId)) return;
    this.profiles = this.profiles.map((p) => (p.id === profileId ? { ...p, identity } : p));
    this.onChange();
  }

  /**
   * Who a profile is, for the endpoint that asks the tools about it. Blank for
   * an id nobody has: an unknown profile and one that has claimed nobody are the
   * same answer, which is the machine exactly as it stands.
   */
  identityOf(profileId: string): ProfileIdentity {
    return this.profiles.find((p) => p.id === profileId)?.identity ?? blankIdentity();
  }

  /**
   * Delete a profile and say what it was running. The last one cannot go — there
   * is always somewhere to be.
   */
  deleteProfile(profileId: string): string[] {
    if (this.profiles.length < 2) return [];
    const doomed = this.profiles.find((p) => p.id === profileId);
    if (!doomed) return [];
    const agents = this.agentsIn(profileId);
    this.profiles = this.profiles.filter((p) => p.id !== profileId);
    if (this.activeId === profileId) this.activeId = this.profiles[0]!.id;
    this.onChange();
    return agents;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private blankWorkspace(name: string): Workspace {
    const pane = makePane(id("n"));
    return {
      id: id("w"),
      name,
      layout: pane,
      focusedPaneId: pane.pane.id,
      lastPaneId: null,
      color: null,
      mascotId: null,
      identityProfileId: null,
      dev: null,
    };
  }

  private blankProfile(name: string): Profile {
    const workspace = this.blankWorkspace("main");
    return {
      id: id("p"),
      name,
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      lastWorkspaceId: null,
      // Nobody in particular. A new profile inherits nothing, on the same
      // reasoning as a new workspace's null colour: a default copied at
      // creation is a default that stops following the machine.
      identity: blankIdentity(),
    };
  }

  private replaceProfile(profileId: string, fn: (profile: Profile) => Profile): void {
    this.profiles = this.profiles.map((p) => (p.id === profileId ? fn(p) : p));
    this.onChange();
  }

  private mutate(profileId: string, workspaceId: string, fn: (w: Workspace) => Workspace): void {
    this.replaceProfile(profileId, (profile) => ({
      ...profile,
      workspaces: profile.workspaces.map((w) => (w.id === workspaceId ? this.repair(fn(w)) : w)),
    }));
  }

  private mutateWorkspace(workspaceId: string, fn: (w: Workspace) => Workspace): void {
    this.mutate(this.activeId, workspaceId, fn);
  }

  /**
   * The invariant a tree operation cannot keep on its own: the focused pane has
   * to exist. Closing one, or restoring a layout written by an older build, can
   * leave a focus pointing at nothing, and every "do it here" action would then
   * quietly do nothing at all.
   */
  private repair(workspace: Workspace): Workspace {
    const all = panes(workspace.layout);
    if (all.some((pane: PaneState) => pane.id === workspace.focusedPaneId)) return workspace;
    return { ...workspace, focusedPaneId: all[0]!.id };
  }
}

export type { LayoutNode };
