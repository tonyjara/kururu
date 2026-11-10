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
 * An ask is held in memory: the dialog on every page, its timer, and the
 * promise its caller waits on. A server restarted with one open loses it,
 * and its caller is told so by the connection it was waiting on ending —
 * nothing was saved, and the owner sees the dialog go. That is the right
 * failure for a dialog about keys: never one answered on the owner's behalf.
 *
 * Generic over nothing and given its store, its clock and its writers, so
 * the tests drive a whole ask with a store in memory and a scratch home.
 */
import { randomUUID } from "node:crypto";
import { defaultUse, ASK_MS, type AskFieldView, type AskRequest, type EnvTarget, type FieldOutcome, type UseAnswer, type UseRule, type VaultAsk, type VaultItemView } from "../../shared/vaultitems";
import type { Approval } from "./vaultrun";
import { readConfigFile, writeConfigFile } from "./config";
import type { SecretStore } from "./keychain";
import { envPath, tildePath, writeEnvVariable } from "./vaultfile";

export const VAULT_FILE = "vault.json";
/** Env files remembered per item, newest first. */
const ENV_KEPT = 5;
/** How long a finished ask's outcomes can still be asked for, by a caller whose wait ran out first. */
const DONE_KEPT_MS = 30 * 60_000;
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
    out.set(name, {
      label: typeof m.label === "string" ? m.label : name,
      use: m.use === "ask" ? "ask" : "free",
      env,
      createdAt: num(m.createdAt),
      updatedAt: num(m.updatedAt),
      by: typeof m.by === "string" ? m.by : "",
      lastUse: last && typeof last.by === "string" ? { at: num(last.at), by: last.by } : null,
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

  constructor(private readonly deps: VaultDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.items = adoptItems((deps.load ?? (() => readConfigFile(VAULT_FILE)))());
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
    this.deps.changed(this.asks());
  }

  /** Every item, by name. Never a value. */
  list(): VaultItemView[] {
    return [...this.items]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, m]) => ({ name, label: m.label, use: m.use, store: this.deps.store.kind, env: m.env, createdAt: m.createdAt, updatedAt: m.updatedAt, by: m.by, lastUse: m.lastUse }));
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
      return { id: String(i), label: f.label, name: f.name, env, use, exists: Boolean(had) };
    });
    const id = randomUUID().slice(0, 8);
    let resolve!: (outcomes: FieldOutcome[]) => void;
    const done = new Promise<FieldOutcome[]>((r) => {
      resolve = r;
    });
    const view: OpenAsk["view"] = { kind: "values", id, title: req.title, reason: req.reason, from, fields, until: this.now() + ASK_MS };
    const timer = this.setTimer(() => this.close(id, "cancelled", "nobody answered in time"), ASK_MS);
    this.open.set(id, { view, timer, resolve, done });
    this.log(`${from} asked for ${fields.map((f) => f.name).join(", ")} (${id})`);
    signal?.addEventListener("abort", () => this.close(id, "cancelled", "the caller went away"), { once: true });
    this.announce();
    return { id, done };
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
  }

  /** End an open ask with every field the same outcome, without a value having been seen. */
  private close(id: string, outcome: "cancelled", why: string): void {
    const open = this.open.get(id);
    if (!open) return;
    this.open.delete(id);
    this.clearTimer(open.timer);
    const outcomes: FieldOutcome[] = open.view.fields.map((f) => ({ field: f.id, name: f.name, outcome }));
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
  async answer(id: string, values: ReadonlyMap<string, string> | null, uses: ReadonlyMap<string, UseRule>): Promise<FieldOutcome[]> {
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
      const value = values.get(field.id);
      if (!value) {
        outcomes.push({ field: field.id, name: field.name, outcome: "skipped" });
        continue;
      }
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
