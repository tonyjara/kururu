/**
 * Which agent program runs in each pty, as this server reads it — for the names
 * a pty host started before them cannot read.
 *
 * The host is the one that answers the question (`agents/procs.ts`, every two
 * seconds), and it answers it with the list of names it was started with. That
 * list is in the half of kururu that is never restarted on purpose: `agy` was
 * added to it while a host that had been up for a week went on reading every
 * Antigravity pane as a plain shell. A shell is not listed in the sidebar,
 * has no card's agent and no links, so the agents were running and nowhere to
 * be seen — and the only fix on the host's side is a restart that ends every
 * one of them.
 *
 * So this side reads the same table it already reads for the dev servers and
 * the memory column (`proctable.ts`), with the server's own copy of the names,
 * which is as new as the server, and fills in a program where the host said
 * none. Only there: where the host names a program, it is the host's answer,
 * and the two cannot fight over a pane. A host that knows every name makes this
 * a pass that changes nothing; it stays on rather than being gated on the host's
 * protocol, because a name added to the list is not a protocol change and
 * nothing would have bumped the number for it.
 *
 * Rejected: putting the correction in `hostlink.ts`, where the snapshot
 * arrives. That file is the host's protocol as well as the server's end of it,
 * and the rule is to keep host files out of a fix that must not need the host.
 */
import type { AgentSnapshot } from "../../shared/model";
import { DEFAULT_AGENT_COMMANDS, findAgents, type ProcTable } from "./agents/procs";
import type { ProcRows } from "./proctable";

/**
 * Agent id → the program found under its pty, for every live pty the host has
 * left blank. One walk over the table for all of them, as the host's is.
 *
 * `foreground` is not in the server's table and is set false throughout; it
 * only breaks a tie between two matches at the same depth, which a pane
 * running one agent does not have.
 */
export function programsUnder(
  agents: readonly AgentSnapshot[],
  rows: ProcRows,
  names: string[] = DEFAULT_AGENT_COMMANDS,
): Map<string, string> {
  const roots: [string, number][] = [];
  for (const agent of agents) {
    if (agent.exited || agent.agent) continue;
    if (Number.isInteger(agent.pid) && agent.pid > 0) roots.push([agent.id, agent.pid]);
  }
  if (roots.length === 0) return new Map();
  const table: ProcTable = new Map();
  for (const row of rows.values()) table.set(row.pid, { pid: row.pid, ppid: row.ppid, foreground: false, args: row.args });
  const out = new Map<string, string>();
  for (const [id, found] of findAgents(roots, table, names)) out.set(id, found.kind);
  return out;
}

/**
 * The host's list with the programs it could not name filled in. The same
 * array back when there is nothing to fill, so a reader comparing by identity
 * sees no change; an agent that is filled is a new object, never edited in
 * place, because the host's list is the one `hostlink.ts` holds.
 */
export function fillPrograms(agents: AgentSnapshot[], found: ReadonlyMap<string, string>): AgentSnapshot[] {
  if (found.size === 0) return agents;
  let changed = false;
  const out = agents.map((agent) => {
    const name = found.get(agent.id);
    if (!name || agent.agent || agent.exited) return agent;
    changed = true;
    return { ...agent, agent: name };
  });
  return changed ? out : agents;
}

/**
 * The fill, kept across the host's pushes and this server's polls.
 *
 * The host's list comes in whole on every push (`host.agents` is replaced), and
 * the poll runs on a timer of its own, so either can be the newer. `apply` is
 * handed whatever `host.agents` now is: a list it did not hand out itself is the
 * host's own and becomes the one filled in, and one it did is filled again from
 * the host's list it was made from — which is how a program that has exited
 * stops being claimed, rather than staying on the filled copy forever.
 */
export class ProgramCover {
  private found = new Map<string, string>();
  private hosts: AgentSnapshot[] = [];
  private shown: AgentSnapshot[] = [];

  /** `agents` with the fill applied. Assign the answer back to `host.agents`. */
  apply(agents: AgentSnapshot[]): AgentSnapshot[] {
    if (agents !== this.shown) this.hosts = agents;
    this.shown = fillPrograms(this.hosts, this.found);
    return this.shown;
  }

  /** The host's own list, unfilled — what the next poll reads for the blanks. */
  hostList(): readonly AgentSnapshot[] {
    return this.hosts;
  }

  /** A new reading. True when it changes what `apply` would fill in. */
  update(found: Map<string, string>): boolean {
    const same = found.size === this.found.size && [...found].every(([id, name]) => this.found.get(id) === name);
    if (same) return false;
    this.found = found;
    return true;
  }
}

export const programs = new ProgramCover();
