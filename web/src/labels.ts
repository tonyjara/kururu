/**
 * How the window draws the answers, where `shared/labels.ts` decides them.
 *
 * The two that say *which terminal is this* moved down to `shared/` when the
 * server started composing notifications — see the header there. What is left
 * here is the part that is about drawing: a tab strip has one line and has to
 * choose which question to answer with it, a tooltip needs a word for a colour,
 * and a path needs shortening to the width of a column. None of those is a
 * thing the server has an opinion about.
 *
 * The two are re-exported rather than re-imported at each call site, because
 * `agentLabel` beside `tabLabel` is how they are read and a component asking two
 * modules for one row's worth of strings is a split with nothing behind it.
 */
import type { AgentSnapshot } from "../../shared/model";
import { agentLabel, agentSummary, basename } from "../../shared/labels";
import { remoteShellOf } from "../../shared/machines";

export { agentLabel, agentSummary, basename };

/**
 * The machine an agent tab runs on, or null for one on this Mac — what the
 * tab and the sidebar row put beside its name.
 *
 * Agents only. A shell on a machine is already called after it
 * (`agentLabel`), and a mark beside a name that says the same thing is the
 * name twice. An agent is called "claude" wherever it runs, and the two are
 * not the same thing to have: one here reports through its hooks, one there
 * is read off its screen, and the person deciding whether to trust a dot is
 * owed the difference.
 */
export function remoteHost(agent: AgentSnapshot): string | null {
  const remote = remoteShellOf(agent.command);
  return remote?.agent ? remote.host : null;
}

/** The tooltip's word on an agent on a machine: where it is, and what kururu cannot know about it from here. */
export function remoteNote(agent: AgentSnapshot): string | null {
  const host = remoteHost(agent);
  if (!host) return null;
  return (
    `Runs on ${host}, in tmux. Its status is read off its screen — kururu gets no hook reports from another machine yet — ` +
    "so done and blocked can come a few seconds late, a prompt it does not recognise is missed, and there is no context ring or transcript."
  );
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

/** `/Users/me/code/kururu` → `…/code/kururu`. Enough to tell projects apart. */
export function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}
