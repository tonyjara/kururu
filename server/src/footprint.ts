/**
 * Reading one terminal's process tree for what is in it, not only how big it is.
 *
 * `memory.ts` adds a tree up every five seconds for the sidebar, and reads the
 * narrowest `ps` it can to do it, because it runs forever. This runs when
 * Settings' Processes page asks and at no other time, so it can afford the
 * column that poll refuses: argv. With argv a tree stops being a number and
 * becomes "a claude, an nvim and a vite", which is the sentence somebody
 * deciding what to close wants to read.
 *
 * Counting is the decision worth stating. A process counts as an agent, an
 * editor or a dev server unless something above it in the same tree already
 * counted as the same thing — nvim forks an `nvim --embed` under itself, claude
 * runs its hooks and MCP servers under itself, and `bun run dev` is a bun under
 * a bun. One of each is what the person started; the descendants are its own
 * business and its memory, which is added to the terminal regardless.
 *
 * The matching is borrowed rather than written again: `matchAgentCommand` from
 * the tab-label detection, `matchDevCommand` from the dev-server scan. They have
 * already been taught the ways a command line lies, and a page that disagreed
 * with the sidebar about whether a tab has a claude in it would be worse than no
 * page at all.
 *
 * Outside `agents/` for the reason `nvim.ts` is: it reads the process table and
 * touches no pty, so changing it never costs anybody a running agent.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { DEFAULT_AGENT_COMMANDS, matchAgentCommand } from "./agents/procs";
import { matchDevCommand } from "./devservers";

export interface FootProc {
  pid: number;
  ppid: number;
  /** Bytes. `ps` prints kilobytes on macOS and Linux both. */
  rss: number;
  /**
   * When it started, as `ps` spells it. A pid alone names a process only until
   * it exits, and the Processes page signals nvims by what it showed seconds
   * earlier — so a process is the pid *and* this, and a recycled pid with a
   * different start is a different process that nothing here will touch.
   */
  start: string;
  args: string;
}

export type FootTable = Map<number, FootProc>;

/** `lstart` is fixed-format under the C locale: `Fri Oct  9 15:11:56 2026`. */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s?(.*)$/;

/** `ps -eo pid=,ppid=,rss=,lstart=,args=` into pid → process. */
export function parseFootTable(out: string): FootTable {
  const table: FootTable = new Map();
  for (const line of out.split("\n")) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    table.set(pid, {
      pid,
      ppid: Number(m[2]) || 0,
      rss: (Number(m[3]) || 0) * 1024,
      start: m[4]!.replace(/\s+/g, " "),
      // Only the head of a line names a program, and claude's runs to kilobytes.
      // ps pads `lstart` out to a column, so what follows it starts with spaces.
      args: m[5]!.trimStart().slice(0, 300),
    });
  }
  return table;
}

export type Classified =
  | { kind: "agent"; name: string }
  | { kind: "editor" }
  | { kind: "dev"; name: string }
  | null;

/** Editors worth counting. Matched on the executable's own name. */
const EDITORS = new Set(["nvim", "vim"]);

/**
 * What one command line is, if it is anything worth counting. Agent first,
 * because `npx claude` is an agent and not a dev server; editor before dev
 * server, because nothing that is an editor is also a dev server and the check
 * is cheaper.
 */
export function classify(args: string, names: string[] = DEFAULT_AGENT_COMMANDS): Classified {
  const agent = matchAgentCommand(args, names);
  if (agent) return { kind: "agent", name: agent };
  const head = args.trim().split(/\s+/, 1)[0] ?? "";
  if (EDITORS.has(basename(head).toLowerCase())) return { kind: "editor" };
  const dev = matchDevCommand(args);
  if (dev) return { kind: "dev", name: dev };
  return null;
}

export interface TreeReading {
  rss: number;
  processes: number;
  agents: string[];
  editors: number;
  devServers: string[];
}

