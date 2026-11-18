/**
 * The vault's items and the dialogs that fill them: what is kept, by name,
 * and the asks open on the owner's screens.
 *
 * A value never lives here. It arrives in the owner's answer, goes to the
 * store (`keychain.ts`) and, when the field says so, into one variable of an
 * env file (`vaultfile.ts`), and the caller is told a word per field. What
 * this module keeps is the metadata — label, use rule, the env files a value
 * was last written to, who asked, when — in `~/.config/kururu/vault.json`,
 * `0600` though nothing in it is secret, because it is a list of what there
 * is to take.
 *
 * An ask is the dialog on every page, its timer, and the promise its caller
 * waits on. It may stay up for hours (the owner away from the Mac), and the
 * server under `bun run dev` restarts on every save, so an open ask — its
 * title, fields and deadline, never a value, there being none yet — is also
 * written to `<state>/vault-asks.json` and taken up again by the next
 * server, with what became of recent ones, so a caller that reconnects by id
 * hears how its ask ended. A command's ask to use an item is not kept: it
 * belongs to a run, and the run's caller is gone with the server.
 *
 * Generic over nothing and given its store, its clock and its writers, so
 * the tests drive a whole ask with a store in memory and a scratch home.
 */
import { randomUUID } from "node:crypto";
import {
  acceptsName,
  base64Bytes,
  canonicalBase64,
  cleanFileName,
  defaultUse,
  durationWords,
  FILE_MAX,
  sizeWords,
  type AnswerValue,
  type AskFieldView,
  type AskRequest,
  type EnvTarget,
  type FieldOutcome,
  type FileFacts,
  type UseAnswer,
  type UseRule,
  type VaultAsk,
  type VaultItemView,
} from "../../shared/vaultitems";
import type { Approval } from "./vaultrun";
import { readConfigFile, writeConfigFile } from "./config";
import { stateDir, writeAtomic } from "./fsutil";
import type { SecretStore } from "./keychain";
import { envPath, tildePath, writeEnvVariable } from "./vaultfile";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const VAULT_FILE = "vault.json";
/** Env files remembered per item, newest first. */
const ENV_KEPT = 5;
/** How long a finished ask's outcomes can still be asked for, by a caller whose wait ran out first: Kuru comes back by id hours later. */
const DONE_KEPT_MS = 24 * 3_600_000;
/** And at most this many of them. */
const DONE_KEPT = 50;
/** How long a command waits for the owner to allow an item before it is refused. */
export const USE_ASK_MS = 5 * 60_000;
/** "Allow for 15 minutes": per agent, per item, in memory. */
export const LASTING_MS = 15 * 60_000;

interface ItemMeta {
  label: string;
  use: UseRule;
  env: EnvTarget[];
  createdAt: number;
  updatedAt: number;
  by: string;
  lastUse: { at: number; by: string } | null;
  /** A file item's name and size: its value is the file's base64. Absent for text. */
  file?: FileFacts | null;
}

type Timer = unknown;

export interface VaultDeps {
  store: SecretStore;
  /** The open asks changed: every page is sent them. */
  changed: (asks: VaultAsk[]) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  /** Checks an env file's path at ask time, throwing why not. Default `envPath`. */
  checkEnv?: (file: string) => string;
  /** Writes one variable. Default `writeEnvVariable`. */
  writeEnv?: (file: string, variable: string, value: string) => { path: string; backup: string | null };
  /** Where `vault.json` is read and written. Default the config folder's. */
  load?: () => unknown;
  save?: (value: unknown) => void;
  /** A line for the server's log. Never given a value. */
  log?: (line: string) => void;
  /** The home folder paths are said against, `~/…`. Default the process's. */
  home?: string;
  /** Where open asks outlive a restart: the server's are `readAsksFile` and `writeAsksFile`. None given, they do not — a test never writes the state folder. */
  loadAsks?: () => unknown;
  saveAsks?: (value: unknown) => void;
}

interface OpenUse {
  view: Extract<VaultAsk, { kind: "use" }>;
  agentId: string | null;
  names: string[];
  timer: Timer;
  resolve: (approval: Approval) => void;
}

