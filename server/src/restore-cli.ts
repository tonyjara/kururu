/**
 * `bun run restore <repository>`: a new Mac put back together from the
 * backup — or an old one, carefully.
 *
 * It clones the repository into the mirror's place (or pulls one that is
 * there), rebuilds the database from the boards and conversations through
 * the same importer the server uses, and puts the config files, the
 * memory folders and the arrangement back where they live. Only where
 * nothing is, unless `--replace`, which moves what is there to `.bak`
 * first; the database is added to rather than replaced either way, since a
 * row already there is left alone. It refuses to run while a server is up,
 * because that server holds the database and the files it would write.
 *
 * It ends by saying what it could not put back: the logins, the OpenRouter
 * and web providers' keys and the share token are not in the backup, on purpose.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { validRepoUrl } from "../../shared/backup";
import { configDir } from "./config";
import { readMirror, restoreFiles } from "./export";
import { git } from "./gitcmd";
import { snapshotPath } from "./persist";
import { dataDir, Store } from "./store";

const PORT = Number(process.env.KURURU_PORT ?? 7717);

async function serverUp(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const replace = args.includes("--replace");
  const source = args.find((arg) => !arg.startsWith("--"));
  if (!source) throw new Error("usage: bun run restore <repository url or path> [--replace]");
  if (await serverUp()) throw new Error(`a kururu server is up on :${PORT}; stop it first, since it holds the database and the files this writes`);

  const dir = join(dataDir(), "backup");
  if (existsSync(join(dir, ".git"))) {
    console.log(`pulling into ${dir}`);
    await git(["pull", "--ff-only", "-q"], dir, { batch: true, timeout: 120_000 });
  } else if (existsSync(join(source, "boards")) || existsSync(join(source, "README.md"))) {
    // A directory that already is a mirror, for a restore from a disk.
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    console.log(`reading the mirror at ${source}`);
  } else {
    if (!validRepoUrl(source)) throw new Error("that is not a git URL or an absolute path");
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    console.log(`cloning into ${dir}`);
    await git(["clone", "-q", source, dir], dataDir(), { batch: true, timeout: 120_000 });
  }
  const mirror = existsSync(join(dir, "boards")) || existsSync(join(dir, "README.md")) ? dir : source;

  const { data, skipped } = readMirror(mirror);
  for (const file of skipped) console.warn(`  skipped, would not parse: ${file}`);
  const store = Store.open();
  try {
    const counts = store.importExport(data);
    console.log(`database: ${counts.profiles} profile(s), ${counts.workspaces} workspace(s), ${counts.boards} board(s), ${counts.cards} card(s), ${counts.turns} turn(s) added`);
  } finally {
    store.close();
  }
  const files = restoreFiles(mirror, { configDir: configDir(), stateDir: join(snapshotPath(), "..") }, replace);
  for (const path of files.written) console.log(`  wrote ${path}`);
  for (const path of files.skipped) console.log(`  left alone (exists; --replace to overwrite): ${path}`);

  console.log(`
Done. What the backup never carried, and so what is left to do by hand:
  - /login in each profile (Settings → Profiles says which are signed in)
  - the OpenRouter management key, in Settings → OpenRouter
  - the web providers' keys, in Settings → Web: the cloud Firecrawl's and the self-hosted one's, if you used them
  - the Telegram bot token and your account, in Settings → Channels, if you used it
  - the share token is made afresh the first time sharing is turned on
  - Input Monitoring for the talk key, when the app asks`);
}

main().catch((err: unknown) => {
  console.error(`kururu restore: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
