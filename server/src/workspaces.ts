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
import type { Profile, ProfileSummary, Workspace } from "../../shared/model";
import { isWorkspaceColor } from "../../shared/model";
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
    workspaces: profile.workspaces.map((workspace) => ({
      ...workspace,
      color: isWorkspaceColor(workspace.color) ? workspace.color : null,
    })),
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
    this.mutateWorkspace(workspace.id, (w) => ({ ...w, focusedPaneId: paneId }));
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
    if (!pane || pane.agentIds.length > 0) return;
    if (panes(workspace.layout).length < 2) return;
    this.closePane(paneId);
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
    return { id: id("w"), name, layout: pane, focusedPaneId: pane.pane.id, color: null };
  }

  private blankProfile(name: string): Profile {
    const workspace = this.blankWorkspace("main");
    return {
      id: id("p"),
      name,
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      lastWorkspaceId: null,
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
