/**
 * The editors: nvim in kururu's tabs, hooked so the reader follows the
 * buffer it is on, a file opened in one, and every nvim on the machine
 * counted for the footprint and closed or ended on request.
 *
 * Closing is the careful part. An nvim may hold unsaved work, so it is asked
 * to quit and given time before anything is killed, and a tab it emptied is
 * closed only once it is really gone.
 */
import { type FootprintNvim, type NvimCloseReport, type NvimPlace, nvimWhere } from "../../shared/footprint";
import { agentLabel, agentSummary } from "../../shared/labels";
import { panes, paneWithAgent } from "../../shared/layout";
import type { ClientMessage, EditorChoice } from "../../shared/wire";
import { readProcTable } from "./agents/procs";
import { appearance, host, overlay, workspaces } from "./context";
import { processCwds } from "./cwd";
import { allowedRoots, findDocs, listDir, readBytes, readFile, resolveInRoot } from "./files";
import { findNvims, childIndex as footChildren, type FootProc, type FootTable, type FoundNvim, readFootTable, readTree } from "./footprint";
import { renderMarkdown } from "./markdown";
import { attach as attachEditor, endHard, findNvim, isNvimTab, nvimCommand, openFile, quit as quitNvim } from "./nvim";
import { PORT } from "./preamble";
import { forget, openTerminal } from "./terminals";

// ---------------------------------------------------------------------------
// The reader, and the editor that drives it
// ---------------------------------------------------------------------------

/**
 * How often kururu looks for an editor to attach to.
 *
 * An nvim starting inside a pty raises no event anything out here can hear — the
 * same reason the dev-server scan is a timer — so this is a poll, and it is a
 * cheap one because it only asks about terminals a reader is actually following.
 * A pane with no reader beside it costs nothing at all.
 */
export const NVIM_SCAN_MS = 2000;

/**
 * Sockets already hooked. Keyed by the socket path rather than the pid, because
 * a pid is reused and a socket path carries the pid *and* the directory nvim
 * made for that run — so a new editor in a recycled pid is a new key, which is
 * what stops kururu from deciding it has already attached to a process that has
 * never heard of it.
 */
const attached = new Set<string>();

/** A path and a filetype. Anything larger is not an editor reporting a buffer. */
export const NVIM_BODY_LIMIT = 8 * 1024;

/**
 * Attach to whatever editor is in this terminal, if there is one.
 *
 * Failure is silent and normal: most terminals have no nvim in them, an nvim
 * that has just started may not have its socket yet, and `--remote-expr` against
 * an editor sitting in a modal prompt will time out. All three are answered by
 * the next sweep.
 */
export async function hookEditor(agentId: string): Promise<void> {
  const agent = host.find(agentId);
  if (!agent || agent.exited || !agent.pid) return;
  const nvim = await findNvim(agent.pid);
  if (!nvim || attached.has(nvim.socket)) return;
  if (await attachEditor(nvim, agentId, PORT)) attached.add(nvim.socket);
}

/**
 * Sweep the terminals that have a reader pointed at them.
 *
 * Deliberately not every terminal: attaching is a process spawn, and installing
 * a hook in an editor nobody asked to watch would be reaching into somebody's
 * session for no reason at all. A reader is the asking.
 */
export async function pollEditors(): Promise<void> {
  // The host may not have said hello yet, in which case there is no
  // arrangement to read — the guard every other poll in here has, and the one
  // that was missing when a fresh instance's timer fired before its host was up.
  if (!workspaces) return;
  const following = new Set<string>();
  for (const profile of workspaces.all()) {
    for (const workspace of profile.workspaces) {
      for (const pane of panes(workspace.layout)) {
        if (pane.reader?.follow) following.add(pane.reader.follow);
      }
    }
  }
  for (const agentId of following) await hookEditor(agentId);
  // A socket for an editor that has gone is a key that will never be asked
  // about again; drop it so a long session does not accumulate them.
  if (attached.size > 64) attached.clear();
}

