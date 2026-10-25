/**
 * A file handed to Kuru by a page that cannot name it by its path.
 *
 * Dropping a file on Kuru's box types its path, as dropping one on a terminal
 * does and as Claude Code's own box does: Kuru is a Claude Code session on the
 * same computer, and a path is all it needs to Read the file — a picture
 * included. The window is told where a Finder file is (`pathForFile` on the
 * bridge); two things are not. A picture copied to the clipboard — ⌃⇧⌘4 — is
 * bytes with no file behind it, and a phone's photo is a file on the phone.
 * So those are sent to the server, kept in kururu's `drops/` folder, and the
 * path of the copy is what goes into the box.
 *
 * Only pictures Claude can look at and text, which is what a person hands
 * Kuru to read. Anything else is refused by name rather than kept: a folder
 * the server fills with whatever a page sends it is a folder anybody holding
 * the token can fill. The bytes decide, not the name or the type the page
 * gave — a page says `image/png` about anything — and the server picks the
 * extension off what it found, so a copy cannot arrive as `.command`.
 *
 * Pure, so the judging is tested as arithmetic; `server/src/drops.ts` writes
 * the file and `web/src/drop.ts` decides what to send.
 */

/**
 * The most one file may be. A full-screen screenshot of a 5K display is
 * around fifteen megabytes as PNG, and that is the largest thing anybody
 * pastes; Claude Code shrinks a picture before its model sees it, so the
 * size here is only what the disk and one request body hold.
 */
export const DROP_MAX_BYTES = 20 * 1024 * 1024;

/** What a drop was found to be, and the extension its copy is given. */
export type DropKind = { kind: "image"; ext: "png" | "jpg" | "gif" | "webp" } | { kind: "text"; ext: string };

/** The pictures Claude reads, as a page names them, for deciding what is worth sending at all. */
export const DROP_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * Text kept under its own extension, because a `.md` read as Markdown and a
 * `.csv` as a table is half of what the name is for. Anything else that is
 * text arrives as `.txt`: an extension off this list is a door to some
 * program's idea of what the file is for, `.command` being Terminal's.
 */
const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log", "yaml", "yml", "toml", "xml", "ini", "conf",
  "css", "scss", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cpp", "hpp", "cs", "php", "lua", "sql", "diff", "patch", "graphql", "proto", "tex", "rst", "srt", "vtt",
]);

/** The extension a name ends in, lowercased, or the empty string. */
function extOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Whether a file is worth sending, by what the page can see of it: null for
 * yes, and otherwise why not, in a sentence the composer shows. The server
 * judges the bytes again with `judgeDrop`, so this is only what saves
 * uploading twenty megabytes to be told no.
 */
export function dropRefusal(file: { name: string; type: string; size: number }): string | null {
  if (file.size > DROP_MAX_BYTES) return `${file.name || "That file"} is over ${DROP_MAX_BYTES / 1024 / 1024} MB.`;
  if (DROP_IMAGE_TYPES.includes(file.type)) return null;
  if (file.type.startsWith("text/") || TEXT_EXTS.has(extOf(file.name))) return null;
  if (/^image\/hei[cf]/.test(file.type) || /^hei[cf]$/.test(extOf(file.name))) return heicRefusal(file.name);
  return `${file.name || "That file"} is not a picture or a text file, which is all Kuru's box takes from here.`;
}

function heicRefusal(name: string): string {
  return `${name || "That picture"} is HEIC, which Claude cannot read — share it as JPEG (or Most Compatible in the Camera's settings).`;
}

const startsWith = (bytes: Uint8Array, sig: readonly number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/**
 * What a drop's bytes are, or why it is refused.
 *
 * Pictures by their magic numbers, the four Claude reads. Text is UTF-8 that
 * decodes without a fault and has no NUL in it, which no text file a person
 * hands over has and every binary one does; `name` is consulted only for the
 * extension text keeps. HEIC — an iPhone's own photos — gets its own answer,
 * since the fix is a setting on the phone and not a different file.
 */
export function judgeDrop(bytes: Uint8Array, name: string): DropKind | { refused: string } {
  if (bytes.length === 0) return { refused: "That file is empty." };
  if (bytes.length > DROP_MAX_BYTES) return { refused: `That file is over ${DROP_MAX_BYTES / 1024 / 1024} MB.` };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", ext: "png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: "image", ext: "jpg" };
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return { kind: "image", ext: "gif" };
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return { kind: "image", ext: "webp" };
  if (startsWith(bytes, ascii("ftyp"), 4) && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(String.fromCharCode(...bytes.slice(8, 12)))) {
    return { refused: heicRefusal(name) };
  }
  if (!bytes.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const ext = extOf(name);
      return { kind: "text", ext: TEXT_EXTS.has(ext) ? ext : "txt" };
    } catch {
      // Not UTF-8, so not text this box takes.
    }
  }
  return { refused: `${name || "That file"} is not a picture or a text file, which is all Kuru's box takes from here.` };
}

/**
 * The name a drop's copy is kept under: when it came, then what it was
 * called, then the extension the bytes earned.
 *
 * The time first so the folder lists in the order things were handed over,
 * to the second because two pastes in one second are rare and the writer
 * numbers a clash anyway. The original name is kept, cut down to characters
 * no shell and no URL needs escaping, because "the invoice screenshot" is
 * how Kuru will be asked about it and `image.png` is what every pasted
 * picture is called; with nothing left of it, the kind stands in.
 */
export function dropFileName(original: string, kind: DropKind, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const base = original.slice(original.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48)
    .replace(/[-.]+$/, "");
  return `${stamp}-${stem || kind.kind}.${kind.ext}`;
}
