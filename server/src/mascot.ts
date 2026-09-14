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
 * artwork. The *selections* — which row, which columns, how fast, and which of
 * the ones you kept is the badge — are a small JSON file at
 * `~/.config/kururu/mascot.json`, written by Settings. A list rather than one,
 * because a sheet holds six animations across eight facings and what people do
 * with a picker is find three they like: a picker with no way to keep anything
 * makes you re-find a selection you already made.
 *
 * A user's own art lives in `~/.config/kururu/sheets`, and there can be as many
 * as they like. Settings writes there when you import one; dropping a PNG in
 * yourself does exactly the same thing, because the directory *is* the
 * mechanism and the button is only a door onto it. There is no second shape to
 * support and no manifest to write: a strip of frames is a sheet one row tall,
 * and Settings is where the grid gets described with the picture in front of you.
 *
 * It was a single slot at `~/.config/kururu/mascot.png` called `custom`, which
 * could hold one file and therefore made "which sheet" a question with two
 * answers: one of ours, or *the* other one. A directory answers it the same way
 * for both. A file left at the old path is moved in on the first run that finds
 * it rather than being stranded.
 *
 * What arrives *over the network* is checked, and that is the one asymmetry
 * worth naming. A file you put in the directory yourself is served exactly as
 * you left it — if it is not a PNG it fails in the browser and the row falls
 * back to the dot, and quietly substituting the frog would read as the feature
 * being broken rather than the file being wrong. An import is different in kind:
 * it is a write to the user's config directory, requested by a client, and
 * kururu is reachable from the tailnet. So an import must be a real PNG, under
 * the size cap, with a name that is a name — the same three questions `files.ts`
 * asks, for the same reason.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Mascot, MascotSet } from "../../shared/model";
import { adoptMascots, DEFAULT_MASCOT, isSheetName } from "../../shared/model";
import { configDir, readConfigFile, writeConfigFile } from "./config";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the sheets live. The same `../../` walk `index.ts` does for `web/dist`,
 * and wrong in exactly the same situations — which is the point: one way of
 * finding the things that ship beside the code, not two.
 */
const ASSETS = process.env.KURURU_ASSETS || join(HERE, "../../assets/spritesheets");

/** Where a user's own sheets live. Written by an import, readable by hand. */
export function sheetsDir(): string {
  return join(configDir(), "sheets");
}

const FILE = "mascot.json";

/**
 * The single-slot sheet an older kururu supported, moved into the directory that
 * replaced it. Run once at start; a no-op for everybody who never had one.
 *
 * Moved rather than copied, because leaving it would mean the same picture in
 * two places with only one of them reachable — and renamed to `mascot`, which is
 * what it was always called in the UI.
 */
