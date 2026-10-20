/**
 * Another node's things, as this one names them: the grammar of a qualified
 * id, which node a client's verb is for, and the child's workspace rewritten
 * so that nothing in it can be mistaken for something of this machine's.
 *
 * It exists because two kururus both mint `a237`. The Mac's window draws a
 * child's workspace with the components it draws its own with, and those
 * pool emulators, look up agents and send verbs by id — so a child's ids
 * have to be spelt so that no `a237` of the child's can ever be read as the
 * Mac's, on the wire or in the pool. A remote thing is `n:<node>:<id>`, and
 * this file is the only place that prefix is spelt (see
 * `docs/plans/remote-workspaces.md#ids-and-the-one-grammar`).
 *
 * What is qualified: agents (the terminal tabs), panes, splits, the
 * workspace itself, and **every root of the child's disk** — a document
 * tab's, a reader's, a project's, a made file's. A root is the one thing in
 * a verb that says which disk a path is on, so a path from the child's tree
 * carries its node with it the way a pane id does, and a verb that pairs
 * one machine's file with the other's pane is refused here rather than
 * opening a different file, or none (phase 2). What is not qualified, and
 * why:
 *
 * - **The board's tab and a document's tab as tabs.** `BOARD_TAB` is one
 *   per workspace and a document's tab is its address; neither names a
 *   thing that exists outside the pane it sits in, so each takes the side of
 *   the pane a verb names with it — a "neutral" id below. The root inside a
 *   document's address is qualified like any other root, and put back on
 *   the way out.
 * - **A card.** Every verb about a card names its workspace too, and the
 *   workspace is what says where the card lives; a card's random id cannot
 *   collide with a local one in any way that matters, since nothing looks a
 *   card up without its workspace. Qualifying it would be a second spelling
 *   of a fact the workspace already carries. A card's run and dev server
 *   name agents, and those are qualified like every other agent.
 *
 * The other half of the rule is that a qualified id is **never written**:
 * not into `session.json`, the host's blob, the database or `made.json`.
 * Nothing here writes anything; `containsQualified` is what the test that
 * holds the rule looks for.
 *
 * Pure, in `shared/`, because the server routes with it and the client
 * draws with it, and because every rule in it is one worth a test.
 */
import { BOARD_TAB, docTab, isBoardTab, isDocTab, panes, parseDocTab, terminalsOf, type LayoutNode, type ReaderState } from "./layout";
import type { MadeFile } from "./made";
import type { AgentSnapshot, AgentStatus, Profile, Workspace } from "./model";
import { allNeeds, type Need, type ProfileNeeds } from "./needs";
import type { NodeStatus, NodeSummary, SummaryNeed } from "./nodes";
import { isNotifyEvent, type NotifyEvent } from "./notify";
import { WORKSPACE_COLORS, type WorkspaceColor } from "./model";
import type { ClientMessage, WorkspaceProject } from "./wire";
import { adoptLaunchers, visibleLaunchers, type Launcher, type LaunchSettings } from "./launchers";

const PREFIX = "n:";
/** A node id is `n` and twelve hex digits (`shared/nodes.ts`), and the local part follows its colon. */
const QUALIFIED = /^n:(n[0-9a-f]{12}):(.+)$/s;
/** The same, anywhere in a text: what a file on disk must never hold. */
const QUALIFIED_ANYWHERE = /n:n[0-9a-f]{12}:/;

/** `a7` on that node, as this one spells it. */
export function qualify(node: string, id: string): string {
  return `${PREFIX}${node}:${id}`;
}

/** The node and the node's own id, or null for anything of this machine's. */
export function parseRemote(id: unknown): { node: string; id: string } | null {
  if (typeof id !== "string") return null;
  const match = QUALIFIED.exec(id);
  return match ? { node: match[1]!, id: match[2]! } : null;
}

export function isRemote(id: unknown): boolean {
  return parseRemote(id) !== null;
}

