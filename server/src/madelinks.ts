/**
 * Links to what an agent made, and the ways a file reaches somebody: the
 * reader, the editor, Telegram.
 *
 * The rule for what counts as made is `shared/made.ts`, read off an agent's
 * last reply and never off everything it touched; the record is `made.ts`.
 * What is here is the server's half — noticing a reply, checking each path is
 * inside a root this server may show, sweeping links whose file has gone, and
 * opening one where it was asked for. Kuru's own replies are read the same
 * way, so the drawer can link what it names.
 */
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { KuruFile } from "../../shared/kuru";
import { paneWithAgent } from "../../shared/layout";
import { remoteShellOf } from "../../shared/machines";
import { type MadeFile, mentionsIn, readsInReader } from "../../shared/made";
import { isPictureName } from "../../shared/pictures";
import { channels, harness, host, kuru, madeFiles, pushSnapshot, state, turnStart, workspaces } from "./context";
import { allowedRoots, allowRoot, resolveInRoot } from "./files";
import { harnessHome } from "./harnesshome";
import { openTerminal } from "./terminals";
import { locateMentions, stillThere as madeStillThere } from "./made";
import { nvimCommand } from "./nvim";
import { PictureRefused, stageOutgoing, wholePath } from "./pictures";

/**
 * A turn's start and end, as the links under an agent's row hear of them.
 * The start is the prompt hook's report; the end is the Stop report's reply,
 * read for what the turn made (`MadeFiles.turnEnded`) and written onto the
 * card the agent runs, if it runs one. Kuru's own replies are the drawer's
 * (`kuruFiles`), and an agent on a machine sends no reply here and has no
 * disk here to find its files on.
 */
export function noteMade(agentId: string, report: { status?: string; message?: string }, body: Record<string, unknown>): void {
  if (report.status === "working" && report.message?.trim()) turnStart.set(agentId, Date.now());
  const reply = typeof body.reply === "string" ? body.reply : "";
  if (report.status !== "done" || !reply.trim() || harness.isHarness(agentId)) return;
  const agent = host.find(agentId);
  if (!agent || agent.exited || remoteShellOf(agent.command)) return;
  const since = turnStart.get(agentId) ?? madeFiles.lastTurn(agentId) ?? agent.createdAt;
  const moved = madeFiles.turnEnded({ id: agent.id, createdAt: agent.createdAt, cwd: agent.cwd }, reply, since);
  workspaces.setMade(agentId, madeFiles.of(agentId));
  if (moved) pushSnapshot();
}

/**
 * The directories a path Kuru wrote may be relative to: the projects of the
 * profile on screen, every terminal's directory in Kuru's profile, then every
 * root the server allows. Kuru answers about every agent in its profile and
 * writes a path as the agent's project spells it, so there is no one
 * directory to read it from — `locateMentions` tries each, and the most
 * recently written match wins.
 */
function projectDirsOf(profileId: string): string[] {
  const dirs: string[] = [];
  if (profileId === workspaces.active.id) for (const project of state.projects) dirs.push(project.root, ...project.choices);
  for (const id of workspaces.agentsIn(profileId)) {
    const agent = host.find(id);
    if (agent && !remoteShellOf(agent.command)) dirs.push(agent.cwd);
  }
  dirs.push(...allowedRoots());
  return [...new Set(dirs)];
}

/**
 * The files each of Kuru's replies names, for the drawer to make links of.
 *
 * Resolved once per reply and kept, since a reply's words never change and
 * the conversation is assembled again on every change to it — except a reply
 * that named nothing findable, which is tried again after a while: right
 * after a restart the projects' roots are still being relearnt. A link whose
 * file goes is taken off by `sweepMade`.
 */
const kuruFound = new Map<string, { at: number; files: KuruFile[] }>();

/** How long "this reply names no file" is believed before it is looked for again. */
const KURU_RETRY_MS = 30_000;

/** Replies remembered. The drawer shows sixty and pages back; this is a few pages. */
const KURU_FOUND_MAX = 400;

