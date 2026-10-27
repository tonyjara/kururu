/**
 * Where the chat's pictures are kept, and which pictures may go to it — the
 * disk's half of `shared/pictures.ts`, which says why there are such folders
 * and why the second question is narrower than "can kururu read it".
 *
 * Both folders are in the data directory beside `drops/`, for its reason: a
 * path that went into a message can be read again in the drawer or quoted
 * onto a card a week later, so nothing sweeps them. `telegram/inbox/` is what
 * came from the phone. `telegram/outbox/` is a copy of each picture on its
 * way out, made when Kuru asks: the queue survives a restart, and what is
 * uploaded is the bytes that were checked, not whatever is at that path by
 * the time Telegram answers — a file swapped for a link to `~/.ssh` in
 * between would otherwise be the one that went. A copy leaves once the chat
 * has it. Folders `0700`, files `0600`, never backed up (`EXCLUDED`).
 *
 * HEIC — what an iPhone's camera writes, and what a phone sends when a photo
 * goes "as a file" — is converted to JPEG here, both ways, since Claude
 * cannot read it and Telegram will not show it as a photo: `sips` on a Mac,
 * which every Mac has, `heif-convert` or ImageMagick elsewhere.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { imageKindOf } from "../../shared/drops";
import { PICTURE_IN_MAX, PICTURE_OUT_MAX, pictureFileName, placeRefusal, sendAs, type SendAs } from "../../shared/pictures";
import { allowedRoots } from "./files";
import { dataDir } from "./store";

const run = promisify(execFile);

/** How long a conversion may take. `sips` does a 12-megapixel photo in well under a second. */
const CONVERT_MS = 30_000;

export function inboxDir(): string {
  return join(dataDir(), "telegram", "inbox");
}

export function outboxDir(): string {
  return join(dataDir(), "telegram", "outbox");
}

/** A picture refused for what it is or where it is, in words for whoever asked — as against a disk that failed. */
export class PictureRefused extends Error {}