/**
 * The id as its own node spells it: what a label or a tooltip shows, since
 * `n:n3f…:/home/omarchy/proj` is a spelling for the wire and the pool, and a
 * person reading the tree wants the folder.
 */
export function bareOf(id: string): string {
  return parseRemote(id)?.id ?? id;
}

/** Which node a qualified id belongs to, or null. */
export function nodeOfId(id: unknown): string | null {
  return parseRemote(id)?.node ?? null;
}

/** Whether a text — a file about to be written, an export — holds a qualified id anywhere. */
export function containsQualified(text: string): boolean {
  return QUALIFIED_ANYWHERE.test(text);
}

/**
 * The hue a node is drawn in: its band, its chips. One of the board
 * palette's names, so that it reaches the page as a token (`--ws-<name>`)
 * and every theme says what it looks like, and picked off the id so that
 * every window and every drawer agrees without a field on the wire.
 */
export function nodeHue(node: string): WorkspaceColor {
  let hash = 0;
  for (const ch of node) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return WORKSPACE_COLORS[hash % WORKSPACE_COLORS.length]!;
}

// ---------------------------------------------------------------------------
// The child's workspace, as the Mac draws it
// ---------------------------------------------------------------------------

/** A root of the child's disk, as the Mac spells it; "" — a reader that will ask which project — stays "". */
export function qualifyRoot(node: string, root: string): string {
  return root ? qualify(node, root) : root;
}

/** A tab, as the Mac spells it: a terminal qualified, the board as it is, a document with its root qualified. */
export function qualifyTab(node: string, tab: string): string {
  if (isBoardTab(tab)) return tab;
  if (isDocTab(tab)) {
    const doc = parseDocTab(tab);
    return doc ? docTab(qualifyRoot(node, doc.root), doc.path) : tab;
  }
  return qualify(node, tab);
}

/** A document's tab put back as its node spells it; anything else as it is. */
function bareTab(tab: unknown): unknown {
  const doc = parseDocTab(tab);
  const remote = doc ? parseRemote(doc.root) : null;
  return doc && remote ? docTab(remote.id, doc.path) : tab;
}

function qualifyReader(node: string, reader: ReaderState): ReaderState {
  const agent = (id: string | null): string | null => (id ? qualify(node, id) : id);
  return { ...reader, root: qualifyRoot(node, reader.root), follow: agent(reader.follow), editor: agent(reader.editor) };
}

function qualifyMade(node: string, made: MadeFile[] | undefined): MadeFile[] | undefined {
  return made?.map((file) => ({ ...file, root: qualifyRoot(node, file.root) }));
}

export function qualifyLayout(node: string, layout: LayoutNode): LayoutNode {
  if (layout.type === "pane") {
    const { pane } = layout;
    return {
      type: "pane",
      pane: {
        ...pane,
        id: qualify(node, pane.id),
        agentIds: pane.agentIds.map((tab) => qualifyTab(node, tab)),
        ...(pane.reader ? { reader: qualifyReader(node, pane.reader) } : {}),
      },
    };
  }
  return { ...layout, id: qualify(node, layout.id), a: qualifyLayout(node, layout.a), b: qualifyLayout(node, layout.b) };
}

/**
 * One of the child's workspaces with every id in it qualified, and nothing
 * else changed: the tree, the focus, the board and its runs. The machine
 * pin goes, because it names an entry in the child's own `vps.json` that
 * this node's list of machines knows nothing about.
 */
export function qualifyWorkspace(node: string, workspace: Workspace): Workspace {
  const agent = (id: string | null): string | null => (id ? qualify(node, id) : id);
  return {
    ...workspace,
    id: qualify(node, workspace.id),
    layout: qualifyLayout(node, workspace.layout),
    focusedPaneId: qualify(node, workspace.focusedPaneId),
    lastPaneId: workspace.lastPaneId ? qualify(node, workspace.lastPaneId) : null,
    machine: null,
    board: workspace.board
      ? {
          ...workspace.board,
          cards: workspace.board.cards.map((card) => ({
            ...card,
            run: card.run ? { ...card.run, agentId: agent(card.run.agentId) } : null,
            dev: card.dev ? { ...card.dev, agentId: agent(card.dev.agentId) } : null,
            ...(card.made ? { made: qualifyMade(node, card.made) } : {}),
          })),
        }
      : null,
  };
}

