/**
 * A workspace moved to another node, both halves: the one it leaves and the
 * one it arrives on. The rules are `shared/move.ts`'s; this is the part with
 * a database, a link and a disk in it.
 *
 * **One exchange, and removal last.** The moving node asks the other
 * whether the folder will do, then sends the board as the export writes it
 * with a move id, and only when the answer comes back does it take the
 * workspace off its own list. A move interrupted anywhere before that
 * leaves this node exactly as it was. The id is made from the two nodes
 * and the workspace's key, not drawn at random, so the second press after
 * an answer that never arrived is the same move — and the other node,
 * which wrote its answer beside the cards it adopted, gives the same answer
 * again rather than a second copy of the workspace.
 *
 * **The folder is the other node's to judge.** A path is a grammar on one
 * machine and nothing on the next, so the receiving node resolves it, keeps
 * it inside its home, follows links and checks again — refuse, never
 * clamp, as `files.ts` does — and wants a repository there, because the
 * folder is where the cards' agents will work and a move pointed at the
 * wrong one is a board of cards about code that is not there. It reads the
 * disk and runs no `git`: a `.git` beside the files is enough to know it
 * is a checkout, and `worktree.ts` and `backup.ts` stay the only files
 * that run git.
 *
 * On the restartable side of the split. A server restart in the middle is
 * a dropped link, which is a move that did not happen yet.
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CardWorktree } from "../../shared/board";
import type { DbTarget } from "../../shared/databases";
import type { AgentSnapshot, Workspace } from "../../shared/model";
import {
  adoptOffer,
  basename,
  folderSentence,
  movePlan,
  projectsFolder,
  tilde,
  type FolderProblem,
  type MoveCheck,
  type MoveCheckAsk,
  type MoveDone,
  type MovePlan,
} from "../../shared/move";
import type { Actor } from "../../shared/store";
import type { NodeHost } from "./nodes";
import type { Store } from "./store";
import type { Workspaces } from "./workspaces";

/** The folder check: a stat or two on the other side. */
const CHECK_MS = 10_000;
/** The move: a whole board through one transaction there. Generous, since a lost answer is safe to ask again. */
const MOVE_MS = 60_000;

export interface MoverDeps {
  workspaces: Workspaces;
  store: Store;
  nodes: NodeHost;
  /** Every terminal the host has, as the snapshot draws it. */
  agents: () => readonly AgentSnapshot[];
  /** A profile's Kuru terminal, which no move may end. */
  harnessOf: (profileId: string) => string | null;
  /** Every folder a workspace's terminals work in, the one it is about first. */
  dirsOf: (workspace: Workspace) => string[];
  /** The databases a workspace's env files name. */
  databasesOf: (workspaceId: string) => readonly DbTarget[];
  /** The machine a workspace's shells are pinned to, by name. */
  machineOf: (workspace: Workspace) => string | null;
  /** Whether a card's worktree is on the disk. */
  standing: (worktree: CardWorktree) => boolean;
  /** End terminals the way deleting a workspace does. */
  endTerminals: (ids: string[]) => void;
  home: string;
  log: (line: string) => void;
}

/** What the move answered, and where the workspace can now be opened. */
export interface Moved {
  done: MoveDone;
  node: string;
  url: string;
}

export class Mover {
  /** Workspaces whose move is on the wire, by key: a second press waits for the first, it does not race it. */
  private readonly moving = new Set<string>();

  constructor(private readonly deps: MoverDeps) {}

  // -------------------------------------------------------------------------
  // The node it leaves
  // -------------------------------------------------------------------------

  private target(nodeId: string): { id: string; name: string } {
    const name = this.deps.nodes.nameOf(nodeId);
    if (!name) throw new Error("That node is not in the roster.");
    if (!this.deps.nodes.linked(nodeId)) throw new Error(`${name} is not linked right now, so nothing can move to it. Is it awake?`);
    return { id: nodeId, name };
  }

  private where(profileId: string, workspaceId: string): { workspace: Workspace; profileKey: string; only: boolean } {
    const profile = this.deps.workspaces.profile(profileId);
    const workspace = profile?.workspaces.find((w) => w.id === workspaceId);
    if (!profile || !workspace) throw new Error("That workspace is gone.");
    return { workspace, profileKey: profile.key, only: profile.workspaces.length < 2 };
  }

  /** The terminals a move would end or be refused by: the workspace's tabs, and its cards' agents wherever they are. */
  private terminalsOf(profileId: string, workspace: Workspace): AgentSnapshot[] {
    const ids = new Set(this.deps.workspaces.agentsInWorkspace(profileId, workspace.id));
    for (const card of workspace.board?.cards ?? []) if (card.run?.agentId) ids.add(card.run.agentId);
    return this.deps.agents().filter((a) => ids.has(a.id));
  }

  private refusalInput(profileId: string, workspace: Workspace, only: boolean) {
    return { workspace, terminals: this.terminalsOf(profileId, workspace), only, harnessId: this.deps.harnessOf(profileId), standing: this.deps.standing };
  }

