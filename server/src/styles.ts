/**
 * The styles registry, from this side of it: fetching the catalogue, installing
 * what somebody picked, and reading back what is already here.
 *
 * `../kururu-styles` is the sibling repository — themes, skins, mascots and
 * packs as data, with an `index.json` its CI generates from the directories. Its
 * README is the specification; `shared/styles.ts` is the format and every check
 * applied to it; this file is the part that touches the network and the disk.
 *
 * ## The server fetches, never the browser
 *
 * Three reasons, and the first is the one that decides it. A phone on the
 * tailnet has no business reaching GitHub — it is looking at kururu, and a page
 * that also talks to a third party is a page whose privacy story is now two
 * stories. The second is that the server is the only thing that can write to
 * `~/.config/kururu`, so a browser that fetched would have to post the bytes
 * back anyway, with the checking then happening on whichever side we trusted
 * least. The third is simply that it sidesteps CORS, which `raw.githubusercontent.com`
 * would otherwise make a question.
 *
 * ## Why it lives on the restartable side
 *
 * Nothing in here is near a pty. It is HTTP and JSON and files in a config
 * directory, which means editing it costs a reconnect and no agents — and that
 * matters more than usual for a feature whose whole job is to accept files from
 * strangers. The rules about what is acceptable are going to be tightened, and
 * tightening them must never be a thing that ends somebody's work.
 *
 * ## What an install actually is
 *
 * A copy, with the version and the digest recorded beside it. The entry's files
 * land in `~/.config/kururu/styles/<kind>/<id>/` and `installed.json` gets a
 * line. A mascot additionally puts its sheet in `~/.config/kururu/sheets`, which
 * is where the picker already looks — so a mascot from the registry and one
 * somebody dragged in by hand are the same thing the moment they are installed,
 * and everything downstream of that point has only ever had one case to handle.
 *
 * Every file is verified against the digest the index published before anything
 * is written. Not because somebody is expected to tamper with GitHub, but
 * because the boring failure is real: a connection cut in half leaves a torn
 * sprite sheet, and a torn sprite sheet in a config directory reads as kururu
 * being broken rather than as a download that needs retrying.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MascotConfig } from "../../shared/model";
import type { Skin } from "../../shared/skin";
import {
  adoptIndex,
  adoptInstalled,
  adoptMascotManifest,
  adoptSkinManifest,
  adoptThemeManifest,
  ASSET_PATH,
  compareVersions,
  EMPTY_LIBRARY,
  isAssetName,
  isStyleKind,
  type InstalledStyle,
  type StyleEntry,
  type StyleIndex,
  type StyleKind,
  type StyleLibrary,
} from "../../shared/styles";
import { isStyleId } from "../../shared/skin";
import type { Theme } from "../../shared/theme";
import { configPath } from "./config";
import { importSheet, removeSheet, sheets } from "./mascot";

/**
 * Where the registry is.
 *
 * `raw.githubusercontent.com` on the default branch rather than the GitHub API:
 * no auth, no rate limit anybody will hit, and nothing that has to be up beyond
 * a static file host. The environment override is not a debugging hook so much
 * as the way somebody tests a style they are writing — point kururu at a local
 * checkout served over HTTP and the Styles tab is their own working copy.
 */
const BASE = (process.env.KURURU_STYLES_URL || "https://raw.githubusercontent.com/tonyjara/kururu-styles/main").replace(/\/+$/, "");

export function stylesDir(): string {
  return configPath("styles");
}

function entryDir(kind: StyleKind, id: string): string {
  return join(stylesDir(), `${kind}s`, id);
}

const INSTALLED = join("styles", "installed.json");

/**
 * A megabyte per file, and four for an entry.
 *
 * The registry refuses anything bigger at the other end, so this is the second
 * of the two checks rather than the first — and it is here because "the other
 * end validated it" is only true of the registry we mean, and `KURURU_STYLES_URL`
 * exists. An installed sheet is shipped to whatever is looking at kururu,
 * including a phone on a cellular connection.
 */
const FILE_LIMIT = 1024 * 1024;
const ENTRY_LIMIT = 4 * 1024 * 1024;

/** Long enough for a cold GitHub and short enough that a dialog is not simply stuck. */
const FETCH_TIMEOUT = 12_000;