/** An agent of the child's, as the Mac's clients are told of it: what it made names the child's disk, and says so. */
export function qualifyAgent(node: string, agent: AgentSnapshot): AgentSnapshot {
  return { ...agent, id: qualify(node, agent.id), ...(agent.made ? { made: qualifyMade(node, agent.made) } : {}) };
}

/** Where one of the child's workspaces is, for the file tree: its workspace and every root qualified. */
export function qualifyProject(node: string, project: WorkspaceProject): WorkspaceProject {
  return { workspaceId: qualify(node, project.workspaceId), root: qualifyRoot(node, project.root), choices: project.choices.map((root) => qualifyRoot(node, root)) };
}

/** How the Mac's link to a watched node stands, as the panes draw it. */
export type RemoteState = "opening" | "up" | "away";

/**
 * Another node's workspace, on this screen: which one, the tree as the node
 * last said it with every id qualified, its agents, and whether the watch is
 * up. In `SessionSnapshot.remote` while one is on screen; the Mac's own
 * `profile` beside it is untouched and still says which local workspace is
 * active, which is where the window goes back to.
 */
export interface RemoteView {
  node: { id: string; name: string };
  /** The workspace by key, which survives the child's restarts; its counter id does not. */
  workspaceKey: string;
  state: RemoteState;
  /** When `state` began, for "away since 23:10". */
  since: number | null;
  /** Null until the child's first snapshot, or once the child no longer has that workspace. */
  workspace: Workspace | null;
  /** The agents of that workspace, qualified. */
  agents: AgentSnapshot[];
  /** The child's own launch settings. */
  launch: LaunchSettings | null;
  /** What a pane's `+` and a card's robot offer there: see `remoteLaunchers`. */
  launchers: Launcher[];
  /**
   * Where the workspace is on the child's disk, as the child's branch walk
   * found it, roots qualified — what the file tree opens on. Null until the
   * child has said, and from a child that cannot be read through the watch.
   */
  project: WorkspaceProject | null;
}

/**
 * The rows a remote workspace's `+` menu and its cards' robots offer: the
 * node's own, as its summary carries them (`NodeSummary.launchers`), since
 * the agent runs there and the id is looked up in the box's catalogue. A
 * node from before carries none, and gets this node's catalogue under its
 * own settings, which is what phase 1 offered; a version apart, a row the
 * box does not know is answered as its own phone would be answered.
 */
export function remoteLaunchers(summaryLaunchers: unknown, launch: LaunchSettings | null): Launcher[] {
  return adoptLaunchers(summaryLaunchers) ?? (launch ? visibleLaunchers(launch) : []);
}

// ---------------------------------------------------------------------------
// Which node a verb is for
// ---------------------------------------------------------------------------

/**
 * The verbs that may go to another node, and the fields of each that carry
 * ids. Everything not in here is this node's and nobody else's: settings,
 * profiles, keys, voice, the nodes themselves — a verb with no id has no way
 * to say it means another machine, and that is the point.
 */
