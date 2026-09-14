/**
 * Which agent program is running inside a pty, found by asking the kernel.
 *
 * Kururu launches something — a shell, or an agent directly — and what is
 * actually running a moment later is a different question. You start a shell and
 * type `claude`; you exit claude and get the shell back. So the tab label comes
 * from a walk of the process tree under the pty's own pid, not from the argv we
 * spawned with. Same principle as dev-server discovery next door: ask the
 * kernel, do not parse intent out of a command line.
 *
 * Lifted from ghosttown's `src/core/procs.ts` — the agent-detection slice only,
 * not the dev-server half, which kururu already has its own copy of. The pure
 * string work is unchanged, because it has already been taught about the ways a
 * command line lies. The one edit is how `ps` is run: Bun.spawn became execFile.
 */
import { execFile } from "node:child_process";

/**
 * Commands that mean "an agent lives here". Matched on the executable name, so
 * a full path, a `node .../claude-code/cli.js` install, and a bare `claude` all
 * hit the same entry.
 */
export const DEFAULT_AGENT_COMMANDS = [
  "claude",
  "codex",
  "gemini",
  "aider",
  "opencode",
  "amp",
  "cursor-agent",
  "goose",
  "crush",
  "droid",
  "copilot",
  "qwen",
  "cline",
];

/** Interpreters worth looking past: the agent is the *script* they were given. */
const LAUNCHERS = new Set([
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "npx",
  "bunx",
  "uv",
  "uvx",
  "pnpm",
  "yarn",
  "sh",
  "bash",
  "zsh",
  "env",
]);

/**
 * Tokens of a command line that may name the program. Stopping early keeps a
 * flag *value* from matching — Claude Code is launched with a 2 KB `--settings`
 * blob that mentions "claude" a dozen times.
 */
const MAX_TOKENS = 3;
/** Depth cap on the descendant walk; agents sit at 1-2 hops from the shell. */
const MAX_DEPTH = 6;
/** Backstop so a fork bomb in a pty cannot make the poll expensive. */
const MAX_VISITED = 4000;

const SCRIPT_EXT = /\.(js|mjs|cjs|ts|py|rb|sh)$/;

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** In its terminal's foreground process group — the `+` in ps STAT. */
  foreground: boolean;
  /** argv joined, as ps prints it (macOS truncates around 2 KB). */
  args: string;
}

export type ProcTable = Map<number, ProcInfo>;

/** An agent program found running inside a pty. */
export interface AgentProc {
  /** The name that matched ("claude", "codex", …). */
  kind: string;
  pid: number;
  /** Hops from the pty's own process (0 = the pty runs it directly). */
  depth: number;
  foreground: boolean;
}