/**
 * The root a file belongs to, or null.
 *
 * The longest allowed root that contains it, which is `files.ts`'s question
 * asked from the other end. Roots still come only from the places the server
 * already knows — an agent's cwd, a dev server's, `KURURU_ROOTS` — so an editor
 * that wanders outside every project kururu is holding gets no answer rather
 * than teaching the server a new place to read from. That asymmetry is the whole
 * point of the rule: a path arriving from outside may *select* a root, never
 * create one.
 */
function rootFor(absolute: string): { root: string; rel: string } | null {
  let best: { root: string; rel: string } | null = null;
  for (const root of allowedRoots()) {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (!absolute.startsWith(prefix)) continue;
    if (best && best.root.length >= root.length) continue;
    best = { root, rel: absolute.slice(prefix.length) };
  }
  return best;
}

/**
 * The root a *directory* is in, or "" — `rootFor` asked about a path that may
 * be a root itself rather than something underneath one.
 *
 * Which is the common case here and not an edge: `allowRoot` is told about a
 * terminal's cwd, so a pane's cwd is usually a root exactly, and `rootFor`
 * matches on a prefix and therefore answers nothing for it. The empty string is
 * a real answer and the picker draws it — a reader that cannot guess its project
 * asks which one, rather than guessing wrong and looking broken.
 */
export function rootForDir(dir: string | undefined): string {
  if (!dir) return "";
  if (allowedRoots().includes(dir)) return dir;
  return rootFor(dir.endsWith("/") ? dir : `${dir}/`)?.root ?? "";
}

/**
 * An editor saying where it is. The one endpoint whose caller is a program
 * kururu installed rather than a person or a client — `report-cli.ts`'s shape,
 * for the same reason: the thing that knows is the thing that should say so.
 */
export function nvimBuffer(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const { agent, path, filetype } = body as { agent?: unknown; path?: unknown; filetype?: unknown };
  if (typeof agent !== "string" || typeof path !== "string" || !path.startsWith("/")) return;
  // A reader that draws markdown should not blank itself because you looked at
  // a source file for a moment. Anything it cannot render leaves it as it was.
  const markdown = filetype === "markdown" || /\.(md|markdown|mdx)$/i.test(path);
  if (!markdown) return;
  const located = rootFor(path);
  if (!located) return;
  for (const { workspaceId, paneId } of workspaces.readersFollowing(agent)) {
    workspaces.setReaderTarget(workspaceId, paneId, located.root, located.rel);
  }
}

/**
 * Every nvim in the workspace on screen, in the order a person would reach for
 * them.
 *
 * The focused pane first, because it is where you were typing; then the pane
 * focus came from, which is where you were typing a moment ago — clicking in the
 * tree does not move the pane focus, but a phone's trip through a reader might
 * have. Within a pane the showing tab goes before the ones behind it. The
 * process table is read once for the lot rather than once per terminal.
 *
 * The active workspace only, deliberately. The file is in this workspace's
 * project, and an editor in another workspace is one you would have to go and
 * find after it had opened the file — the move this exists to save.
 */
export async function editorsHere(): Promise<EditorChoice[]> {
  const workspace = workspaces.activeWorkspace;
  const all = panes(workspace.layout);
  const order = [workspace.focusedPaneId, workspace.lastPaneId];
  const ranked = [...all].sort((a, b) => rank(a.id) - rank(b.id));
  function rank(id: string): number {
    const at = order.indexOf(id);
    return at === -1 ? order.length : at;
  }
  const table = await readProcTable();
  const found: EditorChoice[] = [];
  for (const pane of ranked) {
    const tabs = pane.agentIds.map((id, i) => ({ id, i }));
    tabs.sort((a, b) => (a.i === pane.activeIdx ? -1 : b.i === pane.activeIdx ? 1 : a.i - b.i));
    for (const { id } of tabs) {
      const agent = host.find(id);
      if (!agent || agent.exited || !agent.pid) continue;
      if (await findNvim(agent.pid, table)) found.push({ agentId: id, paneId: pane.id });
    }
  }
  return found;
}

