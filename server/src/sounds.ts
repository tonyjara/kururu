/**
 * The sounds a notification can make, and the one problem with offering the
 * system's: the browser cannot play them.
 *
 * Kururu ships one — the croak, because kururu is a frog — and then offers
 * whatever the machine already has, which on macOS is `/System/Library/Sounds`
 * plus anything in `~/Library/Sounds`. That is the same shape `mascot.ts` has for
 * sheets and it is here for the same reason: what is worth choosing is not a file
 * kururu wrote, and a picker with nothing in it but our own frog is a picker that
 * makes the setting look decorative.
 *
 * **And a third source, which is the only one anybody chose: the styles
 * registry.** A `sound` entry is a style like a theme is, so a pack can name the
 * noise its window makes along with its palette and its sprite — the coin a
 * brick-and-sky pack wants is not in `/System/Library/Sounds` and never will be.
 * It arrives through `server/src/styles.ts` rather than a `readdir` here, which
 * is why it is the one source in this file whose path was verified against
 * `installed.json` before it was offered.
 *
 * **Every one of those system sounds is AIFF, and Chromium cannot decode AIFF.**
 * Measured rather than assumed — `canPlayType("audio/aiff")` returns the empty
 * string in Electron 44 and `decodeAudioData` throws — so serving the file as it
 * sits on disk would put fourteen names in the dropdown, every one of which is
 * silence. The fix is `afconvert`, which is in `/usr/bin` on every macOS, takes
 * about 24ms for the largest of them, and produces WAV, which every browser can
 * play including the phone's. It happens on the way out rather than at install
 * time because there is no install: these are the OS's files, kururu does not own
 * them, and a cache of transcodes would be a directory that goes stale the day
 * somebody updates the system. 24ms once per sound, behind a year of
 * `cache-control`, is cheaper than the bookkeeping.
 *
 * **An id is never pasted into a path.** `mascot.ts` argues for two checks — a
 * name that is a name, and the name found in the list — and this does the
 * stronger thing that argument was reaching for: the catalogue is built by
 * reading directories, each entry keeps the absolute path it was found at, and
 * resolving an id is a lookup in that list. There is no string concatenation for
 * a traversal to survive, which matters because the id arrives from a client and
 * kururu is reachable from the tailnet.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { installedSounds } from "./styles";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The sounds that ship. The same `../../` walk `mascot.ts` does for its sheets
 * and `index.ts` does for `web/dist` — one way of finding the things that sit
 * beside the code, not three.
 */
const ASSETS = process.env.KURURU_SOUNDS || join(HERE, "../../assets/sounds");

/**
 * Where to look for the machine's own, in the order a tie is broken.
 *
 * The user's directory before the system's, because a file somebody put in
 * `~/Library/Sounds` called `Frog` is a deliberate replacement for the one macOS
 * ships under that name — that is what the directory is *for*, and it is how
 * every other macOS app resolves an alert sound.
 *
 * Linux's freedesktop directory is in the list and costs nothing: it is `.oga`,
 * which is Ogg, which browsers play without help. Everywhere else the list comes
 * back empty and the dropdown is kururu's own sounds, which is a shorter list
 * rather than a broken one.
 */
function systemDirs(): string[] {
  const home = homedir();
  if (process.platform === "darwin") {
    return [join(home, "Library/Sounds"), "/Library/Sounds", "/System/Library/Sounds"];
  }
  return [join(home, ".local/share/sounds"), "/usr/share/sounds/freedesktop/stereo"];
}

/** Served as they are: the browser has a decoder for every one of these. */
const PLAYABLE: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
};

/** Apple's own formats, which no browser decodes. See the header. */
const CONVERTIBLE = new Set([".aiff", ".aif", ".aifc", ".caf"]);

export type SoundKind = "kururu" | "style" | "system";

/** One row of the dropdown. */
export interface SoundInfo {
  id: string;
  /**
   * What to show. For a file on the machine that is the id, which for these is
   * already the name; for a style it is the name the registry gave it, because
   * the row in the Styles tab said *Coin* and the dropdown saying `coin` would
   * be kururu using two words for one thing.
   */
  name: string;
  kind: SoundKind;
}

interface Entry extends SoundInfo {
  path: string;
  ext: string;
}

/**
 * A megabyte and a half of source audio, which is five times the largest thing
 * in `/System/Library/Sounds`. Not a guard against the user — these are their own
 * files — but against the accident where something enormous is sitting in a
 * sounds directory and kururu ships it to a phone.
 */
const LIMIT = 1_536 * 1024;

/**
 * Whether this machine can turn an AIFF into something a browser will play.
 *
 * Looked up once. A macOS without `afconvert` is not a thing that happens, but a
 * Linux box with a `~/.local/share/sounds` full of `.caf` files is, and the right
 * answer there is to leave them out of the list rather than to offer fourteen
 * names that fail in the browser — which is the exact failure this module exists
 * to prevent, arriving by another door.
 */
