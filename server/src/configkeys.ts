/**
 * The keys kururu keeps in its config files, kept in the Keychain instead,
 * with every reader none the wiser.
 *
 * OpenRouter's management key, the Telegram bot's token, the Firecrawl keys,
 * the Claude tokens made for lending: each was a field in a `0600` JSON file
 * in `~/.config/kururu`, read per request by its own module through
 * `readConfigFile`, and lent to a node by reading the same file
 * (`secrets.ts`). Encrypted at rest is what the owner asked for
 * (`docs/plans/vault-secrets.md`), and the one place that every one of those
 * reads and writes passes through is `config.ts`. So that is where the move
 * is made: a write puts each secret field in the Keychain and the file gets a
 * marker in its place, `"kururu-keychain:<nonce>"`; a read puts the value
 * back in the object it returns. The modules, the lending, the Vault page's
 * hints and the settings beside each key read exactly what they did.
 *
 * Synchronous, because `readConfigFile` is and its forty callers are: a
 * `spawnSync` of `security`, a few tens of milliseconds, then remembered by
 * the marker's nonce, which every write changes — so a reader that polls
 * (Telegram, OpenRouter) costs one call per process, not one per poll, and
 * never reads a value older than the file. The process holds the value in
 * memory, which every one of those modules did already.
 *
 * Off unless the server turns it on (`sealConfigSecrets`), on a Mac only: a
 * test, a CLI and a Linux node never write a Keychain by accident. Anything
 * that goes wrong leaves the file as it would have been before this existed —
 * a refusal from `security` writes the value into the file, and says so by
 * file name. `access.json` and the node keys are not in the list, and
 * `docs/plans/vault-secrets.md` says why.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { decodePieces, encodePieces } from "./keychain";

export const MARKER = "kururu-keychain:";
/** The mode every file here is written with: they all held a key, and still hold where one is. */
export const OWNER_ONLY = 0o600;
const SERVICE = "kururu-config";

/**
 * The files and the fields in them that are secrets: a dotted path, `*` for
 * every key of a map. Only a string that is not already a marker is moved.
 */
export function secretPaths(file: string): string[] {
  switch (file) {
    case "openrouter.json":
      return ["managementKey"];
    case "telegram.json":
      return ["token"];
    case "firecrawl.json":
      return ["apiKey"];
    case "claude-lend.json":
      return ["tokens.*.token"];
    case "claude-token.json":
      return ["token"];
  }
  // The web providers' files, `web-<id>.json`: whichever of the usual names they keep a key under.
  if (/^web-[a-z][a-z0-9-]*\.json$/.test(file)) return ["apiKey", "key", "token"];
  return [];
}

/** Every concrete path in `value` that a pattern names: `tokens.*.token` → `tokens.machine.token`, … */
function expand(value: unknown, pattern: string): string[][] {
  const parts = pattern.split(".");
  let at: { path: string[]; node: unknown }[] = [{ path: [], node: value }];
  for (const part of parts) {
    const next: typeof at = [];
    for (const { path, node } of at) {
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const keys = part === "*" ? Object.keys(node) : [part];
      for (const key of keys) if (Object.hasOwn(node, key)) next.push({ path: [...path, key], node: (node as Record<string, unknown>)[key] });
    }
    at = next;
  }
  return at.map((a) => a.path);
}

function getAt(value: unknown, path: readonly string[]): unknown {
  let node = value;
  for (const key of path) node = node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
  return node;
}

/** A copy of `value` with one path set: the caller's object is never changed under it. */
function setAt(value: unknown, path: readonly string[], to: unknown): unknown {
  if (!path.length) return to;
  const [head, ...rest] = path;
  const node = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return { ...node, [head!]: setAt(node[head!], rest, to) };
}

/** Where one field's value is kept: the account names the file and the field, so a removed field's item can be found and removed. */
const accountOf = (file: string, path: readonly string[]) => `${file}:${path.join(".")}`;

export interface ConfigSealer {
  /** The value as the file should hold it: secrets swapped for markers. Throws on a Keychain refusal. */
  seal: (file: string, value: unknown, before: unknown) => unknown;
  /** The value as readers want it: markers swapped back for their values. A marker that cannot be read is left as it is, which every reader takes as no key. */
  open: (file: string, value: unknown) => unknown;
  /** The items of the markers in a file that is going away. */
  forget: (file: string, value: unknown) => void;
}

function run(args: string[], input?: string): { code: number; stdout: string } {
  const r = spawnSync("/usr/bin/security", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 10_000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? "" };
}

