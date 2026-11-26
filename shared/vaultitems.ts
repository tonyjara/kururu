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
/**
 * A file's longest. A .p12 or a .pfx is a few KB, an Apple .p8 a few hundred
 * bytes, a service account's JSON two or three; a megabyte is room for a
 * certificate chain with every intermediate in it, and past that it is not a
 * credential. The Keychain keeps it in pieces of 1800 characters
 * (`keychain.ts`), so this is also what bounds the pieces.
 */
export const FILE_MAX = 1024 * 1024;
/** A file's base64, as the Keychain and `--secret` hold it, at its longest. */
export const FILE_B64_MAX = Math.ceil(FILE_MAX / 3) * 4;
/** A file's name as the owner's disk had it, kept to show and to name the temporary copy a command is handed. */
export const FILE_NAME_MAX = 128;
/** An extension a file field may say it wants: `.pfx`. */
const EXTENSION = /^\.[a-z0-9]{1,10}$/;
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
/**
 * The words a caller may write. A title and a label are one line each and are
 * clipped where the dialog would; the reason is not clipped but refused when
 * it is longer, because it is often a walkthrough (where in a console to find
 * the key, which button, what to copy), and a walkthrough cut at step three is
 * worse than no walkthrough: it was 600 and clipped until HOL-145's APNs ask
 * stopped mid-word on 2026-11-18. The dialog scrolls the reason inside itself,
 * so the length is for the vault's own file, not for the screen.
 */
export const TITLE_MAX = 120;
export const REASON_MAX = 8000;
export const LABEL_MAX = 80;

/** Where a field's value goes besides its Keychain item: one variable in an env file under the home folder. */
export interface EnvTarget {
  /** As the caller wrote it, `~/…` or absolute. The server resolves and checks it. */
  file: string;
  variable: string;
}

/**
 * What a field takes: text pasted into a masked input, or a file picked or
 * dropped — a certificate, a `.p8`, a service account's JSON — whose bytes
 * are kept as they are, so nobody has to base64 one in a terminal and paste
 * the result (the owner, 2026-11-18, looking at a dialog that asked for
 * SIFEN's .p12 that way).
 */
export type FieldKind = "text" | "file";