const ROUTED: Partial<Record<ClientMessage["type"], readonly string[]>> = {
  "new-tab": ["paneId", "workspaceId"],
  "close-tab": ["agentId"],
  "select-tab": ["paneId"],
  "cycle-tab": ["paneId"],
  "move-tab": ["agentId", "paneId"],
  "split-with": ["agentId", "paneId"],
  "move-tab-to-workspace": ["agentId", "workspaceId"],
  "reorder-agent": ["agentId", "beforeAgentId"],
  "hide-agent": ["agentId"],
  "rename-tab": ["agentId"],
  input: ["agentId"],
  "propose-size": ["agentId"],
  "request-backlog": ["agentId"],
  split: ["paneId"],
  "close-pane": ["paneId"],
  "focus-pane": ["paneId"],
  "focus-dir": [],
  "step-pane": [],
  "last-pane": [],
  nudge: [],
  "set-ratio": ["splitId"],
  "swap-panes": ["paneId", "withPaneId"],
  "move-pane": ["paneId", "toPaneId"],
  "merge-panes": ["paneId", "intoPaneId"],
  "switch-workspace": ["workspaceId"],
  "reveal-agent": ["agentId"],
  "open-reader": ["paneId", "agentId"],
  "open-board": ["paneId", "workspaceId"],
  "pin-reader": ["paneId"],
  "select-doc": ["paneId"],
  "close-doc": ["paneId"],
  "move-doc": ["fromPaneId", "toPaneId"],
  "split-with-doc": ["fromPaneId", "paneId"],
  "add-card": ["workspaceId"],
  "add-run-card": ["workspaceId"],
  "edit-card": ["workspaceId"],
  "move-card": ["workspaceId"],
  "delete-card": ["workspaceId"],
  "resize-column": ["workspaceId"],
  "run-card": ["workspaceId"],
  "resume-card": ["workspaceId"],
  "worktree-status": ["workspaceId"],
  "commit-card": ["workspaceId"],
  "stash-card": ["workspaceId"],
  "merge-card": ["workspaceId"],
  "open-worktree": ["workspaceId"],
  "restart-card-dev": ["workspaceId"],
  "stop-card-dev": ["workspaceId"],
  // A path's root says which disk it is on; see `ON_A_DISK`.
  "open-doc": ["paneId", "root"],
  "split-with-file": ["paneId", "root"],
  "show-doc": ["root"],
  "find-editors": [],
  "open-in-editor": ["paneId", "agentId", "root"],
  "open-made": ["workspaceId", "root"],
};

/**
 * Verbs that act on the focused pane when they name none. Sent while a
 * remote workspace is on screen, the focused pane is the remote one, so they
 * go where it is.
 */
const FOCUSED = new Set<ClientMessage["type"]>([
  "new-tab",
  "close-tab",
  "cycle-tab",
  "split",
  "close-pane",
  "focus-dir",
  "step-pane",
  "last-pane",
  "nudge",
  "open-reader",
  "open-board",
  // The nvims of the workspace on screen, which is the remote one.
  "find-editors",
]);

/**
 * Verbs that carry a path into a pane. The path's root says whose disk it
 * is on, so one that pairs this machine's file with another's pane — or the
 * other way round — would open a different file there, or none, and is
 * refused with a sentence about files rather than about terminals.
 */
const ON_A_DISK = new Set<ClientMessage["type"]>(["open-doc", "split-with-file", "show-doc", "open-in-editor", "open-made"]);

/** What a verb's reply carries that names an agent or a pane, by verb: qualified on its way back. */
const REPLY_IDS: Partial<Record<ClientMessage["type"], readonly string[]>> = {
  "new-tab": ["id"],
  "add-run-card": ["agentId"],
  "run-card": ["agentId"],
  "resume-card": ["agentId"],
  "open-in-editor": ["agentId"],
  "open-made": ["paneId"],
};

export type Routed =
  /** This node's verb, to do here as ever. */
  | { to: "here" }
  /** Another node's: `message` is the verb with every id de-qualified, for that node to do. */
  | { to: "node"; node: string; message: ClientMessage }
  /** Neither: a verb that mixes two machines' things, or one this node cannot send yet. */
  | { to: "nowhere"; node: string | null; why: string };

/** A board or a document tab: an id that takes the side of the pane it is named with. */
function neutral(value: unknown): boolean {
  return value === BOARD_TAB || isDocTab(value);
}

