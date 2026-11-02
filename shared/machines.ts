/**
 * The user's other computers: what one is to kururu, how a sample of it is
 * read, and the command line that opens a shell — or an agent — on it.
 *
 * This began as the VPS row — a machine somebody rents to hold their
 * databases, which they want to glance at from the same sidebar that shows
 * what their agents are spending: is the CPU pinned, is the RAM full, is the
 * disk filling. A desktop on the same tailnet asks the same three questions
 * and is reached the same way, so the entry stopped being about renting and
 * became a machine. The list is still kept in `vps.json`, for the reason
 * `server/src/machines.ts` gives.
 *
 * The question was how to get the numbers, and the answer chosen is the one
 * that asks the machine for nothing: kururu runs `ssh` with the user's own
 * `~/.ssh/config`, and one fixed script reads `/proc` and `df`.
 *
 * The alternatives were each worse in a way that mattered. An agent on the box
 * (node_exporter, Netdata, Beszel) is a daemon to install, update and firewall,
 * and a port to open on a machine whose whole security story is that almost
 * none are. Dokploy's own monitoring endpoint is the same port problem plus a
 * token kururu would have to hold. SSH is already open, already key-only (or
 * Tailscale SSH, which is better), and already the thing the user uses to
 * reach the box — so the only new trust is that the kururu server may run
 * *one script it wrote itself* there. What that script is lives in
 * `server/src/machines.ts`, and no part of it ever comes from a client: a
 * client names a host and nothing else. `panel` is a link back to a dashboard
 * — Dokploy's, on the VPS — for whatever the numbers say needs doing.
 *
 * Three figures and no more — CPU, memory, disk. A first version also read
 * load, uptime, swap and `docker stats`, and was trimmed to what gets looked
 * at; `docker stats` alone was two seconds of work on the box every poll.
 *
 * The second half is the shell. A remote terminal is a *command* — `ssh -t`
 * in an ordinary pty the host already knows how to hold — and never a new
 * kind of terminal, because the host is the one process that costs the user
 * every agent to change, and a command line is the one thing it was always
 * going to run for whoever asked. So everything a remote tab is lives in the
 * line built here, and is read back out of it (`remoteShellOf`) by whatever
 * needs to know: the tab's label, the project scan that must not mistake the
 * local `~` ssh runs in for a project, and the close that ends its tmux
 * session. The line is the record because the server forgets everything on a
 * restart and the host never does.
 *
 * An agent on a machine is the same line with the agent's command typed into
 * the session instead of a plain prompt, and the CLI's name on the end so the
 * tab knows what it is. It gets one thing a shell does not: a check, typed
 * ahead of it, that the CLI is there and signed in (`AGENT_CHECK`), because
 * "command not found" and a login screen are what a missing one looks like
 * otherwise, and neither says which machine or what to do about it.
 *
 * Pure, and in `shared/` rather than beside the ssh call, because the parse
 * and the quoting are the parts worth testing and the wire types are the part
 * both halves import.
 */
import { AGENT_CLIS, type AgentCli } from "./launchers";
import { shq } from "./text";

/** One machine as the user entered it. Kept in `~/.config/kururu/vps.json`. */
export interface MachineEntry {
  id: string;
  /** What the sidebar calls it. */
  name: string;
  /**
   * What `ssh` is handed: an alias from `~/.ssh/config`, or `user@host`.
   * Checked by `validHost` everywhere it is read, because it lands in an argv.
   */
  host: string;
  /** A dashboard for it — Dokploy's, say — http(s) only, for the name to link to. */
  panel: string | null;
}

export interface MachineUsed {
  used: number;
  total: number;
}

/** One sample. Every figure is optional: a box with a `df` in another shape is still a box. */
export interface MachineReading {
  /** When it was taken. */
  at: number;
  /** Busy share of all cores over the second the script spent sleeping, 0–100. */
  cpu: number | null;
  /** Bytes, `used` meaning total minus *available* — page cache is not pressure. */
  mem: MachineUsed | null;
  /** The root filesystem, in bytes. */
  disk: MachineUsed | null;
}

/**
 * A machine and what is known about it, which is what crosses the wire.
 *
 * `stale` and `error` together, rather than dropping the reading on a failed
 * poll, for the usage bar's reason: numbers from a minute ago are still the best
 * known, and the one thing the row must not do is look current when it is not.
 */
export interface MachineStatus extends MachineEntry {
  reading: MachineReading | null;
  stale: boolean;
  /** Why the last attempt failed, in ssh's words, or null if it did not. */
  error: string | null;
}

/**
 * An ssh destination that cannot be read as an option.
 *
 * The one thing a client puts into a command line kururu runs, so the whole
 * grammar is spelt out rather than escaped: letters, digits, dot, dash and
 * underscore, one optional `user@`, and never a leading dash — `-oProxyCommand=…`
 * is a host name only to a parser that did not look.
 */
