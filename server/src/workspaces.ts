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
import type { Profile, ProfileSummary, Workspace, WorkspaceColor } from "../../shared/model";
import { isLoginKey, isWorkspaceColor, mintLoginKey, WORKSPACE_COLORS } from "../../shared/model";
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
 * Start the counter above every id an arrangement already contains.
 *
 * The comment above was true of one of the two ways a layout comes back and not
 * of the other, which is the whole bug. `persist.ts` rebuilds a stored tree by
 * *minting* every id through `nextId` — the file deliberately holds no ids at
 * all — so after a disk restore the counter is already past everything it made.
 * The host's blob is the opposite: it is the arrangement exactly as the previous
 * server left it, ids and all, and it is handed straight to the constructor
 * because that is the point of it. A new process starts at zero with `w2`, `n1`
 * and `p1` already live, and the next split mints an id something is using.
 *
 * Cheap to miss and expensive to have. Nothing complains, because a duplicate is
 * a perfectly good string; the symptom is that two panes in one workspace answer
 * to one id and `findPane` returns whichever comes first, so focusing, closing
 * or selecting a tab quietly acts on the wrong one. And because a restart is
 * *free* in kururu — the whole design of the three-process split — this is not a
 * rare event but one that happens every time the server is saved.
 *
 * A high-water mark rather than a set of taken ids, because the four prefixes
 * share one counter: the largest number in use is the only thing worth knowing,
 * and stepping past it makes every future id unique whatever it is prefixed
 * with. Ids this did not mint are left exactly as they are — renaming them would
 * mean remapping `focusedPaneId`, `activeWorkspaceId` and the rest, which is a
 * silent rewrite of somebody's live arrangement to repair something that is by
 * construction only a problem for ids that have not been handed out yet.
 */
function adoptSeq(profiles: Profile[]): void {
  const mark = (value: string): void => {
    // Trailing digits, so anything a hand-edited blob might hold is ignored
    // rather than turning the counter into NaN and every id after it into
    // `nundefined`.
    const n = Number(/(\d+)$/.exec(value)?.[1]);
    if (Number.isFinite(n) && n > seq) seq = n;
  };
  const walk = (node: LayoutNode): void => {
    if (node.type === "pane") {
      mark(node.pane.id);
      return;
    }
    mark(node.id);
    walk(node.a);
    walk(node.b);
  };
  for (const profile of profiles) {
    mark(profile.id);
    for (const workspace of profile.workspaces) {
      mark(workspace.id);
      walk(workspace.layout);
    }
  }
}

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
    // The one field in here that is minted rather than nulled when it is
    // missing, and the reason is in `Profile.loginKey`: a profile from before
    // it existed has no logins of its own yet, and a fresh key says exactly
    // that. Checked rather than trusted, because it becomes a path.
    loginKey: isLoginKey(profile.loginKey) ? profile.loginKey : mintLoginKey(),
    // Read as defensively as everything else out of a blob: this one is a list
    // rather than a field, so a hand-edited or older blob could
    // put anything in it. Anything that is not a string is dropped instead of
    // being carried as an id that matches no terminal.
    agentOrder: Array.isArray(profile.agentOrder)
      ? profile.agentOrder.filter((id): id is string => typeof id === "string")
      : [],
    // The same reading, for the same reason: a list out of a blob an older
    // server wrote, where absent is the normal case rather than the odd one.
    hiddenAgents: Array.isArray(profile.hiddenAgents)
      ? profile.hiddenAgents.filter((id): id is string => typeof id === "string")
      : [],
    // `dev` is taken off rather than carried: a blob written while workspaces
    // remembered a dev command still has one, and a field the type no longer
    // names would ride along into every snapshot and back out to disk.
    workspaces: profile.workspaces.map(({ dev: _dev, ...workspace }: Workspace & { dev?: unknown }) => ({
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
    })),
  };
}

