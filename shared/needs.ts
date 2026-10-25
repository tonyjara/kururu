/**
 * What needs a person, across every workspace of a profile.
 *
 * It exists because nothing in kururu answered "where am I wanted" in one
 * place. The sidebar marks an agent that finished while you were away, the
 * board's Review column holds the turns that ended, and a blocked agent's
 * dot turns red — three true facts in three lists, none of them sorted by
 * whether anything will move without you. The profile board tried to be
 * that place for a version by drawing every workspace's board in its sheet,
 * and what that listed was boards: a workspace with a blocked agent and no
 * board never appeared, and a workspace mid-work looked the same as one
 * waiting on you.
 *
 * So one rule, here, pure, over what the snapshot already carries. A thing
 * needs you when it will not move without you: an agent asking, a card in
 * Review, an agent that finished while nobody watched, a card whose agent
 * went away without finishing — and a card in the profile board's Needs
 * you, which is that sentence written down by hand, by you or by Kuru for
 * you. A working agent is not one of those — it
 * will come to you — and is counted separately, so a workspace can be seen
 * to be busy without being mistaken for one that is waiting. The harness
 * is never counted: Kuru asking is the status bar's chip, and one subject
 * per control is the rule that put it there.
 *
 * Pure, on `layout.ts`'s terms: the window draws the answer, the sidebar
 * marks a row with it, and the harness could say it in words. Nothing new
 * crosses the wire for it.
 */
import type { AgentSnapshot, Profile, Workspace } from "./model";
import { panes, terminalsOf } from "./layout";
import { columnCards, NEEDS_COLUMN, type Card } from "./board";

/**
 * Why a thing needs you. `asking` outranks the rest: a prompt is the one
 * kind that holds a turn up, where the others wait as long as you let them.
 */
export type NeedKind = "asking" | "review" | "unseen" | "stalled";

export interface Need {
  kind: NeedKind;
  workspaceId: string;
  /** The terminal, while there is one to go to. Null for a card whose agent has gone, where the board is the door. */
  agent: AgentSnapshot | null;
  /** The card, when the need is a card's. Null for an agent nobody's card claims. */
  card: Card | null;
  /**
   * Whether a plain move to Done is all the card asks for: in Review, with
   * no worktree to merge and no terminal left open to end. Anything else is
   * a question the board asks in its own dialog, and is sent there.
   */
  plainDone: boolean;
}

/**
 * Which of the three lists a workspace is in. `needs` is the one the chip
 * counts; `working` is on its way to you; `quiet` is everything else, out
 * of the way and still reachable.
 */
export type Band = "needs" | "working" | "quiet";

export interface WorkspaceNeeds {
  workspace: Workspace;
  band: Band;
  /** Asking first, then cards in board order, then agents in the sidebar's order. Empty unless the band is `needs`. */
  needs: Need[];
  /** Agents mid-turn here, the harness excepted. Said under a `needs` workspace too, as what else is going on. */
  working: AgentSnapshot[];
}

export interface ProfileNeeds {
  /** Every workspace, in the sidebar's order, each with its band. */
  workspaces: WorkspaceNeeds[];
  /**
   * The cards in the profile board's Needs you, in the column's order —
   * yours to do, each marked with who put it there (`Card.needsBy`). Apart
   * from `workspaces` because they are no workspace's, and apart from
   * `allNeeds` and so from Next, because their door is the profile's board,
   * a sheet that takes the keyboard: a walk that went into it would stop
   * there. Counted, since the chip says how much is waiting on you.
   */
  cards: Card[];
  /** How many things need you, which is what the chip says: the workspaces' and the cards'. */
  count: number;
  /** In how many workspaces — the cards are in none. */
  inWorkspaces: number;
}

/**
 * The columns whose cards are somebody's: a card in To do is a reminder and
 * a card in Done is finished, and an agent still open on either is treated
 * as nobody's card's — it shows as itself, if it shows at all.
 */
const CLAIMING = new Set(["doing", "review"]);

