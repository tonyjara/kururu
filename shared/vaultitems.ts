/**
 * The vault's own items: what one is called, what a caller may ask the owner
 * to type into one, and what the caller is told back.
 *
 * The rest of the vault (`shared/vault.ts`, `shared/secrets.ts`) is about
 * secrets that already live somewhere — a project's env file, an ssh key, a
 * key pasted into Settings — and lending them. These are the ones kururu is
 * handed for safekeeping, so the owner can paste a key once into a dialog
 * instead of into a chat, where a transcript would keep it. The value goes
 * from the field to the store (the Keychain on a Mac) and, when asked, into
 * one variable of an env file; Kuru or the agent that asked hears a word per
 * field and nothing else. See `docs/plans/vault-secrets.md` for the threat
 * model, which is the reason for every refusal here.
 *
 * Pure, so the shapes a caller may send are checked in one place and tested
 * without a server, a Keychain or a window.
 */

/**
 * An item's name: lower-case words in up to four parts, such as
 * `pylink/bancard-staging-private`. It is the Keychain item's account, the
 * name a command asks for, and what the page lists, so it is kept to what is
 * safe in all three — no spaces, no quotes, nothing a shell would read.
 */
export const ITEM_NAME = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*){0,3}$/;
export const ITEM_NAME_MAX = 64;

export function validItemName(name: unknown): name is string {
  return typeof name === "string" && name.length <= ITEM_NAME_MAX && ITEM_NAME.test(name) && !name.includes("..");
}

/** An environment variable's name, as a shell and every dotenv reader take it. */
export const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Whether using an item is free, or waits for the owner to press Allow each
 * time. See `docs/plans/vault-secrets.md#approval`.
 */
export type UseRule = "free" | "ask";

/**
 * The rule a new item starts with: ask, for anything whose name or label
 * says it is a sudo password or production's. A guess from words, and only
 * a default — the owner sees it as a switch in the dialog that saves the
 * item, and the guess errs toward asking.
 */
export function defaultUse(name: string, label: string): UseRule {
  return /(^|[^a-z])(sudo|prod|production|live)([^a-z]|$)/i.test(`${name} ${label}`) ? "ask" : "free";
}

/** At most this many fields in one dialog: a dialog that scrolls is one a field gets missed in. */
export const MAX_FIELDS = 8;
/** A value's longest. A PEM key is a few KB; anything near this is not a key. */
export const VALUE_MAX = 64 * 1024;
/** How long an ask waits for the owner before it closes as timed out, when its caller does not say. */
export const ASK_MS = 15 * 60_000;
/**
 * The longest a caller may ask it to stay up: an afternoon away from the
 * Mac, which is what the first real use needed (the owner, 2026-11-10: "up
 * to a few hours, so a caller doesn't have to loop reopening the dialog").
 * Longer than that and a key is waiting on somebody who has forgotten it.
 */
export const ASK_MAX_MS = 6 * 3_600_000;
export const ASK_MIN_MS = 60_000;

/** "15 minutes", "3 hours", "1 hour 30 minutes": a stay as a sentence says it. */
export function durationWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const part = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  if (!h) return part(Math.max(1, m), "minute");
  return m ? `${part(h, "hour")} ${part(m, "minute")}` : part(h, "hour");
}
/** The words a caller may write, clipped where the dialog would. */
export const TITLE_MAX = 120;
export const REASON_MAX = 600;
export const LABEL_MAX = 80;

/** Where a field's value goes besides its Keychain item: one variable in an env file under the home folder. */
export interface EnvTarget {
  /** As the caller wrote it, `~/…` or absolute. The server resolves and checks it. */
  file: string;
  variable: string;
}

/** One field as a caller asks for it. */
export interface FieldAsk {
  label: string;
  name: string;
  env: EnvTarget | null;
  /** The rule the caller asks for. Only `ask` is the caller's to set; a caller cannot make an item free. */
  use: UseRule | null;
}

export interface AskRequest {
  title: string;
  reason: string;
  fields: FieldAsk[];
  /** How long the dialog stays up for the owner, in milliseconds: `ASK_MS` unless the caller said. */
  openFor: number;
}

function words(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const one = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return one ? one.slice(0, max) : null;
}

