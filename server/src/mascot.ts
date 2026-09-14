/**
 * The mascot: the little animated thing that says an agent is still going, and
 * the sheet it is cut from.
 *
 * A dot that pulses says "working" only to somebody already watching it, and
 * nobody watches a sidebar — they glance at it. Movement is read before colour
 * and long before a tooltip, so the one state worth spotting gets something
 * alive in it, and the other three keep the dot they had. It is also the one
 * piece of chrome in here allowed to be fun; the rest is deliberately furniture.
 *
 * This module exists because *which* animation is the user's decision, and there
 * are two halves to that. The picture comes from `assets/spritesheets` — found
 * on disk the same way `index.ts` finds the built web app, and overridable with
 * `KURURU_ASSETS`, because an app that already resolves its own front end
 * relative to this file gains nothing from a second, cleverer scheme for its
 * artwork. The *selection* — which row, which columns, how fast — is a small
 * JSON file at `~/.config/kururu/mascot.json`, written by Settings. XDG's config
 * directory rather than the state one `persist.ts` uses, because this is a thing
 * a person chose, not a thing kururu wants back.
 *
 * A user who would rather supply their own art drops a PNG at
 * `~/.config/kururu/mascot.png` and picks `custom` in Settings. It is a sheet
 * like any other: a strip of frames is a sheet with one row in it, so there is
 * no second shape to support and no manifest to write — Settings is where the
 * grid gets described, and it has the picture in front of it while you do.
 *
 * Nothing here validates a replacement's *contents*. A file that is not a PNG is
 * served exactly as it was left and fails in the browser, which falls back to
 * the dot. Quietly substituting the frog for a file somebody deliberately put
 * there would read as the feature being broken rather than as the file being
 * wrong — the same reason `set-workspace-color` refuses a bad colour instead of
 * clearing it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MascotConfig } from "../../shared/model";
import { adoptMascot, DEFAULT_MASCOT, isSheetName } from "../../shared/model";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the sheets live. The same `../../` walk `index.ts` does for `web/dist`,
 * and wrong in exactly the same situations — which is the point: one way of
 * finding the things that ship beside the code, not two.
 */
const ASSETS = process.env.KURURU_ASSETS || join(HERE, "../../assets/spritesheets");

/** The name Settings uses for "the file the user dropped in themselves". */
export const CUSTOM = "custom";

function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kururu");
}

/** Where a user's own sheet goes, if they would rather not use one of ours. */
export function customSheetPath(): string {
  return process.env.KURURU_MASCOT || join(configDir(), "mascot.png");
}

function configPath(): string {
  return join(configDir(), "mascot.json");
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/**
 * Every sheet Settings may offer, by name.
 *
 * `guide` is skipped: it is the labelled key to the others, useful to a person
 * reading the repo and meaningless as a mascot. A missing assets directory is
 * not an error — it means the built-ins are unavailable and a custom sheet is
 * the only option, which is a thing Settings can say.
 */
export function sheets(): string[] {
  try {
    return readdirSync(ASSETS)
      .filter((name) => extname(name).toLowerCase() === ".png")
      .map((name) => name.slice(0, -4))
      .filter((name) => name !== "guide" && isSheetName(name))
      .sort();
  } catch {
    return [];
  }
}

/** True when the user has left a sheet of their own to pick. */
export function hasCustomSheet(): boolean {
  try {
    return statSync(customSheetPath()).isFile();
  } catch {
    return false;
  }
}

/**
 * The file a sheet name refers to, or null.
 *
 * The name is checked against the *list*, never pasted into a path and hoped
 * for. `isSheetName` already refuses anything with a slash or a dot in it, so
 * this is the second of the two checks `files.ts` argues for — and the same
 * reasoning applies, since the name arrives from a client and kururu is
 * reachable from the tailnet.
 */
export function sheetFile(name: string): string | null {
  if (name === CUSTOM) {
    const path = customSheetPath();
    return existsSync(path) ? path : null;
  }
  if (!isSheetName(name) || !sheets().includes(name)) return null;
  return join(ASSETS, `${name}.png`);
}

/**
 * A megabyte, which is about fifty times the largest sheet that ships. Not a
 * guard against the user — it is their own file on their own machine — but
 * against the accident where `mascot.png` turns out to be a screenshot, and
 * kururu then ships it down to a phone on every page load.
 */
const LIMIT = 1024 * 1024;

/** The bytes of one sheet, or null if it is missing or absurd. */
export function sheetImage(name: string): Buffer | null {
  const path = sheetFile(name);
  if (!path) return null;
  try {
    if (statSync(path).size > LIMIT) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The selection
// ---------------------------------------------------------------------------

/**
 * What to animate. Read from disk every time rather than cached: it is a
 * hundred bytes, it is read when a client connects rather than per frame, and
 * re-reading is what lets the file be edited by hand without a restart.
 *
 * A config naming a sheet that is not there falls back to the default sheet
 * rather than to the whole default selection — the row and columns somebody
 * chose are still what they chose, and losing them because a PNG was deleted
 * would be the more annoying half of the answer.
 */
export function readConfig(): MascotConfig {
  let stored: unknown = null;
  try {
    stored = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    // No file, or one that does not parse. The default frog, either way.
  }
  const config = adoptMascot(stored);
  const there = config.sheet === CUSTOM ? hasCustomSheet() : sheets().includes(config.sheet);
  return there ? config : { ...config, sheet: DEFAULT_MASCOT.sheet };
}

/**
 * Written atomically, for the same reason `persist.ts` is: the alternative is a
 * truncated JSON file where the settings used to be. A write that fails is not
 * worth failing anything over — the setting stays live in this session and the
 * next start is the one that forgets it.
 */
export function writeConfig(config: MascotConfig): void {
  const path = configPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(config, null, 2), "utf8");
    renameSync(temp, path);
  } catch {
    // Settings that could not be saved are still settings for now.
  }
}
