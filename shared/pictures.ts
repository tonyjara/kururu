/**
 * Pictures through a channel, both ways: the pure half.
 *
 * Kuru is a Claude Code session on this computer, and a path is all it needs
 * to look at a picture — Read shows it one. So a photo sent from the phone is
 * not handed to Kuru as bytes, nor as a link to Telegram's servers, which
 * would need the token to open: it is fetched, kept in kururu's
 * `telegram/inbox/` folder under a name the server chose, and named in the
 * words Kuru is typed — `[telegram] (picture: /…/2026-10-27-153012-4567.jpg)
 * what about this?` — the way a picture pasted into the drawer's box is
 * (`shared/drops.ts`). An album is one message with every picture in it,
 * because it was one gesture: four prompts for four photos would be four
 * turns, three of them answering a picture with no question.
 *
 * **Out is a tool, not a reading of the reply.** A rule that attached any
 * picture a reply named would be the made links' rule (`shared/made.ts`)
 * deciding what to publish, and Kuru names paths all the time — "the
 * screenshot the test left in e2e/shots/" is a sentence about a file, not a
 * wish to send it. Sending a file to Telegram puts it on Telegram's servers,
 * so Kuru does it on purpose, one call per picture (`send_telegram_photo`),
 * and the call says whether it arrived.
 *
 * **What may go out is narrower than what kururu may read.** `files.ts`'s
 * roots are every directory a terminal stood in, `~` among them, and below
 * `~` is `Library` — Messages' attachments, every app's caches — and every
 * dot-folder, where the keys are. So a picture goes from a project or an
 * agent's directory, the user's own folders (Desktop, Downloads, Pictures,
 * Documents), or kururu's own picture folders; never from below a hidden
 * folder or `~/Library`; and only bytes that are a picture Telegram shows as
 * one. `placeRefusal` is that rule over a path already resolved; the server
 * does the resolving, realpath and all (`server/src/pictures.ts`).
 */

import type { ImageKind } from "./drops";

/** A picture a message carries, as Telegram describes it: enough to fetch it and to judge it before fetching. */
export interface TelegramPicture {
  fileId: string;
  /** Bytes, when Telegram said; a photo's sizes nearly always do. */
  size: number | null;
  /** What the sender's app called it — a file sent as a file; null for a photo, which has no name. */
  name: string | null;
  mime: string | null;
}

/** The most a bot may fetch: the Bot API's limit on `getFile`. */
export const PICTURE_IN_MAX = 20 * 1024 * 1024;
/** `sendPhoto`'s limit. Past it a picture goes as a file, which Telegram does not shrink. */
export const PHOTO_OUT_MAX = 10 * 1024 * 1024;
/** The most kururu uploads at all. `sendDocument` takes fifty; a picture past twenty is not one anybody reads on a phone. */
export const PICTURE_OUT_MAX = 20 * 1024 * 1024;
/** Telegram's limit on a picture's caption. */
export const CAPTION_MAX = 1024;
/** The most pictures in one message to Kuru: Telegram's own limit on an album. */
export const ALBUM_MAX = 10;
/**
 * How long an album waits for its next picture. Telegram sends an album's
 * pictures as separate messages, and a long poll is answered the moment the
 * first arrives, so the rest come a poll or two later; a second of nothing
 * new is the album finished.
 */
export const ALBUM_QUIET_MS = 1_500;

const PICTURE_NAME = /\.(jpe?g|png|webp|gif|heic|heif)$/i;

