/**
 * What happens when you drop a file from the Finder onto a terminal.
 *
 * Every terminal does this and has for decades: the path is typed in, escaped,
 * with a space after it, and you carry on with whatever command you were
 * building. It is the fastest way to say "this file" to something that only
 * takes text, and an agent is exactly that — dropping a screenshot onto claude
 * is how you show it a screenshot.
 *
 * Kururu had to be told, because a web page's default answer to a dropped file
 * is to *navigate to it*, which would replace the whole app with a picture. So
 * the terminal claims file drags, and `App.tsx` swallows the ones that miss.
 *
 * Backslashes rather than quotes, because that is what Terminal.app, iTerm and
 * ghostty all do and the point of this gesture is that your hands already know
 * it. Escaping is by allow-list: anything outside a small set of characters that
 * are safe everywhere gets a backslash, which is correct by construction rather
 * than by remembering every metacharacter in every shell.
 */
import { desktop } from "./desktop";

/** Characters that never need escaping, in any shell anyone runs. */
const SAFE = /[A-Za-z0-9._\-/@:+,=]/;

/** One path, as text a shell or a TUI will read back as a single argument. */
export function escapePath(path: string): string {
  let out = "";
  for (const ch of path) out += SAFE.test(ch) ? ch : `\\${ch}`;
  return out;
}

/**
 * Is this drag carrying files from outside the page?
 *
 * `types` rather than `files`, because on `dragover` the browser will not let
 * anybody read the payload — the same restriction `drag.ts` exists to work
 * around for kururu's own drags — and the decision about whether to accept the
 * drop has to be made there, before the drop happens.
 */
export function isFileDrag(transfer: DataTransfer | null): boolean {
  return !!transfer && Array.from(transfer.types).includes("Files");
}

/**
 * The paths in a drop, in the order they were dropped.
 *
 * Two sources, tried in order. The bridge is the real one and the only one that
 * works for a file dragged out of the Finder: the web deliberately does not tell
 * a page where a dropped file lives, so only Electron can answer. `text/uri-list`
 * is the fallback for a file dragged out of another *page*, which does carry its
 * URL, and costs four lines to support.
 *
 * An empty array is the honest answer for a phone dropping a photo into this
 * same UI over the tailnet. The caller types nothing rather than typing
 * something wrong.
 */
export function pathsFrom(transfer: DataTransfer | null): string[] {
  if (!transfer) return [];

  const bridge = desktop();
  if (bridge) {
    const paths = Array.from(transfer.files)
      .map((file) => bridge.pathForFile(file))
      .filter((path): path is string => !!path);
    if (paths.length > 0) return paths;
  }

  return transfer
    .getData("text/uri-list")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("file://"))
    .map((line) => {
      try {
        return decodeURIComponent(new URL(line).pathname);
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

/**
 * What to type for a drop, or the empty string for one we cannot answer.
 *
 * The trailing space is not a flourish: without it the next thing you type joins
 * onto the filename, and with several files the second path would be glued to
 * the first. Terminal.app has always added it and the reason is the same.
 */
export function textForDrop(transfer: DataTransfer | null): string {
  const paths = pathsFrom(transfer);
  return paths.length === 0 ? "" : `${paths.map(escapePath).join(" ")} `;
}
