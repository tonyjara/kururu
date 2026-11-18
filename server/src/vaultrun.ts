/**
 * The broker: one command, run by the server with vault items in its
 * environment, its output streamed back with every value masked, and every
 * use written down.
 *
 * The server runs it rather than the CLI, so there is no endpoint that hands
 * a caller a value and nothing in the CLI's process ever holds one. The
 * caller sends its argv, its folder and its environment; the server reads
 * the items, adds them to that environment, starts the command in a process
 * group of its own with stdin closed, and sends back what it prints, through
 * `Masker` (`shared/mask.ts`). A caller that hangs up ends the group.
 *
 * A file item — a certificate, a `.p8` — can be handed over as a file:
 * `--file ITEM=VAR` writes its bytes to a `0600` file in a `0700` folder of
 * its own under kururu's state folder, puts that file's *path* in VAR, and
 * removes the folder when the command ends, however it ends. A server that
 * dies mid-run leaves one behind, so the next one sweeps what is older than
 * a few minutes when it starts (`sweepRunFiles`). The file is on the disk
 * while the command runs, readable by anything running as the owner, as an
 * env file the dialog writes is: no wider than the command having the value.
 *
 * `sudo` is the one thing that needs a password and will not read it from
 * the environment, so an item can be given to it instead: `SUDO_ASKPASS`
 * points at `bin/vault-askpass`, and the command's environment carries a
 * ticket the askpass trades for the value — three times at most, and only
 * while the run lives. The value goes from the askpass to sudo and never
 * into the command's environment or output.
 *
 * Every run is a line in `vault-uses.jsonl`, in kururu's data folder: who,
 * which items, the command as the caller wrote it, where, who allowed it,
 * the exit code and how long. Never a value; but the command is the caller's
 * text, so it is masked too before it is written, and the page can clear the
 * file.
 *
 * What this does not stop is in `docs/vault.md` and said plainly: the
 * command has the value and can send it anywhere.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Masker, maskText, type Secret } from "../../shared/mask";
import { cleanFileName, validItemName, VARIABLE, type VaultItemView, type VaultUse } from "../../shared/vaultitems";
import { stateDir } from "./fsutil";
import { tildePath } from "./vaultfile";

/** Uses the page shows, newest first. */
export const USES_SHOWN = 50;
/** The command as logged and as the approval shows it. */
const COMMAND_MAX = 500;
/** How many times sudo may ask for the password in one run: a wrong one and two retries. */
const ASKPASS_USES = 3;
/** After SIGTERM, how long a command has before SIGKILL. */
const KILL_AFTER_MS = 3000;

export interface RunRequest {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  secrets: { name: string; variable: string }[];
  /** Items handed over as a file: VARIABLE holds the path of a temporary copy. */
  files: { name: string; variable: string }[];
  askpass: string | null;
}

/** A caller's run read off the wire, or why it is not one. */
export function adoptRunRequest(raw: unknown): RunRequest | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "a run is an object" };
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.argv) || r.argv.length === 0 || r.argv.length > 512 || !r.argv.every((a) => typeof a === "string")) {
    return { error: "give the command after --, such as: vault run --secret NAME=VAR -- bun run smoke" };
  }
  if (typeof r.cwd !== "string" || !isAbsolute(r.cwd)) return { error: "the folder must be an absolute path" };
  try {
    if (!statSync(r.cwd).isDirectory()) return { error: `${r.cwd} is not a folder` };
  } catch {
    return { error: `${r.cwd} is not there` };
  }
  const env: Record<string, string> = {};
  if (r.env && typeof r.env === "object") {
    for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
      if (typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = v;
    }
  }
  const secrets: RunRequest["secrets"] = [];
  if (Array.isArray(r.secrets)) {
    for (const s of r.secrets) {
      const e = s as Record<string, unknown>;
      if (!s || typeof s !== "object" || !validItemName(e.name) || typeof e.variable !== "string" || !VARIABLE.test(e.variable)) {
        return { error: "each --secret is NAME=VARIABLE: an item's name and the variable to put it in, such as pylink/bancard-staging-private=BANCARD_PRIVATE_KEY" };
      }
      secrets.push({ name: e.name, variable: e.variable });
    }
  }
  const files: RunRequest["files"] = [];
  if (Array.isArray(r.files)) {
    for (const s of r.files) {
      const e = s as Record<string, unknown>;
      if (!s || typeof s !== "object" || !validItemName(e.name) || typeof e.variable !== "string" || !VARIABLE.test(e.variable)) {
        return { error: "each --file is NAME=VARIABLE: an item's name and the variable to put its file's path in, such as bpay/sifen-certificate=SIFEN_CERT_PATH" };
      }
      files.push({ name: e.name, variable: e.variable });
    }
  }
  if (secrets.length + files.length > 8) return { error: "at most 8 secrets and files in one run" };
  const variables = [...secrets, ...files].map((s) => s.variable);
  if (new Set(variables).size !== variables.length) return { error: "each --secret and --file needs a variable of its own" };
  const askpass = r.askpass === undefined || r.askpass === null ? null : r.askpass;
  if (askpass !== null && !validItemName(askpass)) return { error: "--askpass names an item" };
  if (!secrets.length && !files.length && !askpass) return { error: "name at least one --secret, --file or --askpass" };
  return { argv: r.argv as string[], cwd: r.cwd, env, secrets, files, askpass };
}

