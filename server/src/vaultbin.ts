/**
 * `vault`, the agents' door into the vault, written where a brief can name
 * it: `~/.local/state/kururu/bin/vault`, as `slot` is (`slots.ts` says why a
 * stable path), pointing at the bundled CLI beside this server and run on
 * this server's own runtime. Rewritten on each start, so it follows the
 * build that is serving; a server run from source with nothing built writes
 * nothing, and `bun run vault` still works from the checkout.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir, writeAtomic } from "./fsutil";

export function vaultCommandPath(): string {
  return join(stateDir(), "bin", "vault");
}

/** The askpass `vault run --askpass` points sudo at: sudo runs a program, never a command line. */
export function vaultAskpassPath(): string {
  return join(stateDir(), "bin", "vault-askpass");
}

function vaultScript(): string {
  return fileURLToPath(new URL("./vault.mjs", import.meta.url));
}

export function writeVaultCommand(): string | null {
  const script = vaultScript();
  if (!existsSync(script)) return null;
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const head = "#!/bin/sh\n# Written by kururu on each start; see docs/vault.md.\n";
  try {
    mkdirSync(dirname(vaultCommandPath()), { recursive: true });
    writeAtomic(vaultCommandPath(), `${head}ELECTRON_RUN_AS_NODE=1 exec ${q(process.execPath)} ${q(script)} "$@"\n`, { mode: 0o755 });
    writeAtomic(vaultAskpassPath(), `${head}ELECTRON_RUN_AS_NODE=1 exec ${q(process.execPath)} ${q(script)} askpass "$@"\n`, { mode: 0o755 });
    return vaultCommandPath();
  } catch {
    return null;
  }
}
