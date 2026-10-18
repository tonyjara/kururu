/**
 * `bun run backup`: a backup now, from the command line.
 *
 * Through the running server when there is one — it holds the database
 * open and the settings, and a second process writing the same mirror
 * would race it — and on its own otherwise, with the same code the server
 * runs. `--check` says what would go and does nothing to git, for the
 * day somebody wants to see the list before pasting a URL.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tokenHeaders } from "../localtoken.mjs";
import { adoptBackupSettings, CONFIG_DIRS, CONFIG_FILES, EXCLUDED, type BackupStatus } from "../../shared/backup";
import { Backup } from "./backup";
import { configDir, readConfigFile } from "./config";
import { walk } from "./export";
import { snapshotPath } from "./persist";
import { dataDir, dbPath, Store } from "./store";

const PORT = Number(process.env.KURURU_PORT ?? 7717);

/**
 * Whether a server is answering, which any answer is: one that wants a token
 * this command does not have is still a server holding the database, and
 * running beside it would race it for the mirror.
 */
async function serverUp(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/health`, { headers: tokenHeaders(), signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  if (check) {
    console.log("What a backup carries, from this Mac:");
    for (const name of CONFIG_FILES) console.log(`  config/${name}`);
    for (const name of CONFIG_DIRS) for (const file of walk(join(configDir(), name))) console.log(`  config/${name}/${file}`);
    console.log("  boards/<profile>/<workspace>.json, conversations/<profile>/<session>.jsonl, memory/<login>/<project>/*, profiles/<login>/settings.json, state/session.json");
    console.log("And never:");
    for (const { what, why } of EXCLUDED) console.log(`  ${what} — ${why}`);
    const settings = adoptBackupSettings(readConfigFile("backup.json"));
    console.log(`Repository: ${settings.url ?? "none set"}; ${settings.enabled ? `every ${settings.intervalMin} min` : "off"}; mirror at ${join(dataDir(), "backup")}`);
    return;
  }
  if (await serverUp()) {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/backup/now`, { method: "POST", headers: tokenHeaders() });
    const status = (await response.json()) as BackupStatus & { error?: string | null };
    if (!response.ok) throw new Error(status.error ?? `the server answered ${response.status}`);
    if (status.error) throw new Error(status.error);
    say(status);
    return;
  }
  // Opened, never made: a backup of a database this command had just made would be a commit of nothing.
  if (!existsSync(dbPath())) throw new Error(`there is no database at ${dbPath()} yet; kururu makes it on its first start`);
  const store = Store.open();
  try {
    const backup = new Backup({ store, broadcast: () => undefined, configDir, stateDir: () => join(snapshotPath(), ".."), dataDir });
    const status = await backup.run();
    backup.close();
    if (status.error) throw new Error(status.error);
    say(status);
  } finally {
    store.close();
  }
}

/** What this run did: a commit made now, or nothing to commit, and whether it is pushed. */
function say(status: BackupStatus): void {
  const madeNow = status.lastCommitAt !== null && status.lastRunAt !== null && status.lastCommitAt >= status.lastRunAt;
  console.log(madeNow ? `committed: ${status.lastCommit}` : `nothing changed since the last backup${status.lastCommit ? ` (${status.lastCommit})` : ""}`);
  console.log(status.unpushed ? `${status.unpushed} commit(s) not yet pushed` : status.lastPushAt ? `pushed at ${new Date(status.lastPushAt).toLocaleTimeString()}` : "nothing to push");
}

main().catch((err: unknown) => {
  console.error(`kururu backup: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
