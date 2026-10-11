/**
 * The mirror: everything precious, as text, in a tree git can diff.
 *
 * The database is one binary file and the config directory is full of
 * secrets. Neither is what should sit in a repository on GitHub, so what
 * goes there is a *mirror*: every board as one JSON file, every harness
 * conversation as one JSONL file, the config files that are decisions and
 * not credentials, the harness's memory folders, and the arrangement. The
 * allow-list is `shared/backup.ts`; this is the walk that applies it.
 *
 * Written so that an unchanged thing is an unchanged file: cards sorted by
 * number, keys stable, one turn per line appended at the end. A backup
 * that changed nothing then stages nothing and makes no commit, and a diff
 * between two backups is what happened in between.
 *
 * It is also the way back. `readMirror` turns the tree into the shape the
 * database imports, which is how `bun run restore` rebuilds `kururu.db`
 * on a new Mac from the text alone — the export carries every column, run
 * and event, so nothing is lost by leaving the binary out.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { BACKUP_README, CONFIG_DIRS, CONFIG_FILES, SETTINGS_DROP } from "../../shared/backup";
import { isLoginKey } from "../../shared/model";
import { EXPORT_VERSION, exportName, type BoardExport, type ConversationExport, type DataExport, type TurnExport } from "../../shared/store";
import type { Store } from "./store";

export interface MirrorSources {
  store: Store;
  /** `~/.config/kururu`. */
  configDir: string;
  /** Where `session.json` is. */
  stateDir: string;
}

/** The subtrees this module owns in the mirror: anything else in the directory is left alone, `.git` first of all. */
const OWNED = ["config", "boards", "conversations", "memory", "profiles", "state"] as const;

/**
 * Write the mirror under `dir`. Returns how many files are now in it and
 * how many were written or removed by this pass.
 */
export function writeMirror(dir: string, sources: MirrorSources): { files: number; changed: number } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const kept = new Set<string>();
  let changed = 0;
  const put = (rel: string, content: string | Buffer): void => {
    kept.add(rel);
    const path = join(dir, rel);
    if (existsSync(path)) {
      const was = readFileSync(path);
      if (typeof content === "string" ? was.toString("utf8") === content : was.equals(content)) return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    changed++;
  };

  put("README.md", BACKUP_README);

  // Config: the named files and the two directories, as they are.
  for (const name of CONFIG_FILES) {
    const path = join(sources.configDir, name);
    if (existsSync(path)) put(join("config", name), readFileSync(path));
  }
  for (const name of CONFIG_DIRS) {
    for (const file of walk(join(sources.configDir, name))) put(join("config", name, file), readFileSync(join(sources.configDir, name, file)));
  }

  // The database, as text.
  const data = sources.store.exportAll();
  for (const board of data.boards) {
    const profile = exportName(board.profile.name, board.profile.key);
    const file = board.workspace ? exportName(board.workspace.name, board.workspace.key) : "profile";
    put(join("boards", profile, `${file}.json`), `${JSON.stringify(board, null, 2)}\n`);
  }
  for (const { header, turns } of data.conversations) {
    const profile = exportName(header.profileName, header.profileKey);
    const lines = [JSON.stringify(header), ...turns.map((turn) => JSON.stringify(turn))];
    put(join("conversations", profile, `${header.id}.jsonl`), `${lines.join("\n")}\n`);
  }

  // Each login's memory folders and settings. The logins are the
  // directories kururu made, found as `logins.ts` finds them.
  const profiles = join(sources.configDir, "profiles");
  for (const key of listDir(profiles).filter(isLoginKey)) {
    const projects = join(profiles, key, "claude", "projects");
    for (const project of listDir(projects)) {
      const memory = join(projects, project, "memory");
      for (const file of walk(memory)) put(join("memory", key, project, file), readFileSync(join(memory, file)));
    }
    const settings = join(profiles, key, "claude", "settings.json");
    if (existsSync(settings)) {
      const scrubbed = scrubSettings(readFileSync(settings, "utf8"));
      if (scrubbed !== null) put(join("profiles", key, "settings.json"), scrubbed);
    }
  }

  const session = join(sources.stateDir, "session.json");
  if (existsSync(session)) put(join("state", "session.json"), readFileSync(session));

  // What this pass did not write, in the subtrees it owns, is gone.
  for (const sub of OWNED) {
    for (const file of walk(join(dir, sub))) {
      const rel = join(sub, file);
      if (kept.has(rel)) continue;
      rmSync(join(dir, rel), { force: true });
      changed++;
    }
  }
  return { files: kept.size, changed };
}