export function validHost(host: unknown): host is string {
  return (
    typeof host === "string" &&
    host.length <= 253 &&
    /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(host)
  );
}

/** An http(s) URL, normalised, or null. Anything else — `javascript:` first — is refused. */
export function validPanel(panel: unknown): string | null {
  if (typeof panel !== "string" || !panel.trim()) return null;
  try {
    const url = new URL(panel.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** A name worth drawing: trimmed, bounded, and the host when there is none. */
export function machineName(name: unknown, host: string): string {
  const trimmed = typeof name === "string" ? name.trim().slice(0, 40) : "";
  return trimmed || host;
}

/**
 * The saved list, adopted rather than trusted — it is a file a person can edit,
 * and it becomes an argv. An entry that fails is dropped rather than repaired,
 * and a duplicate id keeps the first.
 */
export function adoptMachineList(raw: unknown): MachineEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: MachineEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { id, name, host, panel } = item as Record<string, unknown>;
    if (typeof id !== "string" || !id || seen.has(id) || !validHost(host)) continue;
    seen.add(id);
    out.push({ id, name: machineName(name, host), host, panel: validPanel(panel) });
  }
  return out;
}

/**
 * What the collecting script prints between sections. A line of its own, which
 * nothing in `/proc` or `df` can produce.
 */
export const MACHINE_SEP = "@@kururu@@";

/**
 * Read one run of the script: the sections, in the order it prints them.
 *
 *   0 `/proc/stat`'s cpu line   1 meminfo (two lines)   2 `df -kP /`'s row
 *   3 the cpu line again
 *
 * The cpu line is read twice, a second apart, because a CPU percentage is a
 * rate and one sample of a counter is not one. Reading it across the script
 * rather than across two polls means the first reading after a start already
 * has a figure, and a missed poll never turns into a figure averaged over a
 * minute.
 */
export function parseMachineSample(text: string, at: number): MachineReading {
  const parts = text.split(`${MACHINE_SEP}\n`).map((part) => part.trim());
  const section = (i: number) => parts[i] ?? "";
  return {
    at,
    cpu: cpuBetween(section(0), section(3)),
    mem: memoryFrom(section(1)),
    disk: diskFrom(section(2)),
  };
}

/**
 * `cpu  user nice system idle iowait irq softirq steal guest guest_nice`.
 * Busy is everything but idle and iowait over the first eight — guest time is
 * already inside user, and counting it twice is how a box reads 110%.
 */
function cpuBetween(a: string, b: string): number | null {
  const fields = (line: string) => {
    const nums = line.split(/\s+/).slice(1, 9).map(Number);
    return nums.length === 8 && nums.every(Number.isFinite) ? nums : null;
  };
  const x = fields(a);
  const y = fields(b);
  if (!x || !y) return null;
  const total = (n: number[]) => n.reduce((s, v) => s + v, 0);
  const idle = (n: number[]) => n[3]! + n[4]!;
  const dt = total(y) - total(x);
  if (dt <= 0) return null;
  const busy = dt - (idle(y) - idle(x));
  return Math.min(100, Math.max(0, (busy / dt) * 100));
}

function memoryFrom(text: string): MachineUsed | null {
  const kb = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s+(\d+)\s*kB/.exec(line.trim());
    if (match) kb.set(match[1]!, Number(match[2]) * 1024);
  }
  const total = kb.get("MemTotal");
  const available = kb.get("MemAvailable");
  if (total === undefined || available === undefined || total <= 0) return null;
  return { used: Math.max(0, total - available), total };
}

/**
 * `df -kP /`: filesystem, 1024-blocks, used, available, capacity, mount. The
 * total is used plus available rather than the block count, because the blocks
 * reserved for root are in neither and `df`'s own percentage leaves them out
 * too — a bar that disagreed with `df` by five percent would be distrusted.
 */
function diskFrom(line: string): MachineUsed | null {
  const cols = line.split(/\s+/);
  const used = Number(cols[2]);
  const avail = Number(cols[3]);
  if (!Number.isFinite(used) || !Number.isFinite(avail) || used + avail <= 0) return null;
  return { used: used * 1024, total: (used + avail) * 1024 };
}

/**
 * Green, amber, red for a share of something finite.
 *
 * The usage bar refuses to pick thresholds because the account states its own.
 * A machine states nothing, so these are kururu's, and they are the ordinary
 * ones: a quarter left is worth a look, a tenth left is worth acting on.
 */
export function machineSeverity(percent: number): "normal" | "warning" | "critical" {
  return percent >= 90 ? "critical" : percent >= 75 ? "warning" : "normal";
}

