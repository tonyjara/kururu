/**
 * Three small things about strings that were each written several times,
 * and not always the same way.
 *
 * Kept here, with no imports, because the server, the page and the shared
 * modules between them all need them, and a copy per file is how three of
 * the five `~` abbreviations came to call `/Users/meg` a place inside
 * `/Users/me`. `shared/model.ts` keeps its own random hex: it is in the pty
 * host's bundle, and changing that bundle is a host restart.
 */

/**
 * One argument for a POSIX shell, whatever is in it: single-quoted, with a
 * quote inside written as `'\''`.
 *
 * Control characters other than tab and newline are dropped first, which is
 * what the harness's copy always did and the others did not. These strings
 * end up on a command line a pty runs, and a raw escape or carriage return
 * there is a keystroke to the terminal rather than a character of the
 * argument; no path or prompt kururu quotes means one.
 */
export function shq(value: string): string {
  return `'${value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replaceAll("'", `'\\''`)}'`;
}

/**
 * A path with the home directory written as `~`, for showing. Only the home
 * itself or something under it — `/Users/meg` is not `~g`.
 */
export function abbreviateHome(path: string, home: string): string {
  if (!home) return path;
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** `bytes` random bytes as lowercase hex, from the platform's CSPRNG — the same in a page and in Node. */
export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
}
