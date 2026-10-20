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
 * What is qualified: agents (the terminal tabs), panes, splits and the
 * workspace itself. What is not, and why:
 *
 * - **The board's tab and a document's tab.** `BOARD_TAB` is one per
 *   workspace and a document's tab is its address; neither names a thing
 *   that exists outside the pane it sits in, so each takes the side of the
 *   pane a verb names with it — a "neutral" id below.
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
import { BOARD_TAB, isBoardTab, isDocTab, type LayoutNode } from "./layout";
import type { AgentSnapshot, Workspace } from "./model";
import { WORKSPACE_COLORS, type WorkspaceColor } from "./model";
import type { ClientMessage } from "./wire";
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

/** A tab, as the Mac spells it: a terminal qualified, the board and a document as they are. */
export function qualifyTab(node: string, tab: string): string {
  return isBoardTab(tab) || isDocTab(tab) ? tab : qualify(node, tab);
}

export function qualifyLayout(node: string, layout: LayoutNode): LayoutNode {
  if (layout.type === "pane") {
    const { pane } = layout;
    return { type: "pane", pane: { ...pane, id: qualify(node, pane.id), agentIds: pane.agentIds.map((tab) => qualifyTab(node, tab)) } };
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
          })),
        }
      : null,
  };
}

/**
 * An agent of the child's, as the Mac's clients are told of it. What it made
 * is the child's disk's, and opening it is phase 2's; until then a link the
 * Mac would resolve against its own disk is a link to the wrong file, so it
 * is left off.
 */
export function qualifyAgent(node: string, agent: AgentSnapshot): AgentSnapshot {
  const { made: _made, ...rest } = agent;
  return { ...rest, id: qualify(node, agent.id) };
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
  // Listed so that a remote pane is refused with the right sentence; see `THIS_DISK`.
  "open-doc": ["paneId"],
  "split-with-file": ["paneId"],
  "open-in-editor": ["paneId", "agentId"],
  "open-made": ["workspaceId"],
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
]);

/**
 * Verbs that carry a path on *this* disk into a pane. A remote pane's files
 * are the box's, so the Mac's path would be a different file there or none:
 * refused rather than forwarded, until the asks of phase 2 exist.
 */
const THIS_DISK = new Set<ClientMessage["type"]>(["open-doc", "split-with-file", "open-in-editor", "open-made"]);

/** What a verb's reply carries that names an agent, by verb: qualified on its way back. */
const REPLY_AGENT: Partial<Record<ClientMessage["type"], string>> = {
  "new-tab": "id",
  "add-run-card": "agentId",
  "run-card": "agentId",
  "resume-card": "agentId",
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
    return { to: "nowhere", node: [...nodes][0] ?? null, why: "That stays where it is: a terminal cannot move between computers." };
  }
  let node = [...nodes][0] ?? null;
  if (!node && !named && onScreen && FOCUSED.has(message.type)) node = onScreen;
  if (!node) return { to: "here" };
  if (THIS_DISK.has(message.type)) return { to: "nowhere", node, why: "A file from this computer cannot open on another one." };
  const bare: Record<string, unknown> = { ...record };
  for (const field of fields) {
    const remote = parseRemote(record[field]);
    if (remote) bare[field] = remote.id;
  }
  return { to: "node", node, message: bare as unknown as ClientMessage };
}

/** A reply from the node that ran a verb, with the agent it names qualified, so the window can find the tab it opened. */
export function qualifyReply(node: string, type: ClientMessage["type"], result: unknown): unknown {
  const field = REPLY_AGENT[type];
  if (!field || !result || typeof result !== "object") return result;
  const value = (result as Record<string, unknown>)[field];
  return typeof value === "string" ? { ...result, [field]: qualify(node, value) } : result;
}
