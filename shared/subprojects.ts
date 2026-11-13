/**
 * The projects inside a workspace: the sites of a monorepo that are each
 * somebody's own thing, so that Kuru's conversation can be tagged and
 * filtered by them and not only by the workspace they share.
 *
 * The owner, 2026-11-12: "shared landings has a lot of projects in it. So I
 * think we need to be a bit more granular with the filters for the chat and
 * the tags … make an exception for workspaces like shared landings … right
 * now I want to see the last things we said about Yetapa." Shared Landings is
 * one repository and one workspace, and four businesses: Yetapá, Parque
 * Guasú, Agua Lomas and tonyjara.com, each in `apps/<name>`. A tag that said
 * "Shared Landings" put the four in one thread, which is the thread nobody
 * wanted to read.
 *
 * **Found, then corrected.** The server looks under a workspace's root for a
 * monorepo's app folders (`apps/*` and `sites/*` with a manifest of their own,
 * in a root that says it is a monorepo) and keeps what it found on the
 * workspace (`Subprojects.found`); the owner renames, adds, hides and gives
 * other names in Settings → Workspaces (`Subprojects.edits`), and only those
 * are written to disk. Found is what the folder holds today, so it is looked
 * at again rather than remembered.
 *
 * **Most monorepos are one product in parts, and those are not projects.**
 * Platypost's `apps/` is its server, its phone app and its landing; Pasapy's
 * is web, native and a collector. Tagging a line "web" or "server" says
 * nothing, and "web" in the words would tag half the conversation. So a
 * folder whose name is what a part of a product is called (`ROLE_WORDS`)
 * starts hidden, and a workspace with fewer than two folders left after that
 * has none shown at all: one site among the parts is the product itself. What
 * is left is the case the owner meant: several apps each named for itself.
 * `packages/*` is never looked in: shared code is nobody's project.
 *
 * **A project's tag is its workspace's key, a slash, and its slug** —
 * `wkeb591007ddcc/yetapa` — so it is a workspace key with more on it,
 * written where a workspace key is (`turn_tags`, a filter kept by a device),
 * and a line about it counts for the workspace too (`passes`). The slug is
 * the folder's name, which does not change when the owner renames the
 * project; one the owner added takes it from the name it was given.
 *
 * Pure: the disk is `server/src/subprojects.ts`'s.
 */

/** A folder the server found under a workspace's root, and what it says about itself. */
export interface FoundProject {
  /** Relative to the root: `apps/yetapa`. */
  dir: string;
  /** Its README's first heading, with a domain in brackets taken out: `Yetapa Tours`. */
  title: string | null;
  /** Its package's name, without a scope. */
  pkg: string | null;
  /** The domain its README or package names: `yetapatours.com`. */
  domain: string | null;
}

/** What the owner said about one project, by slug. Everything absent is what was found. */
export interface ProjectEdit {
  slug: string;
  name?: string;
  /** Other names the words may call it by, besides the ones found. */
  aliases?: string[];
  /** True hides one that was shown, false shows one that started hidden. */
  hidden?: boolean;
  /** A project the owner added, which nothing found: its folder, relative to the root, or none. */
  added?: { dir: string | null };
}

/** A workspace's projects as kept on it. */
export interface Subprojects {
  found: FoundProject[];
  edits: ProjectEdit[];
}

export const NO_SUBPROJECTS: Subprojects = { found: [], edits: [] };

/** A project as everything else reads it. */
export interface Subproject {
  slug: string;
  /** Its tag: the workspace's key, `/`, the slug. */
  key: string;
  name: string;
  /** The folder it is, relative to the workspace's root, or null for one added without. */
  dir: string | null;
  /** The owner's other names for it. */
  aliases: string[];
  /** The names the folder gave it, which the words count as well: the folder, the package, the README's title, the domain. */
  found: string[];
  hidden: boolean;
  /** Why it starts hidden, for Settings to say; null for one that starts shown. */
  quiet: "role" | "alone" | null;
  added: boolean;
}

/** The folders of a monorepo that hold its apps. Never `packages`, `libs` or `tools`: those are shared code. */
export const APP_DIRS = ["apps", "sites"] as const;

