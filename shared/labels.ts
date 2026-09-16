/**
 * What to call a terminal, and what to say it is doing.
 *
 * These were in `web/src/labels.ts`, and the module comment there said two
 * places need the same answer — the sidebar and the pane's own bar. There are
 * three now: the server composes a notification, and a terminal called one thing
 * in the sidebar and another on the card that just interrupted you is a card you
 * have to go looking to match up. Which is the whole argument for moving the two
 * that answer *which terminal is this* down here, beside `countsAsAgent`, and
 * for exactly its reason — two spellings of one rule disagree on the case that
 * matters, and here that case is the notification you get for the agent you
 * renamed.
 *
 * What stayed in `web/` is what is about *drawing* rather than naming: a tab's
 * one line, the word on a tooltip, a path shortened for a column of a certain
 * width. The server has no opinion about any of those.
 *
 * There are two questions, not one, and keeping them apart is the shape of this
 * module. *What is this* is answered by the program running in the pty and
 * changes about twice in a terminal's life. *What is it doing* changes every
 * turn, and a row that puts the second where the first goes is a row whose top
 * line moves while you are reading it.
 */
import type { AgentSnapshot } from "./model";

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
 * in a tab as it is in a list, and is different again on a notification, where
 * the answer is to say nothing rather than to pad the card out.
 */
export function agentSummary(agent: AgentSnapshot): string | null {
  return agent.activity || agent.title || null;
}

export function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}
