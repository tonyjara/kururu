/**
 * Moving a workspace to another node: what is refused, what the dialog
 * says goes and stays, and the shapes the two nodes trade over the link.
 *
 * A workspace is a project, and a project can outgrow the Mac: the box
 * that stays on while the lid is shut is where its agents should run. The
 * first such move is a whole board of a hundred cards with their runs and
 * their history, and the two things it must never do are lose a card and
 * leave the user unsure what went. So the rule is narrow on purpose:
 *
 * - **What moves is the board and its name**, as the export writes it
 *   (`BoardExport`, the same rows a backup carries), every card with every
 *   run and event and its dates. The other node adopts them through the
 *   store's one road in for a move and says so on each card.
 * - **What stays is everything that is about this machine**: the code, the
 *   env files (unless they are lent, which `secrets.ts` does beside the
 *   move and never as part of it) and the database the project points at, the pane arrangement,
 *   the terminals, a dev server, a machine pin, the links to files agents
 *   made here, and the conversations behind the cards' runs. The folder on
 *   the other node is a checkout that is already there, never a copy; a
 *   move that copied code would be a sync with a conflict rule, which is
 *   what `docs/data.md` was written to avoid.
 * - **It is refused while work is under way**: an agent running in it or on
 *   one of its cards, and a card with a worktree standing. Both are things
 *   that would be ended or orphaned, and on the worktree rule's reasoning
 *   nothing ends work without asking — here, the ask is to finish first.
 *
 * Pure, so the refusal and every sentence the dialog draws are tested as
 * text, and the harness's `move_workspace` says exactly what the dialog
 * says.
 */
import { BOARD_COLUMNS, cardCode, COLUMN_LABELS, type Board, type BoardColumn, type Card, type CardWorktree } from "./board";
import type { DbTarget } from "./databases";
import { panes, terminalsOf } from "./layout";
import type { AgentSnapshot, Workspace } from "./model";
import type { BoardExport } from "./store";

// ---------------------------------------------------------------------------
// The shapes on the link
// ---------------------------------------------------------------------------

/** What the moving node asks the other before anything moves: would this folder do. Null `folder` asks for its guess. */
export interface MoveCheckAsk {
  workspaceName: string;
  /** The last part of the folder here, which the guess on the other side is made of. */
  basename: string;
  folder: string | null;
}

export type FolderProblem = "relative" | "outside" | "missing" | "not-dir" | "not-repo";

/** The other node's answer: the folder it would use, and whether it can. */
export interface MoveCheck {
  /** Absolute, as that node resolved it. */
  folder: string;
  /** The same with that node's home as `~`, for the dialog. */
  shown: string;
  problem: FolderProblem | null;
  /** The profile on screen there, which is the one a workspace arrives in. */
  profile: string;
  /** A workspace there already has this name. Said, not refused: two of a name is the user's to tidy. */
  clash: boolean;
}

/** The move itself: the workspace's name and its board as the export writes it, and where it goes. */
export interface MoveOffer {
  /** The same for every attempt at moving this workspace to that node, so a retry is answered the same way. */
  move: string;
  workspace: { key: string; name: string };
  folder: string;
  /** Null for a workspace whose board was never opened. */
  board: BoardExport | null;
}

/** What the other node made. `again` when the move id had already been answered, and nothing was made twice. */
export interface MoveDone {
  key: string;
  name: string;
  folder: string;
  profile: string;
  cards: number;
  again: boolean;
}

/** A move id: `mv` and sixteen hex digits. */
export const MOVE_ID = /^mv[0-9a-f]{16}$/;

/**
 * What the dialog is told when it opens or the folder changes: whether the
 * move is refused here, what goes and what stays, and the other node's word
 * on the folder.
 */
export interface MovePlan {
  node: { id: string; name: string };
  workspace: { id: string; name: string };
  refusal: string | null;
  moves: string[];
  stays: string[];
  check: MoveCheck | null;
  /** Why the other node could not be asked about the folder. */
  checkError: string | null;
}

// ---------------------------------------------------------------------------
// The refusal
// ---------------------------------------------------------------------------

export interface MoveInput {
  workspace: Workspace;
  /** Every terminal the workspace's panes hold, and every agent its cards' runs name, as the host has them. */
  terminals: readonly AgentSnapshot[];
  /** Whether it is the profile's only workspace, which cannot go: there would be nowhere to be. */
  only: boolean;
  /** Kuru's own terminal, which a workspace may hold and a move must not end. */
  harnessId: string | null;
  /** Whether a card's worktree is on the disk. One that is gone is a stale pointer and does not stop anything. */
  standing: (worktree: CardWorktree) => boolean;
}