/** What a folder that is a part of one product is called. A project named one of these starts hidden. */
export const ROLE_WORDS = new Set([
  "admin", "android", "api", "app", "backend", "bot", "browser", "cli", "client", "collector", "cms", "core", "crawler", "cron",
  "dashboard", "demo", "desktop", "docs", "e2e", "edge", "electron", "email", "emails", "example", "examples", "extension", "frontend",
  "functions", "infra", "ingest", "ios", "jobs", "landing", "marketing", "mcp", "mobile", "native", "playground", "queue", "scraper",
  "server", "site", "storybook", "studio", "test", "tests", "ui", "web", "worker", "workers", "www",
]);

/** The most projects one workspace keeps: past this it is not a handful of sites, and the panel is not a directory listing. */
export const SUBPROJECTS_MAX = 30;
export const PROJECT_NAME_MAX = 40;
export const PROJECT_ALIASES_MAX = 8;

/** Text with its accents taken off and its case kept: `Yetapá` → `Yetapa`. */
export function unaccent(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").normalize("NFC");
}

/** Text compared as a person reads it: any case, with or without its accents. */
export function plain(text: string): string {
  return unaccent(text).toLowerCase();
}

/** A slug: what a tag key may hold after the slash. */
export function slugOf(text: string): string {
  return plain(text)
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40);
}

/** A tag key that is a project's: the workspace's key and the slug, or null for a workspace's own. */
export function splitProjectKey(key: string): { space: string; slug: string } | null {
  const at = key.indexOf("/");
  return at > 0 ? { space: key.slice(0, at), slug: key.slice(at + 1) } : null;
}

/** The workspace a tag key belongs to: itself, or the part before a project's slash. */
export function spaceOfKey(key: string): string {
  return splitProjectKey(key)?.space ?? key;
}

/** A folder name made a name to read: `parque-guasu` → `Parque guasu`. Only when nothing better was found. */
function prettyFolder(dir: string): string {
  const base = dir.slice(dir.lastIndexOf("/") + 1).replace(/[-_]+/g, " ").trim();
  return base ? base[0]!.toUpperCase() + base.slice(1) : dir;
}

/** A name kept to what a tag can draw. */
function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f\[\],]+/g, " ").replace(/\s+/g, " ").trim().slice(0, PROJECT_NAME_MAX).trim();
  return name.length >= 2 ? name : null;
}

/** The domain's own label, `yetapatours` of `yetapatours.com`, which is how a reply that names the site names the project. */
function domainLabel(domain: string | null): string | null {
  if (!domain) return null;
  const parts = domain.replace(/^www\./, "").split(".");
  return parts.length >= 2 ? (parts[parts.length - 2] ?? null) : null;
}

/**
 * A workspace's projects: what was found, with the owner's edits laid over
 * it, then the ones the owner added. Hidden ones are in the list, so Settings
 * can show them again; everything that tags reads `visibleProjects`.
 */
export function subprojectsOf(workspaceKey: string, state: Subprojects | null | undefined): Subproject[] {
  const found = state?.found ?? [];
  const edits = state?.edits ?? [];
  const edit = (slug: string) => edits.find((e) => e.slug === slug);
  const role = (dir: string) => ROLE_WORDS.has(slugOf(dir.slice(dir.lastIndexOf("/") + 1)));
  const own = found.filter((f) => !role(f.dir)).length;
  const out: Subproject[] = [];
  for (const f of found) {
    const slug = slugOf(f.dir.slice(f.dir.lastIndexOf("/") + 1));
    if (!slug || out.some((p) => p.slug === slug)) continue;
    const e = edit(slug);
    const quiet = role(f.dir) ? "role" : own < 2 ? "alone" : null;
    const names = [f.dir.slice(f.dir.lastIndexOf("/") + 1), f.pkg, f.title, domainLabel(f.domain)].filter((n): n is string => !!n && n.length >= 2);
    out.push({
      slug,
      key: `${workspaceKey}/${slug}`,
      name: cleanName(e?.name) ?? cleanName(f.title) ?? prettyFolder(f.dir),
      dir: f.dir,
      aliases: e?.aliases ?? [],
      found: names.filter((n, i) => names.findIndex((m) => plain(m) === plain(n)) === i),
      hidden: e?.hidden ?? quiet !== null,
      quiet,
      added: false,
    });
  }
  for (const e of edits) {
    if (!e.added || out.some((p) => p.slug === e.slug)) continue;
    const name = cleanName(e.name);
    if (!name) continue;
    out.push({ slug: e.slug, key: `${workspaceKey}/${e.slug}`, name, dir: e.added.dir, aliases: e.aliases ?? [], found: [], hidden: e.hidden === true, quiet: null, added: true });
  }
  return out.slice(0, SUBPROJECTS_MAX);
}