export function kuruFiles(profileKey: string, reply: { id: string; text: string }): KuruFile[] {
  const key = `${profileKey}\0${reply.id}`;
  const now = Date.now();
  const had = kuruFound.get(key);
  if (had && (had.files.length > 0 || now - had.at < KURU_RETRY_MS)) return had.files;
  const profileId = workspaces.profileIdOf(profileKey);
  const mentions = mentionsIn(reply.text);
  const found = profileId && mentions.length ? locateMentions(mentions, projectDirsOf(profileId), 0) : [];
  const files: KuruFile[] = [];
  const seen = new Set<string>();
  for (const { mention, file } of found) {
    if (seen.has(mention.text)) continue;
    seen.add(mention.text);
    files.push({ ...file, text: mention.text });
  }
  kuruFound.delete(key);
  kuruFound.set(key, { at: now, files });
  if (kuruFound.size > KURU_FOUND_MAX) kuruFound.delete(kuruFound.keys().next().value!);
  return files;
}

/**
 * How often the links are checked against the disk. A link to a file that was
 * deleted or moved should be gone within a glance of it, and the check is a
 * `stat` for each of a handful of files.
 */
export const MADE_SWEEP_MS = 5000;

/** Every link — on rows, on cards, in the drawer — that no longer goes anywhere, taken away. */
export function sweepMade(): void {
  if (!host || !workspaces) return;
  if (madeFiles.sweep(host.agents.map((agent) => ({ id: agent.id, createdAt: agent.createdAt })))) pushSnapshot();
  workspaces.pruneMade(madeStillThere);
  let gone = false;
  for (const [key, entry] of kuruFound) {
    const files = entry.files.filter(madeStillThere);
    if (files.length === entry.files.length) continue;
    kuruFound.set(key, { ...entry, files });
    gone = true;
  }
  if (gone) kuru.changed();
}

/**
 * Whether kururu itself is holding this link — on an agent's row, on a card,
 * in a reply of Kuru's. What lets `openMade` allow a root that has not been
 * relearnt since a restart: a card's link into a worktree no terminal is in
 * any more is a root the server found, not one a client made up.
 */
function heldLink(root: string, path: string): boolean {
  const is = (file: MadeFile) => file.root === root && file.path === path;
  for (const agent of host.agents) if (madeFiles.of(agent.id).some(is)) return true;
  if (workspaces.cardHasMade(root, path)) return true;
  for (const entry of kuruFound.values()) if (entry.files.some(is)) return true;
  return false;
}

/**
 * Open what an agent made: Markdown in the reader, as a tab of the focused
 * pane — the file tree's `show-doc` — and anything else in a new nvim tab
 * there, at the line the link names. The focused pane because that is the
 * one you were last in (KUR-44); a new nvim rather than one already running,
 * unlike the tree, because a link is one click and the tree's question of
 * which editor is the one you are typing in is a second.
 *
 * In the workspace the link was in — the agent's, the card's — switched to
 * first, the way clicking the agent's row goes to it, so the file opens
 * beside the work it came from. A link out of Kuru's drawer names no
 * workspace and goes to the one whose project holds it, or stays put.
 */
export async function openMade(
  root: string,
  path: string,
  line: number | null,
  workspaceId: string | null,
  focus: boolean,
): Promise<{ paneId: string }> {
  let full = resolveInRoot(root, path);
  if (!full && heldLink(root, path)) {
    allowRoot(root);
    full = resolveInRoot(root, path);
  }
  // Which of the two refusals it was is said only for a root kururu already
  // allows: whether a file exists anywhere else is not a phone's to learn.
  if (!full) throw new Error(rootAllowed(root) ? "that file is not there any more" : "that file is outside every project kururu has open");
  try {
    if (!statSync(full).isFile()) throw new Error("not a file");
  } catch {
    throw new Error("that file is not there any more");
  }
  const target = workspaceId ?? workspaceOfRoot(root);
  if (target && target !== workspaces.activeWorkspace.id) {
    if (!workspaces.active.workspaces.some((w) => w.id === target)) throw new Error("that workspace is not in this profile");
    workspaces.switchWorkspace(target);
  }
  if (readsInReader(path)) {
    const paneId = workspaces.showDoc(root, path);
    if (!paneId) throw new Error("there is no pane to show it in");
    if (focus) workspaces.focusPane(paneId);
    return { paneId };
  }
  const paneId = workspaces.focusedPaneId;
  await openTerminal(paneId, { cwd: root, command: nvimCommand(path, line), kind: "shell" });
  return { paneId };
}

/**
 * Kuru's `show_file`: the path found the way a reply's paths are — from the
 * agent's directory, or with no agent from the profile's projects — put
 * first on the agent's row and its card, and opened when asked. Opened only
 * while Kuru's profile is the one on screen: a file opened in a profile
 * nobody is looking at is a layout changed for no one.
 */