/** The command as a person would type it, for the log and the approval. */
export function commandText(argv: readonly string[]): string {
  const text = argv.map((a) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
  return text.length > COMMAND_MAX ? `${text.slice(0, COMMAND_MAX - 1)}…` : text;
}

/**
 * What a run sends its caller, one JSON line each: the command's stdout
 * (`o`) and stderr (`e`) as base64 of the masked bytes, a word from kururu
 * (`note`, plain text, which the CLI prints on its stderr), or the end.
 */
export type RunEvent = { o: string } | { e: string } | { note: string } | { exit: number | null; signal?: string };

export type Approval = "free" | "owner" | "lasting" | "denied";

/** A file item's bytes, and the patterns besides its base64 that mask it: the bytes themselves, and each long line of a text file, since a command that prints a PEM key or a service account's JSON tends to print it a line at a time. */
export function fileSecrets(name: string, b64: string, isFile: boolean): { bytes: Buffer; secrets: Secret[] } {
  const bytes = isFile ? Buffer.from(b64, "base64") : Buffer.from(b64, "utf8");
  const secrets: Secret[] = [{ name, value: b64 }, { name, value: "", bytes }];
  if (!bytes.includes(0)) {
    const lines = new Set(bytes.toString("utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= LINE_MASK_MIN));
    for (const line of [...lines].slice(0, LINES_MASKED)) secrets.push({ name, value: line });
  }
  return { bytes, secrets };
}
/** A line of a text file shorter than this is not masked on its own: `-----END PRIVATE KEY-----` is not a secret, and short lines are the ones that also appear in everything else. */
const LINE_MASK_MIN = 24;
/** And at most this many lines of one file: a key is a few dozen. */
const LINES_MASKED = 400;

/** Leftover run folders older than this are swept when a server starts: a run the last server started may still be going for a moment. */
const SWEEP_AFTER_MS = 10 * 60_000;

/**
 * Remove what a server that died mid-run left in `dir`: a folder per run,
 * each holding a file item's copy. Returns how many went.
 */
export function sweepRunFiles(dir: string, now = Date.now()): number {
  let gone = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith("run-")) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs < SWEEP_AFTER_MS) continue;
      rmSync(path, { recursive: true, force: true });
      gone += 1;
    } catch {
      // Gone already, or not ours to read.
    }
  }
  return gone;
}

export interface VaultRunDeps {
  item: (name: string) => VaultItemView | null;
  valueOf: (name: string) => Promise<string | null>;
  used: (names: readonly string[], by: string) => void;
  /**
   * Whether this run may go ahead: `free` when no item asks, else the
   * owner's answer. `note` tells the caller it is waiting. See step 4 in
   * `docs/plans/vault-secrets.md`.
   */
  approve: (run: { by: string; agentId: string | null; items: VaultItemView[]; command: string; cwd: string }, note: (line: string) => void, signal: AbortSignal) => Promise<Approval>;
  askpassPath: () => string;
  /** Where a run's file copies go, a folder each: `~/.local/state/kururu/vault/run`. */
  filesDir: () => string;
  /** The port the askpass asks, which is this server's. */
  port: number;
  logPath: () => string;
  now?: () => number;
}

