/**
 * LazyGit, as a tab: the new-tab menu's row and a workspace row's "Open
 * LazyGit".
 *
 * It is the one program kururu opens that is neither a shell nor an agent, and
 * it exists as a row because the way to it used to be nvim — open an editor,
 * then the editor's git — for something used more often than the editor. A
 * flag on `new-tab` rather than a `Launcher`, for nvim's reason: there is no
 * model to pick and no CLI setting that applies to it. And the line is built
 * here and on the server, never in the browser, for the reason `launcher` is
 * an id — see `shared/launchers.ts`.
 *
 * **Quitting it closes the tab**, which is where it parts from nvim. nvim
 * drops back to a shell because `:q` closes a buffer and not the editor;
 * LazyGit has no buffers, and `q` is somebody finished with it. Only a clean
 * quit, though. A LazyGit that would not start, or the check below saying it
 * is not there, leaves a shell standing under what it said, because the
 * server reaps an ended terminal at once and the reason would go with the tab.
 *
 * On a machine it is typed into the workspace's tmux session, as nvim and the
 * agents are, behind the same question the agent launchers ask first: is it
 * installed there.
 */

import { checkName } from "./machines";

/**
 * Whether the program is there, with its command, its name and the place as
 * `$1 $2 $3`. `AGENT_CHECK`'s first half, asked from inside the shell that is
 * about to run it for that check's reason — a non-interactive login on a
 * machine never reads the rc file most installs put themselves on the PATH
 * from — and kept free of single quotes and backslashes for the same reason:
 * it rides as one single-quoted word through whatever the account's shell is.
 */
export const LAZYGIT_CHECK = [
  `c=$1; n=$2; m=$3`,
  `command -v "$c" >/dev/null 2>&1 || { echo; echo "kururu: $n is not installed on $m. There is no $c on the PATH here."; echo "kururu: install it in this tab, then open it again."; exit 127; }`,
].join("; ");

/** One argument for a POSIX shell, whatever is in it. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The check, as the start of a line: it fails, and nothing after `&&` runs, when there is no LazyGit. */
function checked(where: string): string {
  return `sh -c ${quote(LAZYGIT_CHECK)} kururu lazygit LazyGit ${quote(where)}`;
}

/**
 * The command line for a LazyGit tab on this Mac.
 *
 * The title is set by hand first, for `nvimCommand`'s reason: the tab is named
 * from the terminal's title, and this line cut at its last slash would be
 * `sh}" -l`. LazyGit leaves the title alone, so the tab says "lazygit" for as
 * long as it runs.
 */
export function lazygitCommand(): string {
  return `printf '\\033]2;lazygit\\007'; ${checked("this Mac")} && lazygit || exec "\${SHELL:-/bin/sh}" -l`;
}

/**
 * The line typed into a session on a machine. `exit` after a clean quit is
 * what closes the tab there: the session's shell ends, tmux with it, and ssh
 * comes home with nothing left to attach to.
 */
export function lazygitRun(where: string): string {
  return `${checked(checkName(where))} && lazygit && exit`;
}
