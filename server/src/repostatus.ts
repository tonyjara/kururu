/**
 * Where each workspace is on the disk, and what git says about it: the
 * branch on its row, the project and the roots the file tree may read, the
 * databases its env files name, and the status its row's git menu acts on.
 *
 * One walk up from the directories its terminals stand in, on a timer, since
 * nothing raises an event when a branch moves. It is also the one place roots
 * are learned, from what kururu holds and never from a client — the rule
 * `files.ts` keeps.
 */
import type { WorkspaceDatabase } from "../../shared/databases";
import { findPane, panes } from "../../shared/layout";
import type { Workspace } from "../../shared/model";
import { GIT_STATUS_MS, type GitAction, type RepoGit, type WorkspaceBranch, type WorkspaceProject } from "../../shared/wire";
import { broadcast, host, state, workspaces } from "./context";
import { type DatabaseScanInput, scanDatabases } from "./databases";
import { allowRoot } from "./files";
import { readHead, repoAt } from "./git";
import { tabCwd } from "./terminals";
import { commitTyped, defaultBranch, fastForward, fetchAll, mainRoot, pullBranch, pushBranch, repoStatus } from "./worktree";

/** The databases a workspace's env files name, as the last scan found them. Outside `attach`, whose own `state` is the host's. */
export function databasesOfWorkspace(workspaceId: string): WorkspaceDatabase[] {
  return state.databases.filter((db) => db.workspaceId === workspaceId);
}

/**
 * Every directory this workspace could be said to be *in*, best first.
 *
 * A workspace has no directory of its own — it is an arrangement, not a project
 * — so this asks the two things that do have one, in the order of how much they
 * know. A live terminal's cwd is where somebody actually is. A pane's remembered
 * cwd is where its terminals were, and is the only one of the two that survives
 * a restart with the panes empty.
 */
export function workspaceDirs(workspace: Workspace): string[] {
  const dirs: string[] = [];
  const add = (dir: string | undefined | null) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };
  for (const pane of panes(workspace.layout)) {
    for (const agentId of pane.agentIds) add(tabCwd(agentId));
    add(pane.cwd);
  }
  return dirs;
}

/**
 * The same directories, with the one you are *looking at* first.
 *
 * `workspaceDirs` answers in tree order, which is the wrong answer for the
 * branch: a workspace holding two checkouts reported whichever pane happened to
 * be first in the tree, so a row named after the project could sit there
 * showing a sibling repository's branch and never move while you checked things
 * out all afternoon. That is not a stale row — it is a
 * row faithfully reporting a repository nobody asked about, which is worse,
 * because it looks exactly like the poll being broken.
 *
 * Focus is what breaks the tie, and it is the tie-break that costs nothing to
 * be wrong about: it is one line of text, the tooltip already says which
 * working tree it came from, and the pane you last touched is the one you just
 * ran `git switch` in. The tab showing inside that pane goes first for the same
 * reason one pane goes before another.
 *
 * Only a reordering. Every directory `workspaceDirs` would have offered is
 * still offered, in its own order, behind these — so a focused pane with no
 * repository under it falls through to exactly the old answer.
 */