export async function showFileFor(profileId: string, agentId: string | null, path: string, line: number | null, open: boolean): Promise<string> {
  const agent = agentId ? host.find(agentId) : undefined;
  if (agent && remoteShellOf(agent.command)) throw new Error("That agent runs on a machine, and kururu only opens files on this Mac.");
  const written = mentionsIn(`\`${path}\``)[0] ?? { text: path, path, line: null, cue: true, at: 0 };
  const [found] = locateMentions([{ ...written, line: line ?? written.line }], agent ? [agent.cwd] : projectDirsOf(profileId), 0);
  if (!found) throw new Error(`${path} is not a file inside a project kururu has open${agent ? ` (looked from ${agent.cwd})` : ""}.`);
  const said: string[] = [];
  if (agent) {
    madeFiles.pin(agent, found.file);
    workspaces.setMade(agent.id, madeFiles.of(agent.id));
    pushSnapshot();
    said.push(`Linked ${found.file.path} under the agent's row, and on its card if it runs one.`);
  }
  if (open) {
    if (profileId !== workspaces.active.id) {
      said.push("Not opened: the user's window is showing another profile.");
    } else {
      const home = agent ? workspaces.active.workspaces.find((w) => paneWithAgent(w.layout, agent.id))?.id : undefined;
      await openMade(found.file.root, found.file.path, found.file.line, home ?? null, false);
      said.push(`Opened it on the user's screen, in ${readsInReader(found.file.path) ? "the reader" : "nvim"}.`);
    }
  }
  // The user wrote from Telegram, so they are on their phone, where a link
  // on the Mac's sidebar is no use: a picture goes to the chat as well.
  const key = workspaces.profile(profileId)?.key;
  if (key && isPictureName(found.file.path) && channels.answers(key, "telegram")) {
    try {
      said.push(await sendPicture(key, join(found.file.root, found.file.path), null));
    } catch (err) {
      said.push(`Not sent to the Telegram chat: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return said.join(" ");
}

/**
 * Kuru's `send_telegram_photo`: a picture found where Kuru said — a whole
 * path, `~/…`, or one relative to the agent named or to Kuru's own folder
 * and the profile's projects — checked and copied by `stageOutgoing`, and
 * sent to the chat by the node that reads it. Says what happened, or throws
 * why not, in words for Kuru.
 */
export async function sendPictureFor(profileId: string, agentId: string | null, path: string, caption: string | null): Promise<string> {
  const profile = workspaces.profile(profileId);
  if (!profile) throw new Error("That profile is gone.");
  const agent = agentId ? host.find(agentId) : undefined;
  if (agent && remoteShellOf(agent.command)) throw new Error("That agent runs on a machine, and its files are not on this computer.");
  const refused = channels.telegram.pictureRefusal(profile.key);
  if (refused) throw new Error(refused);
  const bases = agent ? [agent.cwd] : [harnessHome(profile.key), ...projectDirsOf(profileId)];
  const full = wholePath(path, bases);
  if (!full) throw new Error(`${path} is not a file kururu can find${agent ? ` from ${agent.cwd}` : ""}. Give its whole path.`);
  return sendPicture(profile.key, full, caption);
}

async function sendPicture(profileKey: string, full: string, caption: string | null): Promise<string> {
  try {
    return await channels.telegram.sendPicture(profileKey, await stageOutgoing(full), caption);
  } catch (err) {
    if (err instanceof PictureRefused) throw new Error(err.message);
    throw err;
  }
}

/** Whether a root, as a client spelt it, is one the server allows — realpath'd first, as `files.ts` stores them. */
function rootAllowed(root: string): boolean {
  try {
    return allowedRoots().includes(realpathSync(root));
  } catch {
    return false;
  }
}

/**
 * The workspace on screen if its project holds this root, else the first one
 * in the profile whose project does, else null — the drawer's link, which
 * names none. The projects are the branch walk's (`pollBranches`).
 */
function workspaceOfRoot(root: string): string | null {
  const holds = (dir: string) => root === dir || root.startsWith(`${dir}/`);
  const here = state.projects.find((p) => p.workspaceId === workspaces.activeWorkspace.id);
  if (here && [here.root, ...here.choices].some(holds)) return here.workspaceId;
  return state.projects.find((p) => [p.root, ...p.choices].some(holds))?.workspaceId ?? null;
}
