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
import { appendFileSync, chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Masker, maskText, type Secret } from "../../shared/mask";
import { validItemName, VARIABLE, type VaultItemView, type VaultUse } from "../../shared/vaultitems";
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
  if (secrets.length > 8) return { error: "at most 8 secrets in one run" };
  const askpass = r.askpass === undefined || r.askpass === null ? null : r.askpass;
  if (askpass !== null && !validItemName(askpass)) return { error: "--askpass names an item" };
  if (!secrets.length && !askpass) return { error: "name at least one --secret or --askpass" };
  return { argv: r.argv as string[], cwd: r.cwd, env, secrets, askpass };
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
    const names = [...new Set([...req.secrets.map((s) => s.name), ...(req.askpass ? [req.askpass] : [])])];
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
      secrets.push({ name: s.name, value });
    }
    let ticket: string | null = null;
    if (req.askpass) {
      // Read now only to mask it: sudo is given it by the askpass, not by the environment.
      const value = await this.deps.valueOf(req.askpass).catch(() => null);
      if (value === null) {
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

/** Where the log is: kururu's data folder, beside the database. */
export function usesPath(dataDir: string): string {
  return join(dataDir, "vault-uses.jsonl");
}