/**
 * A profile's terminals in the order the sidebar draws them.
 *
 * `ids` is the list as the pty host holds it, which is spawn order and is the
 * default; `order` is what somebody has dragged, which is a memory of a gesture
 * and not a list of what exists. So the two are merged rather than one
 * replacing the other: remembered positions first, then everything spawned
 * since, in the order it arrived. An id in `order` that names nothing is simply
 * skipped — a terminal that has been killed leaves its id behind, and pruning
 * the list on every snapshot to tidy that up would be a write per status tick
 * to reach the answer this already gives.
 *
 * Pure, and exported for the test, because it is the one decision in here: both
 * the snapshot and a drop reconcile through it, and a drop that landed against a
 * different order than the one on screen would put the row somewhere nobody
 * pointed at.
 */
/**
 * A colour for a workspace that is about to exist, given the ones its profile is
 * already wearing.
 *
 * Random, but not blind: it counts what is taken and draws from the colours that
 * are used least, so the first fourteen workspaces in a profile are fourteen
 * different colours and the fifteenth is the first repeat. Blind random is the
 * version that was obviously right and is obviously wrong the moment you look at
 * it — with fourteen colours and four workspaces it collides about a third of
 * the time, and two rows the same colour is worse than two rows with no colour
 * at all, because the second says nothing and the first says something false.
 *
 * Random *within* the least-used set rather than the next one along, because the
 * alternative is an order: make four workspaces and they are green, amber, sand,
 * coral in every profile on every machine, which reads as a sequence rather than
 * as a tag and invites somebody to look for a meaning in it.
 *
 * Untagged workspaces are counted as nothing at all rather than as a colour, so
 * a profile of workspaces somebody deliberately cleared does not push the next
 * one anywhere in particular.
 */
export function nextColor(taken: Iterable<WorkspaceColor | null>): WorkspaceColor {
  const used = new Map<WorkspaceColor, number>(WORKSPACE_COLORS.map((c) => [c, 0]));
  for (const color of taken) {
    if (color === null) continue;
    used.set(color, (used.get(color) ?? 0) + 1);
  }
  const fewest = Math.min(...used.values());
  const free = WORKSPACE_COLORS.filter((c) => used.get(c) === fewest);
  return free[Math.floor(Math.random() * free.length)] ?? WORKSPACE_COLORS[0];
}

export function orderAgents(ids: string[], order: string[]): string[] {
  const present = new Set(ids);
  const placed = new Set<string>();
  const out: string[] = [];
  for (const id of order) {
    if (!present.has(id) || placed.has(id)) continue;
    out.push(id);
    placed.add(id);
  }
  for (const id of ids) {
    if (placed.has(id)) continue;
    out.push(id);
    placed.add(id);
  }
  return out;
}

export type ChangeHandler = () => void;

export class Workspaces {
  private profiles: Profile[] = [];
  private activeId: string;

  /**
   * Called after anything here changes. The server pushes a snapshot; `persist.ts`
   * writes the structure. Both are debounced by their own callers — this fires on
   * every mutation and does not care how often that is.
   */
  onChange: ChangeHandler = () => {};

