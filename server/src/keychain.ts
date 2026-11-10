/**
 * Where the vault keeps a value: the login Keychain on a Mac, a `0600` file
 * on a node with none.
 *
 * The Keychain because the owner asked for the Mac's own store rather than
 * crypto of ours (`docs/plans/vault-secrets.md`), and through
 * `/usr/bin/security` because kururu has no native code in the server and a
 * binding for one call was the wrong trade. Three things about that tool
 * decide the shape of this file, each tried against a throwaway keychain
 * before it was written:
 *
 * - **Nothing goes on a command line**, where `ps` would show it. `security
 *   -i` reads commands from its stdin, and `add-generic-password -X` takes
 *   the data as hex, so no quoting in the value can break the line.
 * - **A line of `security -i` holds about 4 KB**, so a value is written in
 *   pieces of `CHUNK` characters: the item `<name>`, then `<name>#1`, …
 * - **`find-generic-password -w` prints anything that is not printable ASCII
 *   as hex**, with nothing to say it did. So a short printable value is kept
 *   as itself, which is what the owner sees in Keychain Access, and anything
 *   else — a line break, a letter with an accent, a 3 KB PEM key — as
 *   `kururu-b64:` and its base64, which is printable by construction.
 *
 * What `security` says on stderr is never kept or logged: on a refusal it can
 * print its usage, and nothing it prints is worth the risk of the one line
 * that one day echoes what it was fed. A failure is its exit code.
 *
 * An item made this way trusts `/usr/bin/security`, so any process running as
 * the owner can read it back through the same tool without a prompt. That is
 * the limit the plan's threat model states; nothing here pretends otherwise.
 *
 * On Linux the store is files: `<dir>/<name>` (slashes become folders),
 * `0600` under `0700`. A headless node has no keyring for `secret-tool` to
 * talk to; see the plan's "Linux nodes".
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeAtomic } from "./fsutil";

export interface SecretStore {
  readonly kind: "keychain" | "file";
  /** Keep a value under a name, replacing what was there. Throws a sentence with no value in it. */
  put(name: string, value: string): Promise<void>;
  /** The value, or null when there is none. */
  get(name: string): Promise<string | null>;
  has(name: string): Promise<boolean>;
  remove(name: string): Promise<void>;
}

/** Characters of one piece. Hex doubles it, and the line keeps room for the command and a keychain's path. */
const CHUNK = 1800;
/** The most pieces a value is read back from: `VALUE_MAX` in base64 is under this many. */
const MAX_CHUNKS = 64;
export const B64 = "kururu-b64:";

/** What is written: the value as itself when `-w` would print it back unchanged, else marked base64, in pieces. */
export function encodePieces(value: string): string[] {
  const plain = /^[\x20-\x7e]*$/.test(value) && value.length <= CHUNK && !value.startsWith(B64);
  const data = plain ? value : B64 + Buffer.from(value, "utf8").toString("base64");
  const pieces: string[] = [];
  for (let i = 0; i < data.length; i += CHUNK) pieces.push(data.slice(i, i + CHUNK));
  return pieces.length ? pieces : [""];
}

/** The value back from what `encodePieces` wrote. */
export function decodePieces(pieces: readonly string[]): string {
  const data = pieces.join("");
  return data.startsWith(B64) ? Buffer.from(data.slice(B64.length), "base64").toString("utf8") : data;
}

const pieceName = (name: string, i: number) => (i === 0 ? name : `${name}#${i}`);

interface Ran {
  code: number;
  stdout: string;
}

/** `security`, with `input` on its stdin. Its stderr is read and dropped; see the module's comment. */
function security(args: readonly string[], input: string | null): Promise<Ran> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("/usr/bin/security", args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve({ code: -1, stdout: "" });
      return;
    }
    const out: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", () => {});
    child.on("error", () => resolve({ code: -1, stdout: "" }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8") }));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? undefined);
  });
}

/**
 * The login Keychain, or `keychain` — a path, for the tests, which make a
 * throwaway one rather than touch the owner's.
 */
