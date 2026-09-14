/**
 * What to call a terminal, and how to shorten a path.
 *
 * Two places need the same answer — the sidebar and the pane's own bar — and a
 * terminal that is called one thing in the list and another on screen is a
 * terminal you have to look twice at.
 */
import type { AgentSnapshot } from "../../shared/model";

/**
 * The program actually running, if the process table found one; otherwise what
 * it was started as. A shell reports itself as a shell until you type `claude`
 * into it, at which point it starts calling itself claude — which is the honest
 * answer, and the reason `agent` is asked first.
 */
export function agentLabel(agent: AgentSnapshot): string {
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