/** Used as a percentage of total, or null when there is no total to be a share of. */
export function usedShare(part: MachineUsed | null): number | null {
  if (!part || part.total <= 0) return null;
  return Math.min(100, (part.used / part.total) * 100);
}

/** The fullest reading on any machine — see `worstLoad`. */
export interface WorstLoad {
  id: string;
  name: string;
  label: "CPU" | "RAM" | "Disk";
  percent: number;
}

/**
 * The fullest reading on any machine — which machine, which of CPU, memory
 * and disk, and how full — or null while no machine has reported one. It is
 * what colours the bottom bar's machines glyph and names the culprit in its
 * title, so that "something is maxing out" is one glance and "what" is one
 * hover. A stale reading counts: it is still the best thing known, and its
 * row says how old it is.
 */
export function worstLoad(machines: readonly MachineStatus[]): WorstLoad | null {
  let worst: WorstLoad | null = null;
  for (const machine of machines) {
    const reading = machine.reading;
    if (!reading) continue;
    const metrics: readonly (readonly [WorstLoad["label"], number | null])[] = [
      ["CPU", reading.cpu],
      ["RAM", usedShare(reading.mem)],
      ["Disk", usedShare(reading.disk)],
    ];
    for (const [label, percent] of metrics) {
      if (percent === null || !Number.isFinite(percent)) continue;
      if (!worst || percent > worst.percent) worst = { id: machine.id, name: machine.name, label, percent };
    }
  }
  return worst;
}

/** `8131476 * 1024` → `7.8G`. Binary units, one decimal under ten, because that is what `free -h` prints. */
export function formatBytes(n: number): string {
  const units = ["B", "K", "M", "G", "T"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const digits = value < 10 && i > 0 ? 1 : 0;
  return `${value.toFixed(digits)}${units[i]}`;
}

// ---------------------------------------------------------------------------
// A workspace that runs on a machine
// ---------------------------------------------------------------------------

/**
 * Where a workspace's terminals run, when it is not here: a machine by id, and
 * a folder on it.
 *
 * Terminals, and nothing that reads a disk. What the new-tab menu opens — a
 * shell, nvim, an agent — and a card's run are command lines, and a command
 * line can be run anywhere ssh reaches. The file tree, the reader, worktrees,
 * the database scan and dev-server discovery all read this Mac's disk and this
 * Mac's process table, and a remote one of each is a remote filesystem kururu
 * does not have — so they stay local, and the pages that show them say so
 * rather than drawing an empty tree as though there were nothing on the
 * machine.
 *
 * An id rather than the host, so that renaming the alias in Settings is not
 * re-pinning every workspace; an id that names no machine reads as no pin, on
 * `mascotId`'s reasoning, and removing a machine unpins what pointed at it.
 */
export interface MachinePin {
  machineId: string;
  /** `~`, `~/…` or an absolute path, as `validRemoteDir` holds it. */
  dir: string;
}

/** Long enough for any real path, short enough to be a line in a settings row. */
export const REMOTE_DIR_MAX = 300;

/**
 * A folder on another machine, or null.
 *
 * It lands inside a command line run by somebody else's shell — and since
 * ssh hands the remote half to whatever the login shell is, that may be bash,
 * zsh or fish, which do not agree about backslashes inside single quotes. So,
 * as with `validHost`, the grammar is spelt out instead of escaped: `~`, `~/…`
 * or `/…`, in letters, digits, space and `._-+@,:=/`. No quote, no `$`, no
 * backslash, nothing a shell gives a meaning to. Blank is home.
 *
 * `~` is not expanded here, because only the far side knows where its home is;
 * the script there does it (`REMOTE_SCRIPT`).
 */
export function validRemoteDir(dir: unknown): string | null {
  if (typeof dir !== "string") return null;
  const trimmed = dir.trim();
  if (!trimmed) return "~";
  if (trimmed.length > REMOTE_DIR_MAX) return null;
  if (!/^(?:~|~\/[A-Za-z0-9 ._\-+@,:=/]*|\/[A-Za-z0-9 ._\-+@,:=/]*)$/.test(trimmed)) return null;
  // `~/code/` and `~/code` are one folder, and the second is how it is shown.
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") || "/" : trimmed;
}

/** A pin off a blob or the disk: both halves valid, or nothing. */
export function adoptPin(raw: unknown): MachinePin | null {
  if (!raw || typeof raw !== "object") return null;
  const { machineId, dir } = raw as Record<string, unknown>;
  const folder = validRemoteDir(dir);
  return typeof machineId === "string" && machineId && folder ? { machineId, dir: folder } : null;
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

/**
 * What a tmux session kururu starts on a machine is called:
 * `kururu-<workspace>-<n>`.
 *
 * Named, rather than left to tmux's numbering, so that `tmux ls` on the
 * machine says whose each one is — and so that it can be found again. `n` is
 * the lowest that no tab already holds, which is what makes a session outlive
 * the pty host: after a restart every remote tab is gone, the sessions are
 * not, and the first shell opened in the workspace again takes `-1` and
 * reattaches to what was there. Lowercase, and nothing tmux reserves (`.` and
 * `:` are target syntax).
 */
export function sessionName(workspaceName: string, taken: Iterable<string>): string {
  const slug =
    workspaceName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/-+$/, "") || "ws";
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const name = `kururu-${slug}-${n}`;
    if (!used.has(name)) return name;
  }
}