  constructor(restored?: Profile[]) {
    // Before anything is minted, which is the whole of it — `blankProfile` below
    // is the first thing that would collide. Here rather than in `attach()` so
    // that every road a restored arrangement can arrive by is covered by
    // construction, including the disk one, where it is a no-op because
    // `persist.ts` has already walked the counter past what it made.
    if (restored?.length) adoptSeq(restored);
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

  /**
   * For the switcher: every profile, with enough to draw a row. Both answers
   * are the caller's — how many ptys are live is the host's to say, and where a
   * login directory is depends on a config path this file does not know.
   */
  summaries(
    liveAgents: (profileId: string) => number,
    loginDir: (loginKey: string) => string,
  ): ProfileSummary[] {
    return this.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      workspaces: profile.workspaces.length,
      agents: liveAgents(profile.id),
      loginDir: loginDir(profile.loginKey),
      loginKey: profile.loginKey,
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
   * Where a terminal is, by the names a person would use for it.
   *
   * For a notification, which has to say where it came from — "the agent in
   * `work · api` finished" is a card you can act on and "an agent finished" is
   * one you have to go looking behind. Names rather than ids because it is read
   * by a human on a lock screen, and null when nothing holds the agent, which is
   * the moment between a pty starting and a tab being made for it.
   */
  placeOf(agentId: string): { profile: string; workspace: string } | null {
    for (const profile of this.profiles) {
      for (const workspace of profile.workspaces) {
        if (paneWithAgent(workspace.layout, agentId)) {
          return { profile: profile.name, workspace: workspace.name };
        }
      }
    }
    return null;
  }

  /**
   * Go to a terminal, wherever in the hierarchy it is: its profile, its
   * workspace, its pane, its tab.
   *
   * One method rather than four calls from `index.ts`, because the four are only
   * correct in this order and against one state. Switching the profile first is
   * what makes the three after it mean anything — `focusPane` and `selectTab`
   * both act on `activeWorkspace`, so a pane focused before the workspace change
   * would be focused in the workspace being left.
   *
   * It is `switchProfile`/`switchWorkspace` rather than anything new, so the
   * *way back* is recorded exactly as it is for a switch somebody made by hand:
   * `lastWorkspaceId` is written, and prefix+z after chasing a notification
   * takes you back to what you were doing. That is not a detail — being taken
   * somewhere by a card is precisely when you want the way back to still work.
   *
   * False when nothing holds that agent, which the caller wants: it is a
   * notification clicked after the terminal it was about has been closed, and
   * the honest answer is to do nothing rather than to move somebody somewhere
   * arbitrary.
   */
  reveal(agentId: string): boolean {
    for (const profile of this.profiles) {
      for (const workspace of profile.workspaces) {
        const pane = paneWithAgent(workspace.layout, agentId);
        if (!pane) continue;
        this.switchProfile(profile.id);
        this.switchWorkspace(workspace.id);
        this.focusPane(pane.id);
        const index = pane.agentIds.indexOf(agentId);
        if (index >= 0) this.selectTab(pane.id, index);
        // Every one of those four returns early when it is already true, so a
        // card clicked for the tab you are looking at would change nothing and
        // announce nothing. Said once here instead: `pushSnapshot` coalesces on a
        // microtask, so the four that did fire and this one are still one message.
        this.onChange();
        return true;
      }
    }
    return false;
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

  /**
   * The same thing, for a terminal that ended on its own — and the pane goes
   * with it if that was the only thing in there.
   *
   * The difference from `removeTab` is who asked. Closing a tab is a gesture
   * aimed at the tab, so the pane it empties is a place somebody is keeping and
   * stays standing as the button that opens the next terminal. A pty that
   * *ended* is not a gesture about the pane at all: the reason the pane was
   * there has gone, and leaving it would mean rearranging accumulated holes —
   * which is exactly what `pruneEmptied` says about a pane a drag emptied. This
   * cannot call that one, because it is about the workspace you are looking at
   * and a terminal ends wherever it was left.
   *
   * Its two refusals are that one's, for the same reasons: never the last pane
   * of a workspace, which would leave nothing to focus and nothing to aim an
   * action at, and never a reader, which holds no terminals and is therefore
   * not a hole. `repair` moves the focus if the pane holding it went.
   */
  reapTab(agentId: string): void {
    for (const profile of this.profiles) {
      for (const workspace of profile.workspaces) {
        const pane = paneWithAgent(workspace.layout, agentId);
        if (!pane) continue;
        this.mutate(profile.id, workspace.id, (w) => {
          const layout = removeTab(w.layout, agentId);
          const emptied = findPane(layout, pane.id);
          if (!emptied || emptied.reader || emptied.agentIds.length > 0) return { ...w, layout };
          if (panes(layout).length < 2) return { ...w, layout };
          return { ...w, layout: closePane(layout, pane.id) ?? layout };
        });
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
   * Put a terminal somewhere else in the sidebar's list: immediately before
   * `beforeAgentId`, or last when that is null.
   *
   * It moves nothing. The list spans a whole profile while the layout is a tree
   * per workspace, so a row dropped between two rows of another workspace is
   * still in the workspace it was in — which is what its own row goes on saying.
   * Dragging one onto a *pane* or a *workspace row* is the gesture that moves it,
   * and those already exist.
   *
   * `ids` is the profile's terminals as the host holds them, passed in because
   * only the host knows that order and because the list on screen was drawn from
   * the same answer. See `orderAgents`.
   */
  reorderAgent(agentId: string, beforeAgentId: string | null, ids: string[]): void {
    if (agentId === beforeAgentId) return;
    const profileId = this.profileOf(agentId);
    const profile = profileId ? this.profiles.find((p) => p.id === profileId) : undefined;
    if (!profile) return;
    const current = orderAgents(ids, profile.agentOrder);
    if (!current.includes(agentId)) return;
    const next = current.filter((id) => id !== agentId);
    // A neighbour that is not in the list is the drop landing on a row that has
    // gone in the meantime, and the end is the honest answer: there is nothing
    // left to be above.
    const at = beforeAgentId ? next.indexOf(beforeAgentId) : -1;
    next.splice(at === -1 ? next.length : at, 0, agentId);
    this.replaceProfile(profile.id, (p) => ({ ...p, agentOrder: next }));
  }

  /**
   * Put a terminal away in the sidebar's list, or bring it back.
   *
   * It touches nothing but the list: no pty, no tab, no pane. The row goes into
   * the drawer at the foot of the list and everything else about that terminal
   * carries on, which is the whole of what makes this different from the ✕ it
   * sits beside.
   *
   * The profile is the one that *holds* the terminal rather than the active one,
   * so a row put away from a phone looking at another profile — which the list
   * cannot currently do, and nothing here should depend on it not doing — lands
   * in the right drawer.
   *
   * An id already in the list is not added twice and one that is not in it is
   * not an error to remove: both are what a second client's message looks like
   * arriving after the first one won, and neither is worth a refusal.
   */
  setAgentHidden(agentId: string, hidden: boolean): void {
    const profileId = this.profileOf(agentId);
    const profile = profileId ? this.profiles.find((p) => p.id === profileId) : undefined;
    if (!profile) return;
    const has = profile.hiddenAgents.includes(agentId);
    if (has === hidden) return;
    const next = hidden
      ? [...profile.hiddenAgents, agentId]
      : profile.hiddenAgents.filter((id) => id !== agentId);
    this.replaceProfile(profile.id, (p) => ({ ...p, hiddenAgents: next }));
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
    const workspace = this.blankWorkspace(name ?? `ws${profile.workspaces.length + 1}`, profile.workspaces);
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
   * Point a profile at a login: another key, or with null a fresh one nobody is
   * signed into. Which keys may be named is the caller's to decide, because it
   * takes a look at the disk to know — this only holds the key to its shape,
   * the way everything that becomes a path is. The directory the profile was
   * pointed at before stays where it is, like every login directory does, and
   * stays in the list for as long as somebody is signed into it.
   */
  setProfileLogin(profileId: string, loginKey: string | null): void {
    const key = loginKey === null ? mintLoginKey() : loginKey;
    if (!isLoginKey(key)) return;
    const profile = this.profiles.find((p) => p.id === profileId);
    if (!profile || profile.loginKey === key) return;
    this.replaceProfile(profileId, (p) => ({ ...p, loginKey: key }));
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

  /**
   * `taken` is the profile the workspace is being made in, for the colour. It is
   * a parameter rather than being read off `this.active` because the one caller
   * that cannot use the active profile is `blankProfile`, which is making the
   * profile that would be read — and a fresh profile has no workspaces, so the
   * honest argument there is an empty list rather than somebody else's palette.
   */
  private blankWorkspace(name: string, taken: readonly Workspace[]): Workspace {
    const pane = makePane(id("n"));
    return {
      id: id("w"),
      name,
      layout: pane,
      focusedPaneId: pane.pane.id,
      lastPaneId: null,
      color: nextColor(taken.map((w) => w.color)),
      mascotId: null,
    };
  }

  private blankProfile(name: string): Profile {
    const workspace = this.blankWorkspace("main", []);
    return {
      id: id("p"),
      name,
      loginKey: mintLoginKey(),
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      lastWorkspaceId: null,
      // Nothing has been dragged yet, which is spawn order — see `orderAgents`.
      agentOrder: [],
      // And nothing has been put away, because nothing is running in it yet.
      hiddenAgents: [],
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