/** Backstop so a fork bomb in a pty cannot make the page expensive. */
const MAX_VISITED = 4000;

export function childIndex(table: FootTable): Map<number, FootProc[]> {
  const index = new Map<number, FootProc[]>();
  for (const proc of table.values()) {
    const siblings = index.get(proc.ppid);
    if (siblings) siblings.push(proc);
    else index.set(proc.ppid, [proc]);
  }
  return index;
}

/**
 * Everything under `rootPid`: its memory added up, and each agent, editor and
 * dev server in it counted once — see the module comment for "once". Null when
 * the root is not in the table, which is a terminal that has exited and a
 * different answer from an empty one.
 */
export function readTree(
  rootPid: number,
  table: FootTable,
  children: Map<number, FootProc[]>,
  names: string[] = DEFAULT_AGENT_COMMANDS,
): TreeReading | null {
  const root = table.get(rootPid);
  if (!root) return null;
  const out: TreeReading = { rss: 0, processes: 0, agents: [], editors: 0, devServers: [] };
  const seen = new Set<number>();
  // Each entry carries which kinds its ancestors already counted as.
  const stack: Array<[FootProc, ReadonlySet<string>]> = [[root, new Set()]];
  while (stack.length > 0 && seen.size < MAX_VISITED) {
    const [proc, inside] = stack.pop()!;
    if (seen.has(proc.pid)) continue;
    seen.add(proc.pid);
    out.rss += proc.rss;
    out.processes++;
    let below = inside;
    const found = classify(proc.args, names);
    if (found && !inside.has(found.kind)) {
      if (found.kind === "agent") out.agents.push(found.name);
      else if (found.kind === "editor") out.editors++;
      else out.devServers.push(found.name);
      below = new Set(inside).add(found.kind);
    }
    for (const kid of children.get(proc.pid) ?? []) stack.push([kid, below]);
  }
  return out;
}

/**
 * The pty host's pid, found as the parent the ptys share — the host does not
 * say its pid and there is no reason it should have to. Only believed when that
 * parent's argv names it, so a terminal reparented to launchd is not mistaken
 * for kururu.
 */
export function hostPidOf(roots: Iterable<number>, table: FootTable): number | null {
  const votes = new Map<number, number>();
  for (const pid of roots) {
    const ppid = table.get(pid)?.ppid;
    if (ppid) votes.set(ppid, (votes.get(ppid) ?? 0) + 1);
  }
  const [best] = [...votes].sort((a, b) => b[1] - a[1]);
  if (!best) return null;
  return table.get(best[0])?.args.includes("ptyhost") ? best[0] : null;
}

const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * The whole table, argv and start times included. Empty when ps fails. The C
 * locale because `lstart` is spelled in the user's language otherwise, and the
 * parser reads English day and month names.
 */
export function readFootTable(): Promise<FootTable> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-eo", "pid=,ppid=,rss=,lstart=,args="],
      { maxBuffer: MAX_BUFFER, env: { ...process.env, LC_ALL: "C" } },
      (err, stdout) => resolve(err && !stdout ? new Map() : parseFootTable(stdout)),
    );
  });
}

// ---------------------------------------------------------------------------
// Every nvim on the machine
// ---------------------------------------------------------------------------

/** An nvim the Processes page can show and close, wherever it is running. */
export interface FoundNvim {
  pid: number;
  start: string;
  args: string;
  /** Its whole tree, top first: the UI, the core under it, its language servers. */
  pids: number[];
  rss: number;
  /** The kururu pty it is in, by the pty's pid, or null when it is outside kururu. */
  ptyRoot: number | null;
  /** An agent program between that pty and the editor — the agent's `$EDITOR`. */
  underAgent: boolean;
  /** Outside kururu, the program at the top of its ancestry: the terminal app, tmux, sshd. */
  app: string | null;
}

/** Whether a command line is an nvim — the program, not a file somebody named nvim. */
function isNvimArgs(args: string): boolean {
  const head = args.trim().split(/\s+/, 1)[0] ?? "";
  return basename(head) === "nvim";
}

