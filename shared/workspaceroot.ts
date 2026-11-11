/**
 * A workspace's root folder, as it may be stored: one absolute path on this
 * Mac, or nothing.
 *
 * Its own module because three roads bring one in — Settings → Workspaces,
 * Kuru's `set_workspace_root`, and a session file or blob written by an
 * older or a hand-edited kururu — and the path ends up as the directory of a
 * process, so all three are read the same way. Pure: whether the folder is
 * there is the server's to ask of the disk, and it asks at the moment the
 * root is set and again at every spawn (`standingDir`), because a folder that
 * was there when it was chosen can be deleted or renamed since.
 *
 * `~` is taken, since it is how a person writes a path, and stored expanded:
 * a process's cwd has no tilde, and comparing a stored `~/x` with a
 * terminal's `/Users/me/x` is exactly the kind of near-miss this field is
 * here to end. It is drawn with the tilde again (`tildePath`). String work
 * rather than `node:path`, which `shared/` does not have: the page draws one.
 */

/** Long enough for any real folder; a path past this is not one somebody typed. */
export const ROOT_MAX = 1024;

/**
 * The cleaned root, null for "none" (an empty string or null), or undefined
 * for a value that is not a path: relative, too long, or with a control
 * character in it, which no folder name a person chose has and a command line
 * would read as something else.
 */
export function workspaceRootPath(value: unknown, home: string): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const typed = value.trim();
  if (typed === "") return null;
  if (typed.length > ROOT_MAX || /[\u0000-\u001f\u007f]/.test(typed)) return undefined;
  const expanded = typed === "~" ? home : typed.startsWith("~/") ? `${home}${typed.slice(1)}` : typed;
  if (!expanded.startsWith("/")) return undefined;
  // `.` and `..` folded away, as the kernel would, so the stored path is the
  // one a terminal started there reports back.
  const parts: string[] = [];
  for (const part of expanded.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** A root as a person reads one: under the home folder, with `~` in front. */
export function tildePath(path: string, home: string): string {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * The root a blob or a session file says, read as defensively as everything
 * else in one: anything that is not a clean path is no root, never an error,
 * since the worst a lost root costs is the fallback rule.
 */
export function adoptRoot(raw: unknown, home: string): string | null {
  return workspaceRootPath(raw, home) ?? null;
}