export function focusedDirs(workspace: Workspace): string[] {
  const pane = findPane(workspace.layout, workspace.focusedPaneId);
  const front: (string | undefined)[] = [];
  if (pane) {
    const showing = pane.agentIds[pane.activeIdx];
    if (showing) front.push(tabCwd(showing));
    for (const agentId of pane.agentIds) front.push(tabCwd(agentId));
    front.push(pane.cwd);
  }
  const first = front.filter((dir): dir is string => Boolean(dir));
  return [...new Set([...first, ...workspaceDirs(workspace)])];
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/**
 * Where the repository is for a given directory, so the walk up the tree is not
 * redone every four seconds.
 *
 * Only the *walk* is remembered, never the branch. That split is the whole
 * design: where `.git` lives changes about as often as somebody moves a project,
 * and what is in `HEAD` changes every time they check something out — which is
 * the fact the row exists to show. Caching the second would make the row a
 * picture of a branch from a minute ago, which is worse than no row.
 */
const repoSeen = new Map<string, { at: number; found: { root: string; git: string } | null }>();
const REPO_CACHE_MS = 60_000;

export async function repoFor(dir: string): Promise<{ root: string; git: string } | null> {
  const had = repoSeen.get(dir);
  if (had && Date.now() - had.at < REPO_CACHE_MS) return had.found;
  const found = await repoAt(dir);
  repoSeen.set(dir, { at: Date.now(), found });
  return found;
}

/**
 * The roots a workspace's tree could be drawn at: each directory's repository,
 * and the directory itself when it is somewhere inside one — a tab sitting in
 * `web/` of a monorepo is a tab whose tree you might want to start at `web/`.
 * Tabs in the same place say it once, which is most workspaces: one entry, and
 * the header draws no picker at all.
 */
async function rootChoices(dirs: string[]): Promise<string[]> {
  const choices: string[] = [];
  const add = (dir: string) => {
    if (!choices.includes(dir)) choices.push(dir);
  };
  for (const dir of dirs) {
    const repo = await repoFor(dir);
    if (repo) add(repo.root);
    if (!repo || repo.root !== dir) add(dir);
  }
  return choices;
}

let lastBranchJson = "";
let lastProjectJson = "";
let lastDatabasesJson = "";

/**
 * What every workspace of the active profile has checked out.
 *
 * The active profile only. Every other profile's workspaces are not on
 * anybody's screen — the snapshot itself carries one profile for the same
 * reason — so the rows this could describe are the rows nobody can see.
 */
export async function pollBranches(): Promise<void> {
  if (!host || !workspaces) return;
  const branches: WorkspaceBranch[] = [];
  const projects: WorkspaceProject[] = [];
  const scans: DatabaseScanInput[] = [];
  for (const workspace of workspaces.active.workspaces) {
    const dirs = focusedDirs(workspace);
    let project = dirs[0];
    for (const dir of dirs) {
      const repo = await repoFor(dir);
      if (!repo) continue;
      project = repo.root;
      const head = await readHead(repo);
      // A repository whose HEAD could not be read is still the answer to "which
      // repository is this workspace in", so the walk stops here either way —
      // trying the next directory up would find the *parent* repo and report a
      // branch from a project this workspace is not in.
      if (head) branches.push({ workspaceId: workspace.id, ...head, git: await gitFor(repo.root) });
      break;
    }
    /**
     * The roots are allowed here, by the server, having found them by walking
     * up from a directory a terminal is in — which is the rule `files.ts`
     * keeps: a root is learned from what kururu holds, never from a client. None
     * is wider than what that terminal can already read.
     *
     * The choices are in tree order rather than focus order, so the header's
     * list does not reshuffle every time focus crosses a pane.
     */
    if (project) {
      const choices = await rootChoices(workspaceDirs(workspace));
      if (!choices.includes(project)) choices.unshift(project);
      for (const root of choices) allowRoot(root);
      projects.push({ workspaceId: workspace.id, root: project, choices });
      scans.push({ workspaceId: workspace.id, project, roots: choices });
    }
  }
  const projectJson = JSON.stringify(projects);
  if (projectJson !== lastProjectJson) {
    lastProjectJson = projectJson;
    state.projects = projects;
    broadcast({ type: "projects", projects });
  }
  /**
   * The env files in the same roots, for the row menu's Databases. The
   * roots are this walk's, which is the whole of why the scan sits here rather
   * than on a timer of its own: it reads under directories the server found
   * by walking up from a terminal, and learns none from anywhere else.
   */
  const databases = await scanDatabases(scans);
  const databasesJson = JSON.stringify(databases);
  if (databasesJson !== lastDatabasesJson) {
    lastDatabasesJson = databasesJson;
    state.databases = databases;
    broadcast({ type: "databases", databases });
  }
  const json = JSON.stringify(branches);
  if (json === lastBranchJson) return;
  lastBranchJson = json;
  state.branches = branches;
  broadcast({ type: "branches", branches });
}

// ---------------------------------------------------------------------------
// The workspace's git, from its row's menu
// ---------------------------------------------------------------------------

/**
 * Which checkout is the main one for a repository the walk found, and which
 * branch "merge" goes into — both subprocesses, and both facts that change
 * about as often as a repository is moved, so they are kept for a minute like
 * the walk is.
 */
const mainSeen = new Map<string, { at: number; root: string; base: string | null }>();

async function mainFor(root: string, fresh = false): Promise<{ root: string; base: string | null }> {
  const had = mainSeen.get(root);
  if (!fresh && had && Date.now() - had.at < REPO_CACHE_MS) return had;
  const main = await mainRoot(root);
  const base = await defaultBranch(main).catch(() => null);
  const seen = { at: Date.now(), root: main, base };
  mainSeen.set(root, seen);
  return seen;
}

/**
 * What `git status` last said, by main checkout. Only the half of `RepoGit`
 * that needs a subprocess is kept here; the branch is read off `HEAD` on every
 * poll like the row's own, so the button can never name a branch the line
 * under it has already moved on from.
 */
const statusSeen = new Map<string, { changes: number; upstream: string | null; ahead: number; behind: number }>();
const statusAt = new Map<string, number>();
const statusBusy = new Set<string>();

/**
 * Ask again, in the background, if it has been long enough — or now, after
 * one of the button's own verbs. One at a time per checkout, so a slow status
 * on a large tree is never stacked up behind itself. A change reruns the
 * branch poll, which is what carries it to the clients.
 */
function refreshStatus(root: string, now = false): void {
  if (statusBusy.has(root)) return;
  if (!now && Date.now() - (statusAt.get(root) ?? 0) < GIT_STATUS_MS) return;
  statusBusy.add(root);
  statusAt.set(root, Date.now());
  void repoStatus(root)
    .then(
      (status) => {
        const changed = JSON.stringify(status) !== JSON.stringify(statusSeen.get(root));
        statusSeen.set(root, status);
        return changed;
      },
      () => statusSeen.delete(root),
    )
    .then((changed) => {
      statusBusy.delete(root);
      if (changed) void pollBranches();
    });
}

/** The row's `git`: the main checkout's head, read now, and its status as last asked. */
async function gitFor(root: string): Promise<RepoGit | null> {
  const main = await mainFor(root).catch(() => null);
  if (!main) return null;
  refreshStatus(main.root);
  const status = statusSeen.get(main.root);
  const repo = status ? await repoFor(main.root) : null;
  const head = repo ? await readHead(repo) : null;
  if (!status || !head) return null;
  return {
    root: main.root,
    branch: head.branch,
    detached: head.detached,
    ...status,
    base: main.base && main.base !== head.branch ? main.base : null,
  };
}

/**
 * One of the row menu's git verbs, on the workspace's main checkout.
 *
 * The checkout is found the way the row's branch is — walking up from where
 * the workspace's terminals are — and then taken to the main one, so a
 * workspace looking at a card's worktree still commits where the button said
 * it would. That walk follows focus, which `docs/layout.md` warns is no way
 * to choose what a button acts on; so the client says which checkout it was
 * showing and a mismatch is refused, and the commit prompt names the path. Detached is refused for everything but a fetch: a commit there is
 * the one git makes easiest to lose.
 */
export async function workspaceGit(
  workspaceId: string,
  shown: string,
  action: GitAction,
  message: string,
): Promise<{ said: string }> {
  const workspace = workspaces.active.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) throw new Error("that workspace is not in this profile");
  let found: { root: string; git: string } | null = null;
  for (const dir of focusedDirs(workspace)) {
    found = await repoFor(dir);
    if (found) break;
  }
  if (!found) throw new Error("this workspace is not in a git repository");
  const { root, base } = await mainFor(found.root, true);
  // Compared, never used: see `workspace-git` in `shared/wire.ts`.
  if (root !== shown) throw new Error(`the workspace is looking at ${root} now, not ${shown} — try again`);
  const repo = await repoFor(root);
  const head = repo ? await readHead(repo) : null;
  if (!head) throw new Error("could not read what is checked out");
  if (head.detached && action !== "fetch") throw new Error(`HEAD is detached at ${head.branch} — check out a branch first`);
  const branch = head.branch;

  try {
    if (action === "fetch") {
      await fetchAll(root);
      return { said: "Fetched" };
    }
    if (action === "pull") {
      await pullBranch(root);
      return { said: `Pulled ${branch}` };
    }
    if (action === "push") {
      await pushBranch(root, branch, (await repoStatus(root)).upstream);
      return { said: `Pushed ${branch}` };
    }

    // The three that commit. Nothing to commit is not a refusal for the two
    // that go on to do something else — a clean tree with commits to merge or
    // push is exactly when those are wanted — only for a plain commit.
    const { changes, upstream } = await repoStatus(root);
    const committed = changes ? (await commitTyped(root, message)).length : 0;
    if (!changes && action === "commit") throw new Error("nothing to commit");
    const files = committed ? `Committed ${committed} file${committed === 1 ? "" : "s"}` : "Nothing to commit";
    if (action === "commit") return { said: files };
    if (action === "commit-push") {
      await pushBranch(root, branch, upstream);
      return { said: `${files}, pushed ${branch}` };
    }
    if (!base) throw new Error(`${files}; there is no main branch to merge into`);
    const { commits } = await fastForward(root, branch, base).catch((err: unknown) => {
      // The commit already happened and is not undone; say so beside the refusal.
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(committed ? `${files}, but ${why}` : why);
    });
    return { said: `${files}, ${base} took ${commits} commit${commits === 1 ? "" : "s"}` };
  } finally {
    refreshStatus(root, true);
  }
}
