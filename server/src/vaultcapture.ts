/**
 * `vault capture`: a secret a command makes, kept without anybody seeing it.
 *
 * Some keys are not pasted by the owner but printed by a program —
 * `aws iam create-access-key` prints a secret access key once, and only
 * once — and an agent that runs one in its own shell has the key on its
 * screen, in its transcript, and in the model that reads it. Piping it into
 * a `vault put` would still leave it in a pipeline the agent wrote, one
 * `tee` or one typo from the screen, and in a CLI process that would then
 * hold a value, which no vault CLI does. So the server runs the command, as
 * it does for `vault run`: its stdout is read here and never sent anywhere,
 * the named fields are kept as vault items, and the caller hears which
 * items were kept, the fields it asked to see that are not secret (an access
 * key's *id*), and the command's stderr with everything its stdout said
 * masked out of it (the owner, 2026-11-20, for Kaipago's SES keys: "the
 * agent pipes it straight into the vault without it ever being shown").
 *
 * The order is the point of most of this:
 *
 * - **Replacing is asked first.** An item already kept is replaced only once
 *   the owner allows it, and that is asked *before* the command runs: a
 *   command that makes a key cannot be undone by refusing to keep its output.
 * - **stdout is the value and is never shown**, not even masked: it is read
 *   whole (up to a megabyte) and dropped. stderr is held until the end and
 *   masked with every value stdout held — the whole of it, each line, each
 *   string in its JSON — since the values are not known until stdout is,
 *   and an error that quotes the request is the usual way a key leaks.
 * - **Nothing is lost when a field is missing.** A command that succeeded
 *   has made its key, so when a `--json-path` is not in its output the whole
 *   output is kept as the bare item instead, when that name is free, and the
 *   caller is told so, and the paths that were there.
 *
 * Every capture is a line in the use log (`kind: "capture"`), a line in each
 * item's history, and a notice on the owner's pages (`Vault.capture`).
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { maskText, type Secret } from "../../shared/mask";
import { validItemName, VALUE_MAX, type UseRule, type VaultUse } from "../../shared/vaultitems";
import { tildePath } from "./vaultfile";
import { commandText, type Approval, type RunEvent } from "./vaultrun";
import type { CapturedValue } from "./vaultstore";

/** The most a command may print on stdout: past this it is not a key, and it is ended. */
export const CAPTURE_OUT_MAX = 1024 * 1024;
/** The most of its stderr kept to show: the start, where an error says what went wrong. */
const ERR_KEPT = 64 * 1024;
/** At most this many items from one command. */
const TARGETS_MAX = 8;
/** After SIGTERM, how long a command has before SIGKILL. */
const KILL_AFTER_MS = 3000;
/** A `--print` path that reads as a secret is refused: printing is for an id, a region, an ARN. */
const SECRET_WORDS = /secret|password|passwd|token|private|credential|signing/i;

/** One field of the output to keep: a JSON path, or null for the whole of stdout. */
export interface CaptureTarget {
  path: string | null;
  name: string;
}

export interface CaptureRequest {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** The bare item: the whole output's when there are no paths, and where it is kept if a path is missing. */
  item: string;
  targets: CaptureTarget[];
  /** JSON paths whose values the caller is shown: what is not secret. */
  print: string[];
  label: string | null;
  use: UseRule | null;
}

/** A JSON path as its steps: `AccessKey.SecretAccessKey`, `Items[0].Key`. Null when it is not one. */
export function parsePath(path: string): (string | number)[] | null {
  if (!path || path.length > 200) return null;
  const steps: (string | number)[] = [];
  for (const part of path.split(".")) {
    const m = /^([A-Za-z0-9_$@-]*)((?:\[\d{1,6}\])*)$/.exec(part);
    if (!m || (!m[1] && !m[2])) return null;
    if (m[1]) steps.push(m[1]);
    for (const index of m[2]!.matchAll(/\[(\d+)\]/g)) steps.push(Number(index[1]));
  }
  return steps;
}

/** What a path leads to in a parsed document, or undefined. */
export function pick(doc: unknown, steps: readonly (string | number)[]): unknown {
  let at: unknown = doc;
  for (const step of steps) {
    if (typeof step === "number") {
      if (!Array.isArray(at)) return undefined;
      at = at[step];
    } else {
      if (!at || typeof at !== "object" || Array.isArray(at) || !Object.prototype.hasOwnProperty.call(at, step)) return undefined;
      at = (at as Record<string, unknown>)[step];
    }
  }
  return at;
}