export function adoptLegacySheet(): void {
  const legacy = join(configDir(), "mascot.png");
  const home = join(sheetsDir(), "mascot.png");
  try {
    if (!existsSync(legacy) || existsSync(home)) return;
    mkdirSync(sheetsDir(), { recursive: true });
    renameSync(legacy, home);
  } catch {
    // A sheet that could not be moved is a sheet that is not offered. Not worth
    // failing a start over.
  }
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/** The sheets that ship. `green.png` and the guide, which is not one. */
export function builtinSheets(): string[] {
  return pngNamesIn(ASSETS);
}

/** The sheets the user brought. Imported, or dropped in by hand — same thing. */
export function importedSheets(): string[] {
  return pngNamesIn(sheetsDir());
}

/**
 * Every sheet Settings may offer, by name.
 *
 * `guide` is skipped: it is the labelled key to the animations, useful to a
 * person reading the repo and meaningless as a mascot. A missing directory is
 * not an error on either side — no assets means the built-ins are unavailable,
 * no `sheets` directory means nothing has been imported yet, and both are things
 * Settings can simply draw as a shorter list.
 */
export function sheets(): string[] {
  return [...new Set([...builtinSheets(), ...importedSheets()])].sort();
}

function pngNamesIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => extname(name).toLowerCase() === ".png")
      .map((name) => name.slice(0, -4))
      .filter((name) => name !== "guide" && isSheetName(name))
      .sort();
  } catch {
    return [];
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
 *
 * What ships wins a tie. Nothing can create one — an import refuses a name a
 * built-in already has — but a directory is a thing people edit by hand, and the
 * answer to "which green is it" should not depend on which listing came back
 * first.
 */
export function sheetFile(name: string): string | null {
  if (!isSheetName(name)) return null;
  if (builtinSheets().includes(name)) return join(ASSETS, `${name}.png`);
  if (importedSheets().includes(name)) return join(sheetsDir(), `${name}.png`);
  return null;
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
// The selections
// ---------------------------------------------------------------------------

/**
 * What to animate, and everything else that has been kept.
 *
 * Read from disk every time rather than cached: it is a few hundred bytes, it is
 * read when a client connects rather than per frame, and re-reading is what lets
 * the file be edited by hand without a restart.
 *
 * A saved mascot naming a sheet that is no longer there falls back to the
 * default *sheet*, keeping its row and columns — losing the selection somebody
 * made because a PNG was deleted would be the more annoying half of the answer,
 * and the frames are still frames.
 */
export function readMascots(): MascotSet {
  const set = adoptMascots(readConfigFile(FILE));
  const there = sheets();
  return {
    default: set.default,
    list: set.list.map((mascot) =>
      there.includes(mascot.sheet) ? mascot : { ...mascot, sheet: DEFAULT_MASCOT.sheet },
    ),
  };
}

export function writeMascots(set: MascotSet): void {
  writeConfigFile(FILE, set);
}

/**
 * An id nothing in the list is using.
 *
 * Counted from the list rather than from a counter in memory, because these
 * outlive the process that made them: a sequence reset by a server restart would
 * hand out `m2` to a second mascot when the file already had one, and the
 * adopter would then have to drop one of them.
 */
export function freshMascotId(list: Mascot[]): string {
  const taken = new Set(list.map((m) => m.id));
  for (let n = 1; ; n++) if (!taken.has(`m${n}`)) return `m${n}`;
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

/** The eight bytes every PNG starts with. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type ImportResult = { ok: true; name: string } | { ok: false; error: string };

/**
 * Put a file somebody chose into the sheets directory.
 *
 * Three questions, and each has a reason beyond tidiness. The *name* must be a
 * name because it becomes a path. The *bytes* must be a PNG because this writes
 * to the user's config directory on behalf of a client, and "a file arrived over
 * the network and was saved under a name it chose" is worth being narrow about —
 * a browser that cannot decode it would fail later and quietly, which is the
 * wrong end to find out. And the *size* is capped because a sheet is sent to a
 * phone on every load, and the accident this is really guarding against is
 * somebody picking a screenshot.
 *
 * It refuses a name already in use rather than overwriting. Settings picks a
 * free one before it sends, so hitting this means two clients raced or somebody
 * typed the URL — and silently replacing a sheet other saved mascots are cut
 * from is not a thing to do on a guess. Removing it first is one click.
 */
export function importSheet(name: string, bytes: Buffer): ImportResult {
  if (!isSheetName(name)) return { ok: false, error: "a sheet name is letters, digits and dashes" };
  if (bytes.length > LIMIT) return { ok: false, error: "that file is over a megabyte" };
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) return { ok: false, error: "that file is not a PNG" };
  if (sheets().includes(name)) return { ok: false, error: `there is already a sheet called ${name}` };

  const path = join(sheetsDir(), `${name}.png`);
  try {
    mkdirSync(sheetsDir(), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, bytes);
    renameSync(temp, path);
  } catch {
    return { ok: false, error: "could not write to the sheets directory" };
  }
  return { ok: true, name };
}

/**
 * Forget an imported sheet. Only an imported one: what ships is not the user's
 * to delete from in here, and a button that removed a file out of the
 * application directory would be a different and much worse button.
 *
 * Saved mascots cut from it are left alone. They fall back to the default sheet
 * when they are next read, keeping the row and columns somebody chose — which is
 * the same answer as a sheet deleted by hand, and there is no reason for the two
 * to differ.
 */
export function removeSheet(name: string): boolean {
  if (!isSheetName(name) || !importedSheets().includes(name)) return false;
  try {
    unlinkSync(join(sheetsDir(), `${name}.png`));
    return true;
  } catch {
    return false;
  }
}