function basename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/** Executable name: no directory, no script extension, no shell quoting. */
function programName(token: string): string {
  return basename(token).replace(/^['"]+/, "").replace(SCRIPT_EXT, "").toLowerCase();
}

function nameMatches(candidate: string, names: string[]): string | null {
  for (const name of names) {
    if (candidate === name || candidate.startsWith(`${name}-`)) return name;
  }
  return null;
}

/** A `-flag` or a `VAR=value` prefix — neither one names the program. */
function isPreamble(token: string): boolean {
  return token.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/**
 * The agent name a command line is running, or null. Pure string work over the
 * leading tokens of one `ps` line.
 *
 * Only the executable can name the agent — a path argument must not, or `vim
 * ~/claude/notes.md` would read as an agent. The one exception is an
 * interpreter: `node …/@anthropic-ai/claude-code/cli.js` *is* claude, so when
 * token 0 is a launcher the script it was handed is examined too, path segments
 * included.
 */
export function matchAgentCommand(args: string, names: string[]): string | null {
  if (!args) return null;
  const tokens = args.trim().split(/\s+/, MAX_TOKENS);
  const head = tokens[0];
  if (!head) return null;
  const direct = nameMatches(programName(head), names);
  if (direct) return direct;
  if (!LAUNCHERS.has(programName(head))) return null;

  for (const token of tokens.slice(1)) {
    if (isPreamble(token)) continue;
    const script = nameMatches(programName(token), names);
    if (script) return script;
    // "…/@anthropic-ai/claude-code/cli.js": the package directory is the name.
    for (const segment of token.toLowerCase().split("/")) {
      const hit = segment && nameMatches(programName(segment), names);
      if (hit) return hit;
    }
    return null; // the script has been seen and it is not an agent
  }
  return null;
}

/** One `ps -eo pid=,ppid=,stat=,args=` line. */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/;

export function parseProcTable(stdout: string): ProcTable {
  const table: ProcTable = new Map();
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    table.set(pid, {
      pid,
      ppid: Number(m[2]) || 0,
      foreground: m[3]!.includes("+"),
      // Only the head of the line can name a program (see MAX_TOKENS), and
      // agent command lines run to kilobytes.
      args: m[4]!.slice(0, 300),
    });
  }
  return table;
}

/** ppid → children, built once per poll and shared by every agent's walk. */
export function childIndex(table: ProcTable): Map<number, ProcInfo[]> {
  const index = new Map<number, ProcInfo[]>();
  for (const proc of table.values()) {
    const siblings = index.get(proc.ppid);
    if (siblings) siblings.push(proc);
    else index.set(proc.ppid, [proc]);
  }
  return index;
}

/**
 * The agent running in (or under) `rootPid`. Breadth-first, so the shallowest
 * match wins: Claude Code's own hook subprocesses are children of the claude
 * that matters, and would otherwise shadow it. A foreground match still beats a
 * deeper background one — that is the program the user is actually talking to.
 */
export function findAgentUnder(
  rootPid: number,
  table: ProcTable,
  children: Map<number, ProcInfo[]>,
  names: string[],
): AgentProc | null {
  const root = table.get(rootPid);
  if (!root) return null;
  let best: AgentProc | null = null;
  let visited = 0;
  let frontier: ProcInfo[] = [root];
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
    const next: ProcInfo[] = [];
    for (const proc of frontier) {
      if (++visited > MAX_VISITED) return best;
      const kind = matchAgentCommand(proc.args, names);
      if (kind) {
        const found: AgentProc = { kind, pid: proc.pid, depth, foreground: proc.foreground };
        // Same depth: a foreground process is the one being interacted with.
        if (!best || (best.depth === depth && !best.foreground && found.foreground)) best = found;
      }
      const kids = children.get(proc.pid);
      if (kids) next.push(...kids);
    }
    // A match at this depth is as shallow as it gets; deeper ones are its own
    // helpers. Only keep descending while nothing has matched.
    if (best) return best;
    frontier = next;
  }
  return best;
}

/**
 * One pass for every agent: `roots` maps agent id → the pid of the program the
 * pty was opened on. Agents with nothing recognisable in them are absent.
 */
export function findAgents(
  roots: Iterable<[string, number]>,
  table: ProcTable,
  names: string[] = DEFAULT_AGENT_COMMANDS,
): Map<string, AgentProc> {
  const out = new Map<string, AgentProc>();
  if (table.size === 0) return out;
  const children = childIndex(table);
  for (const [id, pid] of roots) {
    const agent = findAgentUnder(pid, table, children, names);
    if (agent) out.set(id, agent);
  }
  return out;
}

/** Portable on macOS and Linux; `=` suppresses the header per column. */
const PS_ARGS = ["-eo", "pid=,ppid=,stat=,args="];
/** `ps` over a busy machine runs to a few hundred KB; the default 1 MB is not enough headroom. */
const PS_MAX_BUFFER = 8 * 1024 * 1024;

/** The whole process table. Empty map when ps fails — a failed poll is not an error. */
export function readProcTable(): Promise<ProcTable> {
  return new Promise((resolve) => {
    execFile("ps", PS_ARGS, { maxBuffer: PS_MAX_BUFFER }, (err, stdout) => {
      resolve(err ? new Map() : parseProcTable(stdout));
    });
  });
}