/** A session name as `sessionName` makes one, which is the only kind a command line here may carry. */
const SESSION = /^kururu-[a-z0-9-]{1,40}$/;

/**
 * The script run on the machine, with the session, the folder, the command to
 * type and the agent CLI the tab runs as `$1 $2 $3 $4` (the last empty for
 * anything but an agent).
 *
 * It is a constant, for `server/src/machines.ts`'s reason, and it is quoted
 * once and handed to `sh -c` there rather than typed at the login shell, so
 * that one POSIX script works whichever shell the account has. It holds no
 * single quote and no backslash, which is what lets it ride inside single
 * quotes through bash, zsh and fish alike.
 *
 * In order: `~` is expanded here, where home is; a folder that is not there
 * is said and home used instead, rather than a shell that silently opens
 * somewhere else; a machine without tmux still gets a shell, and is told it
 * will not survive the connection. Otherwise the session is made detached
 * when it does not exist, the command typed into it — `send-keys -l`, so it
 * goes in as keystrokes at the prompt, in the user's shell, with its history
 * and its aliases, the way the harness types everything — and then attached.
 * A session that already exists is attached and *not* typed into, because a
 * reconnect re-runs this line and the command was for the first time.
 *
 * Before attaching, new session or old, the session is let pass a copy
 * through: `allow-passthrough` on its window, and a hook on the session that
 * says the same to every window opened in it later. Claude Code, among
 * others, wraps the `OSC 52` of its copies in tmux's passthrough when it finds
 * itself inside tmux, and tmux drops a wrapped sequence unless this is on —
 * so a copy made in a remote agent would never reach the Mac. Both are scoped
 * to this session, so nothing outside kururu's sessions on that machine
 * changes and its tmux.conf is never written. A tmux too old to know the
 * option (before 3.3) says so to /dev/null, and its sessions go on as they
 * were. Every attach rather than only the first, so a session made before
 * this line said so is put right by the next reconnect.
 *
 * `set-clipboard` is deliberately left alone, though it is the other half of
 * the same question. It is a *server* option: `set -t <session>` is accepted
 * and quietly applied to the whole server, every session the user has there
 * included. Its default, `external`, already sends tmux's own copies — copy
 * mode, a mouse drag, `load-buffer -w` — out as `OSC 52`, which is what this
 * needed; what only `on` adds is a program's *bare* `OSC 52` (nvim's `osc52`
 * provider), and that is the user's to turn on in their own config, not
 * kururu's to change for them under every other session they have.
 *
 * An agent's session also passes its window title out, which tmux keeps to
 * itself unless `set-titles` is on. Claude Code writes a summary of its task
 * there, and on this Mac that title is what an agent's tab is called by
 * (`agentSummary`); without it every remote agent would be a tab that says
 * "claude". Both are *session* options, so `-t "=$S:"` scopes them to this
 * session and no other — the bare `=$S` that `has-session` takes is refused
 * by `set-option` — and a shell's session is left as it was, because a
 * shell's title is its prompt's business and the tab is named after the
 * machine instead.
 *
 * The command arrives base64'd, which is the one encoding that survives a
 * local shell, ssh, a remote login shell and `sh -c` without any of them
 * having an opinion about it.
 */
export const REMOTE_SCRIPT = [
  `S=$1; D=$2; R=$3; A=$4`,
  `case $D in ""|"~") D=$HOME;; "~/"*) D=$HOME/\${D#"~/"};; esac`,
  `[ -d "$D" ] || { echo "kururu: there is no folder $D here, so this starts in $HOME" >&2; D=$HOME; }`,
  `if ! command -v tmux >/dev/null 2>&1; then echo "kururu: tmux is not installed here, so this shell ends when the connection does" >&2; cd "$D" || exit 1; [ -z "$R" ] || "\${SHELL:-/bin/sh}" -lc "$(printf %s "$R" | base64 -d)"; exec "\${SHELL:-/bin/sh}" -l; fi`,
  `if ! tmux has-session -t "=$S" 2>/dev/null; then tmux new-session -d -s "$S" -c "$D" || exit 1; [ -z "$R" ] || { tmux send-keys -t "=$S:" -l -- "$(printf %s "$R" | base64 -d)"; tmux send-keys -t "=$S:" Enter; }; fi`,
  `tmux set-option -w -t "=$S:" allow-passthrough on 2>/dev/null; tmux set-hook -t "=$S:" after-new-window "set-option -w allow-passthrough on" 2>/dev/null`,
  `[ -z "$A" ] || { tmux set-option -t "=$S:" set-titles on; tmux set-option -t "=$S:" set-titles-string "#T"; } 2>/dev/null`,
  `exec tmux attach-session -t "=$S"`,
].join("; ");