/** One field as a caller asks for it. */
export interface FieldAsk {
  label: string;
  name: string;
  kind: FieldKind;
  /** For a file: the extensions it takes, lower-case with the dot, or null for any. */
  accept: string[] | null;
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
 * The reason as its lines: unlike `words`, a newline stays one, since a
 * numbered list of steps is what a reason often is and the dialog draws it as
 * Markdown. Other control characters go, trailing spaces go, and a run of
 * blank lines is one.
 */
function prose(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .replace(/[ \u00a0]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  const reason = prose(r.reason);
  if (reason.length > REASON_MAX) return { error: `The reason is ${reason.length} characters; at most ${REASON_MAX}. Say the rest in a file and name it.` };
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
    const kind = field.kind === undefined || field.kind === null ? "text" : field.kind;
    if (kind !== "text" && kind !== "file") return { error: `${at}'s kind is "text" or "file".` };
    let accept: string[] | null = null;
    if (field.accept !== undefined && field.accept !== null) {
      if (kind !== "file") return { error: `${at} takes text; accept is for a file field.` };
      const list = typeof field.accept === "string" ? field.accept.split(",") : Array.isArray(field.accept) ? field.accept : null;
      const exts = list?.map((e) => (typeof e === "string" ? e.trim().toLowerCase() : "")).filter(Boolean).map((e) => (e.startsWith(".") ? e : `.${e}`));
      if (!exts || !exts.length || exts.length > 12 || !exts.every((e) => EXTENSION.test(e))) {
        return { error: `${at}'s accept is a list of extensions, such as .pfx,.p12.` };
      }
      accept = [...new Set(exts)];
    }
    fields.push({ label, name: field.name, kind, accept, env, use });
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
  /** A masked input, or a file to pick or drop. Absent from an ask a server before files kept open: text. */
  kind?: FieldKind;
  /** For a file, the extensions it takes, or null for any. */
  accept?: string[] | null;
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
      /**
       * A `vault capture` that would put a new value over items already
       * kept: asked before the command runs, since the command may make a
       * key that can be shown only once. Answered Allow once or Deny.
       */
      replace?: boolean;
    };

/**
 * A `vault capture` that kept something: who, when, the command (clipped and
 * masked, as the use log has it), where it ran, and the items it kept, with
 * the labels they had then. Written down and shown nowhere but Settings →
 * Vault: the owner, 2026-11-23, on the notice each one used to put up — "it's
 * ok to keep track of those, but I don't see the point of me dismissing those
 * all the time". A capture asks nothing of anybody, so it does not interrupt;
 * replacing an item is still asked first, as a `use` ask with `replace`.
 */
export interface CaptureEvent {
  at: number;
  /** "Kuru", an agent by its card's code or its title, with its id, or "a shell". */
  by: string;
  command: string;
  cwd: string;
  items: { name: string; label: string }[];
}

/** How many of those `vault.json` keeps, newest first. */
export const CAPTURES_KEPT = 200;

/** Captures read off `vault.json`, or the use log they are first made from: anything malformed is dropped. */
export function adoptCaptures(raw: unknown): CaptureEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: CaptureEvent[] = [];
  for (const e of raw) {
    const v = e as Partial<CaptureEvent> | null;
    if (!v || typeof v.at !== "number" || !Number.isFinite(v.at) || typeof v.by !== "string" || !Array.isArray(v.items)) continue;
    const items = v.items.filter((i): i is { name: string; label: string } => Boolean(i) && typeof i.name === "string").map((i) => ({ name: i.name, label: typeof i.label === "string" ? i.label : i.name }));
    if (!items.length) continue;
    out.push({ at: v.at, by: v.by, command: typeof v.command === "string" ? v.command : "", cwd: typeof v.cwd === "string" ? v.cwd : "", items });
    if (out.length >= CAPTURES_KEPT) break;
  }
  return out;
}

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

/** A file item's file, as the owner's disk named it: never its bytes. */
export interface FileFacts {
  name: string;
  size: number;
}

/**
 * An item's history, newest first: how its value came to be kept — pasted
 * into the dialog, captured from a command's output (`vault capture`, with
 * the command as written, masked), or made a file by `vault convert` — and
 * when its rule was switched, `free` or `ask`, by the owner in Settings or
 * with "Don't ask again" in the use dialog. `by` says which.
 */
export interface ItemEvent {
  at: number;
  by: string;
  how: "pasted" | "captured" | "converted" | UseRule;
  command?: string;
}

/** Every `how` an event may have, for reading the file back. */
export const EVENT_HOWS: readonly ItemEvent["how"][] = ["pasted", "captured", "converted", "free", "ask"];

/** The latest event that put a value in the item, skipping rule switches: what "captured … from" is drawn off. */
export function lastKept(history: readonly ItemEvent[] | undefined): ItemEvent | null {
  return history?.find((e) => e.how === "pasted" || e.how === "captured" || e.how === "converted") ?? null;
}

/** The latest switch of the item's rule, or null when it has kept the one it started with. */
export function lastSwitch(history: readonly ItemEvent[] | undefined): ItemEvent | null {
  return history?.find((e) => e.how === "free" || e.how === "ask") ?? null;
}

/** How many of those an item keeps. */
export const HISTORY_KEPT = 10;

/** An item as Settings and `list_secrets` show it: never a value. */
export interface VaultItemView {
  name: string;
  label: string;
  use: UseRule;
  /** A file's name and size when the item is a file, kept as its base64; null for text. */
  file: FileFacts | null;
  /** Where the value lives: the login Keychain, or a 0600 file on a node with none. */
  store: "keychain" | "file";
  /** The env files it was last written to, by the dialog. Kururu does not keep them in step. */
  env: EnvTarget[];
  createdAt: number;
  updatedAt: number;
  /** Who asked for it to be saved, last. */
  by: string;
  lastUse: { at: number; by: string } | null;
  /** How its value came to be kept, newest first. Absent for an item kept before 2026-11-20. */
  history?: ItemEvent[];
}

/**
 * "3.2 KB": a size as the dialog and `vault list` say it. Megabytes to two
 * places, so a file just over the limit does not read as the limit itself
 * ("1.05 MB; up to 1 MB", not "1.0 MB; up to 1.0 MB").
 */
export function sizeWords(bytes: number): string {
  const trim = (n: number, places: number) => String(Number(n.toFixed(places)));
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${trim(bytes / 1024, bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${trim(bytes / (1024 * 1024), 2)} MB`;
}

/** "file (certificate.pfx, 3.2 KB)", or "text". */
export function kindWords(file: FileFacts | null): string {
  return file ? `file (${file.name}, ${sizeWords(file.size)})` : "text";
}

/** An item's line in `list_secrets` and `vault list`. */
export function itemLine(item: VaultItemView): string {
  const env = item.env.map((e) => `${e.variable} in ${e.file}`).join(", ");
  const used = item.lastUse ? `, last used ${new Date(item.lastUse.at).toISOString().slice(0, 16).replace("T", " ")} by ${item.lastUse.by}` : "";
  const file = item.file ? `${kindWords(item.file)}; ` : "";
  const last = lastKept(item.history);
  const captured = last?.how === "captured" ? `, captured ${new Date(last.at).toISOString().slice(0, 16).replace("T", " ")} by ${last.by}` : "";
  return `${item.name} — ${item.label} (${file}${item.use === "ask" ? "asks before each use" : "free to use"}${env ? `; also written to ${env}` : ""}${captured}${used})`;
}

/**
 * A file's name as it may be kept: the last part of whatever the browser
 * sent, with no control characters, no leading dots, and nothing a shell or
 * a path would read as more than a name. Null when nothing is left.
 */
export function cleanFileName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const last = raw.split(/[\\/]/).pop() ?? "";
  const clean = last
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .replace(/[^A-Za-z0-9 ._()+@,-]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, FILE_NAME_MAX);
  return clean || null;
}

/** Whether a file's name ends in one of the extensions a field takes. */
export function acceptsName(accept: readonly string[] | null | undefined, name: string): boolean {
  if (!accept || !accept.length) return true;
  const lower = name.toLowerCase();
  return accept.some((e) => lower.endsWith(e));
}

/** The canonical base64 of some bytes, or null when `text` is not base64: whitespace and line breaks taken out, then decoded and encoded again, so only what round-trips is kept. */
export function canonicalBase64(text: string): string | null {
  const bare = text.replace(/\s+/g, "");
  if (!bare || bare.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(bare)) return null;
  return bare;
}

/** How many bytes a canonical base64 string decodes to. */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/** A value in an answer: text from a masked input, or a file as its name and its bytes' base64. */
export type AnswerValue = { kind: "text"; text: string } | { kind: "file"; name: string; base64: string; size: number };

/** What a page sends for one field: the text, or `{ name, base64 }` for a file. */
export type WireValue = string | { name: string; base64: string };

/**
 * The answer's values, read off the wire: field id to text or file, at most
 * `MAX_FIELDS`. A text at most `VALUE_MAX`; a file's name cleaned, its
 * base64 checked to be base64 and at most `FILE_MAX` once decoded. Null when
 * something was sent that cannot be read, which the server refuses rather
 * than reading as a skip: a Save that quietly dropped a certificate would be
 * a dialog that said it was saved.
 */
export function adoptValues(raw: unknown): Map<string, AnswerValue> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = new Map<string, AnswerValue>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (out.size >= MAX_FIELDS) break;
    if (!/^[0-9]$/.test(k)) continue;
    if (typeof v === "string") {
      if (v.length > VALUE_MAX) return null;
      out.set(k, { kind: "text", text: v });
      continue;
    }
    if (!v || typeof v !== "object") return null;
    const f = v as Record<string, unknown>;
    const name = cleanFileName(f.name);
    if (!name || typeof f.base64 !== "string" || f.base64.length > FILE_B64_MAX + 8) return null;
    const base64 = canonicalBase64(f.base64);
    if (base64 === null) return null;
    const size = base64Bytes(base64);
    if (size > FILE_MAX) return null;
    out.set(k, { kind: "file", name, base64, size });
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
  /** A `vault capture`: the items are what its output was kept as, not what it was given. Absent for a run. */
  kind?: "capture";
}

/** Settings → Vault's own sections: what is kept, and what was used. */
export interface VaultPage {
  store: "keychain" | "file";
  items: VaultItemView[];
  /** Every `vault capture` that kept something, newest first: the vault's history of what it was handed by a command. */
  captures: CaptureEvent[];
  uses: VaultUse[];
}
