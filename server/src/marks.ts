/**
 * The folder a set of marks is written to, and the sweep that empties it — the
 * writing half of `shared/marks.ts`, which says what a set is.
 *
 * In the data directory beside `drops/`, and for `drops/`'s reasons: the path
 * goes into a message that can sit in the box, be read again in the drawer or
 * be quoted onto a card, so it must not be a temporary folder the system
 * empties when it likes. Unlike `drops/` it is swept, after about thirty days
 * (the user's call): a set is a page's text, markup and pictures, and a month
 * of them is a month of whatever was on the screen. The lines in a message or
 * on a card carry each mark's label and comment, so they still read once the
 * set is gone; the chip says "cleaned up", and a crop asked for is a 404 that
 * says so.
 *
 * `0700` and `0600`, never backed up (`EXCLUDED` in `shared/backup.ts`), and
 * the server judges each picture by its bytes, as `judgeDrop` does, so a body
 * that says PNG about anything writes nothing. The page never names a path:
 * the id is minted here, and a GET is answered only for a name a set may hold.
 *
 * **The sweep touches only what it would have made.** It lists `marks/`,
 * `lstat`s each entry and never follows a link, and removes only a real
 * directory named as a set id whose newest file is past the age
 * (`sweepable`). A line per set goes to `lifecycle.log`, so a set that is
 * gone can be told from a set that never was.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { imageKindOf } from "../../shared/drops";
import { adoptScreenSet, alignMarks, redactScreenSet, screenBoxLines, screenMarkdown, screenMessage, type ScreenSet, type TimedText } from "../../shared/ink";
import { adoptMarkSet, isMarkFile, isMarkSetId, marksMarkdown, marksMessage, redactSet, sweepable, type MarkSet } from "../../shared/marks";
import { record } from "./lifecycle";
import { dataDir } from "./store";

/** A set refused for what it is, as against one the disk could not take. */
export class MarksRefused extends Error {}

/** How often the sweep runs after the one at start. */
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;

export function marksDir(): string {
  return join(dataDir(), "marks");
}

/** A picture off the wire: base64, a data URL's or bare, kept only when its bytes are a PNG or a JPEG. */
function pictureOf(value: string): { bytes: Buffer; ext: "png" | "jpg" } | null {
  if (!value) return null;
  const base64 = value.replace(/^data:image\/[a-z+]+;base64,/i, "");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64.slice(0, 4096))) return null;
  const bytes = Buffer.from(base64, "base64");
  const kind = imageKindOf(bytes);
  return kind === "png" || kind === "jpg" ? { bytes, ext: kind } : null;
}

export interface KeptMarks {
  id: string;
  dir: string;
  /** `marks.md`'s path, which the header line names. */
  path: string;
  /** The lines for Kuru's box. */
  lines: string[];
}

/**
 * Write a posted set and say where, with the lines for the box. Throws
 * `MarksRefused` for a body that is not a set. The pictures are written under
 * names this module picks — a crop the bytes do not bear out is left out and
 * the mark is kept without it — and the record in `marks.json` names them.
 */
export function keepMarks(body: unknown): KeptMarks {
  if (typeof body === "object" && body !== null && (body as { kind?: unknown }).kind === "screen") return keepScreenSet(body);
  const adopted = adoptMarkSet(body);
  if ("refused" in adopted) throw new MarksRefused(adopted.refused);
  const set = redactSet(adopted);
  const { id, dir, write } = newSetDir();

  const crops: Record<number, string> = {};
  const marks = set.marks.map((mark) => {
    const picture = pictureOf(mark.crop);
    if (!picture) return { ...mark, crop: "" };
    // The extension the bytes earned; a GET asks only for `.png`, which is
    // what main sends, so a JPEG is kept in the record and not served.
    const name = `mark-${mark.n}.${picture.ext}`;
    write(name, picture.bytes);
    crops[mark.n] = name;
    return { ...mark, crop: name };
  });
  const view = pictureOf(set.view);
  let viewName = "";
  if (view) {
    viewName = `view.${view.ext}`;
    write(viewName, view.bytes);
  }
  const kept: MarkSet = { ...set, marks, view: viewName, at: Date.now() };
  const path = join(dir, "marks.md");
  write("marks.json", `${JSON.stringify(kept, null, 2)}\n`);
  write("marks.md", marksMarkdown(kept, { view: viewName ? join(dir, viewName) : "", crops: Object.fromEntries(Object.entries(crops).map(([n, name]) => [n, join(dir, name)])) }));
  return { id, dir, path, lines: marksMessage(kept, path) };
}

