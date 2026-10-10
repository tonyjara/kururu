/**
 * Finding the nvim inside a pane, and asking it to say what it is looking at.
 *
 * The reader has to learn which file to draw, and the honest place to ask is the
 * editor — it is the only thing that knows, and it changes its mind constantly.
 * The usual way to arrange that is a snippet in somebody's config, which means
 * the feature does not exist on a machine they have not set up yet, and it means
 * kururu's reader is broken in a way that looks like kururu.
 *
 * It needs none of that, because of three facts that happen to line up.
 * Neovim listens on a unix socket with no configuration whatsoever — `v:
 * servername` is always set, there is no flag to pass. The socket's *name*
 * carries the pid that owns it. And kururu already knows the pid of every pty it
 * holds and already walks the process tree underneath one to see what is running
 * in there. So the whole path from "this pane has an editor in it" to "the
 * editor says it is on README.md" needs nothing from the user at all.
 *
 * What is installed is an autocmd, not a poll. Polling would mean spawning
 * `nvim --server … --remote-expr` once a second per pane, and it could only ever
 * see where the cursor is — not that a file was written, which is the event that
 * should redraw the page. One install, and nvim pushes from then on.
 *
 * The lua crosses a shell argument and then a vimscript string literal, and
 * every quoting scheme that survives one of those mangles the other. So it goes
 * as base64, which contains no character either of them has an opinion about.
 *
 * It is also where an nvim is ended, for Settings → Processes: asked to `:qa`
 * over the same socket, and only when that is refused and somebody says so a
 * second time, signalled — the two halves are `quit` and `endHard` below.
 *
 * This lives outside `agents/` deliberately, for the same reason `transcript.ts`
 * does: it touches no pty. It reads the process table and talks to somebody
 * else's socket, so it stays on the side of the split that can be edited without
 * costing anybody a running agent.
 */
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { childIndex, readProcTable, type ProcInfo, type ProcTable } from "./agents/procs";

/** An editor kururu has found, and the socket it answers on. */
export interface NvimInstance {
  pid: number;
  socket: string;
}

/**
 * Where Neovim puts its sockets. `$XDG_RUNTIME_DIR` is the answer on Linux,
 * `$TMPDIR` on macOS, and `/tmp` is what is left when neither is set — nvim
 * makes the same three guesses in the same order, so this is not a heuristic,
 * it is the other half of one decision.
 */
function socketDirs(): string[] {
  const bases = [process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, "/tmp"];
  const user = process.env.USER ?? process.env.LOGNAME ?? "";
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const base of bases) {
    if (!base) continue;
    const dir = join(base, `nvim.${user}`);
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

/**
 * The socket a given nvim is listening on.
 *
 * The leaf is named for the pid, which is what makes this a lookup rather than a
 * search — but the directory above it is random, so the one level of scanning
 * cannot be avoided. A dead nvim leaves its directory behind, so this asks for
 * the file it wants rather than taking the first socket it finds.
 */
export function socketFor(pid: number): string | null {
  const leaf = `nvim.${pid}.0`;
  for (const dir of socketDirs()) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = join(dir, entry, leaf);
      try {
        if (readdirSync(join(dir, entry)).includes(leaf)) return candidate;
      } catch {
        // A directory that went away between the two reads. Nothing to say.
      }
    }
  }
  return null;
}

/** How far under a pty to look. A shell, a wrapper, the editor, its core. */
const MAX_DEPTH = 6;

/**
 * The address an nvim was told to listen on, when it was told one that can be
 * dialled as written: a path from the root, or a host and port. A bare name is
 * not — nvim files it in a directory of its own choosing — and leaves the
 * default lookup to try.
 */
export function listenOf(args: string): string | null {
  const m = /(?:^|\s)--listen(?:\s+|=)(\S+)/.exec(args);
  const address = m?.[1];
  if (!address) return null;
  return address.startsWith("/") || /^[\w.-]+:\d+$/.test(address) ? address : null;
}