/**
 * Which node a client's verb is for, given which node's workspace is on
 * screen (null while it is a local one).
 *
 * A verb is another node's when the ids it names are that node's, and
 * de-qualified on the way. One that names two nodes' things — a remote tab
 * dropped on a local pane, a local agent moved into a remote workspace — is
 * refused: a pty cannot change machines, and a document dropped across would
 * be a different file. A verb that names nothing and means the focused pane
 * goes to the node on screen. Anything else that carries a qualified id is
 * refused rather than done here, where it could only find nothing — or,
 * worse, write the id down.
 */
export function route(message: ClientMessage, onScreen: string | null): Routed {
  const fields = ROUTED[message.type];
  const record = message as unknown as Record<string, unknown>;
  if (!fields) {
    for (const value of Object.values(record)) {
      const remote = parseRemote(value);
      if (remote) return { to: "nowhere", node: remote.node, why: "That is not something this window does on another computer yet." };
    }
    return { to: "here" };
  }
  const nodes = new Set<string>();
  let local = false;
  let named = false;
  for (const field of fields) {
    const value = record[field];
    if (value === undefined || value === null || neutral(value)) continue;
    named = true;
    const remote = parseRemote(value);
    if (remote) nodes.add(remote.node);
    else local = true;
  }
  if (nodes.size > 1 || (nodes.size === 1 && local)) {
    const why = ON_A_DISK.has(message.type)
      ? "A file opens only on the computer it is on."
      : "That stays where it is: a terminal cannot move between computers.";
    return { to: "nowhere", node: [...nodes][0] ?? null, why };
  }
  let node = [...nodes][0] ?? null;
  if (!node && !named && onScreen && FOCUSED.has(message.type)) node = onScreen;
  if (!node) return { to: "here" };
  const bare: Record<string, unknown> = { ...record };
  for (const field of fields) {
    const remote = parseRemote(record[field]);
    if (remote) bare[field] = remote.id;
    else bare[field] = bareTab(record[field]);
  }
  return { to: "node", node, message: bare as unknown as ClientMessage };
}

/**
 * A reply from the node that ran a verb, with the agents and panes it names
 * qualified, so the window can find the tab it opened. `find-editors` is a
 * list of them, and each is qualified the same way.
 */
export function qualifyReply(node: string, type: ClientMessage["type"], result: unknown): unknown {
  if (type === "find-editors") {
    if (!Array.isArray(result)) return result;
    return result.map((choice: unknown) => qualifyFields(node, choice, ["agentId", "paneId"]));
  }
  const fields = REPLY_IDS[type];
  return fields ? qualifyFields(node, result, fields) : result;
}