/** A value as it is kept: a string as it is, a number or a boolean as it prints, an object as its JSON. Null for nothing. */
export function leafText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** A caller's capture read off the wire, or why it is not one. */
export function adoptCaptureRequest(raw: unknown): CaptureRequest | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "a capture is an object" };
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.argv) || r.argv.length === 0 || r.argv.length > 512 || !r.argv.every((a) => typeof a === "string")) {
    return { error: "give the command after --, such as: vault capture kaipago/ses --json-path AccessKey.SecretAccessKey=secret -- aws iam create-access-key --user-name kaipago-ses" };
  }
  if (typeof r.cwd !== "string" || !isAbsolute(r.cwd)) return { error: "the folder must be an absolute path" };
  if (!validItemName(r.item)) return { error: "ITEM is lower-case words in up to four /-separated parts, project first: kaipago/ses" };
  const item = r.item;
  const env: Record<string, string> = {};
  if (r.env && typeof r.env === "object") {
    for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
      if (typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = v;
    }
  }
  const targets: CaptureTarget[] = [];
  const paths = Array.isArray(r.paths) ? r.paths : [];
  for (const p of paths) {
    const e = p as Record<string, unknown>;
    if (!p || typeof p !== "object" || typeof e.path !== "string" || !parsePath(e.path)) {
      return { error: "each --json-path is PATH or PATH=PART: a field such as AccessKey.SecretAccessKey, or Items[0].Key, and the part of the item's name it is kept under" };
    }
    const part = e.part === undefined || e.part === null || e.part === "" ? null : e.part;
    if (part !== null && (typeof part !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(part))) return { error: `--json-path ${e.path}=… names a part: lower-case letters, digits and . _ -, such as secret` };
    const name = part === null ? item : `${item}/${part}`;
    if (!validItemName(name)) return { error: `${name} cannot be an item: at most four /-separated parts and 64 characters` };
    targets.push({ path: e.path, name });
  }
  if (!targets.length) targets.push({ path: null, name: item });
  if (targets.length > TARGETS_MAX) return { error: `at most ${TARGETS_MAX} --json-path in one capture` };
  const names = targets.map((t) => t.name);
  if (new Set(names).size !== names.length) return { error: "each --json-path needs an item of its own: give each a different =PART" };
  const print: string[] = [];
  for (const p of Array.isArray(r.print) ? r.print : []) {
    if (typeof p !== "string" || !parsePath(p)) return { error: "--print is a JSON path, such as AccessKey.AccessKeyId" };
    if (SECRET_WORDS.test(p)) return { error: `--print ${p} reads as a secret, and --print shows what it names: it is for what is not secret, such as an access key's id. Keep it with --json-path instead` };
    print.push(p);
  }
  if (print.length && targets.every((t) => t.path === null)) return { error: "--print reads a JSON field, so it needs the output read as JSON: name what to keep with --json-path" };
  let label: string | null = null;
  if (r.label !== undefined && r.label !== null) {
    if (typeof r.label !== "string") return { error: "--label is words" };
    label = r.label.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || null;
  }
  let use: UseRule | null = null;
  if (r.use !== undefined && r.use !== null) {
    if (r.use !== "ask") return { error: "--use is ask: an item that asks the owner before each use. Only the owner can make one free" };
    use = "ask";
  }
  return { argv: r.argv as string[], cwd: r.cwd, env, item, targets, print, label, use };
}

/**
 * Everything stdout said that could be a value, as masks for stderr and the
 * command line: the whole of it, each line, and each string in its JSON.
 * More than the values kept, on purpose — a mask too many costs a word in an
 * error message, a mask too few costs a key.
 */