/**
 * Not every process called nvim is an editor. `nvim --server … --remote-expr`
 * is a client — kururu's own server runs one for every question it asks an
 * editor — and the rest are one-shot queries that are gone before anybody
 * could close them.
 */
const NOT_AN_EDITOR = /\s(--remote[\w-]*|--api-info|--version|-v)(\s|$)/;

/** Ancestry is shallow; this bounds a walk through a table that is changing under it. */
const MAX_ANCESTRY = 64;

/**
 * What to call the program an nvim outside kururu is running under, from the
 * command line of the process at the top of its ancestry. An app bundle by its
 * bundle name, outermost first — VS Code's helpers are bundles inside a bundle,
 * and "Visual Studio Code" is the one a person knows it by. Another kururu's pty
 * host says so, because "node" would be no help to anybody.
 */
export function appName(args: string): string | null {
  const bundle = /\/([^/]+)\.app\//.exec(args);
  if (bundle) return bundle[1]!;
  if (args.includes("ptyhostd")) return "another kururu";
  const head = args.trim().split(/\s+/, 1)[0] ?? "";
  // `-zsh` is a login shell, `sshd:` is sshd renaming itself after the session.
  return basename(head).replace(/^-|:$/g, "") || null;
}

/**
 * Every nvim on the machine, once each, with what it costs and where it is.
 *
 * Once each means the topmost nvim in a chain: since 0.11 typing `nvim` gets a
 * UI with the editor running under it as `nvim --embed`, and a plugin's
 * `nvim --headless` job is the editor's business — so an nvim with an nvim above
 * it is part of that one, and its memory is added to it with everything else
 * underneath. An `nvim --embed` with no nvim above it is an editor somebody
 * else is drawing (VS Code's extension, a GUI), and is one.
 *
 * Where is decided walking up: a pid in `ptyRoots` is a kururu terminal, and
 * otherwise the walk runs to the top and names the app there.
 */
export function findNvims(
  table: FootTable,
  children: Map<number, FootProc[]>,
  ptyRoots: ReadonlySet<number>,
  names: string[] = DEFAULT_AGENT_COMMANDS,
): FoundNvim[] {
  const found: FoundNvim[] = [];
  for (const proc of table.values()) {
    if (!isNvimArgs(proc.args) || NOT_AN_EDITOR.test(` ${proc.args}`)) continue;
    let ptyRoot: number | null = null;
    let underAgent = false;
    let top = proc;
    let nested = false;
    // Up to launchd and not onto it: the app is what launchd started, and an
    // nvim whose terminal went away is adopted by launchd and has no app at all.
    for (let up = table.get(proc.ppid), depth = 0; up && up.pid > 1 && depth < MAX_ANCESTRY; up = table.get(up.ppid), depth++) {
      if (isNvimArgs(up.args)) {
        nested = true;
        break;
      }
      if (classify(up.args, names)?.kind === "agent") underAgent = true;
      if (ptyRoots.has(up.pid)) {
        ptyRoot = up.pid;
        break;
      }
      top = up;
    }
    if (nested) continue;
    const pids: number[] = [];
    const seen = new Set<number>();
    let rss = 0;
    const stack = [proc];
    while (stack.length > 0 && seen.size < MAX_VISITED) {
      const next = stack.pop()!;
      if (seen.has(next.pid)) continue;
      seen.add(next.pid);
      pids.push(next.pid);
      rss += next.rss;
      for (const kid of children.get(next.pid) ?? []) stack.push(kid);
    }
    found.push({
      pid: proc.pid,
      start: proc.start,
      args: proc.args,
      pids,
      rss,
      ptyRoot,
      underAgent: ptyRoot !== null && underAgent,
      app: ptyRoot === null && top !== proc ? appName(top.args) : null,
    });
  }
  return found.sort((a, b) => b.rss - a.rss);
}