export function visibleProjects(workspaceKey: string, state: Subprojects | null | undefined): Subproject[] {
  return subprojectsOf(workspaceKey, state).filter((p) => !p.hidden);
}

/** Every name a project answers to: its name, the owner's others, and the folder's. Each once, accents aside. */
export function namesOf(project: Pick<Subproject, "name" | "aliases" | "found">): string[] {
  const all = [project.name, ...project.aliases, ...project.found];
  return all.filter((n, i) => all.findIndex((m) => plain(m) === plain(n)) === i);
}

// ---------------------------------------------------------------------------
// The owner's edits
// ---------------------------------------------------------------------------

/** Aliases typed into one field, comma-separated, kept to what a name can be. */
export function parseAliases(typed: string): string[] {
  const names = typed.split(/[,;\n]/).map(cleanName).filter((n): n is string => n !== null);
  return names.filter((n, i) => names.findIndex((m) => plain(m) === plain(n)) === i).slice(0, PROJECT_ALIASES_MAX);
}

/** One project's edit changed. An edit that says nothing any more is dropped, so the file holds only what was said. */
export function editProject(edits: readonly ProjectEdit[], slug: string, patch: Partial<Omit<ProjectEdit, "slug" | "added">>): ProjectEdit[] {
  const was = edits.find((e) => e.slug === slug) ?? { slug };
  const next: ProjectEdit = { ...was };
  if ("name" in patch) {
    const name = cleanName(patch.name);
    if (name) next.name = name;
    else delete next.name;
  }
  if ("aliases" in patch) {
    if (patch.aliases?.length) next.aliases = patch.aliases.slice(0, PROJECT_ALIASES_MAX);
    else delete next.aliases;
  }
  if ("hidden" in patch) {
    if (typeof patch.hidden === "boolean") next.hidden = patch.hidden;
    else delete next.hidden;
  }
  const empty = !next.added && next.name === undefined && next.aliases === undefined && next.hidden === undefined;
  const rest = edits.filter((e) => e.slug !== slug);
  return empty ? rest : edits.some((e) => e.slug === slug) ? edits.map((e) => (e.slug === slug ? next : e)) : [...rest, next];
}

/** A project the owner adds by name, with a slug no other project of the workspace has. Null when the name is no name. */
export function addProject(edits: readonly ProjectEdit[], taken: readonly string[], typedName: string, dir: string | null = null): { edits: ProjectEdit[]; slug: string } | null {
  const name = cleanName(typedName);
  const base = name ? slugOf(name) : "";
  if (!name || !base) return null;
  let slug = base;
  for (let n = 2; taken.includes(slug) || edits.some((e) => e.slug === slug); n++) slug = `${base}-${n}`;
  return { edits: [...edits, { slug, name, added: { dir: cleanDir(dir) } }], slug };
}

/** An added project taken out. One that was found can only be hidden: it would be found again. */
export function removeProject(edits: readonly ProjectEdit[], slug: string): ProjectEdit[] {
  return edits.filter((e) => !(e.slug === slug && e.added));
}

/** A folder relative to a root, as an edit may name one: no leading slash, no `..`, nothing odd. */
function cleanDir(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const typed = value.trim();
  if (typed.startsWith("/") || typed.startsWith("~")) return null;
  const dir = typed.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!dir || dir.length > 200 || /[\u0000-\u001f\u007f]/.test(dir) || dir.split("/").some((part) => part === ".." || part === "." || part === "")) return null;
  return dir;
}

