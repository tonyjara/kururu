/**
 * The mascot: the little animated thing that says an agent is still going.
 *
 * A dot that pulses says "working" only to somebody already watching it, and
 * nobody watches a sidebar — they glance at it. Movement is read before colour
 * and long before a tooltip, so the one state worth spotting gets something
 * alive in it, and the other three keep the dot they had. It is also the one
 * piece of chrome in here allowed to be fun; the rest is deliberately furniture.
 *
 * This module exists because the sprite is **replaceable**, and that is the
 * whole point of it being a file rather than a drawing in the stylesheet. Drop a
 * PNG at `~/.config/kururu/mascot.png` and it is the mascot; delete it and the
 * built-in frog is back. XDG's *config* directory rather than the state one
 * `persist.ts` writes to, because this is a thing a person chose, not a thing
 * kururu wants back.
 *
 * The contract is one sentence: **a horizontal strip of square frames.** No
 * manifest, no frame size, no count — a strip describes itself, since the number
 * of frames is its width over its height, and the browser can read both off the
 * image it has already loaded. Everything a sidecar JSON file would have said is
 * either derivable or a decision kururu should be making anyway. `assets/mascots`
 * has the frog in six palettes already cut to that shape, and
 * `tools/cut-mascot.py` is what cut them out of the sheets in
 * `assets/spritesheets` if you want a different animation or facing.
 *
 * Nothing here validates the replacement beyond its size. A file that is not a
 * PNG, or is a strip of the wrong shape, is served exactly as it was left: the
 * browser either draws it or fails to, and a failed one falls back to the dot.
 * Quietly substituting the built-in for a file somebody deliberately put there
 * would read as the feature being broken rather than as the file being wrong —
 * the same reason `set-workspace-color` refuses a bad colour instead of
 * clearing it.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where a replacement goes. `KURURU_MASCOT` names a file outright, which is how
 * you try one without moving anything.
 */
export function mascotPath(): string {
  return (
    process.env.KURURU_MASCOT ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kururu", "mascot.png")
  );
}

/**
 * A megabyte, which is about five hundred times a sensible sprite strip. Not a
 * guard against the user — it is their own file on their own machine — but
 * against the accident where `mascot.png` turns out to be a screenshot, and
 * kururu then ships it down to a phone on every page load.
 */
const LIMIT = 1024 * 1024;

/**
 * The strip to serve, and whether it was the user's.
 *
 * Read on every request rather than cached: the file is a kilobyte, and reading
 * it each time is what makes swapping the sprite take effect on a reload instead
 * of on a restart. The replacement is checked with `statSync` first so that the
 * ordinary case — no replacement at all — costs one failed stat and no I/O.
 */
export function mascot(): { body: Buffer; custom: boolean } {
  const path = mascotPath();
  try {
    if (statSync(path).size <= LIMIT) return { body: readFileSync(path), custom: true };
  } catch {
    // No replacement, or one that cannot be read. Either way, the frog.
  }
  return { body: BUILTIN, custom: false };
}

/**
 * The built-in frog: four frames of `assets/mascots/frog-green.png`, inlined.
 *
 * Inlined rather than read off disk because `desktop/build.mjs` bundles this
 * half of the server into a single `server.mjs` that runs inside Electron, and a
 * relative path to an asset directory is a thing that works in the repo and
 * fails in the app. A kilobyte of base64 is cheaper than an asset-copying step
 * in the build, and it means the mascot cannot go missing.
 */
const BUILTIN = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAFQAAAAVCAYAAADYb8kIAAAC0ElEQVR42u2XTXLiMBCFn1w6xcwKswEWnCGESs3MDdhbwLAM" +
  "9whZzg9kzw1gKhA4A4shG5zVcAqKzgIkZFkKNibUhKKrqDINtNGn161nhku4o8Yp8r6/YrG8zF1iP0yxbBEAArC5rnFCjVNl" +
  "/EXlTej8oiYHzE49lq7UqwCAfNHHxPFTfjZq6tTR+/QDACCWLfTQJQlhUv2zg56yRcWypa7zRT+W77W7ZwY0g5rS1AOgNiwC" +
  "+u8a59nyB6gpS32cZctnVFOSenITXPcxRwk7V6BWyF9/AbM1c9WSY8JUuARr3msxD9X1pDsG+ivGPzLMSr2KxTxUi0+rpkgY" +
  "6pWwJreP1jKLeWj9jCX549o7Qn/lGfld7pRR9qhyf5NJTbZaSWNy+2hVO98HMrgTkQ14QE/ZEb+Qk7l1KqhZPaMB4FA1HRou" +
  "mG6g23bKF30QER4+/wQABP++KzviF3IqjxpPBTI2+DXPqNoX3dSe0QZ5H4BjwrQD1WDG5gNjKk+kiYwo8cxTwDQTrntGdTrX" +
  "OE4BIFUdYG8tbraSOZwZY8p2kAFOLFsbBX/7/easM9Vnhit/CgDm+HCOhoSbwvXCwaCh4BARGIvXUG2exOiWPRLD5sauJDTJ" +
  "yoRbfvMeAKxq1u6RVuFch8kYQzBoYDEPET6/wC/kIlB1tdoUa4MJAGLYjMy0RCb8RADeGg2H1NqczCUP4fOLAjTtPYGIIjkz" +
  "ZH4xD+1fKHkxiC6oYtlSr1MDcKn8UFcQmaES4JW4xrQ9QuX+RinVZUem7REwWzstU+y0dXjHJODfA4B1AzIcYnz7lEBExGR7" +
  "T9ujyByVC5z2nnAlrsEY2ym35AEzyzOycbiZC1besTuG/sinjLdrUUcGcOzwtn/Im7ZHJCEFgwaCQUO1voQZ3AlbjqHsrW2L" +
  "1CGKYRNi2NzA0sCJTt2ak+7gowUzDpL1wZVcbZ8FzH+kvKTxCiK0BbRi3GZ9AAAAAElFTkSuQmCC",
  "base64",
);