/** Whether this process is an nvim, by the name it was executed under. */
function isNvim(proc: ProcInfo): boolean {
  const argv0 = proc.args.split(" ", 1)[0] ?? "";
  return (argv0.split("/").pop() ?? "") === "nvim";
}

/**
 * The nvim running in, or under, this pty — and specifically the one that can
 * be talked to, which is not the one you would guess.
 *
 * `procs.ts` has a walk already and this deliberately does not reuse it, because
 * its policy is that the *shallowest* match wins. That is right for finding the
 * agent somebody is talking to and exactly wrong here. Since 0.11 Neovim's TUI
 * is a separate process from the editor: typing `nvim` gets you an `nvim` that
 * is only a UI, which spawns `nvim --embed` underneath it and drives that over
 * RPC. The core is what holds the state and what `v:servername` names, so the
 * socket belongs to the *child* — the shallowest nvim under a pty is the one
 * process here that cannot answer a question.
 *
 * Rather than encode that shape, this walks every nvim it can see and takes the
 * first with a socket. An editor that goes back to being one process, or grows
 * another layer, needs no change here.
 */
export async function findNvim(
  ptyPid: number,
  /** A table already read, when several terminals are being asked about at once. */
  given?: ProcTable,
): Promise<NvimInstance | null> {
  const table = given ?? (await readProcTable());
  const root = table.get(ptyPid);
  if (!root) return null;
  const children = childIndex(table);

  let frontier: ProcInfo[] = [root];
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
    const next: ProcInfo[] = [];
    for (const proc of frontier) {
      if (isNvim(proc)) {
        const socket = listenOf(proc.args) ?? socketFor(proc.pid);
        if (socket) return { pid: proc.pid, socket };
      }
      next.push(...(children.get(proc.pid) ?? []));
    }
    frontier = next;
  }
  return null;
}

/**
 * What gets installed. It is written here as lua rather than assembled, because
 * a program that is going to run inside somebody's editor should be readable as
 * the thing it is.
 *
 * `clear = true` is what makes re-attaching safe: the group is replaced, so an
 * nvim that kururu has already found does not accumulate a handler every time it
 * is found again. The agent id is baked in at install time because nvim has no
 * idea it is in a pane, and the server has to know which pane to redraw.
 */
function hookSource(agentId: string, port: number): string {
  return `
vim.api.nvim_create_augroup("kururu", { clear = true })
vim.api.nvim_create_autocmd({ "BufEnter", "BufWritePost", "BufFilePost" }, {
  group = "kururu",
  desc = "Tell kururu which file this window is showing",
  callback = function(ev)
    local path = vim.api.nvim_buf_get_name(ev.buf)
    if path == "" or vim.bo[ev.buf].buftype ~= "" then return end
    local body = vim.json.encode({
      agent = ${JSON.stringify(agentId)},
      path = path,
      filetype = vim.bo[ev.buf].filetype,
    })
    vim.system({
      "curl", "-s", "-m", "2", "-X", "POST",
      "-H", "content-type: application/json",
      "--data-binary", body,
      "http://127.0.0.1:${port}/api/nvim-buffer",
    })
  end,
})
-- Say where it is now, so a reader opened mid-session is not blank until the
-- next time somebody switches buffers.
vim.schedule(function() vim.api.nvim_exec_autocmds("BufEnter", { group = "kururu" }) end)
return 1
`;
}

/** How long an editor gets to answer before kururu stops waiting for it. */
const EVAL_MS = 3000;

/**
 * Run a chunk of lua in an editor and hand back what it printed, or null.
 *
 * `--remote-expr` rather than `--remote-send`: send types keys into whatever
 * mode the editor happens to be in, which on a bad day is a buffer. An
 * expression is evaluated, answers, and cannot be a paste into somebody's file.
 * An editor sitting in a prompt does not evaluate anything until it leaves it,
 * which is what the timeout is for.
 */