/**
 * What `/api/ls`, `/api/docs`, `/api/markdown` and `/api/file-raw` would
 * answer, for the parent's server reading this disk through its watch
 * (`files-ask`, `doc-ask`). The same functions and so the same refusals and
 * the same bounds — `files.ts` holds a file to 2 MB and a listing to 500
 * entries — with a file's bytes as base64, since the watch carries text.
 *
 * The markup is rendered in the asker's theme when this node has it, so the
 * code in a document matches the Mac's panes; one this node does not know
 * draws its fallback, as an unknown theme here always has.
 */
export async function readForWatcher(msg: Extract<ClientMessage, { type: "files-ask" | "doc-ask" }>): Promise<unknown> {
  const root = msg.root;
  const path = typeof msg.path === "string" ? msg.path : "";
  if (msg.type === "files-ask") {
    if (msg.op === "ls") return { entries: listDir(root, path) };
    if (msg.op === "docs") {
      const roots = allowedRoots();
      const at = root || (roots.length === 1 ? (roots[0] ?? "") : "");
      return at ? { roots, root: at, docs: findDocs(at) } : { roots, root: "", docs: [] };
    }
    throw new Error("not a read this node answers");
  }
  if (msg.op === "markdown") {
    const themeId = typeof msg.themeId === "string" ? msg.themeId : appearance.themeId;
    return renderMarkdown(readFile(root, path).text, root, path, themeId);
  }
  if (msg.op === "raw") {
    const file = readBytes(root, path);
    return { type: file.type, data: Buffer.from(file.bytes).toString("base64") };
  }
  throw new Error("not a read this node answers");
}

/**
 * Open a file from the tree in nvim — one that is running, or a new one.
 *
 * The path is resolved before anything else, and it is the resolved path that
 * reaches the editor: `files.ts` is the only thing that decides what a path from
 * a client means, and this one is about to be handed to a program.
 *
 * A new editor goes in a tab of the focused pane — a click in the tree adds to
 * the pane you were last in rather than rearranging the window around it. It is
 * started in the project so `:e` and every picker in somebody's config are
 * relative to the right place, and it drops into a shell when you quit it. The
 * alternative — the tab ending with the editor — means `:q` on the wrong buffer
 * closes a tab, which is not something `:q` does anywhere else.
 */
export async function openInEditor(
  root: string,
  path: string,
  agentId: string | null,
  at: { paneId?: string; line?: number | null } = {},
): Promise<{ agentId: string }> {
  const full = resolveInRoot(root, path);
  if (!full) throw new Error("that file is outside the project");
  if (agentId !== null) {
    if (typeof agentId !== "string" || !workspaces.agentsHere().includes(agentId)) {
      throw new Error("that terminal is not in this workspace any more");
    }
    const agent = host.find(agentId);
    const nvim = agent && !agent.exited && agent.pid ? await findNvim(agent.pid) : null;
    if (!nvim) throw new Error("there is no nvim in that terminal any more");
    if (!(await openFile(nvim, full))) throw new Error("nvim did not answer — is it waiting at a prompt?");
    const pane = paneWithAgent(workspaces.activeWorkspace.layout, agentId);
    if (pane) {
      workspaces.focusPane(pane.id);
      workspaces.selectTab(pane.id, pane.agentIds.indexOf(agentId));
    }
    return { agentId };
  }
  // A pane named that is not in the workspace on screen is the focused one,
  // on `openTerminal`'s reasoning for a pane closed while the host spawned.
  const paneId = at.paneId && workspaces.hasPane(at.paneId) ? at.paneId : workspaces.focusedPaneId;
  const agent = await openTerminal(paneId, { cwd: root, command: nvimCommand(path, at.line), kind: "shell" });
  return { agentId: agent.id };
}

/** One argument for a POSIX shell, whatever is in it. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Every nvim on the machine, and ending them
// ---------------------------------------------------------------------------

/**
 * How long the nvims that did not refuse `:qa` get to finish going — `VimLeave`
 * autocmds, a shada write — before the ones still standing are reported as not
 * having answered. Polled, because an exit in somebody else's terminal raises
 * nothing out here.
 */