// ---------------------------------------------------------------------------
// What is installed
// ---------------------------------------------------------------------------

function readRecords(): InstalledStyle[] {
  try {
    return adoptInstalled(JSON.parse(readFileSync(configPath(INSTALLED), "utf8")));
  } catch {
    return [];
  }
}

function writeRecords(list: InstalledStyle[]): void {
  const path = configPath(INSTALLED);
  try {
    mkdirSync(stylesDir(), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(list, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } catch {
    // `config.ts`'s reasoning: a record that could not be written is still live
    // in this session, and the next start is the one that forgets it.
  }
}

/**
 * Everything installed, resolved into the shapes the rest of kururu already
 * draws.
 *
 * Read from disk in one go and held by the caller rather than re-read per
 * snapshot, which is what `index.ts` already does with the mascots and the
 * keymap and for the same reason: a snapshot goes out on every status change,
 * and these are files.
 *
 * A record whose manifest has gone — deleted by hand, or half-written by a crash
 * — is skipped rather than being an error. The style then simply is not offered,
 * the saved id falls back at draw time, and reinstalling fixes it. There is
 * nothing a louder failure would buy: the window still has to come up.
 */
export function readLibrary(): StyleLibrary {
  const records = readRecords();
  if (records.length === 0) return EMPTY_LIBRARY;
  const themes: Theme[] = [];
  const skins: Skin[] = [];
  for (const record of records) {
    const manifest = readManifest(record.kind, record.id);
    if (!manifest) continue;
    if (record.kind === "theme") {
      const theme = adoptThemeManifest(manifest);
      if (theme && theme.id === record.id) themes.push(theme);
    }
    if (record.kind === "skin") {
      const skin = adoptSkinManifest(rewriteAssets(manifest, record), (file) =>
        record.files.includes(file) ? assetUrl("skin", record.id, file) : null,
      );
      if (skin && skin.id === record.id) skins.push(skin);
    }
  }
  return { themes, skins, installed: records };
}

function readManifest(kind: StyleKind, id: string): unknown {
  try {
    return JSON.parse(readFileSync(join(entryDir(kind, id), `${kind}.json`), "utf8"));
  } catch {
    return null;
  }
}

/**
 * `url(paper.png)` → `url("/api/styles/asset?…")`, throughout a manifest.
 *
 * A skin may reference a file it shipped — a paper grain, a border texture — and
 * the manifest names it as a file because a manifest may never name a URL. So
 * the rewrite happens here, on the one side that knows what was actually
 * installed, and `cssValue` in `shared/styles.ts` then refuses every `url(` that
 * is not the shape this produces. The two halves have to agree about the prefix,
 * which is why it is a constant in the shared module rather than a string spelt
 * twice.
 *
 * A name that is not in the entry's files is left alone, and `cssValue` drops
 * the whole declaration — which is the right way round: a token quietly pointing
 * at a file that does not exist is a 404 on every paint.
 */
function rewriteAssets(manifest: unknown, record: InstalledStyle): unknown {
  const text = JSON.stringify(manifest);
  const fixed = text.replace(/url\(\s*\\?['"]?([A-Za-z0-9][A-Za-z0-9._-]{0,63})\\?['"]?\s*\)/g, (whole, file: string) =>
    record.files.includes(file) ? `url(\\"${assetUrl(record.kind, record.id, file)}\\")` : whole,
  );
  try {
    return JSON.parse(fixed);
  } catch {
    return manifest;
  }
}

export function assetUrl(kind: StyleKind, id: string, file: string): string {
  return `${ASSET_PATH}?kind=${kind}&id=${encodeURIComponent(id)}&file=${encodeURIComponent(file)}`;
}

/**
 * The file an asset request means, or null.
 *
 * Three checks and each catches something different: the kind and id have to be
 * *names*, the file has to be a name, and the file has to be one this entry
 * actually recorded. The last is the one that matters and is the same rule
 * `sheetFile` follows — a name checked against the list rather than pasted into
 * a path — because this endpoint is reachable from the tailnet and the thing on
 * the other end of the path is the user's config directory.
 */
export function assetFile(kindRaw: string, idRaw: string, fileRaw: string): string | null {
  if (!isStyleKind(kindRaw) || !isStyleId(idRaw) || !isAssetName(fileRaw)) return null;
  const record = readRecords().find((r) => r.kind === kindRaw && r.id === idRaw);
  if (!record || !record.files.includes(fileRaw)) return null;
  const path = join(entryDir(kindRaw, idRaw), fileRaw);
  return existsSync(path) ? path : null;
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

let cached: { index: StyleIndex; at: number } | null = null;

/** Ten minutes. Long enough that opening the tab twice is one request, short enough that "check for updates" is rarely the only way. */
const CACHE_MS = 10 * 60 * 1000;

/**
 * What the registry is offering.
 *
 * Cached in memory, and the last good answer is also written to disk — which is
 * not the same cache doing two jobs. The memory one stops a dialog opening twice
 * from being two requests. The disk one is what the tab shows when there is no
 * network, and it is worth having precisely because the interesting case for
 * this list is somebody deciding what to install, which is exactly when being
 * told "could not reach the registry" and nothing else is least useful.
 */
export async function catalog(force = false): Promise<{ index: StyleIndex | null; stale: boolean; error?: string }> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return { index: cached.index, stale: false };
  try {
    const res = await fetch(`${BASE}/index.json`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`the registry answered ${res.status}`);
    const index = adoptIndex(await res.json());
    if (!index) throw new Error("the registry's index is not one this version understands");
    cached = { index, at: Date.now() };
    try {
      mkdirSync(stylesDir(), { recursive: true });
      writeFileSync(join(stylesDir(), "catalog.json"), JSON.stringify(index), "utf8");
    } catch {}
    return { index, stale: false };
  } catch (error) {
    const last = lastCatalog();
    return {
      index: last,
      stale: true,
      error: error instanceof Error ? error.message : "could not reach the registry",
    };
  }
}

function lastCatalog(): StyleIndex | null {
  try {
    return adoptIndex(JSON.parse(readFileSync(join(stylesDir(), "catalog.json"), "utf8")));
  } catch {
    return null;
  }
}

/**
 * The entry, plus what this machine knows about it.
 *
 * Computed here rather than in the browser because the comparison is `semver`
 * and a string compare gets it silently wrong in the direction that matters —
 * `"1.10.0" < "1.2.0"` is true, so a real update reads as a downgrade and the
 * row says you are current forever. One implementation, on the side that also
 * writes the pin.
 */
export interface CatalogEntry extends StyleEntry {
  installedVersion: string | null;
  update: boolean;
}

export function annotate(index: StyleIndex, installed: InstalledStyle[]): CatalogEntry[] {
  const have = new Map(installed.map((r) => [`${r.kind}/${r.id}`, r]));
  return index.entries.map((entry) => {
    const mine = have.get(`${entry.kind}/${entry.id}`);
    return {
      ...entry,
      installedVersion: mine?.version ?? null,
      update: !!mine && compareVersions(entry.version, mine.version) > 0,
    };
  });
}

/**
 * One file out of an entry that is *not* installed, for drawing the row that
 * offers it.
 *
 * Only mascots need this, and they need it for a reason no other kind has: a
 * theme and a skin can be previewed from numbers the index already carries, but
 * a mascot's whole content is the picture, and a list that described one in
 * words would be a list you have to install from to find out what you are
 * installing. The alternative was inlining a frame into `index.json` as a data
 * URI, which means the registry's dependency-free CI growing a PNG encoder and
 * the index growing by a kilobyte an entry.
 *
 * It is a proxy rather than a redirect, which is the whole point: the browser
 * never talks to GitHub. The server already fetches from the registry — this is
 * the same act, for a picture instead of a manifest — and the digest from the
 * index is checked here too, so a preview cannot show one thing and an install
 * put another on disk.
 *
 * Held in memory only, capped, and never written to the config directory: the
 * distinction between *looking at* a style and *having* one is the distinction
 * this whole module is built on, and a preview that left files behind would blur
 * it.
 */
const previews = new Map<string, Buffer>();
const PREVIEW_CACHE = 24;

export async function preview(kind: string, id: string): Promise<{ bytes: Buffer; file: string } | null> {
  if (!isStyleKind(kind) || !isStyleId(id)) return null;
  const { index } = await catalog();
  if (!index) return null;
  const entry = index.entries.find((e) => e.kind === kind && e.id === id);
  if (!entry) return null;
  const file = entry.files.find((f) => /\.(png|webp|gif|jpe?g)$/i.test(f.name));
  if (!file) return null;

  const key = `${kind}/${id}/${file.digest}`;
  const already = previews.get(key);
  if (already) return { bytes: already, file: file.name };

  try {
    const res = await fetch(`${BASE}/${entry.path}/${file.name}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > FILE_LIMIT) return null;
    if (`sha256-${createHash("sha256").update(bytes).digest("hex")}` !== file.digest) return null;
    // Oldest out first. A Map iterates in insertion order, so the first key is
    // the least recently *added* — which is the right eviction here, where every
    // entry is looked at once while a list is on screen and then not again.
    if (previews.size >= PREVIEW_CACHE) {
      const oldest = previews.keys().next().value;
      if (oldest) previews.delete(oldest);
    }
    previews.set(key, bytes);
    return { bytes, file: file.name };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

/** What an install of a mascot leaves for `index.ts` to add to the user's list. */
export interface InstalledMascot {
  sheet: string;
  config: MascotConfig;
  name: string;
  /** The entry it replaced, if this was an update rather than a first install. */
  replaces: string | null;
}

export type InstallResult =
  | {
      ok: true;
      record: InstalledStyle;
      mascot?: InstalledMascot;
      /**
       * The manifest as it landed, for the one caller that has to read further
       * into it: a pack names three other entries and installing it means
       * installing them, and `index.ts` is where that fan-out belongs because it
       * is the only side that can also *activate* the result.
       */
      manifest: unknown;
    }
  | { ok: false; error: string };

/**
 * Fetch one entry and put it on disk.
 *
 * Everything is downloaded and checked *before* anything is written, which is
 * the whole shape of this function. The alternative — write as they arrive — is
 * how a half-installed style happens, and a half-installed style is the case
 * every reader downstream would then have to handle forever. It is cheap to do
 * it this way here because an entry is four files and a few hundred kilobytes.
 *
 * A mascot's sheet goes through `importSheet`, the same door a file dropped in
 * by hand goes through, so that its three checks — a real PNG, under the cap,
 * under a name that is a name — are applied once and in one place. The sheet is
 * removed first, because on an *update* it is already there and `importSheet`
 * refuses to overwrite: refusing is right for an import, where a collision means
 * somebody else's sheet, and wrong here, where the collision is the older copy
 * of this very entry.
 */
export async function install(kind: string, id: string): Promise<InstallResult> {
  if (!isStyleKind(kind) || !isStyleId(id)) return { ok: false, error: "that is not a style" };
  const { index } = await catalog();
  if (!index) return { ok: false, error: "could not reach the registry" };
  const entry = index.entries.find((e) => e.kind === kind && e.id === id);
  if (!entry) return { ok: false, error: `the registry has no ${kind} called ${id}` };

  const total = entry.files.reduce((n, f) => n + f.size, 0);
  if (total > ENTRY_LIMIT) return { ok: false, error: "that style is larger than kururu will install" };

  const bytes = new Map<string, Buffer>();
  for (const file of entry.files) {
    try {
      const res = await fetch(`${BASE}/${entry.path}/${file.name}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (!res.ok) return { ok: false, error: `${file.name} came back ${res.status}` };
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > FILE_LIMIT) return { ok: false, error: `${file.name} is over a megabyte` };
      const digest = `sha256-${createHash("sha256").update(body).digest("hex")}`;
      if (digest !== file.digest) {
        return { ok: false, error: `${file.name} did not arrive intact — try again` };
      }
      bytes.set(file.name, body);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : `could not fetch ${file.name}` };
    }
  }

  const manifestBytes = bytes.get(entry.manifest);
  if (!manifestBytes) return { ok: false, error: `${entry.manifest} is missing from that entry` };
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    return { ok: false, error: `${entry.manifest} is not JSON` };
  }
  if ((manifest as { id?: unknown })?.id !== entry.id || (manifest as { kind?: unknown })?.kind !== entry.kind) {
    return { ok: false, error: "that entry's manifest disagrees with the index about what it is" };
  }

  const dir = entryDir(entry.kind, entry.id);
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of bytes) writeFileSync(join(dir, name), body);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "could not write to the config directory" };
  }

  const record: InstalledStyle = {
    kind: entry.kind,
    id: entry.id,
    name: entry.name,
    version: entry.version,
    digest: entry.digest,
    installedAt: new Date().toISOString(),
    files: [...bytes.keys()],
  };

  const records = readRecords();
  const was = records.find((r) => r.kind === entry.kind && r.id === entry.id) ?? null;
  // Carry the mascot id across an update, so updating a mascot restyles the one
  // already in the user's list rather than adding a second beside it.
  if (was?.mascotId) record.mascotId = was.mascotId;

  let mascot: InstalledMascot | undefined;
  if (entry.kind === "mascot") {
    const sheetName = (manifest as { sheet?: unknown }).sheet;
    const sheetBytes = typeof sheetName === "string" ? bytes.get(sheetName) : undefined;
    if (!sheetBytes) return { ok: false, error: "that mascot has no sheet" };
    // The id is the sheet's name, so a second install of the same mascot replaces
    // its own sheet rather than accumulating `fox-1`, `fox-2`.
    removeSheet(entry.id);
    if (sheets().includes(entry.id)) {
      return { ok: false, error: `there is already a sheet called ${entry.id}` };
    }
    const put = importSheet(entry.id, sheetBytes);
    if (!put.ok) return { ok: false, error: put.error };
    record.sheet = entry.id;
    mascot = {
      sheet: entry.id,
      config: adoptMascotManifest(manifest, entry.id),
      name: entry.name,
      replaces: was?.mascotId ?? null,
    };
  }

  writeRecords([...records.filter((r) => r !== was), record]);

  return mascot ? { ok: true, record, mascot, manifest } : { ok: true, record, manifest };
}