/** Whether a terminal is an agent at work: started as one, or a shell somebody ran Claude in. Exited ones are nobody's work. */
export function isLiveAgent(terminal: AgentSnapshot): boolean {
  return !terminal.exited && (terminal.kind === "agent" || terminal.agent !== null);
}

function agentName(terminal: AgentSnapshot): string {
  return terminal.titleOverride || terminal.agent || terminal.lastAgent || "an agent";
}

/**
 * Why this workspace may not move now, or null. In the order a person can
 * do something about: the one thing that is never possible first, then
 * what is running, then what is checked out.
 */
export function moveRefusal(input: MoveInput): string | null {
  const { workspace } = input;
  if (input.only) return `${workspace.name} is the only workspace in this profile, and a profile needs one. Make another workspace first.`;
  if (input.harnessId && input.terminals.some((t) => t.id === input.harnessId && !t.exited)) {
    return `Kuru's own terminal is in ${workspace.name}. Move Kuru's tab to another workspace first.`;
  }
  const cards = workspace.board?.cards ?? [];
  const running = input.terminals.filter((t) => t.id !== input.harnessId && isLiveAgent(t));
  if (running.length) {
    const onCard = new Map(cards.filter((c) => c.run?.agentId).map((c) => [c.run!.agentId!, c] as const));
    const named = running.slice(0, 3).map((t) => {
      const card = onCard.get(t.id);
      return card ? `${agentName(t)} on ${cardCode(workspace.name, card.number)} “${card.title}”` : agentName(t);
    });
    const more = running.length > 3 ? ` and ${running.length - 3} more` : "";
    const they = running.length === 1 ? "it" : "them";
    return `${running.length === 1 ? "An agent is" : `${running.length} agents are`} running in ${workspace.name}: ${named.join(", ")}${more}. Let ${they} finish and close ${they}, or let ${they} go to sleep, then move it.`;
  }
  const standing = cards.filter((c) => c.worktree && input.standing(c.worktree));
  if (standing.length) {
    const first = standing[0]!;
    const more = standing.length > 1 ? ` and ${standing.length - 1} more card${standing.length === 2 ? "" : "s"}` : "";
    return `${cardCode(workspace.name, first.number)} “${first.title}”${more} ${standing.length === 1 ? "has a worktree" : "have worktrees"} standing (${first.worktree!.path}). Merge or discard it from the card first: a worktree is a checkout on this machine and cannot go with the card.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// What the dialog says
// ---------------------------------------------------------------------------

export interface PlanInput extends MoveInput {
  /** The other node's name. */
  node: string;
  /** This node's name, for "stays on mac". */
  here: string;
  /** The folder its terminals work in here, if it has one. */
  folder: string | null;
  /** The databases its env files name. */
  databases: readonly DbTarget[];
  /** Its deleted cards, which go too and stay deleted. */
  deleted: number;
  /** The name of the machine its shells are pinned to, if they are. */
  machine: string | null;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 To do, 1 In progress, 80 Done", in the board's order, leaving out empty columns. */
export function columnCounts(cards: readonly Card[]): string {
  const counts = new Map<string, number>();
  for (const card of cards) counts.set(card.column, (counts.get(card.column) ?? 0) + 1);
  const known = BOARD_COLUMNS.filter((c) => counts.has(c)).map((c) => `${counts.get(c)} ${COLUMN_LABELS[c as BoardColumn]}`);
  const other = [...counts.entries()].filter(([c]) => !(BOARD_COLUMNS as readonly string[]).includes(c)).map(([c, n]) => `${n} in ${c}`);
  return [...known, ...other].join(", ");
}

/** A board's runs, as the dialog counts them: cards that ever ran, and those asleep. */
function runCounts(board: Board | null): { ran: number; asleep: number } {
  const cards = board?.cards ?? [];
  return { ran: cards.filter((c) => c.run).length, asleep: cards.filter((c) => c.run?.state === "asleep").length };
}

/**
 * The two lists the dialog draws, as sentences, and the refusal if there is
 * one. Written for the first real use — a project with a long board and
 * its code, env files and database on both machines — so that each list
 * says the thing a person would otherwise have to ask.
 */
export function movePlan(input: PlanInput): { refusal: string | null; moves: string[]; stays: string[] } {
  const { workspace, node, here } = input;
  const board = workspace.board;
  const cards = board?.cards ?? [];
  const moves: string[] = [`The name, ${workspace.name}, into ${node}'s profile on screen.`];
  if (cards.length) {
    const deleted = input.deleted ? `, and its ${plural(input.deleted, "deleted card")}, still deleted` : "";
    moves.push(`The board: ${plural(cards.length, "card")} (${columnCounts(cards)})${deleted}. Each keeps its number, dates and history, and its history says it moved.`);
  } else {
    moves.push(input.deleted ? `The board: no cards, and its ${plural(input.deleted, "deleted card")}, still deleted.` : "The board, which has no cards.");
  }
  const { ran, asleep } = runCounts(board);
  if (ran) {
    moves.push(
      `The runs on ${plural(ran, "card")}, as history. The agents' conversations stay on ${here}, so running one of those cards on ${node} starts a new conversation${asleep ? ` — ${asleep === 1 ? "the one asleep" : `the ${asleep} asleep`} cannot be resumed there` : ""}.`,
    );
  }

  const stays: string[] = [];
  stays.push(
    `The code. Nothing is copied: ${node} uses its own checkout of the project, which must already be there. Push what is not pushed here, and pull it there.`,
  );
  stays.push(
    `Env files (.env and the like) in ${input.folder ? input.folder : "the folder"}, unless they are lent to ${node}: then each is sealed to it, written into its checkout, and sent again when it changes here.`,
  );
  if (input.databases.length) {
    const names = input.databases.slice(0, 3).map((db) => `${db.database} on ${db.host}:${db.port}`);
    stays.push(
      `${input.databases.length === 1 ? "The database" : "The databases"} its env files name (${names.join(", ")}${input.databases.length > 3 ? ", …" : ""}). Nothing in ${input.databases.length === 1 ? "it" : "them"} moves; on ${node} it uses whatever its own env files say.`,
    );
  } else {
    stays.push(`Any database the project uses. Nothing in it moves; on ${node} it uses whatever its own env files say.`);
  }
  stays.push(`The panes. It starts on ${node} with one pane, in its folder there.`);
  const open = input.terminals.filter((t) => !t.exited && t.id !== input.harnessId && workspaceHolds(workspace, t.id));
  if (open.length) stays.push(`${plural(open.length, "terminal")} open in it here (${open.slice(0, 4).map((t) => t.title || t.agent || t.kind).join(", ")}${open.length > 4 ? ", …" : ""}), which ${open.length === 1 ? "closes" : "close"} when it goes.`);
  if (cards.some((c) => c.dev)) stays.push("Its cards' dev servers, which stop when it goes.");
  if (input.machine) stays.push(`The pin to ${input.machine}: on ${node} its shells open on ${node} itself.`);
  if (cards.some((c) => c.made?.length)) stays.push(`The links to files agents made, which point at files on ${here}.`);
  stays.push(`${here}'s copy of the board: it is kept, marked moved, and found in Search → Deleted.`);

  return { refusal: moveRefusal(input), moves, stays };
}

function workspaceHolds(workspace: Workspace, terminalId: string): boolean {
  return panes(workspace.layout).some((pane) => terminalsOf(pane.agentIds).includes(terminalId));
}

/** The other node's word on a folder, as the sentence the dialog draws under the field. */
export function folderSentence(problem: FolderProblem | null, node: string, shown: string): string {
  switch (problem) {
    case null:
      return `${shown} is a repository on ${node}.`;
    case "relative":
      return `Give the folder on ${node} as a whole path, ~/… or /….`;
    case "outside":
      return `${shown} is outside the home folder on ${node}, which is the only place a move may point at.`;
    case "missing":
      return `${node} has no ${shown}. Clone the project there first (git clone … ${shown}), then check again.`;
    case "not-dir":
      return `${shown} on ${node} is a file, not a folder.`;
    case "not-repo":
      return `${shown} on ${node} is a folder but not a git repository. Clone the project there, or pick the folder that is its checkout.`;
  }
}

/**
 * A new workspace made on another node from this window: its name and the
 * folder its terminals start in there. Not a move — nothing goes with it —
 * so its folder is judged by the same `judgeFolder` on that node's disk,
 * and one rule is relaxed: a folder that is not a checkout will do, as a
 * workspace here may sit anywhere (its cards simply cannot have worktrees).
 */
export interface NewWorkspaceAsk {
  name: string;
  folder: string;
}

/** What the other node made. */
export interface NewWorkspaceMade {
  key: string;
  name: string;
  /** Absolute, as that node resolved it. */
  folder: string;
  shown: string;
  /** The profile on screen there, which is the one it was made in. */
  profile: string;
}

/** A name for a workspace, as the field gave it: trimmed, bounded, and never empty when there is a folder to name it after. */
export function workspaceName(raw: unknown, folder: string): string {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ").slice(0, 60) : "";
  return name || basename(folder) || "workspace";
}

/** Whether a folder the other node judged will do for a new workspace: everything a move needs but a checkout. */
export function newFolderOk(problem: FolderProblem | null): boolean {
  return problem === null || problem === "not-repo";
}

/** The other node's word on a folder for a new workspace, as the sentence under the field. */
export function newFolderSentence(problem: FolderProblem | null, node: string, shown: string): string {
  switch (problem) {
    case null:
      return `${shown} is a repository on ${node}.`;
    case "not-repo":
      return `${shown} is a folder on ${node}, not a git repository: its cards cannot have worktrees.`;
    case "outside":
      return `${shown} is outside the home folder on ${node}, which is the only place a workspace made from here may point at.`;
    case "missing":
      return `${node} has no ${shown}. Make it or clone the project there first, then check again.`;
    default:
      return folderSentence(problem, node, shown);
  }
}

/**
 * Where a project probably lives on a node: the folder most of its
 * workspaces' folders sit in, else the first of the usual names that
 * exists, else home. A guess the dialog shows and the person corrects —
 * the check that follows is what decides.
 */
export function projectsFolder(dirs: readonly string[], home: string, exists: (path: string) => boolean): string {
  const parents = new Map<string, number>();
  for (const dir of dirs) {
    const parent = dir.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
    if (!parent || parent === home || !parent.startsWith(`${home}/`)) continue;
    parents.set(parent, (parents.get(parent) ?? 0) + 1);
  }
  const best = [...parents.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (best) return best[0];
  for (const name of ["Projects", "projects", "code", "Code", "src", "dev", "Developer"]) {
    if (exists(`${home}/${name}`)) return `${home}/${name}`;
  }
  return home;
}

/** A path with the home folder as `~`, as the dialog shows it. */
export function tilde(path: string, home: string): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The last part of a folder, which the guess on the other side is made of. */
export function basename(path: string | null): string {
  return (path ?? "").replace(/\/+$/, "").split("/").pop() ?? "";
}

// ---------------------------------------------------------------------------
// The offer, as the receiving node takes it
// ---------------------------------------------------------------------------

/** More cards than any board has; a bound, so a runaway peer cannot hand over a million. */
export const MOVE_CARDS_MAX = 5_000;
const NAME_MAX = 60;
const EVENTS_MAX = 2_000;
const RUNS_MAX = 500;
const ACTORS = new Set<string>(["user", "harness", "automation", "import"]);
const KINDS = new Set<string>(["created", "edited", "moved", "sent", "run", "deleted", "restored", "imported"]);
const RUN_STATES = new Set<string>(["starting", "working", "blocked", "finished", "ended", "asleep"]);

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const orNull = <T>(v: unknown, ok: (v: unknown) => v is T): v is T | null => v === null || ok(v);

/**
 * A move off the wire, checked down to every event, or null. The peer is a
 * member the roster lists, and this is still the shape a database row will
 * be written from: anything that is not what the export writes is refused
 * whole rather than half taken. A column a workspace's board does not have
 * becomes To do, and a worktree is dropped — a path on another machine is
 * nothing here — as `adoptBoard` would.
 */
export function adoptOffer(raw: unknown): MoveOffer | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const ws = o.workspace as Record<string, unknown> | undefined;
  if (typeof o.move !== "string" || !MOVE_ID.test(o.move)) return null;
  if (!ws || typeof ws.key !== "string" || !/^wk[0-9a-f]{12}$/.test(ws.key) || !isStr(ws.name, 200)) return null;
  const name = ws.name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  if (!name || !isStr(o.folder, 1024) || !o.folder) return null;
  const offer: MoveOffer = { move: o.move, workspace: { key: ws.key, name }, folder: o.folder, board: null };
  if (o.board === null || o.board === undefined) return offer;
  const b = o.board as Record<string, unknown>;
  const board = b.board as Record<string, unknown> | undefined;
  if (b.version !== 1 || !board || !isNum(board.next) || !isNum(board.createdAt) || !Array.isArray(b.cards) || b.cards.length > MOVE_CARDS_MAX) return null;
  const cards: BoardExport["cards"] = [];
  for (const raw of b.cards as unknown[]) {
    const c = raw as Record<string, unknown>;
    if (!c || typeof c !== "object" || !isStr(c.id, 64) || !c.id || !Number.isInteger(c.number) || (c.number as number) < 1) return null;
    if (!isStr(c.title, 200) || !isStr(c.body, 20_000) || typeof c.column !== "string" || !isNum(c.position) || typeof c.isolate !== "boolean") return null;
    if (!isNum(c.createdAt) || !isNum(c.updatedAt) || !orNull(c.deletedAt, isNum)) return null;
    const d = c.dates as Record<string, unknown> | null;
    if (d !== null && (!d || typeof d !== "object" || !isStr(d.start, 10) || !isStr(d.end, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(d.start) || !/^\d{4}-\d{2}-\d{2}$/.test(d.end))) return null;
    if (!Array.isArray(c.runs) || c.runs.length > RUNS_MAX || !Array.isArray(c.events) || c.events.length > EVENTS_MAX) return null;
    const runs: BoardExport["cards"][number]["runs"] = [];
    for (const r of c.runs as Record<string, unknown>[]) {
      if (!r || !isStr(r.launcher, 100) || !isStr(r.label, 200) || typeof r.state !== "string" || !RUN_STATES.has(r.state) || !isNum(r.startedAt)) return null;
      if (!orNull(r.endedAt, isNum) || !orNull(r.sessionId, (v): v is string => isStr(v, 100)) || !orNull(r.cwd, (v): v is string => isStr(v, 1024))) return null;
      runs.push({ launcher: r.launcher, label: r.label, state: r.state as never, startedAt: r.startedAt, endedAt: r.endedAt, sessionId: r.sessionId, cwd: r.cwd });
    }
    const events: BoardExport["cards"][number]["events"] = [];
    for (const e of c.events as Record<string, unknown>[]) {
      if (!e || !isNum(e.at) || typeof e.actor !== "string" || !ACTORS.has(e.actor) || typeof e.kind !== "string" || !KINDS.has(e.kind)) return null;
      if (!orNull(e.fromColumn, (v): v is string => isStr(v, 64)) || !orNull(e.toColumn, (v): v is string => isStr(v, 64))) return null;
      if (e.detail !== null && (typeof e.detail !== "object" || Array.isArray(e.detail) || JSON.stringify(e.detail).length > 4_000)) return null;
      events.push({ at: e.at, actor: e.actor as never, kind: e.kind as never, fromColumn: e.fromColumn, toColumn: e.toColumn, detail: e.detail as Record<string, unknown> | null });
    }
    cards.push({
      id: c.id,
      number: c.number as number,
      title: c.title,
      body: c.body,
      column: (BOARD_COLUMNS as readonly string[]).includes(c.column) ? c.column : "todo",
      position: c.position,
      isolate: c.isolate,
      dates: d ? { start: d.start as string, end: d.end as string } : null,
      worktree: null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      deletedAt: c.deletedAt,
      runs,
      events,
    });
  }
  const p = (b.profile ?? {}) as Record<string, unknown>;
  offer.board = {
    version: 1,
    profile: { key: typeof p.key === "string" ? p.key : "", name: typeof p.name === "string" ? p.name : "", loginKey: null },
    workspace: { key: ws.key, name },
    board: { id: typeof board.id === "string" ? board.id : "", next: Math.max(1, Math.trunc(board.next)), columns: null, createdAt: board.createdAt },
    cards,
  };
  return offer;
}

/** The plan as Kuru reads it from `move_workspace`: the same lists the dialog draws, as lines. */
export function planText(plan: MovePlan): string {
  const lines = [`Moving ${plan.workspace.name} to ${plan.node.name}.`];
  if (plan.refusal) lines.push(`Refused right now: ${plan.refusal}`);
  if (plan.check) {
    lines.push(`Folder there: ${folderSentence(plan.check.problem, plan.node.name, plan.check.shown)}`);
    lines.push(`It would go into ${plan.node.name}'s profile ${plan.check.profile}${plan.check.clash ? `, which already has a workspace called ${plan.workspace.name}` : ""}.`);
  } else lines.push(`Folder there: not checked — ${plan.checkError ?? "no answer"}`);
  lines.push("What moves:", ...plan.moves.map((line) => `- ${line}`), "What stays:", ...plan.stays.map((line) => `- ${line}`));
  return lines.join("\n");
}