  /**
   * What the dialog draws: whether it is refused here, what goes and what
   * stays, and the other node's word on the folder — its guess when none
   * was typed. The folder is asked about even when the move is refused, so
   * the person can see both things they have to fix at once.
   */
  async plan(profileId: string, workspaceId: string, nodeId: string, folder: string | null): Promise<MovePlan> {
    const node = this.target(nodeId);
    const { workspace, profileKey, only } = this.where(profileId, workspaceId);
    const here = this.deps.dirsOf(workspace)[0] ?? null;
    const lists = movePlan({
      ...this.refusalInput(profileId, workspace, only),
      node: node.name,
      here: this.deps.nodes.name(),
      folder: here ? tilde(here, this.deps.home) : null,
      databases: this.deps.databasesOf(workspaceId),
      deleted: this.deps.store.deletedOn(profileKey, workspace.key),
      machine: this.deps.machineOf(workspace),
    });
    let check: MoveCheck | null = null;
    let checkError: string | null = null;
    try {
      check = await this.askFolder(nodeId, { workspaceName: workspace.name, basename: basename(here) || workspace.name, folder });
    } catch (err) {
      checkError = err instanceof Error ? err.message : String(err);
    }
    return { node, workspace: { id: workspace.id, name: workspace.name }, ...lists, check, checkError };
  }

  /**
   * The other node's word on a folder for this workspace, its guess when
   * none is given: the check the dialog makes, for lending env files into
   * that checkout without moving anything.
   */
  async folderCheck(profileId: string, workspaceId: string, nodeId: string, folder: string | null, checkout: string | null = null): Promise<MoveCheck> {
    this.target(nodeId);
    const { workspace } = this.where(profileId, workspaceId);
    // The checkout's own name when it is known: env files go into the
    // project, and a pane standing in a subfolder or at home is not it.
    const name = basename(checkout) || basename(this.deps.dirsOf(workspace)[0] ?? null) || workspace.name;
    return this.askFolder(nodeId, { workspaceName: workspace.name, basename: name, folder });
  }

  private async askFolder(nodeId: string, ask: MoveCheckAsk): Promise<MoveCheck> {
    const name = this.deps.nodes.nameOf(nodeId) ?? "That node";
    const answer = await this.deps.nodes.ask(nodeId, (id) => ({ type: "workspace-move-check", id, ask }), CHECK_MS, `${name} did not answer about the folder. Is its kururu up to date?`);
    if (answer.type !== "workspace-move-checked") throw new Error(`${name} answered something else.`);
    if (!answer.check) throw new Error(`${name} said: ${answer.error ?? "no"}`);
    return answer.check;
  }

  /**
   * The move. Refused here first, by the same rule the dialog drew, and
   * there next, by the folder; then the board goes, and only on the answer
   * is this node's copy marked moved and the workspace taken off the list,
   * ending the terminals it held, as deleting it would.
   */
  async move(profileId: string, workspaceId: string, nodeId: string, folder: string, actor: Actor): Promise<Moved> {
    const node = this.target(nodeId);
    const { workspace, profileKey, only } = this.where(profileId, workspaceId);
    const refusal = movePlan({
      ...this.refusalInput(profileId, workspace, only),
      node: node.name,
      here: this.deps.nodes.name(),
      folder: null,
      databases: [],
      deleted: 0,
      machine: null,
    }).refusal;
    if (refusal) throw new Error(refusal);
    if (!folder.trim()) throw new Error(`Which folder on ${node.name}?`);
    if (this.moving.has(workspace.key)) throw new Error(`${workspace.name} is already on its way to ${node.name}.`);
    this.moving.add(workspace.key);
    try {
      const board = this.deps.store.exportBoard(profileKey, workspace.key);
      // Nothing standing goes (the refusal saw to that); a worktree the disk
      // no longer has is a pointer at nothing, and is left behind with it.
      if (board) board.cards = board.cards.map((card) => ({ ...card, worktree: null }));
      const carried = new Set((board?.cards ?? []).map((card) => card.id));
      const move = moveId(this.deps.nodes.selfId(), workspace.key, nodeId);
      const answer = await this.deps.nodes.ask(
        nodeId,
        (id) => ({ type: "workspace-move", id, offer: { move, workspace: { key: workspace.key, name: workspace.name }, folder, board } }),
        MOVE_MS,
        `${node.name} did not answer, so nothing was removed here. Move it again: if it did arrive, ${node.name} answers the same move the same way and makes nothing twice.`,
      );
      if (answer.type !== "workspace-moved") throw new Error(`${node.name} answered something else.`);
      if (!answer.done) throw new Error(`${node.name} did not take it: ${answer.error ?? "no reason given"}`);
      const done = answer.done;
      this.deps.store.markMovedAway(profileKey, workspace.key, { id: move, node: node.name, key: done.key, carried }, actor);
      const ended = this.deps.workspaces.as(actor, () => this.deps.workspaces.deleteWorkspaceIn(profileId, workspace.id));
      this.deps.endTerminals(ended);
      this.deps.log(`move: ${workspace.name} went to ${node.name} as ${done.key}${done.again ? " (answered again)" : ""}, ${done.cards} cards`);
      const url = this.deps.nodes.statuses().find((n) => n.id === nodeId)?.url ?? "";
      return { done, node: node.name, url };
    } finally {
      this.moving.delete(workspace.key);
    }
  }