export function keychainStore(service: string, keychain?: string): SecretStore {
  const where = keychain ? [keychain] : [];
  // A label and an account are written inside `security -i`'s own quoting,
  // so they are held to characters that need none. Names already are.
  const quoted = (s: string) => `"${s.replace(/[^A-Za-z0-9 ._:/#@-]/g, "")}"`;
  const readPiece = async (account: string): Promise<string | null> => {
    const ran = await security(["find-generic-password", "-s", service, "-a", account, "-w", ...where], null);
    if (ran.code === 44) return null;
    if (ran.code !== 0) throw new Error(`the Keychain could not be read (security said ${ran.code})`);
    return ran.stdout.endsWith("\n") ? ran.stdout.slice(0, -1) : ran.stdout;
  };
  const exists = async (account: string): Promise<boolean> => {
    const ran = await security(["find-generic-password", "-s", service, "-a", account, ...where], null);
    return ran.code === 0;
  };
  const drop = async (account: string): Promise<boolean> => {
    const ran = await security(["delete-generic-password", "-s", service, "-a", account, ...where], null);
    return ran.code === 0;
  };
  const store: SecretStore = {
    kind: "keychain",
    async put(name, value) {
      // An empty field is skipped before it gets here; one that did would be
      // written as a single NUL, the only way `-X` can say nothing.
      if (!value) throw new Error("an empty value is not kept");
      const pieces = encodePieces(value);
      const tail = where.length ? ` ${quoted(where[0] ?? "")}` : "";
      const lines = pieces.map((piece, i) => {
        const hex = Buffer.from(piece, "utf8").toString("hex") || "00";
        // An empty value as one NUL would read back as "\0"; an empty value is refused before this anyway.
        return `add-generic-password -U -s ${quoted(service)} -a ${quoted(pieceName(name, i))} -l ${quoted(`kururu: ${name}${i ? ` (${i + 1})` : ""}`)} -X ${hex}${tail}\n`;
      });
      const ran = await security(["-i"], lines.join(""));
      if (ran.code !== 0) throw new Error(`the Keychain refused it (security said ${ran.code})`);
      // A shorter value than the last leaves pieces behind; they go now, so a
      // read never joins an old tail onto a new head.
      for (let i = pieces.length; i < MAX_CHUNKS; i += 1) if (!(await drop(pieceName(name, i)))) break;
      // Read back and compared, because `security -i` can say 0 for a line it
      // did not take. Compared here and never returned or logged.
      const back = await store.get(name);
      if (back !== value) throw new Error("the Keychain did not keep it (read back different)");
    },
    async get(name) {
      const first = await readPiece(name);
      if (first === null) return null;
      const pieces = [first];
      if (first.startsWith(B64)) {
        for (let i = 1; i < MAX_CHUNKS; i += 1) {
          const next = await readPiece(pieceName(name, i));
          if (next === null) break;
          pieces.push(next);
        }
      }
      return decodePieces(pieces);
    },
    has: (name) => exists(name),
    async remove(name) {
      for (let i = 0; i < MAX_CHUNKS; i += 1) if (!(await drop(pieceName(name, i))) && i > 0) break;
    },
  };
  return store;
}

/** A `0600` file per name under `dir` (`0700`). For a node with no Keychain. */
export function fileStore(dir: string): SecretStore {
  const pathOf = (name: string) => join(dir, ...name.split("/"));
  return {
    kind: "file",
    async put(name, value) {
      const path = pathOf(name);
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
        writeAtomic(path, value, { mode: 0o600, suffix: ".kururu-tmp" });
      } catch (err) {
        throw new Error(`could not write the vault's file (${(err as NodeJS.ErrnoException).code ?? "error"})`);
      }
    },
    async get(name) {
      try {
        return readFileSync(pathOf(name), "utf8");
      } catch {
        return null;
      }
    },
    async has(name) {
      return existsSync(pathOf(name));
    },
    async remove(name) {
      rmSync(pathOf(name), { force: true });
    },
  };
}

/**
 * The store this machine keeps the vault in: the login Keychain on a Mac,
 * files under `fileDir` elsewhere. `KURURU_VAULT_STORE=file` forces files,
 * for an isolated instance on a Mac that must not write the owner's
 * Keychain; `KURURU_VAULT_KEYCHAIN` names a keychain file to use instead of
 * the login one, for the same reason.
 */
export function machineStore(service: string, fileDir: string): SecretStore {
  if (process.platform === "darwin" && process.env.KURURU_VAULT_STORE !== "file") return keychainStore(service, process.env.KURURU_VAULT_KEYCHAIN || undefined);
  return fileStore(fileDir);
}