export function needsOf(profile: Profile, agents: readonly AgentSnapshot[]): ProfileNeeds {
  const harness = profile.harness?.agentId ?? null;
  const byId = new Map<string, AgentSnapshot>();
  for (const agent of agents) if (!agent.exited && agent.id !== harness) byId.set(agent.id, agent);

  // Which workspace each terminal lives in, read off the layouts the way the
  // sidebar reads it — a terminal is in exactly one pane of one workspace.
  const home = new Map<string, string>();
  for (const workspace of profile.workspaces) {
    for (const pane of panes(workspace.layout)) {
      for (const id of terminalsOf(pane.agentIds)) home.set(id, workspace.id);
    }
  }

  // A card's agent is the card's wherever its tab was dragged to, so it is
  // claimed across the profile before any workspace is looked at.
  const claimed = new Set<string>();
  for (const workspace of profile.workspaces) {
    for (const card of workspace.board?.cards ?? []) {
      if (CLAIMING.has(card.column) && card.run?.agentId) claimed.add(card.run.agentId);
    }
  }

  const workspaces: WorkspaceNeeds[] = profile.workspaces.map((workspace) => {
    const needs: Need[] = [];
    for (const card of workspace.board?.cards ?? []) {
      const need = cardNeed(workspace.id, card, byId);
      if (need) needs.push(need);
    }
    const here = agents.filter((agent) => byId.has(agent.id) && home.get(agent.id) === workspace.id);
    for (const agent of here) {
      if (claimed.has(agent.id)) continue;
      const kind = agentNeed(agent);
      if (kind) needs.push({ kind, workspaceId: workspace.id, agent, card: null, plainDone: false });
    }
    // Stable, so that among the asking the order is still the board's and the sidebar's.
    needs.sort((a, b) => Number(b.kind === "asking") - Number(a.kind === "asking"));
    const working = here.filter((agent) => agent.status === "working");
    const band: Band = needs.length ? "needs" : working.length ? "working" : "quiet";
    return { workspace, band, needs, working };
  });

  const cards = columnCards(profile.board, NEEDS_COLUMN);
  const count = workspaces.reduce((n, w) => n + w.needs.length, cards.length);
  const inWorkspaces = workspaces.filter((w) => w.band === "needs").length;
  return { workspaces, cards, count, inWorkspaces };
}

/**
 * A card's need, or null. Only In progress and Review can have one: Review
 * is the whole of what the column means, and In progress wants you only
 * when its agent does — a question, a turn that ended unseen — or when the
 * agent has gone without finishing, which leaves a card nothing will move.
 * An agent that went to sleep went on purpose and finished first, and its
 * card, if it still wants anybody, is in Review.
 */
function cardNeed(workspaceId: string, card: Card, agents: ReadonlyMap<string, AgentSnapshot>): Need | null {
  if (!CLAIMING.has(card.column)) return null;
  const agent = (card.run?.agentId && agents.get(card.run.agentId)) || null;
  const need = (kind: NeedKind): Need => ({
    kind,
    workspaceId,
    agent,
    card,
    plainDone: kind !== "asking" && doneRefusal(card, agent) === null,
  });
  if (agent?.status === "blocked") return need("asking");
  if (card.column === "review") return need("review");
  if (agent?.unread) return need("unseen");
  if (card.run && card.run.state === "ended") return need("stalled");
  return null;
}

/**
 * Why a move to Done is not a plain one, or null when it is: a card in
 * Review with no worktree to merge and no terminal left open to end — the
 * two questions the board's dialog asks. `Need.plainDone` is this being
 * null, and a node asked by another to move one of its cards to Done
 * (`card-done-ask`, `docs/nodes.md`) asks it again at that moment and says
 * the sentence when it is not, since the card may have moved on since the
 * summary that drew the button. `agent` is the card's live terminal, if any.
 */
export function doneRefusal(card: Card, agent: AgentSnapshot | null): string | null {
  if (card.column === "done") return "It is in Done already.";
  if (card.column !== "review") return "It is not in Review any more.";
  if (agent?.status === "blocked") return "Its agent is asking something.";
  if (card.worktree !== null) return "Its worktree is still standing, and its board asks whether to merge it first.";
  if (agent !== null) return "Its agent is still open, and its board asks whether to end it first.";
  return null;
}

/**
 * An agent's own need, for one no card claims. `blocked` only ever comes
 * from the agent saying so, so it needs no second test; `unread` is the
 * server's mark for a turn that ended while nobody watched, and a shell
 * that finished an `ls` off screen earns the same mark for nothing, which
 * is why the row has to have held an agent.
 */
function agentNeed(agent: AgentSnapshot): NeedKind | null {
  if (agent.status === "blocked") return "asking";
  if (agent.unread && (agent.agent || agent.lastAgent)) return "unseen";
  return null;
}

/** Every need in the order the drawer walks them: workspace by workspace, as `needsOf` sorted them. */
export function allNeeds(needs: ProfileNeeds): Need[] {
  return needs.workspaces.flatMap((w) => w.needs);
}

/**
 * The need to go to next, from where you are: the one after the need you
 * are on, round to the first, or the first when you are on none. The
 * current need is the one whose terminal has the keyboard, or — for a card
 * with no terminal — whose workspace is on screen with its board showing.
 * Stepping from the one you are on rather than always going to the first
 * is what lets you leave one for later: a prompt you are not ready to
 * answer would otherwise be the only place Next ever went.
 */
export function nextNeed(
  needs: ProfileNeeds,
  at: { focusedAgentId: string | null; workspaceId: string | null; boardShowing: boolean },
): Need | null {
  const all = allNeeds(needs);
  if (all.length === 0) return null;
  const here = all.findIndex((need) =>
    need.agent ? need.agent.id === at.focusedAgentId : need.workspaceId === at.workspaceId && at.boardShowing,
  );
  return here === -1 ? all[0]! : all[(here + 1) % all.length]!;
}