/** The Keychain sealer: the login keychain, or `keychain` (a path) for an isolated instance or a test. */
export function keychainSealer(keychain?: string): ConfigSealer {
  const where = keychain ? [keychain] : [];
  const quote = (s: string) => `"${s.replace(/[^A-Za-z0-9 ._:/#@*-]/g, "")}"`;
  const memo = new Map<string, string>();
  const piece = (account: string, i: number) => (i === 0 ? account : `${account}#${i}`);

  const read = (account: string): string | null => {
    const pieces: string[] = [];
    for (let i = 0; i < 64; i += 1) {
      const r = run(["find-generic-password", "-s", SERVICE, "-a", piece(account, i), "-w", ...where]);
      if (r.code !== 0) break;
      pieces.push(r.stdout.endsWith("\n") ? r.stdout.slice(0, -1) : r.stdout);
      if (i === 0 && !pieces[0]!.startsWith("kururu-b64:")) break;
    }
    return pieces.length ? decodePieces(pieces) : null;
  };
  const remove = (account: string) => {
    for (let i = 0; i < 64; i += 1) if (run(["delete-generic-password", "-s", SERVICE, "-a", piece(account, i), ...where]).code !== 0 && i > 0) break;
  };
  const write = (account: string, value: string) => {
    const pieces = encodePieces(value);
    const tail = where.length ? ` ${quote(where[0]!)}` : "";
    const lines = pieces.map((p, i) => `add-generic-password -U -s ${SERVICE} -a ${quote(piece(account, i))} -l ${quote(`kururu: ${account}`)} -X ${Buffer.from(p, "utf8").toString("hex")}${tail}\n`);
    if (run(["-i"], lines.join("")).code !== 0) throw new Error("security refused it");
    for (let i = pieces.length; i < 64; i += 1) if (run(["delete-generic-password", "-s", SERVICE, "-a", piece(account, i), ...where]).code !== 0) break;
    if (read(account) !== value) throw new Error("the Keychain did not keep it");
  };
  const markers = (file: string, value: unknown): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const pattern of secretPaths(file)) {
      for (const path of expand(value, pattern)) {
        const v = getAt(value, path);
        if (typeof v === "string" && v.startsWith(MARKER)) out.set(accountOf(file, path), path);
      }
    }
    return out;
  };

  return {
    seal(file, value, before) {
      let out = value;
      const kept = new Set<string>();
      for (const pattern of secretPaths(file)) {
        for (const path of expand(value, pattern)) {
          const v = getAt(value, path);
          if (typeof v !== "string" || !v) continue;
          const account = accountOf(file, path);
          kept.add(account);
          if (v.startsWith(MARKER)) continue;
          write(account, v);
          const marker = `${MARKER}${randomBytes(6).toString("hex")}`;
          memo.set(marker, v);
          out = setAt(out, path, marker);
        }
      }
      // A field the new value no longer has — a login's token removed, a key cleared — goes from the Keychain with it.
      for (const account of markers(file, before).keys()) if (!kept.has(account)) remove(account);
      return out;
    },
    open(file, value) {
      let out = value;
      for (const [account, path] of markers(file, value)) {
        const marker = getAt(value, path) as string;
        let v = memo.get(marker);
        if (v === undefined) {
          const got = read(account);
          if (got === null) continue;
          v = got;
          memo.set(marker, v);
        }
        out = setAt(out, path, v);
      }
      return out;
    },
    forget(file, value) {
      for (const account of markers(file, value).keys()) remove(account);
    },
  };
}

/** Whether a value still holds a key in the clear that `seal` would move. */
function hasPlain(file: string, value: unknown): boolean {
  return secretPaths(file).some((pattern) => expand(value, pattern).some((path) => {
    const v = getAt(value, path);
    return typeof v === "string" && v !== "" && !v.startsWith(MARKER);
  }));
}

/** The files in the config folder this module has fields for. */
export function sealableFiles(names: readonly string[]): string[] {
  return names.filter((n) => n.endsWith(".json") && secretPaths(n).length > 0);
}

export interface MoveDeps {
  files: () => string[];
  readRaw: (name: string) => unknown;
  read: (name: string) => unknown;
  write: (name: string, value: unknown) => boolean;
  /** Put the file back as it was, byte for byte, without sealing. */
  restore: (name: string, raw: unknown) => void;
  log: (line: string) => void;
}

/**
 * At the server's start: every key still in the clear in one of these files
 * goes to the Keychain, the file is read back through the sealer and compared
 * with what it was, and a file that does not read back the same is put back
 * as it was. Names files, never values.
 */
export function moveConfigSecrets(deps: MoveDeps): { moved: string[]; kept: string[] } {
  const moved: string[] = [];
  const kept: string[] = [];
  for (const name of deps.files()) {
    const raw = deps.readRaw(name);
    if (raw === null || !hasPlain(name, raw)) continue;
    const ok = deps.write(name, raw) && JSON.stringify(deps.read(name)) === JSON.stringify(raw) && !hasPlain(name, deps.readRaw(name));
    if (ok) moved.push(name);
    else {
      deps.restore(name, raw);
      kept.push(name);
    }
  }
  if (moved.length) deps.log(`moved the keys in ${moved.join(", ")} into the Keychain`);
  if (kept.length) deps.log(`left the keys in ${kept.join(", ")} in their files: the Keychain did not keep them`);
  return { moved, kept };
}

/**
 * `vault to-files`: every key this module moved, back in its file, and its
 * Keychain item gone — for going back to a kururu from before this. Names
 * files, never values.
 */
export function unsealConfigSecrets(deps: Omit<MoveDeps, "read" | "write"> & { sealer: ConfigSealer; writePlain: (name: string, value: unknown) => void }): string[] {
  const back: string[] = [];
  for (const name of deps.files()) {
    const raw = deps.readRaw(name);
    if (raw === null) continue;
    const open = deps.sealer.open(name, raw);
    if (JSON.stringify(open) === JSON.stringify(raw)) continue;
    deps.writePlain(name, open);
    deps.sealer.forget(name, raw);
    back.push(name);
  }
  return back;
}

/** Whether this server keeps its config keys in the Keychain: on a Mac, unless an instance or the owner says not. */
export function sealsConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === "darwin" && env.KURURU_KEYCHAIN_CONFIG !== "0" && env.KURURU_VAULT_STORE !== "file";
}