/** Whether a file is called a picture — a guess, for deciding whether to try; the bytes decide. */
export function isPictureName(name: string): boolean {
  return PICTURE_NAME.test(name);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The picture a message carries, or null. A photo comes in several sizes and
 * the largest is taken — what Kuru looks at should be what was sent, not a
 * thumbnail of it. A file counts when its type or its name says picture; its
 * bytes are what decide, once fetched. A sticker, a video, a GIF (which
 * Telegram turns into a video) carry no picture here.
 */
export function pictureOf(raw: Record<string, unknown>): TelegramPicture | null {
  if (Array.isArray(raw.photo)) {
    let best: { fileId: string; size: number | null; area: number } | null = null;
    for (const item of raw.photo) {
      const size = (item ?? {}) as Record<string, unknown>;
      if (typeof size.file_id !== "string" || !size.file_id) continue;
      const area = (finite(size.width) ?? 0) * (finite(size.height) ?? 0);
      if (!best || area >= best.area) best = { fileId: size.file_id, size: finite(size.file_size), area };
    }
    if (best) return { fileId: best.fileId, size: best.size, name: null, mime: "image/jpeg" };
  }
  const doc = raw.document as Record<string, unknown> | undefined;
  if (!doc || typeof doc !== "object" || typeof doc.file_id !== "string" || !doc.file_id) return null;
  const mime = typeof doc.mime_type === "string" ? doc.mime_type.slice(0, 100) : null;
  const name = typeof doc.file_name === "string" ? doc.file_name.slice(0, 128) : null;
  if (!mime?.startsWith("image/") && !(name && PICTURE_NAME.test(name))) return null;
  return { fileId: doc.file_id, size: finite(doc.file_size), name, mime };
}

/**
 * The name a picture from the chat is kept under: when it came, to the
 * second, then the message's id, which no two messages of one chat share —
 * so the folder lists in the order things were sent and a name never has to
 * be numbered. Local time, as `dropFileName`'s is, because it is read by a
 * person looking for "the one from this afternoon".
 */
export function pictureFileName(at: Date, messageId: number, ext: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${stamp}-${Math.trunc(Math.abs(messageId))}.${ext}`;
}

/**
 * A path as one word, escaped the way `escapePath` in `web/src/drop.ts`
 * escapes a dropped one — the same allow-list, so Kuru reads every path it
 * is handed one way. kururu's own folders need none of it; a data directory
 * somebody moved might.
 */
export function pathWord(path: string): string {
  let out = "";
  for (const ch of path) out += /[A-Za-z0-9._\-/@:+,=]/.test(ch) ? ch : `\\${ch}`;
  return out;
}

/**
 * The words a message with pictures is typed into Kuru as, after the
 * channel's mark: the pictures first, so Kuru knows what "this" is before it
 * reads the question, then what was written with them. `missed` is how many
 * of them could not be fetched, which the chat was told and Kuru should be.
 */
export function pictureWords(paths: readonly string[], caption: string, missed = 0): string {
  const named = paths.map(pathWord).join(" ");
  const head = paths.length === 0 ? "" : paths.length === 1 ? `(picture: ${named})` : `(${paths.length} pictures: ${named})`;
  const lost = missed > 0 ? `(${missed === 1 ? "a picture" : `${missed} pictures`} that could not be fetched from Telegram)` : "";
  return [head, lost, caption].filter(Boolean).join(" ");
}

/**
 * Why a file may not go to the chat, by where it is, or null when it may.
 * `rel` is its path below the folder that holds it, with `/`; `full` the
 * whole of it, realpath'd; `home` the user's. Hidden folders hold settings
 * and keys — `.ssh`, `.config`, a project's `.env.d` — and `~/Library` holds
 * other programs' private files, a phone's messages among them.
 */
export function placeRefusal(rel: string, full: string, home: string): string | null {
  if (rel.split("/").some((part) => part.startsWith("."))) return "it is inside a hidden folder, which is where settings and keys are kept";
  const library = `${home}/Library`;
  if (full === library || full.startsWith(`${library}/`)) return "it is inside ~/Library, which holds other programs' private files";
  return null;
}

/** How a picture goes: as a photo, which Telegram shows inline and shrinks, or as a file, which it keeps whole. */
export type SendAs = "photo" | "document";

/**
 * How a picture of this kind and size goes, or why it does not go at all.
 * HEIC is converted before it gets here; GIF is refused, since Telegram plays
 * one as a video and a still is what a screenshot is.
 */
export function sendAs(kind: ImageKind | null, size: number): SendAs | { refused: string } {
  if (kind === null) return { refused: "it is not a picture (PNG, JPEG, WebP or HEIC, by its bytes)" };
  if (kind === "gif") return { refused: "it is a GIF, which Telegram turns into a video; send a PNG or JPEG of it" };
  if (kind === "heic") return { refused: "it is HEIC and could not be converted to JPEG" };
  if (size === 0) return { refused: "it is empty" };
  if (size > PICTURE_OUT_MAX) return { refused: `it is over ${PICTURE_OUT_MAX / 1024 / 1024} MB` };
  return size > PHOTO_OUT_MAX ? "document" : "photo";
}

/**
 * A caption as Telegram will take it: whole when it fits, and otherwise none
 * on the picture and the words as a message after it,
 * rather than cut, since a caption cut at 1024 is a sentence that stops.
 */
export function splitCaption(text: string | null): { caption: string | null; after: string | null } {
  const words = text?.trim() ?? "";
  if (!words) return { caption: null, after: null };
  return words.length <= CAPTION_MAX ? { caption: words, after: null } : { caption: null, after: words };
}

/**
 * Whether a refusal from `sendPhoto` is one a file would not get: a picture
 * too long and thin, or too large on a side, for Telegram to make a photo of
 * — a full-page screenshot is the usual one. Those go again as a document.
 */
export function photoRefusedForShape(description: string): boolean {
  return /PHOTO_INVALID_DIMENSIONS|PHOTO_SAVE_FILE_INVALID|IMAGE_PROCESS_FAILED|PHOTO_EXT_INVALID/i.test(description);
}