  // -------------------------------------------------------------------------
  // The node it arrives on
  // -------------------------------------------------------------------------

  /** Every folder this node's workspaces work in, which is what its projects folder is guessed from. */
  private allDirs(): string[] {
    return this.deps.workspaces.all().flatMap((p) => p.workspaces.flatMap((w) => this.deps.dirsOf(w)));
  }

  /** A peer asking whether a folder will do; its guess, when none is given. */
  check(_peer: string, raw: unknown): MoveCheck {
    const ask = (raw ?? {}) as Partial<MoveCheckAsk>;
    const home = this.deps.home;
    let folder = typeof ask.folder === "string" && ask.folder.trim() ? ask.folder.trim() : null;
    if (folder === null) {
      const base = typeof ask.basename === "string" ? ask.basename.replace(/[/\0]/g, "").slice(0, 120) : "";
      const projects = projectsFolder(this.allDirs(), home, existsSync);
      folder = base ? join(projects, base) : projects;
    }
    const { path, problem } = judgeFolder(folder, home);
    const profile = this.deps.workspaces.active;
    const name = typeof ask.workspaceName === "string" ? ask.workspaceName.trim() : "";
    return { folder: path, shown: tilde(path, home), problem, profile: profile.name, clash: profile.workspaces.some((w) => w.name === name) };
  }

  /**
   * A peer's workspace arriving: made here in the profile on screen with
   * one pane in its folder, its cards adopted with the answer beside them,
   * and the board read back into memory from the rows — the direction a
   * board takes when the database is where it came from. The same move id
   * a second time is answered from that record and makes nothing. All of
   * it in one turn of the loop, so two copies of one move cannot interleave.
   */
  adopt(peer: string, raw: unknown): Promise<MoveDone> {
    const offer = adoptOffer(raw);
    if (!offer) return Promise.reject(new Error("the move was not one this kururu understands; update kururu on both"));
    const again = this.deps.store.moveAnswered(offer.move);
    if (again) return Promise.resolve({ ...again, again: true });
    const { path, problem } = judgeFolder(offer.folder, this.deps.home);
    if (problem) return Promise.reject(new Error(folderSentence(problem, this.deps.nodes.name(), tilde(path, this.deps.home))));
    const ws = this.deps.workspaces;
    const profile = ws.active;
    const id = ws.as("import", () => ws.newWorkspaceIn(profile.id, offer.workspace.name, path));
    const made = id ? ws.workspaceIn(profile.id, id) : null;
    if (!id || !made) return Promise.reject(new Error("the workspace could not be made here"));
    try {
      const done = this.deps.store.adoptMove(
        { id: offer.move, from: peer, to: this.deps.nodes.name() },
        profile.key,
        made.key,
        offer.board,
        { key: made.key, name: made.name, folder: path, profile: profile.name, cards: 0, again: false },
      );
      const board = this.deps.store.loadBoard(profile.key, made.key);
      if (board) ws.replaceBoard(profile.key, made.key, board);
      return Promise.resolve(done);
    } catch (err) {
      // Nothing was adopted, so the empty workspace made for it goes again.
      ws.deleteWorkspaceIn(profile.id, id);
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/** The same move every time this workspace is sent to that node. */
export function moveId(self: string, workspaceKey: string, target: string): string {
  return `mv${createHash("sha256").update(`kururu-move-v1\n${self}\n${workspaceKey}\n${target}`).digest("hex").slice(0, 16)}`;
}

/**
 * A folder a peer named, judged on this disk: `~` expanded, absolute, inside
 * home before and after its links are followed, a directory, a checkout.
 * The path given back is the resolved one when it exists, so the workspace
 * is made where the folder really is.
 */
export function judgeFolder(raw: string, home: string): { path: string; problem: FolderProblem | null } {
  const text = raw.trim();
  const expanded = text === "~" ? home : text.startsWith("~/") ? join(home, text.slice(2)) : text;
  if (!isAbsolute(expanded) || expanded.includes("\0")) return { path: expanded, problem: "relative" };
  const path = resolve(expanded);
  const inside = (p: string, root: string) => p === root || p.startsWith(`${root}/`);
  if (!inside(path, home)) return { path, problem: "outside" };
  if (!existsSync(path)) return { path, problem: "missing" };
  let real: string;
  let realHome: string;
  try {
    real = realpathSync(path);
    realHome = realpathSync(home);
  } catch {
    return { path, problem: "missing" };
  }
  if (!inside(real, realHome)) return { path, problem: "outside" };
  try {
    if (!statSync(real).isDirectory()) return { path, problem: "not-dir" };
  } catch {
    return { path, problem: "missing" };
  }
  if (!existsSync(join(real, ".git"))) return { path, problem: "not-repo" };
  // In home's own spelling when home is itself a link (`/var` is `/private/var`
  // on a Mac): the folder is shown as `~/…` and stored as the person knows it.
  return { path: real === realHome ? home : real.startsWith(`${realHome}/`) ? join(home, relative(realHome, real)) : real, problem: null };
}