const NVIM_QUIT_MS = 2000;
const NVIM_QUIT_POLL_MS = 150;
/** After `endHard`, which has already waited out its own grace: long enough for the kernel to reap. */
const NVIM_KILL_SETTLE_MS = 500;

/** More than anybody has open, and a ceiling on what one message can set going. */
const NVIM_CLOSE_LIMIT = 256;

/** Every live terminal kururu holds, by the pid on the end of its pty — where `findNvims` stops walking up. */
function ptyRoots(): Map<number, string> {
  const roots = new Map<number, string>();
  for (const agent of host?.agents ?? []) if (!agent.exited && agent.pid) roots.set(agent.pid, agent.id);
  return roots;
}

/** A process is its pid and when it started; see `FootProc.start`. */
function nvimId(nvim: { pid: number; start: string }): string {
  return `${nvim.pid}@${nvim.start}`;
}

/** Whether the process an id named is still running, as itself, in this table. */
function stillThere(nvim: FoundNvim, table: FootTable): boolean {
  return table.get(nvim.pid)?.start === nvim.start;
}

/**
 * Where an nvim is, for a person: the tab it is in and that tab's workspace, or
 * the app it is running under. The tab is named as its strip names it — for an
 * nvim, by its title, because the label alone is the command line cut at a
 * slash and says `sh}" -l`.
 */
function placeOf(nvim: FoundNvim, roots: Map<number, string>): NvimPlace {
  const agentId = nvim.ptyRoot === null ? undefined : roots.get(nvim.ptyRoot);
  const agent = agentId === undefined ? undefined : host.find(agentId);
  if (agentId === undefined || !agent) return { kind: "outside", app: nvim.app };
  const shown = overlay(agent);
  const workspace = workspaces
    .all()
    .flatMap((profile) => profile.workspaces)
    .find((w) => panes(w.layout).some((pane) => pane.agentIds.includes(agentId)));
  return {
    kind: "kururu",
    agentId,
    tab: shown.titleOverride || agentSummary(shown) || agentLabel(shown),
    workspace: workspace?.name ?? null,
    nvimTab: isNvimTab(agent.command),
    agent: nvim.underAgent,
  };
}

/**
 * Every nvim on the machine for the Processes page, placed and with its
 * directory — one `lsof` for the lot. Machine-wide on purpose: the tile is about
 * what the machine is paying for, and an nvim in another terminal app costs the
 * same as one in a tab.
 */
export async function nvimCensus(table: FootTable, children: Map<number, FootProc[]>): Promise<FootprintNvim[]> {
  const roots = ptyRoots();
  const found = findNvims(table, children, new Set(roots.keys()));
  const cwds = await processCwds(found.map((nvim) => nvim.pid));
  return found.map((nvim) => ({
    id: nvimId(nvim),
    pid: nvim.pid,
    args: nvim.args,
    rss: nvim.rss,
    processes: nvim.pids.length,
    cwd: cwds.get(nvim.pid) ?? null,
    place: placeOf(nvim, roots),
  }));
}

/**
 * The nvims these ids name that are still those processes, in a table read now.
 * An id is the page's word for what it showed, and only that is acted on: a
 * pid that has since become another process, or an id that was never an nvim,
 * names nothing here.
 */
function nvimsNamed(ids: unknown, table: FootTable, roots: Map<number, string>): FoundNvim[] {
  if (!Array.isArray(ids)) throw new Error("which nvims?");
  const wanted = new Set(ids.slice(0, NVIM_CLOSE_LIMIT).filter((id): id is string => typeof id === "string"));
  return findNvims(table, footChildren(table), new Set(roots.keys())).filter((nvim) => wanted.has(nvimId(nvim)));
}

/** Read the table until none of these is still running, or the time is up, and hand back the last read. */
async function untilGone(nvims: FoundNvim[], ms: number): Promise<FootTable> {
  let table = await readFootTable();
  const until = Date.now() + ms;
  while (Date.now() < until && nvims.some((nvim) => stillThere(nvim, table))) {
    await new Promise((resolve) => setTimeout(resolve, NVIM_QUIT_POLL_MS));
    table = await readFootTable();
  }
  return table;
}

