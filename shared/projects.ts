/**
 * What kururu knows about a repository that is not in the repository: whether a
 * card runs in a worktree of its own, what to run in a fresh one before the
 * agent starts, and what starts the project's dev server.
 *
 * Keyed by the repository's root and not by the workspace, and that is the
 * decision this file exists for. A workspace once remembered a dev command and
 * it went with the sidebar's dev buttons, on the argument that a fact *watched*
 * off the process table is not a setting. This is the other kind: three things
 * a person types once, about a project. Two workspaces open on one checkout want
 * the same answers, and a workspace is a drawer that gets renamed and thrown
 * away while the repository stays where it is. So the Settings page lists the
 * repositories the workspaces are in, and the workspace is only how you got
 * there.
 *
 * The root is a path, and a path never comes from a client: the server accepts
 * a settings write only for a root it found itself, by walking up from a
 * terminal it holds — the same rule `files.ts` keeps for what the tree may
 * read.
 *
 * Also here, because both halves want them: how a card's worktree is named and
 * where it goes. Pure string work, since `shared/` has no `node:path` and the
 * client draws the path before the server has made it.
 */

export interface ProjectSettings {
  /**
   * Cards run in a worktree beside the repository. On by default, because it
   * is the whole reason a board hands work to more than one agent: two agents
   * in one checkout are two agents editing each other's files.
   */
  worktrees: boolean;
  /**
   * Run in a *fresh* worktree, before the agent, in the agent's own terminal.
   * `git worktree add` gives you the tracked files and nothing else — no
   * `node_modules`, no `.env`, no build cache — and this is where that gets
   * put right. Empty means nothing is run. It is not run again when a card is
   * handed to a second agent and its worktree is still there.
   */
  setup: string;
  /**
   * What starts the dev server, for the card's ▶. Kept here so the server can
   * hand it a free port when it runs it; the port the server actually took is
   * still read off the kernel, never assumed from the line.
   */
  dev: string;
}

/**
 * What became of one card's worktree when a repository's were retired — one
 * row of the reply to `retire-worktrees`. `commits` is how many the base branch
 * took; `error` is why the worktree is still standing, in git's words where git
 * was the one that said no. A row per card rather than one verdict, because
 * three worktrees can merge and a fourth be mid-edit, and the page has to say
 * which.
 */
export interface WorktreeOutcome {
  cardId: string;
  title: string;
  branch: string;
  commits: number;
  error: string | null;
}

/**
 * Where a card's worktree stands, asked for when its menu opens — the reply to
 * `worktree-status`. Asked and not polled, because each of these is a `git`
 * subprocess and `git.ts` keeps subprocesses out of the four-second loop on
 * purpose; a menu opening is a click, and a click may cost one. `changes` is
 * what `git status` lists, `ahead` and `behind` are against the base.
 */
export interface WorktreeStatus {
  /** The directory is still there. A card whose worktree went can still be merged. */
  present: boolean;
  changes: string[];
  ahead: number;
  behind: number;
}

/**
 * Why a card's merge stopped before anything was ended: the checkout the base
 * is on has uncommitted work in files the branch also changes, and git will
 * not fast-forward over it. Found *before* the agent is ended and the rebase
 * run, by comparing `git status` there with what the branch touched, because
 * git's own refusal would come after both. `files` are tracked files with
 * local changes the merge would overwrite; `untracked` are files the branch
 * creates that already sit there untracked. `clean` is whether the local
 * changes and the branch's fit together in a dry run (`git merge-tree`), null
 * when git could not say — it is what tells committing or stashing the local
 * work apart from a conflict that neither would get past.
 */
export interface MergeBlock {
  base: string;
  files: string[];
  untracked: string[];
  clean: boolean | null;
}

/**
 * What to do about a `MergeBlock`, sent back with the second `merge-card`:
 * commit everything on the base's checkout first and rebase the card onto
 * that, or `git merge --autostash` — set the local changes aside, fast-forward,
 * put them back. Neither is offered over an `untracked` collision or a dry run
 * that conflicted.
 */
