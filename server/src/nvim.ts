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
        const socket = socketFor(proc.pid);
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
    execFile("nvim", ["--server", instance.socket, "--remote-expr", expr], { timeout: 3000 }, (err, stdout) => {
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