interface OpenAsk {
  view: Extract<VaultAsk, { kind: "values" }>;
  /** How long it was asked to stay up, for the sentence that says it ran out. */
  openFor: number;
  timer: Timer;
  resolve: (outcomes: FieldOutcome[]) => void;
  done: Promise<FieldOutcome[]>;
}

function adoptItems(raw: unknown): Map<string, ItemMeta> {
  const out = new Map<string, ItemMeta>();
  const items = raw && typeof raw === "object" ? (raw as { items?: unknown }).items : null;
  if (!items || typeof items !== "object") return out;
  for (const [name, v] of Object.entries(items as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const m = v as Record<string, unknown>;
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    const env = Array.isArray(m.env)
      ? m.env.filter((e): e is EnvTarget => Boolean(e) && typeof (e as EnvTarget).file === "string" && typeof (e as EnvTarget).variable === "string").slice(0, ENV_KEPT)
      : [];
    const last = m.lastUse && typeof m.lastUse === "object" ? (m.lastUse as Record<string, unknown>) : null;
    const f = m.file && typeof m.file === "object" ? (m.file as Record<string, unknown>) : null;
    const file = f && typeof f.name === "string" && typeof f.size === "number" && Number.isFinite(f.size) ? { name: f.name, size: f.size } : null;
    out.set(name, {
      label: typeof m.label === "string" ? m.label : name,
      use: m.use === "ask" ? "ask" : "free",
      env,
      createdAt: num(m.createdAt),
      updatedAt: num(m.updatedAt),
      by: typeof m.by === "string" ? m.by : "",
      lastUse: last && typeof last.by === "string" ? { at: num(last.at), by: last.by } : null,
      file,
    });
  }
  return out;
}

export class Vault {
  private items: Map<string, ItemMeta>;
  private readonly open = new Map<string, OpenAsk>();
  private readonly finished = new Map<string, { at: number; outcomes: FieldOutcome[] }>();
  private readonly openUses = new Map<string, OpenUse>();
  /** `${agentId} ${name}` → until, from "Allow for 15 minutes". Gone with a restart, on purpose. */
  private readonly lasting = new Map<string, number>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;

  /** Set by `close()` at shutdown: from then on a hangup is the server going, not the caller, and changes nothing. */
  private closing = false;

  constructor(private readonly deps: VaultDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.items = adoptItems((deps.load ?? (() => readConfigFile(VAULT_FILE)))());
    this.takeUp(deps.loadAsks?.() ?? null);
  }

  /**
   * The asks the last server left open, put back up with what is left of
   * their time, and those that ran out while nobody was serving them ended
   * as timed out. And what became of recent ones, for a caller asking by id.
   */
  private takeUp(raw: unknown): void {
    const r = raw && typeof raw === "object" ? (raw as { open?: unknown; finished?: unknown }) : {};
    const now = this.now();
    if (Array.isArray(r.finished)) {
      for (const f of r.finished) {
        const e = f as { id?: unknown; at?: unknown; outcomes?: unknown };
        if (typeof e.id === "string" && typeof e.at === "number" && Number.isFinite(e.at) && now - e.at <= DONE_KEPT_MS && Array.isArray(e.outcomes)) {
          this.finished.set(e.id, { at: e.at, outcomes: e.outcomes as FieldOutcome[] });
        }
      }
    }
    if (!Array.isArray(r.open)) return;
    for (const raw of r.open) {
      const v = raw as OpenAsk["view"] & { openFor?: unknown };
      if (!v || v.kind !== "values" || typeof v.id !== "string" || typeof v.until !== "number" || !Number.isFinite(v.until) || !Array.isArray(v.fields)) continue;
      const openFor = typeof v.openFor === "number" && Number.isFinite(v.openFor) ? v.openFor : 0;
      const view: OpenAsk["view"] = { kind: "values", id: v.id, title: String(v.title ?? ""), reason: String(v.reason ?? ""), from: String(v.from ?? ""), fields: v.fields, until: v.until };
      this.openWith(view, openFor);
      if (v.until <= now) this.close(view.id, "timeout", `nobody answered within ${durationWords(openFor || 0)}`);
    }
  }

  /** What survives a restart: the open asks' views (no value is ever in one) and recent outcomes. */
  private keepAsks(): void {
    if (this.closing || !this.deps.saveAsks) return;
    const value = {
      v: 1,
      open: [...this.open.values()].map((a) => ({ ...a.view, openFor: a.openFor })),
      finished: [...this.finished].map(([id, f]) => ({ id, at: f.at, outcomes: f.outcomes })),
    };
    try {
      this.deps.saveAsks(value);
    } catch (err) {
      this.log(`could not keep the open asks for the next server (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
  }

  /** The server is going: what is open stays written for the next one, and the connections closing under it are not callers hanging up. */
  shutdown(): void {
    this.keepAsks();
    this.closing = true;
  }

  get storeKind(): "keychain" | "file" {
    return this.deps.store.kind;
  }

  private persist(): void {
    const items: Record<string, ItemMeta> = {};
    for (const [name, meta] of [...this.items].sort(([a], [b]) => a.localeCompare(b))) items[name] = meta;
    const value = { v: 1, items };
    if (this.deps.save) this.deps.save(value);
    else writeConfigFile(VAULT_FILE, value, 0o600);
  }

  private log(line: string): void {
    (this.deps.log ?? ((l) => console.log(l)))(`kururu: vault: ${line}`);
  }

  /** The open asks, as every page is sent them: a command waiting first, since something is held up on it. */
  asks(): VaultAsk[] {
    return [...[...this.openUses.values()].map((u) => u.view), ...[...this.open.values()].map((a) => a.view)];
  }

  private announce(): void {
    this.keepAsks();
    this.deps.changed(this.asks());
  }

  /** Every item, by name. Never a value. */
  list(): VaultItemView[] {
    return [...this.items]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, m]) => ({ name, label: m.label, use: m.use, file: m.file ?? null, store: this.deps.store.kind, env: m.env, createdAt: m.createdAt, updatedAt: m.updatedAt, by: m.by, lastUse: m.lastUse }));
  }

  item(name: string): VaultItemView | null {
    return this.list().find((i) => i.name === name) ?? null;
  }

  /**
   * Open a dialog on every page. Checks every env path first and throws
   * the caller's error, so the owner is never shown an ask that cannot be
   * done. Returns its id and the promise of its outcomes; `signal` cancels
   * it when the caller hangs up.
   */
  ask(req: AskRequest, from: string, signal?: AbortSignal): { id: string; done: Promise<FieldOutcome[]> } {
    const check = this.deps.checkEnv ?? ((file: string) => envPath(file));
    const fields: AskFieldView[] = req.fields.map((f, i) => {
      let env: EnvTarget | null = null;
      if (f.env) {
        const path = check(f.env.file);
        env = { file: tildePath(path, this.deps.home), variable: f.env.variable };
      }
      const had = this.items.get(f.name);
      const use: UseRule = had?.use ?? (f.use === "ask" ? "ask" : defaultUse(f.name, f.label));
      return { id: String(i), label: f.label, name: f.name, env, use, exists: Boolean(had), kind: f.kind, accept: f.accept };
    });
    const id = randomUUID().slice(0, 8);
    const view: OpenAsk["view"] = { kind: "values", id, title: req.title, reason: req.reason, from, fields, until: this.now() + req.openFor };
    const done = this.openWith(view, req.openFor);
    this.log(`${from} asked for ${fields.map((f) => f.name).join(", ")} for ${durationWords(req.openFor)} (${id})`);
    this.hangup(id, signal);
    this.announce();
    return { id, done };
  }

  /** An ask up, with its timer and the promise its callers wait on. */
  private openWith(view: OpenAsk["view"], openFor: number): Promise<FieldOutcome[]> {
    let resolve!: (outcomes: FieldOutcome[]) => void;
    const done = new Promise<FieldOutcome[]>((r) => {
      resolve = r;
    });
    const left = Math.max(0, view.until - this.now());
    const timer = this.setTimer(() => this.close(view.id, "timeout", `nobody answered within ${durationWords(openFor)}`), left);
    this.open.set(view.id, { view, openFor, timer, resolve, done });
    return done;
  }

  /** A caller that hangs up cancels its ask — unless it is the server going, whose connections all close at once. */
  hangup(id: string, signal?: AbortSignal): void {
    signal?.addEventListener(
      "abort",
      () => {
        if (!this.closing) this.close(id, "cancelled", "the caller stopped waiting (Ctrl-C, or its agent ended)");
      },
      { once: true },
    );
  }

  /** The labels of an open ask's fields, in order, for the lines a caller reads. */
  labelsOf(id: string): string[] | null {
    return this.open.get(id)?.view.fields.map((f) => f.label) ?? null;
  }

  /** An ask's outcomes: waited for while it is open, or as it ended, for a while after. Null for one never heard of. */
  wait(id: string): Promise<FieldOutcome[]> | null {
    const open = this.open.get(id);
    if (open) return open.done;
    const ended = this.finished.get(id);
    return ended ? Promise.resolve(ended.outcomes) : null;
  }

  private finish(id: string, outcomes: FieldOutcome[]): void {
    const now = this.now();
    for (const [k, v] of this.finished) if (now - v.at > DONE_KEPT_MS) this.finished.delete(k);
    this.finished.set(id, { at: now, outcomes });
    while (this.finished.size > DONE_KEPT) this.finished.delete(this.finished.keys().next().value!);
    // A Save finishes after the dialog was taken off the pages, so this is
    // not always followed by an `announce`: kept here for a caller asking by
    // id from the next server.
    this.keepAsks();
  }

  /** End an open ask with every field the same outcome, without a value having been seen. */
  private close(id: string, outcome: "cancelled" | "timeout", why: string): void {
    const open = this.open.get(id);
    if (!open) return;
    this.open.delete(id);
    this.clearTimer(open.timer);
    const outcomes: FieldOutcome[] = open.view.fields.map((f) => ({ field: f.id, name: f.name, outcome, why }));
    this.finish(id, outcomes);
    this.log(`ask ${id} ${outcome}: ${why}`);
    this.announce();
    open.resolve(outcomes);
  }

  /**
   * The owner's answer, from a page: `values` by field id, or null for
   * Cancel. Each field with a value goes to the store, then to its env file,
   * in order; one that fails does not stop the next. The first answer wins
   * and the other pages' dialogs close with it. Throws only for an ask that
   * is not open, which a second page pressing Save a moment late is.
   */
  async answer(id: string, values: ReadonlyMap<string, AnswerValue> | null, uses: ReadonlyMap<string, UseRule>): Promise<FieldOutcome[]> {
    const open = this.open.get(id);
    if (!open) throw new Error("That ask is closed: it was answered elsewhere or ran out of time.");
    if (values === null) {
      this.close(id, "cancelled", "the owner pressed Cancel");
      return open.done;
    }
    // Off every page before the first write, so a second Save cannot start a second one.
    this.open.delete(id);
    this.clearTimer(open.timer);
    this.announce();
    const outcomes: FieldOutcome[] = [];
    const writeEnv = this.deps.writeEnv ?? ((file: string, variable: string, value: string) => writeEnvVariable(file, variable, value));
    for (const field of open.view.fields) {
      const answered = values.get(field.id);
      const isFile = field.kind === "file";
      if (!answered || (answered.kind === "text" ? !answered.text : !answered.base64)) {
        outcomes.push({ field: field.id, name: field.name, outcome: "skipped" });
        continue;
      }
      if ((answered.kind === "file") !== isFile) {
        outcomes.push({ field: field.id, name: field.name, outcome: "failed", why: isFile ? "a file was asked for and text came" : "text was asked for and a file came" });
        continue;
      }
      if (answered.kind === "file" && !acceptsName(field.accept, answered.name)) {
        outcomes.push({ field: field.id, name: field.name, outcome: "failed", why: `${answered.name} is not ${field.accept?.join(" or ")}` });
        continue;
      }
      // A file is kept as its base64: the store keeps text, and `--secret`
      // hands a program the base64 it would otherwise have been pasted.
      const value = answered.kind === "file" ? answered.base64 : answered.text;
      try {
        await this.deps.store.put(field.name, value);
      } catch (err) {
        outcomes.push({ field: field.id, name: field.name, outcome: "failed", why: err instanceof Error ? err.message : "the store refused it" });
        continue;
      }
      const now = this.now();
      const had = this.items.get(field.name);
      const meta: ItemMeta = {
        label: field.label,
        use: uses.get(field.id) ?? field.use,
        env: had?.env ?? [],
        createdAt: had?.createdAt || now,
        updatedAt: now,
        by: open.view.from,
        lastUse: had?.lastUse ?? null,
        file: answered.kind === "file" ? { name: answered.name, size: answered.size } : null,
      };
      let envFailed: string | null = null;
      if (field.env) {
        try {
          const wrote = writeEnv(field.env.file, field.env.variable, value);
          const target = { file: tildePath(wrote.path, this.deps.home), variable: field.env.variable };
          meta.env = [target, ...meta.env.filter((e) => e.file !== target.file || e.variable !== target.variable)].slice(0, ENV_KEPT);
        } catch (err) {
          envFailed = err instanceof Error ? err.message : "the file could not be written";
        }
      }
      this.items.set(field.name, meta);
      outcomes.push(
        envFailed
          ? { field: field.id, name: field.name, outcome: "failed", why: `kept in the ${this.deps.store.kind === "keychain" ? "Keychain" : "vault"}, but ${field.env?.variable} was not written: ${envFailed}` }
          : { field: field.id, name: field.name, outcome: "saved" },
      );
    }
    this.persist();
    this.finish(id, outcomes);
    this.log(`ask ${id} answered: ${outcomes.map((o) => `${o.name} ${o.outcome}`).join(", ")}`);
    open.resolve(outcomes);
    return outcomes;
  }

  /**
   * Whether a command may use these items. `free` when none of them asks;
   * `lasting` when every one that asks was allowed to this agent for fifteen
   * minutes and still is; otherwise a dialog on every page, and the owner's
   * answer — `denied` after five minutes unanswered or when the caller hangs
   * up. `note` tells the caller it is waiting.
   */
  approve(
    run: { by: string; agentId: string | null; items: VaultItemView[]; command: string; cwd: string },
    note: (line: string) => void,
    signal?: AbortSignal,
  ): Promise<Approval> {
    const asking = run.items.filter((i) => i.use === "ask");
    if (!asking.length) return Promise.resolve("free");
    const now = this.now();
    for (const [key, until] of this.lasting) if (until <= now) this.lasting.delete(key);
    if (run.agentId && asking.every((i) => this.lasting.has(`${run.agentId} ${i.name}`))) return Promise.resolve("lasting");
    const id = randomUUID().slice(0, 8);
    return new Promise<Approval>((resolve) => {
      const view: OpenUse["view"] = {
        kind: "use",
        id,
        from: run.by,
        items: asking.map((i) => ({ name: i.name, label: i.label })),
        command: run.command,
        cwd: run.cwd,
        lasting: run.agentId !== null,
        until: now + USE_ASK_MS,
      };
      const timer = this.setTimer(() => this.endUse(id, "denied", "nobody answered in time"), USE_ASK_MS);
      this.openUses.set(id, { view, agentId: run.agentId, names: asking.map((i) => i.name), timer, resolve });
      note(`waiting for the owner to allow ${asking.map((i) => i.name).join(", ")} (up to ${USE_ASK_MS / 60_000} minutes)`);
      this.log(`${run.by} asks to use ${view.items.map((i) => i.name).join(", ")} (${id})`);
      signal?.addEventListener("abort", () => this.endUse(id, "denied", "the caller went away"), { once: true });
      this.announce();
    });
  }

  private endUse(id: string, approval: Approval, why: string): void {
    const open = this.openUses.get(id);
    if (!open) return;
    this.openUses.delete(id);
    this.clearTimer(open.timer);
    this.log(`use ${id} ${approval}: ${why}`);
    this.announce();
    open.resolve(approval);
  }

  /** The owner's answer to a command waiting to use items. */
  allow(id: string, answer: UseAnswer): void {
    const open = this.openUses.get(id);
    if (!open) throw new Error("That ask is closed: it was answered elsewhere, ran out of time, or its command was stopped.");
    if (answer === "lasting" && open.agentId) {
      const until = this.now() + LASTING_MS;
      for (const name of open.names) this.lasting.set(`${open.agentId} ${name}`, until);
    }
    this.endUse(id, answer === "deny" ? "denied" : "owner", answer === "deny" ? "the owner pressed Deny" : answer === "lasting" ? "the owner allowed it for 15 minutes" : "the owner allowed it once");
  }

  /** A file item's name and size, or null for text or no such item. */
  fileOf(name: string): FileFacts | null {
    return this.items.get(name)?.file ?? null;
  }

  /**
   * A text item that holds a file's base64 — pasted the old way, `base64 -i
   * cert.p12 | pbcopy` — made a file item called `fileName`, so `vault run
   * --file` can hand it to a command as the file again. The value is read
   * here to check it is base64 and to measure it, and is put back only
   * without its line breaks; nothing about it but its size is said. Throws
   * a sentence with no value in it.
   */
  async convertToFile(name: string, fileName: string, by: string): Promise<VaultItemView> {
    const meta = this.items.get(name);
    if (!meta) throw new Error(`No item ${name} in the vault.`);
    const clean = cleanFileName(fileName);
    if (!clean || clean !== fileName.trim()) throw new Error("The file's name is one name, such as certificate.p12: letters, digits, spaces and . _ - ( ) + @ , only.");
    const value = await this.deps.store.get(name);
    if (value === null) throw new Error(`${name} has no value kept.`);
    const b64 = canonicalBase64(value);
    if (b64 === null) throw new Error(`${name} does not hold base64, so it is not a file's: it stays text. A file can be asked for again with vault ask --file-field.`);
    const size = base64Bytes(b64);
    if (size > FILE_MAX) throw new Error(`${name} is ${sizeWords(size)} once decoded; a file is at most ${sizeWords(FILE_MAX)}.`);
    if (b64 !== value) await this.deps.store.put(name, b64);
    meta.file = { name: clean, size };
    meta.updatedAt = this.now();
    this.persist();
    this.log(`${by} made ${name} a file (${clean}, ${sizeWords(size)})`);
    return this.item(name)!;
  }

  /** The owner's switch, from Settings. */
  setUse(name: string, use: UseRule): VaultItemView {
    const meta = this.items.get(name);
    if (!meta) throw new Error(`No item ${name} in the vault.`);
    meta.use = use;
    this.persist();
    return this.item(name)!;
  }

  /** The item and its value gone. An env file it was written to keeps its copy, and the page says so. */
  async remove(name: string): Promise<void> {
    if (!this.items.has(name)) throw new Error(`No item ${name} in the vault.`);
    await this.deps.store.remove(name);
    this.items.delete(name);
    this.persist();
    this.log(`removed ${name}`);
  }

  /** A value, for the broker only (`vaultrun.ts`): never to a page, a log or a tool's answer. */
  async valueOf(name: string): Promise<string | null> {
    if (!this.items.has(name)) return null;
    return this.deps.store.get(name);
  }

  /** Note a use, for the page and `list_secrets`. */
  used(names: readonly string[], by: string): void {
    const at = this.now();
    let any = false;
    for (const name of names) {
      const meta = this.items.get(name);
      if (meta) {
        meta.lastUse = { at, by };
        any = true;
      }
    }
    if (any) this.persist();
  }
}

function asksPath(): string {
  return join(stateDir(), "vault-asks.json");
}

export function readAsksFile(): unknown {
  try {
    return JSON.parse(readFileSync(asksPath(), "utf8"));
  } catch {
    return null;
  }
}

/** Owner-only though no value is in it: it names what keys are wanted and where they go. */
export function writeAsksFile(value: unknown): void {
  writeAtomic(asksPath(), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