/**
 * A caller's ask read off the wire — Kuru's tool arguments, the CLI's body —
 * into its shape, or why it is not one. Everything the dialog will show and
 * everything the server will write to is checked here, so a bad path or a
 * name that cannot be an item is the caller's error, said to the caller,
 * and never a dialog the owner has to puzzle over. The path is only checked
 * for shape: whether it is a place kururu may write is the server's to say
 * (`vaultfile.ts`), on the disk.
 */
export function adoptAskRequest(raw: unknown): AskRequest | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "An ask is an object with a title, a reason and fields." };
  const r = raw as Record<string, unknown>;
  const title = words(r.title, TITLE_MAX);
  if (!title) return { error: "A title is needed: what the owner is being asked for, such as \"Bancard staging keys for Pylink\"." };
  const reason = words(r.reason, REASON_MAX) ?? "";
  if (!Array.isArray(r.fields) || r.fields.length === 0) return { error: "At least one field is needed." };
  if (r.fields.length > MAX_FIELDS) return { error: `At most ${MAX_FIELDS} fields in one ask.` };
  const fields: FieldAsk[] = [];
  const names = new Set<string>();
  for (const [i, f] of r.fields.entries()) {
    const at = `Field ${i + 1}`;
    if (!f || typeof f !== "object") return { error: `${at} is not an object.` };
    const field = f as Record<string, unknown>;
    const label = words(field.label, LABEL_MAX);
    if (!label) return { error: `${at} needs a label, such as "Private key".` };
    if (!validItemName(field.name)) {
      return { error: `${at}'s name must be lower-case words in up to four /-separated parts, at most ${ITEM_NAME_MAX} characters, such as pylink/bancard-staging-private.` };
    }
    if (names.has(field.name)) return { error: `${at} names ${field.name} again.` };
    names.add(field.name);
    let env: EnvTarget | null = null;
    if (field.env !== undefined && field.env !== null) {
      const e = field.env as Record<string, unknown>;
      if (typeof e !== "object" || typeof e.file !== "string" || typeof e.variable !== "string") {
        return { error: `${at}'s env is { "file": "~/…", "variable": "NAME" }.` };
      }
      const file = e.file.trim();
      if (!file || file.length > 512 || /[\u0000-\u001f]/.test(file) || !(file.startsWith("~/") || file.startsWith("/"))) {
        return { error: `${at}'s env file must be a path under the home folder, ~/… or absolute.` };
      }
      if (!VARIABLE.test(e.variable)) return { error: `${at}'s variable must be letters, digits and _, not starting with a digit.` };
      env = { file, variable: e.variable };
    }
    let use: UseRule | null = null;
    if (field.use !== undefined && field.use !== null) {
      if (field.use !== "ask" && field.use !== "free") return { error: `${at}'s use is "ask" or "free".` };
      use = field.use;
    }
    fields.push({ label, name: field.name, env, use });
  }
  // A number off the wire: checked, never clamped, so a caller that asked
  // for a day hears that it cannot have one instead of getting six hours
  // it did not ask for.
  let openFor = ASK_MS;
  if (r.openForMs !== undefined && r.openForMs !== null) {
    if (typeof r.openForMs !== "number" || !Number.isFinite(r.openForMs) || r.openForMs < ASK_MIN_MS || r.openForMs > ASK_MAX_MS) {
      return { error: `The dialog can stay up between 1 minute and ${durationWords(ASK_MAX_MS)}.` };
    }
    openFor = Math.round(r.openForMs);
  }
  return { title, reason, fields, openFor };
}

/** One field as the dialog draws it. Never a value: there is none to draw. */
export interface AskFieldView {
  /** Its place in the ask, as a string: what the answer's values are keyed by. */
  id: string;
  label: string;
  name: string;
  /** The env file as the owner will read it, `~/…`, and the variable. */
  env: EnvTarget | null;
  /** The rule the switch starts at: the item's own if it exists, else the caller's `ask` or the default. */
  use: UseRule;
  /** An item by this name is kept already, and a value saved here replaces it. */
  exists: boolean;
}

/**
 * What every page connected to the server is sent while an ask is open. A
 * `values` ask is the dialog with fields; a `use` ask is a command waiting
 * for the owner to allow an item it would run with (`docs/plans/vault-secrets.md#approval`).
 */