/**
 * A tab kururu opened as nvim, once its nvim has gone, closed the way
 * `close-tab` closes one — when what is left is a shell with nothing in it,
 * which is what `nvimCommand` drops into. A shell somebody typed nvim into is a
 * shell they wanted, and stays; so does an nvim tab where something else has
 * been started from that shell since, which is theirs.
 */
function closeEmptiedTab(agentId: string, table: FootTable): void {
  const agent = host.find(agentId);
  if (!agent || !isNvimTab(agent.command)) return;
  const tree = agent.exited || !agent.pid ? null : readTree(agent.pid, table, footChildren(table));
  if (tree && (tree.agents.length > 0 || tree.devServers.length > 0 || tree.editors > 0)) return;
  host.kill(agentId);
  workspaces.reapTab(agentId);
  forget(agentId);
}

/** Count what went, closing nvim tabs behind them, and list what did not with `why`. */
function settle(
  nvims: FoundNvim[],
  table: FootTable,
  roots: Map<number, string>,
  why: (nvim: FoundNvim) => string,
): NvimCloseReport {
  const report: NvimCloseReport = { closed: 0, left: [] };
  for (const nvim of nvims) {
    if (stillThere(nvim, table)) {
      const args = nvim.args.length > 60 ? `${nvim.args.slice(0, 59)}…` : nvim.args;
      report.left.push({ id: nvimId(nvim), label: `${args} (${nvimWhere(placeOf(nvim, roots))})`, reason: why(nvim) });
      continue;
    }
    report.closed++;
    const agentId = nvim.ptyRoot === null ? undefined : roots.get(nvim.ptyRoot);
    if (agentId !== undefined) closeEmptiedTab(agentId, table);
  }
  return report;
}

/**
 * Settings → Processes' close buttons: `:qa` in each nvim the page showed,
 * wherever it is running, and a moment for them to go.
 *
 * Gentle is all this does. `:qa` refuses unsaved work, and a refusal is
 * reported and never escalated — ending what refused is `killNvims`, which the
 * page asks for on a button of its own, so a signal is always a second yes.
 * Whether one went is read off the process table rather than the socket,
 * because an nvim that quits drops the socket in the middle of its answer — see
 * `quit` in `nvim.ts`.
 */
export async function closeNvims(ids: unknown): Promise<NvimCloseReport> {
  const roots = ptyRoots();
  const [before, procs] = await Promise.all([readFootTable(), readProcTable()]);
  const targets = nvimsNamed(ids, before, roots);
  const said = new Map<FoundNvim, string>();
  await Promise.all(
    targets.map(async (nvim) => {
      const found = await findNvim(nvim.pid, procs);
      const answer = found ? await quitNvim(found) : "kururu could not find its socket";
      if (answer) said.set(nvim, answer);
    }),
  );
  const table = await untilGone(targets.filter((nvim) => !said.has(nvim)), NVIM_QUIT_MS);
  return settle(targets, table, roots, (nvim) => said.get(nvim) ?? "did not answer — it may be waiting at a prompt");
}

/**
 * The second yes: end what refused `:qa`. SIGTERM and then SIGKILL to each
 * one's own tree, and nothing above it — see `endHard`. The ids are checked
 * exactly as `closeNvims` checks them, against a table read now.
 */
export async function killNvims(ids: unknown): Promise<NvimCloseReport> {
  const roots = ptyRoots();
  const targets = nvimsNamed(ids, await readFootTable(), roots);
  await endHard(targets.flatMap((nvim) => nvim.pids));
  const table = await untilGone(targets, NVIM_KILL_SETTLE_MS);
  return settle(targets, table, roots, (nvim) => {
    try {
      process.kill(nvim.pid, 0);
      return "it survived SIGKILL";
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM" ? "it belongs to another user" : "it survived SIGKILL";
    }
  });
}
