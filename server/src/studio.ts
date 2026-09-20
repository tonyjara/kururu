/**
 * The skins you make yourself: where they live, and the four things the studio
 * can do to one.
 *
 * Settings → Skin studio edits a skin *live* — every slider and every picture
 * dropped on a part lands on the window while you look at it, and on the phone
 * looking at the same server. That is only possible because the skin being
 * edited is an ordinary installed skin: it sits in `~/.config/kururu/styles/skins/<id>/`
 * beside the ones from the registry, with a `skin.json` in exactly the
 * registry's format and its pictures beside it, and `installed.json` carries
 * its record with `local: true`. So `readLibrary` reads it the way it reads
 * everything else, the asset endpoint serves its pictures the way it serves a
 * registry font, `remove` deletes it, and nothing downstream of this file knows
 * a skin of yours from a skin of somebody else's — except the one place that
 * has to, which is `install`, refusing to fetch a registry entry over the top
 * of your work under the same id.
 *
 * ## Why the format is the registry's, and nothing simpler
 *
 * The studio could have written something of its own and compiled it. It does
 * not, because the point of making a skin is that somebody else might wear it,
 * and the way somebody else wears it is a pull request to `../kururu-styles`.
 * A directory that is already a valid entry there — id, version, licence,
 * pictures, manifest — is one `cp -r` from being published, and the same
 * `tools/validate.mjs` that CI runs will pass it. The studio therefore edits a
 * manifest and never a compiled form, and the manifest names *files*, never
 * URLs, for the reason the registry's README gives.
 *
 * ## What is checked, and what is not
 *
 * A picture arriving here is a client asking the server to write a file into
 * the user's config directory over a socket that is on the tailnet, which is
 * the mascot import's situation exactly and gets its three checks: a name that
 * is a name, a size under the cap, and magic bytes that say the file is what
 * its extension claims. A *manifest* arriving here is checked less — its kind,
 * id and schema are forced to what this directory is, and everything else is
 * written as sent, because the reading side (`adoptSkinManifest`) already
 * refuses anything that could reach off the machine or out of a declaration,
 * and refusing it twice would be two places to keep in step. What the studio
 * writes and what the registry accepts are then allowed to differ in exactly
 * the ways the validator will name when the pull request is opened.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { BASE_ICONS, ICON_NAMES, isStyleId, skinFor, type IconName, type Skin, type SkinTokens } from "../../shared/skin";
import { isAssetName, isVersion, STYLES_SCHEMA, type InstalledStyle, type StyleLibrary } from "../../shared/styles";
import { entryDir, measureImage, PNG_MAGIC, readRecords, writeRecords } from "./styles";

/** A megabyte, the registry's own cap, so what the studio accepts the registry will too. */
const FILE_LIMIT = 1024 * 1024;

/**
 * What a file may be, by its first bytes. The extension is what the manifest
 * and the browser go by, so it is the thing to check the bytes *against*: a
 * PNG called `.woff2` would be served as a font and fail in a way that names
 * nothing.
 */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  ".png": (b) => b.subarray(0, 8).equals(PNG_MAGIC),
  ".woff2": (b) => b.toString("ascii", 0, 4) === "wOF2",
  ".woff": (b) => b.toString("ascii", 0, 4) === "wOFF",
  ".ttf": (b) => b.readUInt32BE(0) === 0x00010000 || b.toString("ascii", 0, 4) === "true",
  ".otf": (b) => b.toString("ascii", 0, 4) === "OTTO",
  // A licence beside a font, and nothing else that is text: the registry
  // insists on one, and a studio that could not put it there would produce
  // entries its own validator sends back.
  ".txt": (b) => !b.subarray(0, 512).includes(0),
};

export type StudioResult<T = Record<string, never>> = ({ ok: true } & T) | { ok: false; error: string };

export function localSkins(): InstalledStyle[] {
  return readRecords().filter((r) => r.kind === "skin" && r.local === true);
}

function localRecord(id: string): InstalledStyle | null {
  return isStyleId(id) ? (localSkins().find((r) => r.id === id) ?? null) : null;
}

export function localDir(id: string): string {
  return entryDir("skin", id);
}