export type MergeResolution = "commit" | "stash";

/**
 * The reply to `merge-card`: the merge, with a `note` when it went through but
 * left something to look at (an autostash that did not apply back), or the
 * block that stopped it with nothing ended, for the card to ask about.
 */
export type MergeReply = { commits: number; note: string | null } | { blocked: MergeBlock };

/** By repository root, as a realpath. */
export type ProjectSettingsMap = Record<string, ProjectSettings>;

export const DEFAULT_PROJECT: ProjectSettings = { worktrees: true, setup: "", dev: "" };

/** A shell line somebody typed. Long enough for a `&&` chain; not a script. */
export const COMMAND_MAX = 2000;

/** A command off the disk or the wire: one line, trimmed, capped. */
function command(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, COMMAND_MAX);
}

export function adoptProject(raw: unknown): ProjectSettings {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    worktrees: obj.worktrees !== false,
    setup: command(obj.setup),
    dev: command(obj.dev),
  };
}

/**
 * The whole file. A key that is not an absolute path is dropped: it is about to
 * be compared against a root the server found, and could only ever fail that
 * comparison while riding along in every snapshot.
 */
export function adoptProjects(raw: unknown): ProjectSettingsMap {
  const out: ProjectSettingsMap = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [root, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!root.startsWith("/")) continue;
    out[root] = adoptProject(value);
  }
  return out;
}

export function projectSettingsFor(map: ProjectSettingsMap, root: string): ProjectSettings {
  return map[root] ?? DEFAULT_PROJECT;
}

/**
 * Whether a project's settings are the defaults, which is when its entry can
 * be left out of the file rather than written as three defaults that would
 * then be a row on the page for a repository nobody has thought about.
 */
export function isDefaultProject(settings: ProjectSettings): boolean {
  return settings.worktrees === DEFAULT_PROJECT.worktrees && settings.setup === "" && settings.dev === "";
}

// ---------------------------------------------------------------------------
// Naming a card's worktree
// ---------------------------------------------------------------------------

/** How much of a title goes into a branch name. Enough to recognise; short enough to type. */
const SLUG_MAX = 40;

/**
 * A card's title as something a branch and a directory can be called. ASCII
 * letters and digits, dashes between; anything else — an accent, an emoji, a
 * slash — is a separator, because `git check-ref-format` has opinions and a
 * directory name with a slash in it is two directories.
 */
export function worktreeSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug || "card";
}

/**
 * The name a card's worktree and branch share. The slug for a person, and the
 * tail of the card's id for git: two cards called "fix the tests" are two
 * pieces of work, and a branch that already exists is a branch `worktree add`
 * refuses to make.
 */
export function worktreeName(card: { id: string; title: string }): string {
  return `${worktreeSlug(card.title)}-${card.id.slice(-4)}`;
}

/** Under `kururu/`, so `git branch` groups them and nothing of yours is ever named the same. */
export function worktreeBranch(name: string): string {
  return `kururu/${name}`;
}

/**
 * Where a worktree goes: beside the repository, in a directory named after it.
 *
 * `~/code/app` gets `~/code/app.worktrees/<name>`. Beside rather than inside,
 * because a worktree under the repository is inside every glob, every watcher
 * and every grep an agent runs in the main checkout — and it would be a
 * directory the file tree lists and the dev-server scan attributes to the wrong
 * project. Beside rather than hidden under `~/.local/state`, because you will
 * want to open one in an editor, and a path you cannot find is a path you do
 * not review.
 *
 * A repository that is *itself* one of these — somebody opened kururu inside a
 * worktree and pressed the robot — gets a sibling in the same container rather
 * than a container of its own, so it does not nest.
 */
export function worktreeDir(root: string, name: string): string {
  const trimmed = root.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  const parent = cut > 0 ? trimmed.slice(0, cut) : "/";
  const base = trimmed.slice(cut + 1);
  const container = parent.endsWith(".worktrees") ? parent : `${parent}/${base}.worktrees`;
  return `${container}/${name}`;
}