/** Edits read back from a file, a blob or a client: anything that is not one is left out. */
export function adoptProjectEdits(value: unknown): ProjectEdit[] {
  if (!Array.isArray(value)) return [];
  const out: ProjectEdit[] = [];
  for (const raw of value.slice(0, SUBPROJECTS_MAX * 2)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const slug = typeof r.slug === "string" ? slugOf(r.slug) : "";
    if (!slug || slug !== r.slug || out.some((e) => e.slug === slug)) continue;
    const edit: ProjectEdit = { slug };
    const name = cleanName(r.name);
    if (name) edit.name = name;
    if (Array.isArray(r.aliases)) {
      const aliases = parseAliases(r.aliases.filter((a): a is string => typeof a === "string").join(","));
      if (aliases.length) edit.aliases = aliases;
    }
    if (typeof r.hidden === "boolean") edit.hidden = r.hidden;
    if (r.added && typeof r.added === "object") {
      if (!name) continue;
      edit.added = { dir: cleanDir((r.added as Record<string, unknown>).dir) };
    }
    if (edit.name === undefined && edit.aliases === undefined && edit.hidden === undefined && !edit.added) continue;
    out.push(edit);
  }
  return out;
}

/** What the server found, read back from a blob or the wire. */
export function adoptFound(value: unknown): FoundProject[] {
  if (!Array.isArray(value)) return [];
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v.trim() : null);
  const out: FoundProject[] = [];
  for (const raw of value.slice(0, SUBPROJECTS_MAX)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const dir = cleanDir(r.dir);
    if (!dir || out.some((f) => f.dir === dir)) continue;
    out.push({ dir, title: text(r.title, 120), pkg: text(r.pkg, 120), domain: text(r.domain, 120) });
  }
  return out;
}

export function adoptSubprojects(value: unknown): Subprojects {
  if (!value || typeof value !== "object") return { found: [], edits: [] };
  const r = value as Record<string, unknown>;
  return { found: adoptFound(r.found), edits: adoptProjectEdits(r.edits) };
}

// ---------------------------------------------------------------------------
// What a folder says about itself
// ---------------------------------------------------------------------------

/** A domain as a README or a package writes one. */
const DOMAIN = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})\/?$/i;

/**
 * A README's first heading, read for a name and a domain: `# Yetapa Tours
 * (yetapatours.com)` is "Yetapa Tours" at yetapatours.com, and `#
 * tonyjara.com` is the domain and its label. A heading longer than a name is
 * a sentence, and gives neither.
 */
export function readmeTitle(readme: string): { title: string | null; domain: string | null } {
  const line = readme.split("\n").slice(0, 30).find((l) => /^#\s+\S/.test(l));
  if (!line) return { title: null, domain: null };
  let title = line.replace(/^#\s+/, "").replace(/[`*_]/g, "").trim();
  let domain: string | null = null;
  const bracket = /\s*\(([^)]+)\)\s*$/.exec(title);
  if (bracket && DOMAIN.test(bracket[1]!.trim())) {
    domain = DOMAIN.exec(bracket[1]!.trim())![1]!.toLowerCase();
    title = title.slice(0, bracket.index).trim();
  }
  const whole = DOMAIN.exec(title);
  if (whole) {
    domain = whole[1]!.toLowerCase();
    title = domainLabel(domain) ?? title;
  }
  return { title: title.length >= 2 && title.length <= PROJECT_NAME_MAX ? title : null, domain };
}

/** A package's name without its scope: `@acme/yetapa` → `yetapa`. */
export function packageName(manifest: unknown): string | null {
  if (!manifest || typeof manifest !== "object") return null;
  const name = (manifest as Record<string, unknown>).name;
  if (typeof name !== "string") return null;
  const bare = name.replace(/^@[^/]+\//, "").trim();
  return bare.length >= 2 && bare.length <= 80 ? bare : null;
}

/** The domain a package names as its home page, if it names one. */
export function packageDomain(manifest: unknown): string | null {
  if (!manifest || typeof manifest !== "object") return null;
  const home = (manifest as Record<string, unknown>).homepage;
  if (typeof home !== "string") return null;
  const m = /^https?:\/\/((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/|$)/i.exec(home.trim());
  return m ? m[1]!.toLowerCase().replace(/^www\./, "") : null;
}