/** Which mascot in the user's list this entry is, once `index.ts` has made one. */
export function rememberMascotId(kind: StyleKind, id: string, mascotId: string): void {
  writeRecords(readRecords().map((r) => (r.kind === kind && r.id === id ? { ...r, mascotId } : r)));
}

export type RemoveResult = { ok: true; record: InstalledStyle } | { ok: false; error: string };

/**
 * Take one back off the machine.
 *
 * It does not touch `appearance.json`, and that is deliberate: uninstalling the
 * theme you are wearing leaves the *choice* recorded and falls back to the
 * default at draw time, so reinstalling it puts you back where you were. That is
 * the whole reason `adoptAppearance` stopped resolving ids — a setting rewritten
 * on the way out is a setting that cannot be restored.
 */
export function remove(kind: string, id: string): RemoveResult {
  if (!isStyleKind(kind) || !isStyleId(id)) return { ok: false, error: "that is not a style" };
  const records = readRecords();
  const record = records.find((r) => r.kind === kind && r.id === id);
  if (!record) return { ok: false, error: "that style is not installed" };
  try {
    rmSync(entryDir(kind, id), { recursive: true, force: true });
  } catch {
    // A directory that would not go is a directory that is no longer listed.
    // Leaving the record behind would be worse: it would be offered and fail.
  }
  if (record.sheet) removeSheet(record.sheet);
  writeRecords(records.filter((r) => r !== record));
  return { ok: true, record };
}

/**
 * Anything on disk that no record mentions.
 *
 * Only ever *reported*, never deleted on its own. A directory under `styles/`
 * that `installed.json` does not know about is either a crash between the two
 * writes or somebody putting a style there by hand, and the second is a thing
 * people do — it is how you test one you are writing. Sweeping it would be
 * kururu deleting a file it did not create.
 */
export function orphans(): string[] {
  const known = new Set(readRecords().map((r) => `${r.kind}s/${r.id}`));
  const out: string[] = [];
  for (const kind of ["theme", "skin", "mascot", "pack"] as StyleKind[]) {
    const dir = join(stylesDir(), `${kind}s`);
    try {
      for (const name of readdirSync(dir)) {
        if (!known.has(`${kind}s/${name}`)) out.push(`${kind}s/${name}`);
      }
    } catch {}
  }
  return out;
}

/** Where they all went, for a line in Settings that would otherwise be a path spelt twice. */
export function stylesHome(): string {
  return stylesDir();
}