let converter: string | null | undefined;
function afconvert(): string | null {
  if (converter === undefined) {
    converter = process.platform === "darwin" && existsFile("/usr/bin/afconvert") ? "/usr/bin/afconvert" : null;
  }
  return converter;
}

function existsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Everything offerable, built by reading the directories.
 *
 * Read per call rather than cached, on `readMascots`' reasoning: it is a handful
 * of `readdir`s, it happens when somebody opens a settings page rather than per
 * frame, and re-reading is what makes a file dropped into `~/Library/Sounds`
 * appear without a restart.
 *
 * First wins a tie — kururu's own, then what somebody installed, then the user's
 * own files, then the system's — and the whole file is ordered so that "first"
 * means "most deliberately chosen", with the one deliberate exception argued
 * for below.
 */
function catalogue(): Entry[] {
  const found = new Map<string, Entry>();
  const take = (dir: string, kind: SoundKind) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // A directory that is not there is a shorter list, not an error.
    }
    for (const name of names.sort()) {
      const ext = extname(name).toLowerCase();
      if (!PLAYABLE[ext] && !(CONVERTIBLE.has(ext) && afconvert())) continue;
      const id = name.slice(0, -ext.length);
      if (!id || found.has(id)) continue;
      found.set(id, { id, name: id, kind, path: join(dir, name), ext });
    }
  };
  take(ASSETS, "kururu");
  /**
   * A sound installed from the styles registry — the noise a pack makes.
   *
   * Between the two, and the position is an argument rather than an accident.
   * It is *after* kururu's own because these ids come from the registry and
   * kururu's default sound must not be shadowable by an entry somebody merged:
   * `notify.json` says `croak` and it has to keep meaning the croak. It is
   * *before* the machine's because installing one is a deliberate act and
   * `/System/Library/Sounds` is merely what the OS happens to contain — which
   * is the ordering rule the rest of this file already follows.
   *
   * It is also the one source whose path does not come from a `readdir` here:
   * `installedSounds` resolves it against `installed.json`, so the two-sided
   * name check that every other style asset gets applies to this one too.
   */
  for (const sound of installedSounds()) {
    const ext = extname(sound.path).toLowerCase();
    if (!PLAYABLE[ext]) continue;
    if (found.has(sound.id)) continue;
    found.set(sound.id, { id: sound.id, name: sound.name, kind: "style", path: sound.path, ext });
  }
  for (const dir of systemDirs()) take(dir, "system");
  return [...found.values()];
}

/** What the picker draws, in the order the catalogue was built. */
export function sounds(): SoundInfo[] {
  const all = catalogue();
  const order = (kind: SoundKind) =>
    all.filter((entry) => entry.kind === kind).map(({ id, name, kind: k }) => ({ id, name, kind: k }));
  return [...order("kururu"), ...order("style"), ...order("system")];
}

/**
 * The bytes for one id, in something a browser can play, or null.
 *
 * Null covers every way this can fail — an id nothing answers to, a file that
 * has been deleted since the list was drawn, a transcode that did not work — and
 * they are one answer on purpose: the caller's only move is a 404, and the
 * client's only move is to make no noise. A notification that arrives silently
 * is a notification; a server that throws while composing one is a bug in the
 * part of kururu that was supposed to be the nicety.
 */
export async function soundBytes(id: string): Promise<{ bytes: Buffer; type: string } | null> {
  const entry = catalogue().find((sound) => sound.id === id);
  if (!entry) return null;
  try {
    if (statSync(entry.path).size > LIMIT) return null;
  } catch {
    return null;
  }

  const direct = PLAYABLE[entry.ext];
  if (direct) {
    try {
      return { bytes: readFileSync(entry.path), type: direct };
    } catch {
      return null;
    }
  }
  return convert(entry.path);
}

/**
 * AIFF in, WAV out, through a temporary file.
 *
 * `afconvert` writes to a path rather than to stdout — it seeks while writing the
 * header, which a pipe cannot do — so there is a scratch file whatever we would
 * prefer. It goes in the OS temp directory and is removed in a `finally`, which
 * is the one thing this has to get right: the failure mode of getting it wrong is
 * a directory that fills up one alert sound at a time.
 */
async function convert(path: string): Promise<{ bytes: Buffer; type: string } | null> {
  const tool = afconvert();
  if (!tool) return null;
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "kururu-sound-"));
    const out = join(dir, "out.wav");
    await run(tool, ["-f", "WAVE", "-d", "LEI16", path, out]);
    return { bytes: readFileSync(out), type: "audio/wav" };
  } catch {
    return null;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