export type VaultAsk =
  | {
      kind: "values";
      id: string;
      title: string;
      reason: string;
      /** Who asked, as the owner knows them: "Kuru", or an agent by its name. */
      from: string;
      fields: AskFieldView[];
      /** When it closes by itself, epoch ms. */
      until: number;
    }
  | {
      kind: "use";
      id: string;
      from: string;
      /** The items, by label and name. */
      items: { name: string; label: string }[];
      /** The command as the caller gave it, clipped. */
      command: string;
      /** Where it runs, `~/…`. */
      cwd: string;
      /** Whether "for 15 minutes" is offered: only to a caller that is an agent kururu knows. */
      lasting: boolean;
      until: number;
    };

/**
 * What became of one field, and for anything but a save, why — never with
 * the value in it. `cancelled` is somebody's doing (the owner's Cancel, the
 * caller hanging up), `timeout` is nobody's: the dialog stayed up its whole
 * time unanswered, which tells a caller that asking again later is fair.
 */
export type FieldOutcome =
  | { field: string; name: string; outcome: "saved" | "skipped" }
  | { field: string; name: string; outcome: "cancelled" | "timeout" | "failed"; why: string };

/** The owner's answer to a `use` ask. */
export type UseAnswer = "once" | "lasting" | "deny";

/** The outcomes, a line each, as a caller is told them. */
export function outcomeLines(outcomes: readonly FieldOutcome[], labels: ReadonlyMap<string, string>): string {
  return outcomes
    .map((o) => {
      const label = labels.get(o.field) ?? o.name;
      return "why" in o ? `${label} (${o.name}): ${o.outcome} — ${o.why}` : `${label} (${o.name}): ${o.outcome}`;
    })
    .join("\n");
}

/** An item as Settings and `list_secrets` show it: never a value. */
export interface VaultItemView {
  name: string;
  label: string;
  use: UseRule;
  /** Where the value lives: the login Keychain, or a 0600 file on a node with none. */
  store: "keychain" | "file";
  /** The env files it was last written to, by the dialog. Kururu does not keep them in step. */
  env: EnvTarget[];
  createdAt: number;
  updatedAt: number;
  /** Who asked for it to be saved, last. */
  by: string;
  lastUse: { at: number; by: string } | null;
}

/** An item's line in `list_secrets` and `vault list`. */
export function itemLine(item: VaultItemView): string {
  const env = item.env.map((e) => `${e.variable} in ${e.file}`).join(", ");
  const used = item.lastUse ? `, last used ${new Date(item.lastUse.at).toISOString().slice(0, 16).replace("T", " ")} by ${item.lastUse.by}` : "";
  return `${item.name} — ${item.label} (${item.use === "ask" ? "asks before each use" : "free to use"}${env ? `; also written to ${env}` : ""}${used})`;
}

/** The answer's values, read off the wire: field id to text, at most `MAX_FIELDS`, each a string of at most `VALUE_MAX`. */
export function adoptValues(raw: unknown): Map<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (out.size >= MAX_FIELDS) break;
    if (!/^[0-9]$/.test(k) || typeof v !== "string" || v.length > VALUE_MAX) continue;
    out.set(k, v);
  }
  return out;
}

/** The rules the owner set in the dialog, read off the wire the same way. */
export function adoptUses(raw: unknown): Map<string, UseRule> {
  const out = new Map<string, UseRule>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (/^[0-9]$/.test(k) && (v === "free" || v === "ask")) out.set(k, v);
  }
  return out;
}

/**
 * One use of the vault's items by a command, as the log keeps it
 * (`vault-uses.jsonl`): who, which items, the command as the caller wrote it,
 * where, who allowed it, and how it ended. Never a value — but the command
 * is the caller's text, so the page shows it and can clear it.
 */
export interface VaultUse {
  at: number;
  /** "Kuru", an agent by its name, or "a shell". */
  by: string;
  agentId: string | null;
  names: string[];
  command: string;
  cwd: string;
  /** "free", or "owner" when somebody pressed Allow, or "lasting" inside a fifteen-minute allowance; "denied" when they pressed Deny. */
  approved: "free" | "owner" | "lasting" | "denied";
  /** The command's exit code, or null when it never ran or was ended. */
  code: number | null;
  ms: number;
}

/** Settings → Vault's own sections: what is kept, and what was used. */
export interface VaultPage {
  store: "keychain" | "file";
  items: VaultItemView[];
  uses: VaultUse[];
}