/** A fresh set's folder, under an id minted here, and a way to write a file into it once. */
function newSetDir(): { id: string; dir: string; write: (name: string, data: string | Buffer) => void } {
  const root = marksDir();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let id = "";
  let dir = "";
  for (let tries = 0; tries < 5; tries++) {
    id = `m${randomBytes(6).toString("hex")}`;
    dir = join(root, id);
    try {
      mkdirSync(dir, { mode: 0o700 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || tries === 4) throw err;
    }
  }
  chmodSync(dir, 0o700);
  return { id, dir, write: (name, data) => writeFileSync(join(dir, name), data, { flag: "wx", mode: 0o600 }) };
}

/** A set's pictures by mark number, as `screenMarkdown` names them: full paths. */
function screenFiles(dir: string, set: ScreenSet): { crops: Record<number, string>; frames: Record<number, string> } {
  const crops: Record<number, string> = {};
  const frames: Record<number, string> = {};
  for (const mark of set.marks) {
    if (mark.crop) crops[mark.n] = join(dir, mark.crop);
    if (mark.frame) frames[mark.n] = join(dir, mark.frame);
  }
  return { crops, frames };
}

/**
 * A set of marks on the screen (`shared/ink.ts`), from the desktop app's pen:
 * the pictures written under names chosen here and judged by their bytes, the
 * titles redacted, and `marks.md` written. A set with a voice has no words
 * yet — the clip is heard after this, by the outbox, which then calls
 * `finishScreenSet` — so its file says so until it is written again; a set
 * with none is finished now, and its lines are the box's.
 *
 * The set before the clip, because the outbox is what must never lose words
 * and it should only ever point at a folder that exists.
 */
function keepScreenSet(body: unknown): KeptMarks {
  const adopted = adoptScreenSet(body);
  if ("refused" in adopted) throw new MarksRefused(adopted.refused);
  const set = redactScreenSet(adopted);
  const { id, dir, write } = newSetDir();
  const marks = set.marks.map((mark) => {
    const crop = pictureOf(mark.crop);
    const frame = pictureOf(mark.frame);
    let cropName = "";
    let frameName = "";
    if (crop?.ext === "png") {
      cropName = `mark-${mark.n}.png`;
      write(cropName, crop.bytes);
    }
    if (frame?.ext === "jpg") {
      frameName = `frame-${mark.n}.jpg`;
      write(frameName, frame.bytes);
    }
    return { ...mark, crop: cropName, frame: frameName };
  });
  const kept: ScreenSet = { ...set, marks };
  const path = join(dir, "marks.md");
  write("marks.json", `${JSON.stringify(kept, null, 2)}\n`);
  write("marks.md", screenMarkdown(kept, screenFiles(dir, kept), kept.audioAt !== null));
  return { id, dir, path, lines: kept.audioAt !== null ? [screenMessage(kept, path)] : screenBoxLines(kept, path) };
}

/**
 * A screen set's words, once the outbox has heard its clip: each mark put in
 * them where it was meant (`alignMarks`), `marks.json` and `marks.md` written
 * again with them, and the one line for Kuru. `said` is null for a clip that
 * held no words, which still sends the marks, as "(nothing said)". Null for
 * a set that is not there — swept, or never a screen set — and the outbox then
 * sends the words alone.
 */
export function finishScreenSet(id: string, said: TimedText | null): string | null {
  if (!markSetExists(id)) return null;
  const dir = join(marksDir(), id);
  let set: ScreenSet;
  try {
    const record = JSON.parse(readFileSync(join(dir, "marks.json"), "utf8")) as ScreenSet;
    if (record?.kind !== "screen" || !Array.isArray(record.marks)) return null;
    set = record;
  } catch {
    return null;
  }
  const words = said ?? { text: "", words: [] };
  const offset = set.audioAt !== null ? set.at - set.audioAt : 0;
  const done: ScreenSet = { ...set, said: words, places: alignMarks(words, set.marks, offset) };
  const path = join(dir, "marks.md");
  // Written again in place, through a temporary name, so a reader never
  // finds half a file; the record first, since the file is drawn from it.
  const again = (name: string, data: string) => {
    const tmp = join(dir, `.${name}.tmp`);
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, join(dir, name));
  };
  again("marks.json", `${JSON.stringify(done, null, 2)}\n`);
  again("marks.md", screenMarkdown(done, screenFiles(dir, done)));
  return screenMessage(done, path);
}

/** Whether a set is there: false for one swept or never made. */
export function markSetExists(id: string): boolean {
  if (!isMarkSetId(id)) return false;
  try {
    const stat = lstatSync(join(marksDir(), id));
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** A file of a set, for a GET: its path, or why there is none. */
export function markFile(id: string, name: string): { path: string } | { missing: "no such set" | "cleaned up" | "no such file" } {
  if (!isMarkSetId(id) || !isMarkFile(name)) return { missing: "no such file" };
  if (!markSetExists(id)) return { missing: "cleaned up" };
  const path = join(marksDir(), id, name);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return { missing: "no such file" };
  } catch {
    return { missing: "no such file" };
  }
  return { path };
}

/** The newest modification time among a set's directory and the files directly in it, read with `lstat`. */
function newestIn(dir: string): number {
  let newest = lstatSync(dir).mtimeMs;
  for (const name of readdirSync(dir)) {
    try {
      newest = Math.max(newest, lstatSync(join(dir, name)).mtimeMs);
    } catch {
      // Gone between the listing and the look: it is not newer than anything.
    }
  }
  return newest;
}

/** Remove the sets past their age, and say which. Anything not a set of ours is left alone. */
export function sweepMarks(now = Date.now()): string[] {
  const root = marksDir();
  if (!existsSync(root)) return [];
  const swept: string[] = [];
  for (const name of readdirSync(root)) {
    if (!isMarkSetId(name)) continue;
    const dir = join(root, name);
    try {
      const stat = lstatSync(dir);
      const entry = { name, isDirectory: stat.isDirectory(), isSymbolicLink: stat.isSymbolicLink(), newestMs: stat.isDirectory() && !stat.isSymbolicLink() ? newestIn(dir) : stat.mtimeMs };
      if (!sweepable(entry, now)) continue;
      rmSync(dir, { recursive: true, force: true });
      swept.push(name);
      record("sweep", `swept marks set ${name}, last written ${new Date(entry.newestMs).toISOString().slice(0, 10)}: over 30 days old`);
    } catch (err) {
      record("sweep", `could not sweep marks set ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return swept;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** The sweep now, and once a day after. Never keeps the process up. */
export function startMarkSweep(): void {
  if (sweepTimer) return;
  try {
    sweepMarks();
  } catch {
    // A sweep that fails is a set kept a day longer, never a server that does not start.
  }
  sweepTimer = setInterval(() => {
    try {
      sweepMarks();
    } catch {
      // As above.
    }
  }, SWEEP_EVERY_MS);
  sweepTimer.unref();
}