interface Ticket {
  name: string;
  left: number;
}

export class VaultRuns {
  private readonly tickets = new Map<string, Ticket>();
  private readonly now: () => number;

  constructor(private readonly deps: VaultRunDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Run one command for `by`. Resolves when it has ended and its line is
   * written. Never throws: everything that goes wrong is an event, so the
   * caller always hears an `exit`.
   */
  async run(req: RunRequest, caller: { name: string; agentId: string | null }, emit: (ev: RunEvent) => void, signal: AbortSignal): Promise<void> {
    const started = this.now();
    const names = [...new Set([...req.secrets.map((s) => s.name), ...req.files.map((f) => f.name), ...(req.askpass ? [req.askpass] : [])])];
    const command = commandText(req.argv);
    const cwd = tildePath(req.cwd, homedir());
    const log = (approved: Approval, code: number | null, secrets: readonly Secret[]) =>
      this.write({ at: started, by: caller.name, agentId: caller.agentId, names, command: maskText(command, secrets), cwd, approved, code, ms: this.now() - started });

    const items: VaultItemView[] = [];
    for (const name of names) {
      const item = this.deps.item(name);
      if (!item) {
        emit({ note: `no item ${name}; \`vault list\` names what is kept, and \`vault ask\` asks the owner for one` });
        emit({ exit: 2 });
        return;
      }
      items.push(item);
    }

    const approved = await this.deps.approve({ by: caller.name, agentId: caller.agentId, items, command, cwd }, (line) => emit({ note: line }), signal);
    if (approved === "denied" || signal.aborted) {
      log("denied", null, []);
      if (!signal.aborted) {
        emit({ note: "not allowed: the owner said no, or did not answer in time. Nothing ran." });
        emit({ exit: 77 });
      }
      return;
    }

    const secrets: Secret[] = [];
    const env: Record<string, string> = { ...req.env };
    delete env.KURURU_VAULT_TICKET;
    delete env.SUDO_ASKPASS;
    for (const s of req.secrets) {
      let value: string | null = null;
      try {
        value = await this.deps.valueOf(s.name);
      } catch (err) {
        emit({ note: `${s.name} could not be read: ${err instanceof Error ? err.message : "the store refused"}` });
      }
      if (value === null) {
        log(approved, null, secrets);
        emit({ note: `${s.name} has no value kept` });
        emit({ exit: 2 });
        return;
      }
      env[s.variable] = value;
      const item = this.deps.item(s.name);
      if (item?.file) secrets.push(...fileSecrets(s.name, value, true).secrets);
      else secrets.push({ name: s.name, value });
    }
    // The copies go in a folder of this run's own, made 0700 by mkdtemp,
    // each file 0600 under its own name — a program may care that a
    // certificate ends in .p12 — and the folder goes in the `finally` below.
    let runDir: string | null = null;
    const dropFiles = () => {
      if (runDir) rmSync(runDir, { recursive: true, force: true });
      runDir = null;
    };
    for (const f of req.files) {
      let value: string | null = null;
      try {
        value = await this.deps.valueOf(f.name);
      } catch (err) {
        emit({ note: `${f.name} could not be read: ${err instanceof Error ? err.message : "the store refused"}` });
      }
      if (value === null) {
        dropFiles();
        log(approved, null, secrets);
        emit({ note: `${f.name} has no value kept` });
        emit({ exit: 2 });
        return;
      }
      const item = this.deps.item(f.name);
      const { bytes, secrets: masks } = fileSecrets(f.name, value, Boolean(item?.file));
      secrets.push(...masks);
      try {
        if (!runDir) {
          const parent = this.deps.filesDir();
          mkdirSync(parent, { recursive: true, mode: 0o700 });
          chmodSync(parent, 0o700);
          runDir = mkdtempSync(join(parent, "run-"));
          chmodSync(runDir, 0o700);
        }
        const base = cleanFileName(item?.file?.name ?? f.name.split("/").pop()) ?? "file";
        // Two items with one file name each get a folder of their own inside.
        const sub = join(runDir, String(req.files.indexOf(f)));
        mkdirSync(sub, { mode: 0o700 });
        const path = join(sub, base);
        writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
        env[f.variable] = path;
      } catch (err) {
        dropFiles();
        log(approved, null, secrets);
        emit({ note: `${f.name} could not be written for the command (${(err as NodeJS.ErrnoException).code ?? "error"})` });
        emit({ exit: 2 });
        return;
      }
    }
    let ticket: string | null = null;
    if (req.askpass) {
      // Read now only to mask it: sudo is given it by the askpass, not by the environment.
      const value = await this.deps.valueOf(req.askpass).catch(() => null);
      if (value === null) {
        dropFiles();
        log(approved, null, secrets);
        emit({ note: `${req.askpass} has no value kept` });
        emit({ exit: 2 });
        return;
      }
      secrets.push({ name: req.askpass, value });
      ticket = randomBytes(24).toString("hex");
      this.tickets.set(ticket, { name: req.askpass, left: ASKPASS_USES });
      env.SUDO_ASKPASS = this.deps.askpassPath();
      env.KURURU_VAULT_TICKET = ticket;
      env.KURURU_PORT = String(this.deps.port);
    }
    this.deps.used(names, caller.name);

    const out = new Masker(secrets);
    const err = new Masker(secrets);
    const send = (key: "o" | "e", bytes: Buffer) => {
      if (bytes.length) emit(key === "o" ? { o: bytes.toString("base64") } : { e: bytes.toString("base64") });
    };
    let code: number | null = null;
    let ended: string | undefined;
    try {
      await new Promise<void>((resolve) => {
        let child;
        try {
          child = spawn(req.argv[0]!, req.argv.slice(1), { cwd: req.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
        } catch (e) {
          emit({ note: `could not start ${req.argv[0]}: ${(e as Error).message}` });
          code = 127;
          resolve();
          return;
        }
        const group = child.pid;
        const kill = () => {
          if (!group) return;
          try {
            process.kill(-group, "SIGTERM");
          } catch {
            return;
          }
          setTimeout(() => {
            try {
              process.kill(-group, "SIGKILL");
            } catch {
              // Gone.
            }
          }, KILL_AFTER_MS).unref();
        };
        signal.addEventListener("abort", kill, { once: true });
        child.stdout.on("data", (c: Buffer) => send("o", out.push(c)));
        child.stderr.on("data", (c: Buffer) => send("e", err.push(c)));
        let failed = false;
        child.on("error", (e) => {
          failed = true;
          emit({ note: `could not start ${req.argv[0]}: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "not found on the PATH" : e.message}` });
          code = 127;
          resolve();
        });
        child.on("close", (c, s) => {
          signal.removeEventListener("abort", kill);
          if (failed) return;
          code = c;
          ended = s ?? undefined;
          resolve();
        });
      });
    } finally {
      dropFiles();
    }
    if (ticket) this.tickets.delete(ticket);
    send("o", out.end());
    send("e", err.end());
    log(approved, code, secrets);
    emit(ended ? { exit: code, signal: ended } : { exit: code });
  }

  /** The askpass's trade: a live ticket for its item's value. Null once spent or ended. */
  async askpass(ticket: string): Promise<string | null> {
    const t = this.tickets.get(ticket);
    if (!t || t.left <= 0) return null;
    t.left -= 1;
    return this.deps.valueOf(t.name).catch(() => null);
  }

  private write(use: VaultUse): void {
    const path = this.deps.logPath();
    try {
      appendFileSync(path, `${JSON.stringify(use)}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
    } catch (err) {
      console.error(`kururu: vault: could not write the use log (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
  }

  /** The newest uses first. */
  uses(limit = USES_SHOWN): VaultUse[] {
    const path = this.deps.logPath();
    if (!existsSync(path)) return [];
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    const out: VaultUse[] = [];
    const lines = text.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      try {
        const u = JSON.parse(lines[i]!) as VaultUse;
        if (typeof u.at === "number" && typeof u.by === "string" && Array.isArray(u.names)) out.push(u);
      } catch {
        // A torn line from a crash mid-append: skipped.
      }
    }
    return out;
  }

  clearUses(): void {
    const path = this.deps.logPath();
    if (existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
  }
}

/** Where a run's file copies go, a folder per run: kururu's state folder, never a backup's, never the shared /tmp. */
export function vaultFilesDir(): string {
  return join(stateDir(), "vault", "run");
}

/** Where the log is: kururu's data folder, beside the database. */
export function usesPath(dataDir: string): string {
  return join(dataDir, "vault-uses.jsonl");
}