/**
 * What is typed ahead of an agent on a machine, with the CLI and the
 * machine's name as `$1 $2`: is it there, and is it signed in.
 *
 * Typed into the session's shell rather than run by `REMOTE_SCRIPT`, because
 * the question is whether the *interactive* shell can find the CLI — the one
 * the agent is about to be started in. ssh runs `REMOTE_SCRIPT` under a
 * non-interactive login, and on most accounts that never reads the rc file
 * where `~/.local/bin`, nvm or bun put themselves on the PATH; a check from
 * there would call a working install missing. The `sh -c` here inherits the
 * interactive shell's PATH, and `&&` after it means the agent's own line runs
 * only when the answer was yes. An install from before Claude Code's native
 * one is an alias to `~/.claude/local/claude`, which no child process can
 * see, so that path is looked at by name.
 *
 * Signed in is asked of the CLI itself — `claude auth status`, `codex login
 * status` — because only it knows every way it can be (a subscription, a key
 * in the environment, a key helper, a cloud provider). Each says so when it is
 * not — Codex as "Not logged in", Claude Code as `"loggedIn": false` — and
 * only that is taken as no: a crash, a timeout or a word it did not say is a
 * yes, and the agent starts and says whatever it says. Asked only once the CLI's own help shows it has the
 * subcommand, because an old Claude Code or Codex reads `auth status` as a
 * *prompt*, and would start a session on it — the one thing a check must
 * never do. `--help` starts nothing in either.
 *
 * Nothing in here may hold a single quote or a backslash: it is typed as one
 * single-quoted word into whatever the account's shell is, fish included,
 * which disagrees with bash about backslashes in quotes. The test says so.
 */
export const AGENT_CHECK = [
  `c=$1; m=$2`,
  `case $c in claude) n="Claude Code"; g="Usage: claude auth"; set -- auth status; l="Run claude auth login here, or claude and then /login";; *) n=Codex; g="Show login status"; set -- login status; l="Run codex login here";; esac`,
  `p=$(command -v "$c" 2>/dev/null) || p=`,
  `[ -n "$p" ] || [ "$c" != claude ] || [ ! -x "$HOME/.claude/local/claude" ] || p=$HOME/.claude/local/claude`,
  `if [ -z "$p" ]; then echo; echo "kururu: $n is not installed on $m. There is no $c on the PATH here."; echo "kururu: install it in this tab, then start it again from the + menu."; exit 127; fi`,
  `t=; command -v timeout >/dev/null 2>&1 && t="timeout 20"`,
  `if "$p" "$1" --help 2>/dev/null | grep -q "$g"; then case $($t "$p" "$@" 2>&1 </dev/null) in *"Not logged in"*|*loggedIn??false*|*loggedIn???false*) echo; echo "kururu: $n is not logged in on $m."; echo "kururu: $l, then start it again from the + menu."; exit 1;; esac; fi`,
].join("; ");

/**
 * The loop run *here*, around `ssh`, with the host, the session and the
 * remote line as `$1 $2 $3` (the last two empty for a plain shell).
 *
 * Three things happen to an ssh that is not just a login, and each has its
 * answer. It exits on purpose — `exit` at the far prompt, or a detach — and so
 * does this, with ssh's status, and the tab goes the way any finished terminal
 * goes. It never got in, which is ssh's 255 straight away: the reason is on
 * the screen, and the tab waits on Enter rather than ending — the server reaps
 * an ended terminal at once, and a tab that flashed and vanished would take
 * "connection refused" with it. Or it got in and the connection dropped: then
 * a session tab reattaches by itself every few seconds, because the session
 * is still there and the whole point of tmux was that nothing in it was lost,
 * while a plain shell asks, because what it had is gone and a fresh login is
 * a different thing to be handed unasked.
 *
 * "Got in" is twelve seconds connected, not ten: `ConnectTimeout=10` means a
 * host that never answers also takes *about* ten seconds to fail, and a
 * two-second margin is what keeps that failure from being misread as a
 * connection that briefly succeeded — which is what turned a sleeping
 * machine into a tab that reattached forever without ever asking anybody.
 * `fails` counts attempts that did not get in, in a row, and resets on one
 * that did; three of them and the loop stops offering to retry by itself —
 * sleeping or Ctrl-C has already covered "stop looping right now", this is
 * for a host that is staying down. Enter after that starts the count over,
 * which is the only way back in short of closing the tab. The keepalives
 * make a dead link a dead tab in under a minute rather than the TCP timeout's
 * quarter of an hour.
 */