function evalLua(instance: NvimInstance, source: string): Promise<string | null> {
  const payload = Buffer.from(source, "utf8").toString("base64");
  const expr = `luaeval('loadstring(vim.base64.decode("${payload}"))()')`;
  return new Promise((resolve) => {
    execFile("nvim", ["--server", instance.socket, "--remote-expr", expr], { timeout: EVAL_MS }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

/** Install the hook, and say whether it took. */
export async function attach(instance: NvimInstance, agentId: string, port: number): Promise<boolean> {
  return (await evalLua(instance, hookSource(agentId, port))) === "1";
}

/**
 * The file tree's other half: open a file in an editor somebody already has.
 *
 * `:drop` rather than `:edit`, because it is the command that already means
 * what a click in a tree means — go to the file where it is showing if it is
 * showing anywhere, and open it here if it is not. But "here" is the window
 * with the cursor in it, and in a configured nvim that is as likely to be a
 * file explorer, a picker's float or a terminal buffer as a file. Dropping a
 * source file into a sidebar is the one outcome worse than doing nothing, so a
 * window that is not a plain buffer hands over to one in the same tab that is.
 *
 * `stopinsert` because a file that opens under a cursor still in insert mode
 * is a file whose next keystroke is typed into it. The path crosses as base64,
 * for the reason `attach` sends its source that way — there is no quoting
 * scheme that survives lua, vimscript and a file name with a quote in it.
 */
export async function openFile(instance: NvimInstance, path: string): Promise<boolean> {
  const encoded = Buffer.from(path, "utf8").toString("base64");
  const source = `
local path = vim.base64.decode("${encoded}")
local function usable(win)
  if vim.api.nvim_win_get_config(win).relative ~= "" then return false end
  return vim.bo[vim.api.nvim_win_get_buf(win)].buftype == ""
end
local ok = pcall(function()
  vim.cmd("stopinsert")
  if not usable(vim.api.nvim_get_current_win()) then
    for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
      if usable(win) then
        vim.api.nvim_set_current_win(win)
        break
      end
    end
  end
  vim.cmd("drop " .. vim.fn.fnameescape(path))
end)
return ok and 1 or 0
`;
  return (await evalLua(instance, source)) === "1";
}

/**
 * Ask an editor to `:qa` — the gentle way to end one, because it is the one that
 * can say no. It refuses while a buffer has unsaved changes or a terminal buffer
 * still has a job running, and in refusing it puts the unsaved buffer on screen,
 * so the tab somebody goes to look at already shows what is holding it open.
 * The refusal is echoed there as nvim's own error, the one typing `:qa` would
 * have shown, and handed back for the page to list: the unsaved buffers by name
 * when there are any, since those are what a person recognises.
 *
 * 'confirm' is off for the one command, because with it on `:qa` opens a
 * save-or-discard dialog, and a dialog raised by a remote request is a modal in
 * a tab nobody is looking at — the request waits on it and the editor sits in it.
 *
 * The deadline is there because an editor at a prompt evaluates nothing until it
 * leaves the prompt: the request queues, kururu gives up on it, and without one
 * it would run the moment somebody pressed Enter — quitting an editor they had
 * just gone to use. Both sides read the same wall clock, so a request that
 * arrives after kururu stopped waiting answers and does nothing.
 *
 * Success has no answer at all, since an nvim that quits closes the socket in
 * the middle of the request. Null therefore means "go and look", and the caller
 * reads the process table rather than trusting a silence or a dropped line.
 */
export async function quit(instance: NvimInstance): Promise<string | null> {
  const deadline = Date.now() + EVAL_MS;
  const source = `
local function now()
  if vim.uv and vim.uv.gettimeofday then
    local s, us = vim.uv.gettimeofday()
    return s * 1000 + math.floor(us / 1000)
  end
  return os.time() * 1000
end
if now() > ${deadline} then return "" end
local unsaved = {}
for _, buf in ipairs(vim.api.nvim_list_bufs()) do
  local bt = vim.bo[buf].buftype
  if vim.bo[buf].modified and (bt == "" or bt == "acwrite") then
    local name = vim.api.nvim_buf_get_name(buf)
    table.insert(unsaved, name == "" and "[No Name]" or vim.fn.fnamemodify(name, ":~:."))
  end
end
local confirm = vim.o.confirm
vim.o.confirm = false
local ok, err = pcall(vim.cmd, "qa")
vim.o.confirm = confirm
-- Only reached when it did not quit. The error arrives wrapped in where it was
-- raised; the E-number onwards is the part nvim itself would have printed.
local said = ok and "it stayed open" or (tostring(err):match("E%d+:.*$") or tostring(err))
vim.api.nvim_echo({ { said, "ErrorMsg" } }, true, {})
if #unsaved > 0 then return "unsaved changes in " .. table.concat(unsaved, ", ") end
return said
`;
  const answer = await evalLua(instance, source);
  return answer ? answer : null;
}

/** How long an nvim gets to answer SIGTERM — write its swap files and go — before SIGKILL. */
const HARD_GRACE_MS = 1500;

/** Signal 0 asks whether a pid exists; EPERM is a yes that is not ours. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function send(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // ESRCH is one that finished on its own; EPERM is another user's, and the
      // caller finds it still standing and says so.
    }
  }
}

/**
 * The hard way, for editors that refused `:qa` and that somebody has said a
 * second time to end anyway.
 *
 * SIGTERM first, to every process in each editor's tree, because nvim answers
 * it by writing its swap files and its UI answers it by putting the terminal
 * back the way it found it — a SIGKILLed UI leaves the shell underneath in the
 * alternate screen with the mouse still reporting. SIGKILL after the grace for
 * whatever did not go, to the same pids; the kernel does not hand a pid out
 * again inside that window, which is `stopDevServer`'s argument too.
 *
 * Pids, never a process group. An nvim typed at a shell is a job of its own,
 * but one inside VS Code or a plugin's terminal shares its group with whatever
 * started it, and the group is the one thing here that could reach a process
 * nobody asked to end. The pids come from a table the caller has just checked
 * against what the page showed.
 */
export async function endHard(pids: number[]): Promise<void> {
  send(pids, "SIGTERM");
  const until = Date.now() + HARD_GRACE_MS;
  let left = pids.filter(alive);
  while (left.length > 0 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    left = left.filter(alive);
  }
  if (left.length > 0) send(left, "SIGKILL");
}

/** One argument for a POSIX shell, whatever is in it. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** What every nvim tab's command line starts with, a file or not. */
const NVIM_TAB = `printf '\\033]2;nvim\\007'; nvim`;

/**
 * The command line for a tab that is nvim rather than a shell that happens to
 * have nvim typed into it — the new-tab menu's row, and the file tree's.
 *
 * The title is set by hand first, because the tab is named from the terminal
 * title when there is one and from the command line when there is not — and
 * this command line, cut at its last slash, is `sh}" -l`. An nvim with
 * `set title` replaces it the moment it starts, and a shell that sets its own
 * takes it back when the editor exits; one that does not says "nvim" for a
 * while longer, which is at least where the tab came from. Dropping into a
 * shell on exit rather than ending the pty is the same choice `openInEditor`
 * makes: `:q` should close a buffer, not a tab.
 */
export function nvimCommand(path?: string): string {
  const arg = path ? ` -- ${shellQuote(path)}` : "";
  return `${NVIM_TAB}${arg}; exec "\${SHELL:-/bin/sh}" -l`;
}

/**
 * Whether a terminal was started by `nvimCommand` — kururu's own nvim, and the
 * only kind Settings → Processes will close in bulk. Read off the command the
 * host recorded at spawn, which nothing after the spawn can change; what is
 * running in the tab now is a separate question, asked of the process table.
 */
export function isNvimTab(command: string): boolean {
  return command.startsWith(`${NVIM_TAB};`) || command.startsWith(`${NVIM_TAB} -- `);
}
