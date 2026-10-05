/**
 * What every terminal kururu holds is costing the machine, laid out the way a
 * person looks for it: by profile, by workspace, by tab.
 *
 * The sidebar already says how much memory one terminal has, and that answers
 * "which of these is heavy" for the rows you can see. It does not answer "how
 * many claudes do I have running across everything", or "is there an nvim in a
 * workspace I forgot about", and those are the questions that come before
 * closing things. This is the page that answers them, and the types are here
 * because both halves read them.
 *
 * Asked for rather than pushed. It is one `ps` with argv in it — twenty times
 * the read the sidebar's poll does — and it is wanted while one page of
 * Settings is open, so the page asks while it is open and nothing runs once it
 * is closed. See `server/src/footprint.ts` for how a tree is read.
 */
import type { AgentStatus, PtyKind, WorkspaceColor } from "./model";

/** One terminal, and what is running under it. */
export interface FootprintTerminal {
  agentId: string;
  /** What the tab is called, as `agentLabel` says it — the server's, since the
   *  client only holds the active profile's agents. */
  label: string;
  /** The second line the sidebar draws — what the program says it is on. */
  summary: string | null;
  kind: PtyKind;
  status: AgentStatus;
  exited: boolean;
  cwd: string;
  /** Resident set of everything under the pty, in bytes, unrounded. Null when
   *  the process is gone, which is what an exited terminal looks like. */
  rss: number | null;
  /** How many processes that is. */
  processes: number;
  /** Each agent program running in here — `["claude"]`, usually. */
  agents: string[];
  /** Editors (nvim, vim) running in here. */
  editors: number;
  /** Dev servers running in here, by the name that matched. */
  devServers: string[];
}

export interface FootprintWorkspace {
  id: string;
  name: string;
  color: WorkspaceColor | null;
  /** Terminal ids, in the order the panes hold them. */
  terminals: string[];
}

export interface FootprintProfile {
  id: string;
  name: string;
  active: boolean;
  workspaces: FootprintWorkspace[];
}

export interface Footprint {
  measuredAt: number;
  terminals: FootprintTerminal[];
  profiles: FootprintProfile[];
  /** Terminals the host holds that no tab in any profile does. */
  unplaced: string[];
  /** Kururu's own two processes. The window is a browser and is not counted. */
  kururu: { server: number | null; host: number | null };
  /** Physical memory, for scale. */
  machineTotal: number;
}

/** What a set of terminals adds up to — a workspace's, a profile's, all of them. */
export interface FootprintTally {
  rss: number;
  terminals: number;
  agents: number;
  editors: number;
  devServers: number;
  /** Live terminals with none of the above in them. */
  shells: number;
}

export function tally(terminals: readonly FootprintTerminal[]): FootprintTally {
  const out: FootprintTally = { rss: 0, terminals: 0, agents: 0, editors: 0, devServers: 0, shells: 0 };
  for (const t of terminals) {
    out.terminals++;
    out.rss += t.rss ?? 0;
    out.agents += t.agents.length;
    out.editors += t.editors;
    out.devServers += t.devServers.length;
    if (!t.exited && t.agents.length === 0 && t.editors === 0 && t.devServers.length === 0) out.shells++;
  }
  return out;
}

/** Agent programs by name, counted: `{ claude: 3, codex: 1 }`. */
export function agentKinds(terminals: readonly FootprintTerminal[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const t of terminals) for (const name of t.agents) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