export const LOOP_SCRIPT = [
  `h=$1; m=$2; r=$3; fails=0`,
  `if [ -n "$r" ]; then set -- "$h" "$r"; else set -- "$h"; fi`,
  `while :; do t=$(date +%s); ssh -t -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -- "$@"; s=$?; [ "$s" -eq 255 ] || exit "$s"; if [ $(( $(date +%s) - t )) -ge 12 ]; then got=1; fails=0; else got=0; fails=$((fails + 1)); fi; echo; if [ "$fails" -ge 3 ]; then echo "kururu: $h has not answered in 3 tries running. Enter tries again; Ctrl-D gives up."; fails=0; read -r _ || exit "$s"; elif [ -n "$m" ] && [ "$got" -eq 1 ]; then echo "kururu: lost the connection to $h. Reattaching $m in 3s; Ctrl-C stops."; sleep 3; else echo "kururu: ssh to $h did not get in. Enter tries again; Ctrl-D gives up."; read -r _ || exit "$s"; fi; done`,
].join("; ");

/** What a remote tab's command line starts with, and what `remoteShellOf` looks for. */
const MARK = "kururu-remote";


/** A string as base64, in a way a browser and Node agree on — `Buffer` is the server's only. */
function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The command line of a tab on a machine.
 *
 * Without a session it is `ssh -t <host>` — the sidebar's button, a login on
 * the machine and nothing else. With one it is `ssh -t <host> <script>`, the
 * script attaching to the named tmux session in `dir` and typing `run` into
 * it the first time; that is what a workspace pinned to the machine opens,
 * and what the harness opens when it is asked to run something there.
 *
 * `agent` says the tab is that CLI rather than a shell, and is the last word
 * on the line, after everything an older `remoteShellOf` reads — so a server
 * from before agents could go to machines still knows these tabs for remote
 * ones, and this one still knows the tabs that server left. `run` is then the
 * line `remoteAgentRun` made.
 *
 * Both go through `LOOP_SCRIPT`, under `/bin/sh` by path, so that what the
 * user's login shell is — the host runs every command line through it — has
 * no say in what the loop means.
 *
 * Throws on a host, session or folder the grammars refuse: every caller has
 * already checked, and a line built from an unchecked one is the thing those
 * grammars exist to rule out.
 */
export function remoteShellCommand(options: { host: string; session?: string; dir?: string; run?: string; agent?: AgentCli }): string {
  const { host, session, agent } = options;
  if (!validHost(host)) throw new Error(`not an ssh host: ${String(host)}`);
  if (agent !== undefined && !AGENT_CLIS.includes(agent)) throw new Error(`not an agent kururu starts: ${String(agent)}`);
  if (agent !== undefined && session === undefined) throw new Error("an agent on a machine runs in a session");
  let remote = "";
  if (session !== undefined) {
    if (!SESSION.test(session)) throw new Error(`not a session name: ${session}`);
    const dir = validRemoteDir(options.dir ?? "~");
    if (dir === null) throw new Error(`not a folder kururu will put in a command line: ${String(options.dir)}`);
    const run = options.run ? base64(options.run) : "";
    remote = `exec sh -c ${shq(REMOTE_SCRIPT)} kururu ${shq(session)} ${shq(dir)} ${shq(run)}${agent ? ` ${agent}` : ""}`;
  }
  return `exec /bin/sh -c ${shq(LOOP_SCRIPT)} ${MARK} ${shq(host)} ${shq(session ?? "")} ${shq(remote)}${agent ? ` ${shq(agent)}` : ""}`;
}

/**
 * The line typed into an agent's session: `AGENT_CHECK`, then the agent.
 *
 * `command` is the launcher's line as `launcherCommand` and `withPrompt` made
 * it, without the hook settings a local agent gets — those name files on this
 * Mac and post to a port on this Mac, and on the machine they would be a
 * Claude that fails to read its own settings. `where` is what the check
 * calls the machine, cut to characters that need no quoting in any shell.
 *
 * A tab in a card's prompt becomes two spaces. This line is *typed*, and a
 * tab typed at bash or zsh is a completion, which would rewrite the prompt
 * under the agent; a newline is safe, because inside the prompt's quotes the
 * shell reads it as part of the word and waits for the rest.
 */
export function remoteAgentRun(cli: AgentCli, command: string, where: string): string {
  if (!AGENT_CLIS.includes(cli)) throw new Error(`not an agent kururu starts: ${String(cli)}`);
  return `sh -c ${shq(AGENT_CHECK)} kururu ${cli} ${shq(checkName(where))} && ${command.replace(/\t/g, "  ")}`;
}

