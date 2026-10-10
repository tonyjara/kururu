/**
 * Where a process *is*, as opposed to where it was started.
 *
 * A terminal's spawn directory is only true for as long as nobody types `cd`,
 * and the first thing anybody does in a fresh shell is go somewhere. So a new
 * tab that opened in the recorded cwd would land in `~` all afternoon while the
 * terminal beside it sat in the project — which is the one thing every
 * multiplexer gets right and the reason tmux has `#{pane_current_path}`.
 *
 * The kernel is asked rather than the shell, because there is no way to ask a
 * shell anything: writing `pwd` into a pty would type it at whatever program is
 * in the foreground. The pid on the end of the pty is the login shell, and its
 * cwd is what `cd` moves — a program running in the foreground has its own, and
 * that is not the one you want to inherit anyway.
 *
 * Best-effort by design: a missing lsof, a process that has exited, a sandbox
 * that refuses — all of them mean "I do not know", and every caller has a
 * recorded cwd to fall back to.
 */
import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";

/**
 * Short, because this runs between a click on `+` and a pty appearing. A slow
 * answer is worse than the fallback it would have replaced.
 */
const TIMEOUT_MS = 1500;

export async function processCwd(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  // Linux says it in a symlink; macOS — the platform kururu is built for — has
  // no /proc, so it costs a process.
  if (process.platform === "linux") {
    return readlink(`/proc/${pid}/cwd`).catch(() => undefined);
  }
  const out = await lsofCwd(pid);
  for (const line of out.split("\n")) {
    // `-F n` prints one field per line; the cwd is the `n` record, and only an
    // absolute path is worth believing.
    if (line.startsWith("n/")) return line.slice(1);
  }
  return undefined;
}

function lsofCwd(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "lsof",
      ["-a", "-d", "cwd", "-p", String(pid), "-F", "n"],
      { timeout: TIMEOUT_MS },
      (err, stdout) => resolve(err && !stdout ? "" : stdout),
    );
  });
}

/**
 * `processCwd` for many processes in one `lsof`, for the Processes page's list
 * of nvims, which wants every one's directory every few seconds while it is
 * open. One process for the lot rather than one each; a pid missing from the
 * answer is a process that went or is not ours to ask about.
 */
export async function processCwds(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const wanted = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (wanted.length === 0) return out;
  if (process.platform === "linux") {
    await Promise.all(
      wanted.map(async (pid) => {
        const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => undefined);
        if (cwd) out.set(pid, cwd);
      }),
    );
    return out;
  }
  const text = await new Promise<string>((resolve) => {
    execFile(
      "lsof",
      ["-a", "-d", "cwd", "-p", wanted.join(","), "-F", "pn"],
      { timeout: TIMEOUT_MS },
      (err, stdout) => resolve(err && !stdout ? "" : stdout),
    );
  });
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1)) || 0;
    else if (line.startsWith("n/") && pid > 0) out.set(pid, line.slice(1));
  }
  return out;
}