function folder(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** HEIC to JPEG, by whichever converter this computer has. Throws when none could. */
async function heicToJpeg(from: string, to: string): Promise<void> {
  const tries: [string, string[]][] =
    process.platform === "darwin"
      ? [["/usr/bin/sips", ["-s", "format", "jpeg", from, "--out", to]]]
      : [
          ["heif-convert", [from, to]],
          ["magick", [from, to]],
          ["convert", [from, to]],
        ];
  for (const [command, args] of tries) {
    try {
      await run(command, args, { timeout: CONVERT_MS });
      if (imageKindOf(readFileSync(to).subarray(0, 16)) === "jpg") return;
    } catch {
      // Not installed, or it could not; the next one may.
    }
  }
  throw new PictureRefused("it is HEIC, and nothing on this computer could turn it into a JPEG");
}

/**
 * A picture from the chat, kept, and the path Kuru is given. Judged by its
 * bytes — a file called `photo.jpg` is whatever it is — and HEIC converted,
 * so what Kuru is handed is always a picture Read can show it.
 */
export async function keepIncoming(bytes: Uint8Array, at: Date, messageId: number): Promise<string> {
  if (bytes.length === 0) throw new PictureRefused("it arrived empty");
  if (bytes.length > PICTURE_IN_MAX) throw new PictureRefused(`it is over ${PICTURE_IN_MAX / 1024 / 1024} MB`);
  const kind = imageKindOf(bytes);
  if (!kind) throw new PictureRefused("it is not a picture Kuru can look at (PNG, JPEG, GIF, WebP or HEIC)");
  const dir = folder(inboxDir());
  const path = join(dir, pictureFileName(at, messageId, kind === "heic" ? "jpg" : kind));
  if (kind !== "heic") {
    writeFileSync(path, bytes, { mode: 0o600 });
    return path;
  }
  const heic = join(dir, `.${randomUUID()}.heic`);
  writeFileSync(heic, bytes, { mode: 0o600 });
  try {
    await heicToJpeg(heic, path);
  } finally {
    rmQuiet(heic);
  }
  return path;
}

function rmQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/** Is `full` at or below `base`? With the separator, so "/a/bc" is not inside "/a/b". */
function inside(base: string, full: string): boolean {
  return full === base || full.startsWith(base + sep);
}

/**
 * The folders a picture may go out from: every root `files.ts` holds — a
 * project, an agent's directory, a terminal's — the user's own folders, and
 * kururu's own picture folders, so a photo from the chat or a pasted one can
 * be sent back. Realpath'd, as `files.ts` keeps its roots.
 */
export function pictureRoots(): string[] {
  const home = homedir();
  const mine = [join(home, "Desktop"), join(home, "Downloads"), join(home, "Pictures"), join(home, "Documents"), inboxDir(), join(dataDir(), "drops"), join(dataDir(), "harness")];
  // A terminal that stood in `/` or `/Users` made that a root, and a picture
  // from anywhere on the disk is not what "the user's folders" means.
  let realHome = home;
  try {
    realHome = realpathSync(home);
  } catch {
    // Home is home.
  }
  const roots = new Set(allowedRoots().filter((root) => root === realHome || !inside(root, realHome)));
  for (const dir of mine) {
    try {
      roots.add(realpathSync(dir));
    } catch {
      // Not on this computer.
    }
  }
  return [...roots];
}

/**
 * A path as Kuru wrote it, made whole: `~/…` from home, an absolute path as
 * it is, and anything else from the first of `bases` it is found under — the
 * agent's directory, or the profile's projects.
 */
export function wholePath(path: string, bases: readonly string[]): string | null {
  const bare = path.trim().replace(/\\(.)/g, "$1");
  if (!bare) return null;
  if (bare === "~" || bare.startsWith("~/")) return join(homedir(), bare.slice(1));
  if (isAbsolute(bare)) return bare;
  for (const base of bases) {
    const full = resolve(base, bare);
    try {
      if (statSync(full).isFile()) return full;
    } catch {
      // Not under this one.
    }
  }
  return null;
}

/** A picture ready to go: the copy that will be uploaded, how, and what it was called. */
export interface StagedPicture {
  file: string;
  as: SendAs;
  name: string;
}

/**
 * A picture checked and copied for the chat, or `PictureRefused` saying why
 * not. Realpath first, so a link out of a project is judged by where it
 * points; then the deepest allowed folder that holds it, and `placeRefusal`
 * on the rest of the path below that; then the bytes. Read once, and that
 * read is the copy.
 */
export async function stageOutgoing(path: string, roots: readonly string[] = pictureRoots()): Promise<StagedPicture> {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new PictureRefused(`there is no file at ${path}`);
  }
  let root: string | null = null;
  for (const candidate of roots) if (real !== candidate && inside(candidate, real) && (!root || candidate.length > root.length)) root = candidate;
  if (!root) {
    throw new PictureRefused(`${path} is not in a project, an agent's folder or the user's Desktop, Downloads, Pictures or Documents, which is where pictures go to Telegram from`);
  }
  const rel = real.slice(root.length + 1).split(sep).join("/");
  const place = placeRefusal(rel, real, realpathSync(homedir()));
  if (place) throw new PictureRefused(`${path} cannot go: ${place}`);
  const stat = statSync(real);
  if (!stat.isFile()) throw new PictureRefused(`${path} is not a file`);
  if (stat.size > PICTURE_OUT_MAX) throw new PictureRefused(`${path} is over ${PICTURE_OUT_MAX / 1024 / 1024} MB`);
  const bytes = readFileSync(real);
  const name = real.slice(real.lastIndexOf(sep) + 1);
  const dir = folder(outboxDir());
  const kind = imageKindOf(bytes);
  const id = randomUUID();
  if (kind === "heic") {
    const heic = join(dir, `.${id}.heic`);
    const jpeg = join(dir, `${id}.jpg`);
    writeFileSync(heic, bytes, { mode: 0o600 });
    try {
      await heicToJpeg(heic, jpeg);
    } finally {
      rmQuiet(heic);
    }
    const as = sendAs("jpg", statSync(jpeg).size);
    if (typeof as !== "string") {
      rmQuiet(jpeg);
      throw new PictureRefused(`${path} cannot go: ${as.refused}`);
    }
    return { file: jpeg, as, name };
  }
  const as = sendAs(kind, bytes.length);
  if (typeof as !== "string") throw new PictureRefused(`${path} cannot go: ${as.refused}`);
  const file = join(dir, `${id}.${kind}`);
  writeFileSync(file, bytes, { mode: 0o600 });
  return { file, as, name };
}

/** A copy that has gone, or will not: off the disk. Only ever one in the outbox folder. */
export function dropStaged(file: string): void {
  if (inside(outboxDir(), file)) rmQuiet(file);
}