/** What a check typed on a machine calls it: its name, cut to characters no shell quotes. */
export function checkName(where: string): string {
  return where.replace(/[^A-Za-z0-9 ._@-]/g, "").trim().slice(0, 40) || "this machine";
}

/** What a remote tab is, read back out of its command line. */
export interface RemoteShell {
  host: string;
  /** The tmux session it attaches to, or null for a plain `ssh -t`. */
  session: string | null;
  /** The agent CLI it was started as, or null for a shell. */
  agent: AgentCli | null;
}

/**
 * The machine and session a terminal's command line is for, or null for a
 * terminal on this Mac.
 *
 * Only lines `remoteShellCommand` built match, and the host and session are
 * re-checked against their grammars, so a shell the user typed `ssh` into is
 * still a local shell — which it is: kururu did not open it on the machine
 * and has nothing to end there when it closes.
 *
 * The loop is matched by shape rather than by text, because a tab outlives
 * the server that opened it: a version with different words in the loop must
 * still know the tabs an older one left in the host. That shape is one
 * single-quoted word, which holds for as long as `LOOP_SCRIPT` has no quote
 * of its own in it — the test says so. The agent is a quoted word of letters
 * at the very end, which the remote line before it can never be: quoted for
 * the second time, it ends `'\''` and a quote.
 */
export function remoteShellOf(command: string | null | undefined): RemoteShell | null {
  if (!command) return null;
  const match = new RegExp(`^exec /bin/sh -c '[^']*' ${MARK} '([^']+)' '([^']*)' `).exec(command);
  if (!match || !validHost(match[1])) return null;
  const session = match[2] || null;
  if (session !== null && !SESSION.test(session)) return null;
  const tail = / '([a-z]+)'$/.exec(command)?.[1];
  const agent = session !== null && tail !== undefined ? (AGENT_CLIS.find((cli) => cli === tail) ?? null) : null;
  return { host: match[1], session, agent };
}

// ---------------------------------------------------------------------------
// The usage ledger's two reads
// ---------------------------------------------------------------------------

/** Which program's logs on a machine. OpenCode's are a database on that disk, and a query over ssh is another project. */
export type UsageLog = "claude" | "codex";

/** Where each program keeps its logs there, as `sessionTailOn` already finds them. */
const USAGE_ROOTS: Record<UsageLog, string> = {
  claude: '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"',
  codex: '"${CODEX_HOME:-$HOME/.codex}/sessions"',
};

/**
 * The lines the ledger wants, for `grep -E` on the far side: `CLAUDE_NEEDLES`
 * and `CODEX_NEEDLES` with each quote matched by `.`, since a remote script may
 * not hold a quote. A little wider than the needles, which is why the parsers
 * here still decide what a line is. A test holds the two together.
 */
export const USAGE_PATTERNS: Record<UsageLog, string> = {
  claude: "type.:.assistant|type.:.cost-state",
  codex: "type.:.turn_context|type.:.token_count",
};

const USAGE_LIST_MARK = "<<<kururu-usage-list";
const USAGE_READ_MARK = "<<<kururu-usage-read";
const USAGE_READ_FAILED = "<<<kururu-usage-failed";

/**
 * Every log on a machine and its size. `find -exec wc -c {} +` is one process
 * for a thousand files and answers the same on Linux and on a Mac, where `stat`
 * and `find -printf` do not, and the `total` line it adds has no `./` in front
 * of it. From inside the root, so that nothing in the answer says where home is.
 */
export function usageListScript(): string {
  const lines = ["export LC_ALL=C"];
  for (const log of ["claude", "codex"] as const) {
    lines.push(`echo "${USAGE_LIST_MARK} ${log}"`);
    lines.push(`( cd ${USAGE_ROOTS[log]} 2>/dev/null && find . -type f -name "*.jsonl" -exec wc -c {} + 2>/dev/null )`);
  }
  lines.push("true");
  return lines.join("\n");
}

export interface UsageFile {
  log: UsageLog;
  /** Under the program's root, and already held to `USAGE_REL`: it goes back into a script. */
  rel: string;
  size: number;
}

/**
 * The only shape of path that goes back into a script. Letters, digits and
 * `._-` is everything Claude Code spells a project directory with and everything
 * in a rollout's name, so there is nothing to escape and nothing a shell gives
 * a meaning to. A file named anything else is passed over rather than escaped,
 * because the far side chose that name.
 */
const USAGE_REL = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\.jsonl$/;
const USAGE_REL_MAX = 512;

export function validUsageRel(rel: unknown): rel is string {
  return typeof rel === "string" && rel.length <= USAGE_REL_MAX && USAGE_REL.test(rel);
}