export function outputSecrets(name: string, stdout: string, doc: unknown): Secret[] {
  const found = new Set<string>();
  const whole = stdout.trim();
  if (whole) found.add(whole);
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length >= 8) found.add(t);
  }
  let budget = 4000;
  const walk = (v: unknown) => {
    if (budget-- <= 0) return;
    if (typeof v === "string") {
      if (v) found.add(v);
    } else if (typeof v === "number" && String(v).length >= 6) found.add(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(doc);
  return [...found].map((value) => ({ name, value }));
}

export interface CaptureDeps {
  /** Whether an item by this name is kept. */
  has: (name: string) => boolean;
  /** An item's label, for the dialog that asks to replace it. */
  labelOf: (name: string) => string | null;
  /** The owner's answer to replacing items already kept (`Vault.confirmReplace`). */
  confirmReplace: (run: { by: string; agentId: string | null; items: { name: string; label: string }[]; command: string; cwd: string }, note: (line: string) => void, signal: AbortSignal) => Promise<Approval>;
  /** Keep the values (`Vault.capture`). */
  keep: (values: readonly CapturedValue[], source: { by: string; command: string; cwd: string }, replace: ReadonlySet<string>) => Promise<{ name: string; outcome: "saved" | "failed"; why?: string }[]>;
  /** A line in the use log (`VaultRuns.record`). */
  record: (use: VaultUse) => void;
  now?: () => number;
}

/** "the AccessKey.SecretAccessKey field", or "what it printed". */
const fromWords = (t: CaptureTarget) => (t.path === null ? "what it printed" : t.path);

/**
 * Run one command and keep what it prints. Never throws: everything is an
 * event, so the caller always hears an `exit` — 0 when every item was kept,
 * the command's own code when it failed, 1 when it succeeded but not all of
 * its output could be kept, 2 when nothing could start, 77 when the owner
 * would not have an item replaced.
 */
export async function runCapture(req: CaptureRequest, caller: { name: string; agentId: string | null }, emit: (ev: RunEvent) => void, signal: AbortSignal, deps: CaptureDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const started = now();
  const command = commandText(req.argv);
  const cwd = tildePath(req.cwd, homedir());
  const names = req.targets.map((t) => t.name);
  const record = (approved: Approval, code: number | null, kept: readonly string[], masks: readonly Secret[]) =>
    deps.record({ at: started, by: caller.name, agentId: caller.agentId, names: kept.length ? [...kept] : names, command: maskText(command, masks), cwd, approved, code, ms: now() - started, kind: "capture" });

  const existing = req.targets.filter((t) => deps.has(t.name));
  let approved: Approval = "free";
  if (existing.length) {
    approved = await deps.confirmReplace(
      { by: caller.name, agentId: caller.agentId, items: existing.map((t) => ({ name: t.name, label: deps.labelOf(t.name) ?? t.name })), command, cwd },
      (line) => emit({ note: line }),
      signal,
    );
    if (approved === "denied" || signal.aborted) {
      record("denied", null, [], []);
      if (!signal.aborted) {
        emit({ note: "not replaced: the owner said no, or did not answer in time. Nothing ran." });
        emit({ exit: 77 });
      }
      return;
    }
  }
  const replace = new Set(existing.map((t) => t.name));

  const env: Record<string, string> = { ...req.env };
  delete env.KURURU_VAULT_TICKET;
  delete env.SUDO_ASKPASS;
  const out: Buffer[] = [];
  let outBytes = 0;
  let tooMuch = false;
  const err: Buffer[] = [];
  let errBytes = 0;
  let errCut = false;
  let code: number | null = null;
  let ended: string | undefined;
  let startFailed: string | null = null;
  await new Promise<void>((resolve) => {
    let child;
    try {
      child = spawn(req.argv[0]!, req.argv.slice(1), { cwd: req.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      startFailed = (e as Error).message;
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
    child.stdout.on("data", (c: Buffer) => {
      if (tooMuch) return;
      outBytes += c.length;
      if (outBytes > CAPTURE_OUT_MAX) {
        tooMuch = true;
        out.length = 0;
        kill();
        return;
      }
      out.push(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      if (errBytes >= ERR_KEPT) {
        errCut = true;
        return;
      }
      const room = ERR_KEPT - errBytes;
      err.push(c.subarray(0, room));
      errBytes += Math.min(room, c.length);
      if (c.length > room) errCut = true;
    });
    let failed = false;
    child.on("error", (e) => {
      failed = true;
      startFailed = (e as NodeJS.ErrnoException).code === "ENOENT" ? "not found on the PATH" : e.message;
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

  if (startFailed !== null) {
    record(approved, 127, [], []);
    emit({ note: `could not start ${req.argv[0]}: ${startFailed}. Nothing was kept.` });
    emit({ exit: 127 });
    return;
  }

  const stdout = Buffer.concat(out).toString("utf8");
  out.length = 0;
  let doc: unknown = undefined;
  const wantsJson = req.targets.some((t) => t.path !== null);
  if (wantsJson) {
    try {
      doc = JSON.parse(stdout);
    } catch {
      doc = undefined;
    }
  }
  const masks = outputSecrets(req.item, stdout, doc);
  const errText = maskText(Buffer.concat(err).toString("utf8"), masks);
  if (errText) emit({ e: Buffer.from(errCut ? `${errText}\n[vault: the rest of its stderr was not kept]\n` : errText).toString("base64") });
  const finish = (exit: number, kept: readonly string[]) => {
    record(approved, code, kept, masks);
    emit({ exit });
  };

  if (signal.aborted) return finish(130, []);
  if (tooMuch) {
    emit({ note: `${req.argv[0]} printed more than ${CAPTURE_OUT_MAX / (1024 * 1024)} MB on stdout, which is no key: it was ended and nothing was kept.` });
    return finish(1, []);
  }
  if (code !== 0) {
    emit({ note: `${req.argv[0]} ${ended ? `was ended by ${ended}` : `exited ${code}`}; nothing was kept. Its stderr is above, with anything it printed on stdout masked.` });
    return finish(typeof code === "number" && code !== 0 ? code : 1, []);
  }

  // What to keep, all or nothing: one field missing keeps none of them, and
  // the whole output is kept instead, so a key made once is not lost.
  const values: CapturedValue[] = [];
  const missing: string[] = [];
  const baseLabel = req.label ?? `From ${req.argv[0]!.split("/").pop()}`;
  for (const t of req.targets) {
    const value = t.path === null ? leafText(stdout.trim()) : wantsJson && doc !== undefined ? leafText(pick(doc, parsePath(t.path)!)) : null;
    if (value === null) {
      missing.push(t.path ?? "stdout");
      continue;
    }
    if (value.length > VALUE_MAX) {
      emit({ note: `${fromWords(t)} is ${value.length} characters; a vault item is at most ${VALUE_MAX}. Nothing was kept.` });
      return finish(1, []);
    }
    values.push({ name: t.name, label: req.targets.length > 1 || t.path !== null ? `${baseLabel} · ${t.path ?? "output"}` : baseLabel, value, use: req.use });
  }

  if (missing.length) {
    const whyNot = !wantsJson ? `${req.argv[0]} printed nothing on stdout` : doc === undefined ? `what ${req.argv[0]} printed is not JSON` : `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not in what ${req.argv[0]} printed${keysWords(doc, missing[0]!)}`;
    const whole = stdout.trim();
    if (wantsJson && whole && whole.length <= VALUE_MAX && !deps.has(req.item) && !names.includes(req.item)) {
      const kept = await deps.keep([{ name: req.item, label: `${baseLabel} · whole output`, value: whole, use: req.use }], { by: caller.name, command: maskText(command, masks), cwd }, new Set());
      if (kept[0]?.outcome === "saved") {
        emit({ note: `${whyNot}. None of the fields were kept; the whole output was kept as ${req.item} instead, so nothing it made is lost — ask the owner to look at it in Settings → Vault, or capture again with the right paths if the command can be run again.` });
        return finish(1, [req.item]);
      }
    }
    emit({ note: `${whyNot}. Nothing was kept${wantsJson && whole ? ` (and the whole output could not be kept as ${req.item} either, which is kept already or too long)` : ""}: if the command made a key, it must be deleted or rotated at its source.` });
    return finish(1, []);
  }

  const outcomes = await deps.keep(values, { by: caller.name, command: maskText(command, masks), cwd }, replace);
  const saved = outcomes.filter((o) => o.outcome === "saved").map((o) => o.name);
  for (const o of outcomes) {
    const t = req.targets.find((x) => x.name === o.name)!;
    emit({ note: o.outcome === "saved" ? `kept ${o.name}${replace.has(o.name) ? " (replaced)" : ""}, from ${fromWords(t)}` : `${o.name} was not kept: ${o.why ?? "the store refused it"}` });
  }
  // The fields asked to be seen, on stdout, after everything was kept.
  const shown: string[] = [];
  for (const p of req.print) {
    const v = doc === undefined ? null : leafText(pick(doc, parsePath(p)!));
    if (v === null) emit({ note: `--print ${p} is not in the output` });
    else shown.push(`${p}=${v}\n`);
  }
  if (shown.length) emit({ o: Buffer.from(shown.join("")).toString("base64") });
  finish(saved.length === values.length ? 0 : 1, saved);
}

/** ", which has AccessKey.UserName, AccessKey.Status": the keys beside where a missing path broke off, never their values. */
function keysWords(doc: unknown, path: string): string {
  const steps = parsePath(path) ?? [];
  let at: unknown = doc;
  let prefix = "";
  for (const step of steps) {
    const next = pick(at, [step]);
    if (next === undefined) break;
    at = next;
    prefix += typeof step === "number" ? `[${step}]` : `${prefix ? "." : ""}${step}`;
  }
  if (!at || typeof at !== "object" || Array.isArray(at)) return "";
  const keys = Object.keys(at).filter((k) => /^[A-Za-z0-9_$@-]{1,60}$/.test(k)).slice(0, 12);
  return keys.length ? `, which has ${keys.map((k) => (prefix ? `${prefix}.${k}` : k)).join(", ")}` : "";
}