/** A profile's Claude settings with the keys that hold secrets taken out, or null for a file that is not JSON. */
export function scrubSettings(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const copy = { ...(parsed as Record<string, unknown>) };
    for (const key of SETTINGS_DROP) delete copy[key];
    return `${JSON.stringify(copy, null, 2)}\n`;
  } catch {
    return null;
  }
}

/** Every file under a directory, as paths relative to it, sorted. Nothing for a directory that is not there. */
export function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name === ".git" || name === ".DS_Store") continue;
      const path = join(dir, name);
      let info;
      try {
        info = statSync(path);
      } catch {
        continue;
      }
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) out.push(relative(root, path));
    }
  };
  visit(root);
  return out;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * The mirror read back as what the database imports. A file that will not
 * parse is skipped and named, not fatal: one bad file must not stop the
 * other ninety-nine from coming back.
 */
export function readMirror(dir: string): { data: DataExport; skipped: string[] } {
  const data: DataExport = { boards: [], conversations: [] };
  const skipped: string[] = [];
  for (const file of walk(join(dir, "boards"))) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, "boards", file), "utf8")) as BoardExport;
      if (parsed.version !== EXPORT_VERSION || !parsed.profile?.key || !parsed.board?.id || !Array.isArray(parsed.cards)) throw new Error("not a board file");
      data.boards.push(parsed);
    } catch {
      skipped.push(join("boards", file));
    }
  }
  for (const file of walk(join(dir, "conversations"))) {
    if (!file.endsWith(".jsonl")) continue;
    try {
      const lines = readFileSync(join(dir, "conversations", file), "utf8").split("\n").filter((line) => line.trim());
      const header = JSON.parse(lines[0] ?? "") as ConversationExport;
      if (header.version !== EXPORT_VERSION || !header.id || !header.profileKey) throw new Error("not a conversation file");
      const turns = lines.slice(1).map((line) => JSON.parse(line) as TurnExport);
      data.conversations.push({ header, turns });
    } catch {
      skipped.push(join("conversations", file));
    }
  }
  return { data, skipped };
}

/**
 * The files of the mirror back where they live. Only where nothing is,
 * unless `replace`, which moves what is there to `.bak` first; either way
 * the list says what was written and what was left alone.
 */
export function restoreFiles(dir: string, targets: { configDir: string; stateDir: string }, replace: boolean): { written: string[]; skipped: string[] } {
  const written: string[] = [];
  const skipped: string[] = [];
  const place = (from: string, to: string): void => {
    if (existsSync(to)) {
      if (!replace) {
        skipped.push(to);
        return;
      }
      copyFileSync(to, `${to}.bak`);
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    written.push(to);
  };
  for (const file of walk(join(dir, "config"))) place(join(dir, "config", file), join(targets.configDir, file));
  for (const file of walk(join(dir, "memory"))) {
    // memory/<login>/<project>/<file> → profiles/<login>/claude/projects/<project>/memory/<file>
    const [key, project, ...rest] = file.split("/");
    if (!key || !project || rest.length === 0 || !isLoginKey(key)) continue;
    place(join(dir, "memory", file), join(targets.configDir, "profiles", key, "claude", "projects", project, "memory", ...rest));
  }
  for (const file of walk(join(dir, "profiles"))) {
    const [key, ...rest] = file.split("/");
    if (!key || !isLoginKey(key) || rest.join("/") !== "settings.json") continue;
    place(join(dir, "profiles", file), join(targets.configDir, "profiles", key, "claude", "settings.json"));
  }
  const session = join(dir, "state", "session.json");
  if (existsSync(session)) place(session, join(targets.stateDir, "session.json"));
  return { written, skipped };
}
