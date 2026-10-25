/**
 * Where a pasted picture, or a file from the phone, is kept so Kuru can Read
 * it — the writing half of `shared/drops.ts`, which says why there is such a
 * folder at all.
 *
 * In the data directory beside the database and not in a temporary one,
 * because the path goes into a message, and a message can sit in the outbox,
 * be read again in the drawer, or be quoted onto a card and run a week later;
 * a file the system swept away by then is a path that lies. Nothing here
 * deletes one. The folder is `0700` and each file `0600`, since a screenshot
 * holds whatever was on the screen, and it is never backed up — see
 * `EXCLUDED` in `shared/backup.ts`.
 *
 * `wx`, so a copy never lands on another: a name already taken gets a number,
 * which in practice is two pastes inside one second.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dropFileName, judgeDrop } from "../../shared/drops";
import { dataDir } from "./store";

/** A drop refused for what it is, as against one the disk could not take. */
export class DropRefused extends Error {}

export function dropsDir(): string {
  return join(dataDir(), "drops");
}

/** Keep a drop's bytes and say where they are. Throws `DropRefused` for a file this box does not take. */
export function keepDrop(bytes: Uint8Array, name: string, at = new Date()): { path: string } {
  const kind = judgeDrop(bytes, name);
  if ("refused" in kind) throw new DropRefused(kind.refused);
  const dir = dropsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = dropFileName(name, kind, at);
  const dot = file.lastIndexOf(".");
  for (let n = 1; n <= 50; n++) {
    const path = join(dir, n === 1 ? file : `${file.slice(0, dot)}-${n}${file.slice(dot)}`);
    try {
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
      return { path };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error("fifty files of that name already arrived this second");
}