/** A listing, or null when this is not one: which must not read as every file having gone. */
export function parseUsageListing(text: string): UsageFile[] | null {
  if (!text.includes(USAGE_LIST_MARK)) return null;
  const out: UsageFile[] = [];
  let log: UsageLog | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith(USAGE_LIST_MARK)) {
      const said = line.slice(USAGE_LIST_MARK.length).trim();
      log = said === "claude" || said === "codex" ? said : null;
      continue;
    }
    const match = /^\s*(\d{1,15})\s+\.\/(\S+)$/.exec(line);
    if (!log || !match || !validUsageRel(match[2])) continue;
    out.push({ log, rel: match[2]!, size: Number(match[1]) });
  }
  return out;
}

/**
 * Up to `length` bytes of a log from `offset`, as only the lines the ledger
 * wants, each with its byte offset, under a line saying what came of it. Null
 * when an argument is not what it must be: this goes into a shell.
 *
 * **Most of a transcript never crosses the link.** Tool output and request
 * blobs are ninety-odd percent of its bytes, so `grep` drops them on the far
 * side, where they cost a read and no more. The lines that do cross are parsed
 * into numbers here and forgotten, as they are on this Mac.
 *
 * **Only whole lines are read.** A last line still being written is left for
 * next time, as `tail.ts` leaves it: `whole` is how far the whole lines reach,
 * the two reads that work it out cost nothing beside the third, and the offset
 * never stops inside a line. Without a temp file, because nothing here writes
 * on somebody else's disk. `grep -b` rather than a count of what came back,
 * since a Codex row's id is its line's offset in the file and has to be the
 * same offset however the file was read. An Alpine box's `grep` has no `-b`, and
 * a read that found nothing is not one that could not look, so a `grep` that
 * failed says so, and the machine's row says why rather than its offsets running
 * on past lines nobody counted.
 */
export function usageReadScript(log: UsageLog, rel: string, offset: number, length: number): string | null {
  if (!validUsageRel(rel) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1) return null;
  const range = `tail -c +$((o+1)) "$f"`;
  return [
    "export LC_ALL=C",
    `f=${USAGE_ROOTS[log]}/${rel}`,
    `[ -f "$f" ] || exit 0`,
    `o=${offset}`,
    `s=$(wc -c < "$f")`,
    "s=$((s))",
    "l=0",
    "w=0",
    `if [ "$s" -gt "$o" ]; then`,
    "l=$((s-o))",
    `[ "$l" -gt ${length} ] && l=${length}`,
    `e=$(${range} | head -c "$l" | tail -c 1 | wc -l)`,
    `n=$(${range} | head -c "$l" | tail -n 1 | wc -c)`,
    `if [ "$e" -gt 0 ]; then w=$l; else w=$((l-n)); fi`,
    "fi",
    `echo "${USAGE_READ_MARK} $s $l $w"`,
    `if [ "$w" -gt 0 ]; then ${range} | head -c "$w" | grep -abE "${USAGE_PATTERNS[log]}"; [ "$?" -gt 1 ] && echo "${USAGE_READ_FAILED}"; fi`,
    "true",
  ].join("\n");
}

export interface UsageChunk {
  /** The file's size when it was asked. */
  size: number;
  /** How many bytes were looked at. */
  length: number;
  /** How far the whole lines among them reach. */
  whole: number;
  /** The lines the ledger wants; `at` is from where the read began. */
  lines: { at: number; text: string }[];
}

/** What a read said: its chunk, `gone` for a file no longer there, or null for an answer that is neither. */
export function parseUsageChunk(text: string): UsageChunk | "gone" | null {
  if (text === "") return "gone";
  const newline = text.indexOf("\n");
  const head = newline === -1 ? text : text.slice(0, newline);
  const match = new RegExp(`^${USAGE_READ_MARK} (\\d{1,15}) (\\d{1,15}) (\\d{1,15})$`).exec(head);
  if (!match) return null;
  const [size, length, whole] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (whole > length) return null;
  const lines: UsageChunk["lines"] = [];
  if (newline !== -1) {
    for (const line of text.slice(newline + 1).split("\n")) {
      if (line === USAGE_READ_FAILED) return null;
      const colon = line.indexOf(":");
      if (colon < 1) continue;
      const at = Number(line.slice(0, colon));
      if (Number.isSafeInteger(at) && at >= 0 && at < whole) lines.push({ at, text: line.slice(colon + 1) });
    }
  }
  return { size, length, whole, lines };
}

/**
 * Whether a folder a Codex rollout names is the one a workspace was pinned to.
 * A pin may say `~/code`, which only the far side can expand (`validRemoteDir`),
 * and a rollout says where it really ran.
 */
export function fitsRemoteDir(dir: string, cwd: string): boolean {
  if (dir === cwd) return true;
  if (dir === "~") return /^\/(?:root|home\/[^/]+|Users\/[^/]+)$/.test(cwd);
  return dir.startsWith("~/") && cwd.endsWith(dir.slice(1));
}
