/**
 * What to call a terminal, what to say it is doing, and how to shorten a path.
 *
 * Two places need the same answer — the sidebar and the pane's own bar — and a
 * terminal that is called one thing in the list and another on screen is a
 * terminal you have to look twice at.
 *
 * There are two questions, not one, and keeping them apart is the whole shape of
 * this module. *What is this* is answered by the program running in the pty and
 * changes about twice in a terminal's life. *What is it doing* changes every
 * turn. A row that puts the second where the first goes is a row whose top line
 * moves while you are reading it, and the sidebar's whole layout — stable line
 * above, live line below — depends on the two never being confused.
 */
import type { AgentSnapshot } from "../../shared/model";

/**
 * What a terminal *is*: a name the user typed, else the program actually running
 * in it.
 *
 * A rename wins over everything and is never overwritten — it is the only answer
 * that knows what somebody meant. After that it is the process table rather than
 * what we launched, because a shell reports itself as a shell until you type
 * `claude` into it, at which point it starts calling itself claude, which is the
 * honest answer.
 *
 * Deliberately *not* the title the program set for itself, however useful that
 * is: see `agentSummary`, which is where that belongs. A label that renamed
 * itself every turn would be a label you cannot find anything by.
 */
export function agentLabel(agent: AgentSnapshot): string {
  if (agent.titleOverride) return agent.titleOverride;
  if (agent.agent) return agent.agent;
  /**
   * A dead pty reports no program, because there is no process to find one in.
   * What it *was* is then the only true thing left to call it, and it is a far
   * better label than "exited" — the dot and the strikethrough already say it is
   * gone, so the word was spending the whole row saying that twice.
   *
   * Only when it has exited. A live shell that has run claude and come back to a
   * prompt is a shell again, and calling it claude would be claiming a process
   * that is not there.
   */
  if (agent.exited) return agent.lastAgent ?? "exited";
  return agent.kind === "shell" ? basename(agent.command) : "starting…";
}

/**
 * What a terminal is *doing*, in one line, from whichever half of kururu knows.
 *
 * Two sources, and the order is the same argument `status.ts` makes about a
 * reported status beating a guessed one. `activity` is an agent telling kururu
 * outright, through the report endpoint a Claude Code hook posts to — the prompt
 * it was handed, the thing it is asking permission for. Nothing beats being
 * told. The title is what it says when nobody asked: claude writes a summary of
 * the turn into its window title once it has had a prompt, which arrives for
 * free with no hook installed and is the reason this line is usually populated
 * at all.
 *
 * Null when neither has said anything, so the caller can decide what a terminal
 * with nothing to report is worth saying about — which is not the same decision
 * in a tab as it is in a list.
 */
export function agentSummary(agent: AgentSnapshot): string | null {
  return agent.activity || agent.title || null;
}

/**
 * What a tab is called, which is one line for both questions.
 *
 * A tab strip has no second row to put the summary on, so it has to choose, and
 * the summary wins: a pane holding four claudes labelled "claude" four times is
 * a strip you navigate by position rather than by reading. What it *is* is not
 * lost — the status mark is beside it and the tooltip spells the rest out — and
 * the moment the summary is missing, which is a fresh agent or a plain shell,
 * this falls straight back to the name.
 *
 * A rename still comes first. Somebody who typed a name for a tab meant it to
 * stay there, and a summary that overwrote it every turn would make the rename
 * look broken.
 */
export function tabLabel(agent: AgentSnapshot): string {
  return agent.titleOverride || agentSummary(agent) || agentLabel(agent);
}

/**
 * The word for a status dot, for the tooltip on it.
 *
 * A colour is only legible to somebody who already knows the code, and nothing
 * else on screen teaches it — which makes the difference between "still going"
 * and "finished and waiting for you", the one distinction the dot exists for,
 * a thing you have to be told once. `done` and `blocked` say what they mean
 * rather than just naming themselves for that reason.
 *
 * Here rather than in either component because both the sidebar and the tab
 * strip draw the same dot, and two vocabularies for one colour would be worse
 * than none.
 */
export function statusLabel(agent: AgentSnapshot): string {
  if (agent.exited) {
    return agent.exitCode === null ? "exited" : `exited (${agent.exitCode})`;
  }
  switch (agent.status) {
    case "working":
      return "working";
    case "done":
      return "done — finished a turn";
    case "blocked":
      return "blocked — waiting for you";
    default:
      return "idle";
  }
}

export function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

/** `/Users/me/Desktop/Nyto/kururu` → `…/Nyto/kururu`. Enough to tell projects apart. */
export function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}