export function readLocalManifest(id: string): Record<string, unknown> | null {
  if (!localRecord(id)) return null;
  try {
    const raw = JSON.parse(readFileSync(join(localDir(id), "skin.json"), "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The files in a skin's directory, as the record lists them.
 *
 * Read off the disk rather than kept, on the registry's own reasoning
 * (`filesOf` in its `tools/lib.mjs`): a list the manifest declared is a list
 * that can forget a file, and the forgotten file would be in the directory,
 * visible in Finder, and refused by the asset endpoint.
 */
function filesIn(id: string): string[] {
  try {
    return readdirSync(localDir(id))
      .filter((name) => isAssetName(name) && statSync(join(localDir(id), name)).isFile())
      .sort();
  } catch {
    return [];
  }
}

/**
 * The registry's digest, computed the registry's way — over names and per-file
 * hashes rather than concatenated bytes — so that a skin published from here
 * arrives in `index.json` with a digest the user can recognise as their own.
 */
function digestOf(id: string, files: string[]): string {
  const h = createHash("sha256");
  for (const name of files) {
    h.update(name);
    h.update("\0");
    h.update(createHash("sha256").update(readFileSync(join(localDir(id), name))).digest());
    h.update("\0");
  }
  return `sha256-${h.digest("hex")}`;
}

/** Bring the record into line with what is on disk and in the manifest. */
function refresh(id: string): InstalledStyle | null {
  const records = readRecords();
  const record = records.find((r) => r.kind === "skin" && r.id === id && r.local);
  if (!record) return null;
  const manifest = readLocalManifest(id) ?? {};
  const files = filesIn(id);
  const next: InstalledStyle = {
    ...record,
    name: typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim().slice(0, 200) : id,
    version: isVersion(manifest.version) ? manifest.version : record.version,
    digest: digestOf(id, files),
    files,
  };
  writeRecords(records.map((r) => (r === record ? next : r)));
  return next;
}

function writeManifestFile(id: string, manifest: Record<string, unknown>): boolean {
  const path = join(localDir(id), "skin.json");
  try {
    mkdirSync(localDir(id), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    renameSync(temp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A new skin of yours, empty or forked.
 *
 * Forking is how most skins will start, because "Ironclad, but with my bezel"
 * is a far more common thought than a blank page. A registry skin forks as a
 * copy of its directory — pictures, fonts and licence included, since a fork
 * that dropped the font would be a fork that looked different for a reason
 * nobody could see. A built-in forks as the difference it makes from the base,
 * which is what the registry format is anyway. Either way the fork is yours:
 * new id, your name as author, version back to `1.0.0`, and the credits of the
 * original kept in `description` so that the provenance is a sentence rather
 * than a lost file.
 *
 * The id is refused rather than adjusted if it is taken, in either list — a
 * skin of yours under a registry skin's id is the collision `install` exists
 * to refuse, and making one on purpose would be making that refusal a surprise.
 */
export function createLocalSkin(
  id: string,
  name: string,
  from: string | null,
  library: StyleLibrary,
): StudioResult<{ manifest: Record<string, unknown> }> {
  if (!isStyleId(id)) return { ok: false, error: "an id is lowercase letters, digits and dashes" };
  if (readRecords().some((r) => r.kind === "skin" && r.id === id)) {
    return { ok: false, error: `there is already a skin called ${id}` };
  }
  const label = name.replace(/[\r\n]+/g, " ").trim().slice(0, 60) || id;
  const author = safeAuthor();

  let manifest: Record<string, unknown> = {
    schema: STYLES_SCHEMA,
    kind: "skin",
    id,
    name: label,
    version: "1.0.0",
    description: "",
    author,
    licence: "CC0-1.0",
    tokens: {},
    icons: {},
    parts: {},
  };

  try {
    rmSync(localDir(id), { recursive: true, force: true });
    mkdirSync(localDir(id), { recursive: true });
  } catch {
    return { ok: false, error: "could not write to the config directory" };
  }

  if (from) {
    const installed = readRecords().find((r) => r.kind === "skin" && r.id === from);
    if (installed) {
      // A copy of the directory, and the manifest re-pointed. Files first, so
      // that a fork interrupted halfway is a directory with pictures and no
      // manifest — which `readLibrary` skips — rather than a manifest naming
      // pictures that are not there.
      for (const file of installed.files) {
        if (file === "skin.json") continue;
        try {
          writeFileSync(join(localDir(id), file), readFileSync(join(entryDir("skin", from), file)));
        } catch {
          // A file that would not copy is a picture the fork does without.
        }
      }
      let source: Record<string, unknown> = {};
      try {
        source = JSON.parse(readFileSync(join(entryDir("skin", from), "skin.json"), "utf8")) as Record<string, unknown>;
      } catch {}
      const { homepage, source: src, ...rest } = source;
      void homepage;
      void src;
      manifest = {
        ...rest,
        schema: STYLES_SCHEMA,
        kind: "skin",
        id,
        name: label,
        version: "1.0.0",
        author,
        description: `Forked from ${String(source.name ?? from)}${source.author ? ` by ${String(source.author)}` : ""}.`,
      };
    } else {
      const built = skinFor(from, library.skins);
      if (built.id === from) {
        manifest.tokens = tokenDiff(built);
        manifest.icons = glyphsOf(built);
        manifest.description = `Forked from ${built.name}.`;
      }
    }
  }

  if (!writeManifestFile(id, manifest)) return { ok: false, error: "could not write the manifest" };

  const files = filesIn(id);
  const record: InstalledStyle = {
    kind: "skin",
    id,
    name: label,
    version: "1.0.0",
    digest: digestOf(id, files),
    installedAt: new Date().toISOString(),
    files,
    local: true,
  };
  writeRecords([...readRecords(), record]);
  return { ok: true, manifest };
}

/** The tokens a built-in moves from the base, which is what its manifest would say. */
function tokenDiff(skin: Skin): Partial<SkinTokens> {
  const base = skinFor(null).tokens;
  const out: Partial<SkinTokens> = {};
  for (const token of Object.keys(skin.tokens) as (keyof SkinTokens)[]) {
    if (skin.tokens[token] !== base[token]) out[token] = skin.tokens[token];
  }
  return out;
}

function glyphsOf(skin: Skin): Partial<Record<IconName, string>> {
  const out: Partial<Record<IconName, string>> = {};
  for (const name of skin.glyphs ?? []) {
    if (ICON_NAMES.includes(name) && skin.icons[name] !== BASE_ICONS[name]) out[name] = skin.icons[name];
  }
  return out;
}

/** The login name, as the author line — a word, never a path or an address. */
function safeAuthor(): string {
  try {
    return userInfo().username.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "me";
  } catch {
    return "me";
  }
}

/**
 * The manifest, as the studio sent it, with the three fields that say what
 * directory this is forced back to the truth. Everything else is the author's,
 * including a mistake — the reading side refuses what has to be refused, and
 * the registry's validator will say the rest in words when the time comes.
 */
export function writeLocalManifest(id: string, value: unknown): StudioResult<{ manifest: Record<string, unknown> }> {
  if (!localRecord(id)) return { ok: false, error: "that is not a skin of yours" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "a manifest is an object" };
  const manifest: Record<string, unknown> = { ...(value as Record<string, unknown>), schema: STYLES_SCHEMA, kind: "skin", id };
  if (!writeManifestFile(id, manifest)) return { ok: false, error: "could not write the manifest" };
  refresh(id);
  return { ok: true, manifest };
}

/**
 * A picture or a font, into the skin's directory.
 *
 * Overwrites, unlike the mascot import, and the difference is who owns the
 * file: a sheet in `sheets/` may be cut by several mascots and replacing it
 * changes all of them behind their backs, where a file in a skin of yours is
 * referenced by that skin alone and replacing it is the ordinary act of
 * redrawing a bezel. The old bytes are gone; the browser's cached copy of the
 * old URL is not, which is why the answer carries a `stamp` the studio appends
 * to the URL it draws its thumbnail from — the asset endpoint caches for a year
 * on the assumption that a file cannot change under its name, and here it can.
 */
export function putLocalAsset(
  id: string,
  file: string,
  bytes: Buffer,
): StudioResult<{ file: string; files: string[]; width?: number; height?: number }> {
  if (!localRecord(id)) return { ok: false, error: "that is not a skin of yours" };
  if (!isAssetName(file) || file === "skin.json") return { ok: false, error: "a file name is letters, digits, dots and dashes" };
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  const check = MAGIC[ext];
  if (!check) return { ok: false, error: "a skin's files are PNG pictures, fonts (woff2, woff, ttf, otf) and a licence as .txt" };
  if (bytes.length > FILE_LIMIT) return { ok: false, error: "that file is over a megabyte, which is the registry's cap too" };
  if (bytes.length < 8 || !check(bytes)) return { ok: false, error: `that file is not a ${ext.slice(1)}` };

  const path = join(localDir(id), file);
  try {
    const temp = `${path}.tmp`;
    writeFileSync(temp, bytes);
    renameSync(temp, path);
  } catch {
    return { ok: false, error: "could not write to the skin's directory" };
  }
  const record = refresh(id);
  const size = ext === ".png" ? measureImage(path) : null;
  return {
    ok: true,
    file,
    files: record?.files ?? filesIn(id),
    ...(size ? { width: size[0], height: size[1] } : {}),
  };
}

export function removeLocalAsset(id: string, file: string): StudioResult<{ files: string[] }> {
  if (!localRecord(id)) return { ok: false, error: "that is not a skin of yours" };
  if (!isAssetName(file) || file === "skin.json") return { ok: false, error: "no such file" };
  const path = join(localDir(id), file);
  if (!existsSync(path)) return { ok: false, error: "no such file" };
  try {
    unlinkSync(path);
  } catch {
    return { ok: false, error: "could not remove that file" };
  }
  const record = refresh(id);
  return { ok: true, files: record?.files ?? filesIn(id) };
}