function qualifyFields(node: string, result: unknown, fields: readonly string[]): unknown {
  if (!result || typeof result !== "object") return result;
  const out: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  for (const field of fields) {
    const value = out[field];
    if (typeof value === "string") out[field] = qualify(node, value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// What another node's agents are doing, for this node's notices
// ---------------------------------------------------------------------------

/** An agent of a node's, with the name of the workspace it is in: what a notice is made of. */
export interface RemoteAgent {
  agent: Pick<AgentSnapshot, "id" | "status" | "exited" | "kind" | "agent" | "lastAgent" | "titleOverride" | "title" | "activity">;
  workspace: string;
}

/**
 * The agents a node's notices are about, read off the snapshot its watch
 * relayed: the terminals in its active profile's panes, and not its Kuru's.
 * The same set the node's summary carries (`summarize`), so that a notice
 * read off one and then the other is about the same agents — the summary is
 * what this node reads while no watch is open.
 */
export function snapshotAgents(snapshot: { profile: Profile; agents: readonly AgentSnapshot[] }): RemoteAgent[] {
  const harness = snapshot.profile.harness?.agentId ?? null;
  const byId = new Map(snapshot.agents.map((a) => [a.id, a] as const));
  const out: RemoteAgent[] = [];
  for (const workspace of snapshot.profile.workspaces) {
    for (const pane of panes(workspace.layout)) {
      for (const id of terminalsOf(pane.agentIds)) {
        const agent = id === harness ? undefined : byId.get(id);
        if (agent) out.push({ agent, workspace: workspace.name });
      }
    }
  }
  return out;
}

/** The same, off the summary a node pushes over its link. */
export function summaryAgents(summary: Pick<NodeSummary, "workspaces">): RemoteAgent[] {
  return summary.workspaces.flatMap((w) => w.agents.map((agent) => ({ agent, workspace: w.name })));
}

/**
 * Which of a node's agents just started wanting a human: `noticeStatuses`'
 * rule — a move into `blocked` or `done`, never a state first seen — over a
 * list rather than the host's. `before` is what was last seen, by the
 * node's own ids, and the answer carries what to remember next.
 */
export function statusEdges(
  before: ReadonlyMap<string, AgentStatus>,
  agents: readonly RemoteAgent[],
): { seen: Map<string, AgentStatus>; edges: Array<RemoteAgent & { event: NotifyEvent }> } {
  const seen = new Map<string, AgentStatus>();
  const edges: Array<RemoteAgent & { event: NotifyEvent }> = [];
  for (const one of agents) {
    const { agent } = one;
    seen.set(agent.id, agent.status);
    const was = before.get(agent.id);
    if (was === undefined || was === agent.status || agent.exited) continue;
    if (isNotifyEvent(agent.status)) edges.push({ ...one, event: agent.status });
  }
  return { seen, edges };
}

// ---------------------------------------------------------------------------
// Another node's needs, as doors into this window
// ---------------------------------------------------------------------------

/** One of another node's needs, where it is: what a row in the Needs drawer and `C-a o` go to. */
export interface NodeNeed {
  node: string;
  workspaceKey: string;
  need: SummaryNeed;
}

/**
 * Every need of the nodes this window can open, in the drawer's order: by
 * rank, then as each node's own `needsOf` sorted them. A node that is away
 * has none — its last summary may list a question already answered — and
 * one from before remote workspaces has none here either, since this window
 * cannot go to it.
 */
export function nodeNeeds(nodes: readonly Pick<NodeStatus, "id" | "state" | "summary">[]): NodeNeed[] {
  const out: NodeNeed[] = [];
  for (const node of nodes) {
    if (node.state !== "up" || !node.summary?.watchable) continue;
    for (const w of node.summary.workspaces) for (const need of w.needs) out.push({ node: node.id, workspaceKey: w.key, need });
  }
  return out;
}

/** A need of this node's or of another's: the one walk `C-a o` takes. */
export type AnyNeed = { here: Need } | { there: NodeNeed };

/**
 * `nextNeed`, across nodes: this node's needs first, as the drawer lists
 * them, then each node's. Where you are is the terminal with the keyboard —
 * qualified, while a remote workspace is on screen — or, for a card with no
 * terminal, the workspace on screen with its board showing.
 */
export function nextNeedAcross(
  needs: ProfileNeeds,
  elsewhere: readonly NodeNeed[],
  at: {
    focusedAgentId: string | null;
    workspaceId: string | null;
    remote: { node: string; workspaceKey: string } | null;
    boardShowing: boolean;
  },
): AnyNeed | null {
  const all: AnyNeed[] = [...allNeeds(needs).map((here) => ({ here })), ...elsewhere.map((there) => ({ there }))];
  if (all.length === 0) return null;
  const current = all.findIndex((one) => {
    if ("here" in one) {
      const { agent, workspaceId } = one.here;
      if (agent) return agent.id === at.focusedAgentId;
      return !at.remote && workspaceId === at.workspaceId && at.boardShowing;
    }
    const { node, workspaceKey, need } = one.there;
    if (need.agentId) return qualify(node, need.agentId) === at.focusedAgentId;
    return at.remote?.node === node && at.remote.workspaceKey === workspaceKey && at.boardShowing;
  });
  return current === -1 ? all[0]! : all[(current + 1) % all.length]!;
}
