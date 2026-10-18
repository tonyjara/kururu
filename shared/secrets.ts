/**
 * Secrets lent by the parent to a child: which ones there are, what each one
 * is on either side, and the rule that decides what to push and what to take
 * back.
 *
 * A child on a box that stays on is the place an agent finally gets
 * `kururu_web`, the sidebar its OpenRouter balance, and — with phase 5 — the
 * place Telegram is answered from while the Mac sleeps. Each of those is a
 * key the Mac already keeps in a `0600` file and reads per request. So the
 * store is built in rather than bought: the parent's own files, sealed to the
 * child's X25519 key and pushed over the link, and kept on the child as the
 * same file every existing reader already reads. 1Password, Bitwarden,
 * Infisical and Vault were weighed in `docs/plans/kururu-parent-child.md`,
 * and each one added a service, an account and a bootstrap secret per child
 * to solve a problem one small module solves.
 *
 * **A kind** is one thing that can be lent: a file on the parent, the file it
 * lands as on a child, the part of it that is the secret, how its hint is
 * read, what it unlocks, and how to end it at the source. Only the secret
 * part travels — the Telegram kind carries the bot's token and never the
 * Mac's switch or allow-list, which would make a second poller of the same
 * bot — and the digest is over that part, so a settings change on the Mac
 * is not a push.
 *
 * **A grant** is per child per kind, off until ticked. A child holds only what
 * is ticked; `plan` is the whole rule for what to push and what to forget,
 * from the grants, what the parent holds, and what the child says it holds.
 *
 * Pure, in `shared/`, for `shared/nodes.ts`'s reason: the server does the
 * crypto and the disk, and every decision here is arithmetic worth a test.
 */
import { tokenHint, validTelegramToken, adoptBot } from "./channels";
import { firecrawlHint, validFirecrawlKey } from "./firecrawl";
import { keyHint, validOpenRouterKey } from "./openrouter";
import { canonical } from "./nodes";

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export type KindFamily = "telegram" | "openrouter" | "firecrawl-cloud" | "web" | "claude-token" | "codex-auth";

/** Where a kind is read on the parent, or written on a child. */
export type SecretPlace =
  /** A file in `~/.config/kururu`. */
  | { in: "config"; file: string }
  /** `auth.json` in a Codex home: the parent's for that login, the child's default one. */
  | { in: "codex-home" };

export interface KindSpec {
  /** `openrouter`, `web:firecrawl-self`, `claude-token:machine`, `codex-auth:0123456789ab`. */
  id: string;
  family: KindFamily;
  /** What the page calls it. */
  label: string;
  /** What a child can do once it holds it. */
  unlocks: string;
  /** How to end it at the source, said beside a kind that was taken back: unticking removes the copy, not the credential. */
  revoke: string;
  /** Where the parent reads it. */
  source: SecretPlace;
  /** Where a child writes it. */
  lands: SecretPlace;
  /**
   * Pushed again whenever the parent's copy changes. True for a key, which
   * changes when somebody pastes a new one; false for a login whose own
   * program rewrites it — Codex refreshes `auth.json` — because pushing the
   * Mac's refresh over the child's would have two machines refreshing one
   * login and signing each other out. Such a kind is a copy made once, and
   * pushed again only when asked.
   */
  follows: boolean;
  /**
   * A node holds at most one kind of the same group, because they land in
   * the same place: two Claude tokens are one `CLAUDE_CODE_OAUTH_TOKEN`.
   */
  group: string | null;
  /** For the families with one per Mac login: `machine` or the login key. */
  login: string | null;
}

/** The web providers' files are `web-<id>.json` (`providerFile`); an id is what fits that name. */
const WEB_ID = /^[a-z][a-z0-9-]{0,39}$/;
/** `machine` for `~/.claude` and `~/.codex`, or a login key (`shared/model.ts`'s twelve hex). */
const LOGIN_SOURCE = /^(machine|[0-9a-f]{12})$/;

/** Where the Claude tokens made for lending are kept on the parent, one per Mac login. */
export const CLAUDE_LEND_FILE = "claude-lend.json";
/** Where a lent Claude token lands on a child, and the file `logins.ts` reads for `CLAUDE_CODE_OAUTH_TOKEN`. */
export const CLAUDE_TOKEN_FILE = "claude-token.json";
/** The parent's grants: which child may hold which kind, and what each said it holds. */
export const GRANTS_FILE = "grants.json";
/** A child's record of what it holds from the parent: kinds, hints, digests, never a value. */
export const HELD_FILE = "secrets-held.json";

/** The kinds there is always exactly one of. Listed on the parent's page whether or not a key is set yet. */
export const FIXED_KINDS = ["telegram", "openrouter", "firecrawl-cloud", "web:firecrawl-self"] as const;

/** A kind id as it may come off the wire, read into its spec, or null for anything that is not one. */
export function kindOf(id: unknown): KindSpec | null {
  if (typeof id !== "string" || id.length > 64) return null;
  if (id === "telegram") {
    return {
      id,
      family: "telegram",
      label: "Telegram bot token",
      unlocks: "the bot's token, so this node can take over the chat while the parent is away (phase 5; until then it only holds it)",
      revoke: "Send /revoke to @BotFather for the bot, then paste the new token on the parent: every node that holds it is sent the new one.",
      source: { in: "config", file: "telegram.json" },
      lands: { in: "config", file: "telegram.json" },
      follows: true,
      group: null,
      login: null,
    };
  }
  if (id === "openrouter") {
    return {
      id,
      family: "openrouter",
      label: "OpenRouter management key",
      unlocks: "the OpenRouter balance on its bottom bar",
      revoke: "Delete the key at openrouter.ai/settings/management-keys and paste a new one on the parent.",
      source: { in: "config", file: "openrouter.json" },
      lands: { in: "config", file: "openrouter.json" },
      follows: true,
      group: null,
      login: null,
    };
  }
  if (id === "firecrawl-cloud") {
    return {
      id,
      family: "firecrawl-cloud",
      label: "Cloud Firecrawl key",
      unlocks: "the paid Firecrawl at the end of its agents' web chain, spending against its own daily budget",
      revoke: "Revoke the key at firecrawl.dev/app/api-keys and paste a new one on the parent.",
      source: { in: "config", file: "firecrawl.json" },
      lands: { in: "config", file: "firecrawl.json" },
      follows: true,
      group: null,
      login: null,
    };
  }
  const web = /^web:(.+)$/.exec(id);
  if (web) {
    const provider = web[1]!;
    if (!WEB_ID.test(provider) || provider === "firecrawl-cloud") return null;
    const self = provider === "firecrawl-self";
    return {
      id,
      family: "web",
      label: self ? "Self-hosted Firecrawl address and key" : `Web provider ${provider}`,
      unlocks: self ? "the free self-hosted Firecrawl first in its agents' web chain, so kururu_web works there" : "that provider in its agents' web chain",
      revoke: self ? "Change the key the gate in front of the self-hosted Firecrawl expects, then paste it on the parent." : "Revoke the key with the provider and paste a new one on the parent.",
      source: { in: "config", file: `web-${provider}.json` },
      lands: { in: "config", file: `web-${provider}.json` },
      follows: true,
      group: null,
      login: null,
    };
  }
  const claude = /^claude-token:(.+)$/.exec(id);
  if (claude) {
    const login = claude[1]!;
    if (!LOGIN_SOURCE.test(login)) return null;
    return {
      id,
      family: "claude-token",
      label: login === "machine" ? "Claude login, as a token" : `Claude login ${login}, as a token`,
      unlocks: "Claude Code on its agents and its Kuru, on the parent's subscription, without a /login there; it outranks one",
      revoke: "On the parent, run claude setup-token again and paste the new token (a token cannot be revoked on its own; it lasts a year), or sign that account out of every device at claude.ai.",
      source: { in: "config", file: CLAUDE_LEND_FILE },
      lands: { in: "config", file: CLAUDE_TOKEN_FILE },
      follows: true,
      group: "claude-token",
      login,
    };
  }
  const codex = /^codex-auth:(.+)$/.exec(id);
  if (codex) {
    const login = codex[1]!;
    if (!LOGIN_SOURCE.test(login)) return null;
    return {
      id,
      family: "codex-auth",
      label: login === "machine" ? "Codex login (auth.json)" : `Codex login ${login} (auth.json)`,
      unlocks: "Codex on its agents, signed in as the parent's account",
      revoke: "codex logout on the node, or sign the account out of its sessions at chatgpt.com; then codex login again on the parent.",
      source: { in: "codex-home" },
      lands: { in: "codex-home" },
      follows: false,
      group: "codex-auth",
      login,
    };
  }
  return null;
}

/** The kind a web provider's key is lent as. */
export function webKind(providerId: string): string {
  return providerId === "firecrawl-cloud" ? "firecrawl-cloud" : `web:${providerId}`;
}

/**
 * Files in `~/.config/kururu` that are written `0600` and are *not* kinds:
 * the ones that never leave the node that made them. The share token, this
 * node's keys and the roster's, the roster, and the records of who holds
 * what — which name node ids that mean nothing once a node is paired anew.
 * `server/test/secrets.test.ts` reads every `0600` write in the server and
 * fails on a file that is in neither list, so the next secret file is a
 * decision rather than an accident.
 */
export const NEVER_SHARED: readonly { file: string; why: string }[] = [
  { file: "access.json", why: "this node's share token, which lets a device in" },
  { file: "node.json", why: "this node's private keys, and on the parent the roster's" },
  { file: "nodes.json", why: "the roster, and on the parent each child's share token" },
  { file: GRANTS_FILE, why: "which node holds what: node ids that mean nothing after a new pairing" },
  { file: HELD_FILE, why: "what this child holds from the parent, by hint" },
];

// ---------------------------------------------------------------------------
// What travels: the secret part of a file, and its hint
// ---------------------------------------------------------------------------

function record(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** A Claude long-lived token, as `claude setup-token` prints one. Loose on the middle, because the format is Anthropic's and not ours. */
export function validClaudeToken(token: unknown): token is string {
  return typeof token === "string" && /^sk-ant-[a-z0-9]{2,12}-[A-Za-z0-9_-]{20,400}$/.test(token);
}

/** A web provider's file: a small object of strings, which is what `web-<id>.json` has always been. */
function webValue(raw: unknown): Record<string, string> | null {
  const r = record(raw);
  if (!r) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) if (typeof v === "string" && v.length <= 2048 && k.length <= 64) out[k] = v;
  return Object.keys(out).length && Object.keys(out).length <= 16 ? out : null;
}

/** A Codex `auth.json`: an object with tokens or an API key in it, and not enormous. */
function codexValue(raw: unknown): Record<string, unknown> | null {
  const r = record(raw);
  if (!r) return null;
  const tokens = record(r.tokens);
  const hasTokens = !!tokens && typeof tokens.refresh_token === "string";
  const hasKey = typeof r.OPENAI_API_KEY === "string" && r.OPENAI_API_KEY.length > 8;
  if (!hasTokens && !hasKey) return null;
  return JSON.stringify(r).length <= 64 * 1024 ? r : null;
}

/**
 * The part of the parent's file that is lent, or null when the file holds
 * none — no key pasted yet, a token cleared. What a child is sent, what the
 * digest is taken over, and what the child's `checkValue` holds it to.
 */
export function extract(spec: KindSpec, raw: unknown): unknown {
  const r = record(raw);
  switch (spec.family) {
    case "telegram":
      return r && validTelegramToken(r.token) ? { token: r.token, bot: adoptBot(r.bot) } : null;
    case "openrouter":
      return r && validOpenRouterKey(r.managementKey) ? { managementKey: r.managementKey } : null;
    case "firecrawl-cloud":
      return r && validFirecrawlKey(r.apiKey) ? { apiKey: r.apiKey } : null;
    case "web":
      return webValue(raw);
    case "claude-token": {
      const entry = record(record(r?.tokens)?.[spec.login ?? ""]);
      return entry && validClaudeToken(entry.token) ? { token: entry.token, account: typeof entry.account === "string" ? entry.account.slice(0, 200) : null } : null;
    }
    case "codex-auth":
      return codexValue(raw);
  }
}

/** Whether what arrived is what that kind's `extract` makes. A child takes nothing else. */
export function checkValue(spec: KindSpec, value: unknown): boolean {
  const v = record(value);
  if (!v) return false;
  switch (spec.family) {
    case "telegram":
      return validTelegramToken(v.token);
    case "openrouter":
      return validOpenRouterKey(v.managementKey);
    case "firecrawl-cloud":
      return validFirecrawlKey(v.apiKey);
    case "web":
      return webValue(v) !== null && Object.keys(webValue(v)!).length === Object.keys(v).length;
    case "claude-token":
      return validClaudeToken(v.token);
    case "codex-auth":
      return codexValue(v) !== null;
  }
}

/**
 * What a child writes, from what arrived and what its file held before.
 * Most kinds are the value itself. The cloud Firecrawl's file keeps the
 * child's own daily budget beside the key, since spending is counted per
 * node. Telegram's keeps nothing of the child's: a switch left on from a bot
 * of its own would make this node poll the parent's bot.
 */
export function landed(spec: KindSpec, value: unknown, existing: unknown): unknown {
  if (spec.family === "firecrawl-cloud") {
    const settings = record(record(existing)?.settings);
    return settings ? { ...(value as object), settings } : value;
  }
  return value;
}

/** What a child's file becomes when the kind is taken back: null to remove it, or what is left that was the child's own. */
export function forgotten(spec: KindSpec, existing: unknown): unknown {
  if (spec.family === "firecrawl-cloud") {
    const settings = record(record(existing)?.settings);
    return settings ? { settings } : null;
  }
  return null;
}

/** An email out of a JWT's payload, which is how Codex's `id_token` says whose login it is. Never verified: it is a label. */
function jwtEmail(jwt: unknown): string | null {
  if (typeof jwt !== "string") return null;
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const text = atob(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "="));
    const email = (JSON.parse(text) as { email?: unknown }).email;
    return typeof email === "string" && email.length <= 200 ? email : null;
  } catch {
    return null;
  }
}

function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * Enough of a value to tell two apart, and nothing a person could use: the
 * last four, a bot's name, an account, an address. Sent to clients on both
 * nodes, as every hint in kururu is; the value never is.
 */
export function hintOf(spec: KindSpec, value: unknown): string {
  const v = record(value) ?? {};
  switch (spec.family) {
    case "telegram": {
      const bot = adoptBot(v.bot);
      const tail = typeof v.token === "string" ? tokenHint(v.token) : "";
      return bot ? `@${bot.username} ${tail}` : tail;
    }
    case "openrouter":
      return typeof v.managementKey === "string" ? keyHint(v.managementKey) : "";
    case "firecrawl-cloud":
      return typeof v.apiKey === "string" ? firecrawlHint(v.apiKey) : "";
    case "web": {
      const host = hostOf(v.endpoint);
      const key = typeof v.apiKey === "string" ? firecrawlHint(v.apiKey) : null;
      return [host, key].filter(Boolean).join(" · ") || "set";
    }
    case "claude-token": {
      const tail = typeof v.token === "string" ? `…${v.token.slice(-4)}` : "";
      return typeof v.account === "string" && v.account ? `${v.account} ${tail}` : tail;
    }
    case "codex-auth": {
      const email = jwtEmail(record(v.tokens)?.id_token);
      if (email) return email;
      return typeof v.OPENAI_API_KEY === "string" ? `API key …${v.OPENAI_API_KEY.slice(-4)}` : "signed in";
    }
  }
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/**
 * One secret on its way to one node. `epk`, `nonce`, `ct` and `tag` are the
 * seal (X25519 with an ephemeral key, HKDF-SHA256, AES-256-GCM, in
 * `server/src/seal.ts`), and the header beside them is bound in as the
 * cipher's additional data, so an envelope for one kind or one node cannot
 * be opened as another. `sig` is the parent's node key over all of it: the
 * seal alone says who may open it, not who made it, and anyone holding the
 * child's public key could make one.
 */
export interface SealedSecret {
  v: 1;
  kind: string;
  /** The parent's node id. */
  from: string;
  /** The node it is for. */
  to: string;
  /** Rises with every push from the parent, so an older one is never taken over a newer. */
  seq: number;
  /** The ephemeral X25519 public key, base64 of the raw 32 bytes. */
  epk: string;
  nonce: string;
  ct: string;
  tag: string;
  sig: string;
}

export type SealHeader = Pick<SealedSecret, "v" | "kind" | "from" | "to" | "seq">;

/** The cipher's additional data. */
export function sealAad(header: SealHeader): string {
  return `kururu-secret-v1\n${canonical({ v: header.v, kind: header.kind, from: header.from, to: header.to, seq: header.seq })}`;
}

/** What the parent signs: the whole envelope but the signature. Prefixed apart from every other thing a node signs. */
export function sealSigned(envelope: Omit<SealedSecret, "sig">): string {
  const { v, kind, from, to, seq, epk, nonce, ct, tag } = envelope;
  return `kururu-sealed-v1\n${canonical({ v, kind, from, to, seq, epk, nonce, ct, tag })}`;
}

/** What the parent signs to take a kind back. */
export function forgetSigned(kind: string, from: string, to: string, seq: number): string {
  return `kururu-forget-v1\n${canonical({ kind, from, to, seq })}`;
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The shape, checked, before anything is decrypted or verified. */
export function asSealed(raw: unknown): SealedSecret | null {
  const e = record(raw);
  if (!e || e.v !== 1) return null;
  if (!kindOf(e.kind) || typeof e.from !== "string" || typeof e.to !== "string") return null;
  if (typeof e.seq !== "number" || !Number.isSafeInteger(e.seq) || e.seq < 1) return null;
  for (const field of ["epk", "nonce", "ct", "tag", "sig"] as const) {
    const value = e[field];
    if (typeof value !== "string" || value.length > 256 * 1024 || !B64.test(value)) return null;
  }
  return e as unknown as SealedSecret;
}

/** The next push's number: the clock, and never one that is not higher than the last. */
export function nextSeq(last: number, now: number): number {
  return Math.max(Math.floor(now), last + 1);
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/** What a child last said it holds of a kind: a digest of the value and the push it came in. */
export interface Holding {
  digest: string;
  seq: number;
}

/** One kind, for one child, on the parent. */
export interface GrantRecord {
  /** Ticked. */
  on: boolean;
  /** When it was last ticked or unticked. */
  at: number;
  /** What the child said it holds, as of its last report or acknowledgement; null for nothing. */
  holds: Holding | null;
  /** Why the child refused the last push, and for which digest — so the same push is not made at it on every look. */
  failed: { digest: string; error: string; at: number } | null;
  /** When it was taken back, for the line that says how to end it at the source too. */
  forgotAt: number | null;
  /** The child's hint for what it holds, from its last acknowledgement. */
  hint: string | null;
  /** When the child acknowledged what it holds now. */
  heldSince: number | null;
}

export function emptyGrant(at: number): GrantRecord {
  return { on: false, at, holds: null, failed: null, forgotAt: null, hint: null, heldSince: null };
}

/**
 * How a grant stands, as the page says it:
 *
 * - `off`: not ticked, and the child holds nothing of it.
 * - `held`: ticked, and the child holds what the parent holds.
 * - `sending`: ticked, linked, and the child does not have it yet.
 * - `waiting`: a push or a take-back owed to a child that is not linked; it is made when it links.
 * - `forgetting`: unticked, linked, and the child has not said it let go.
 * - `failed`: the child refused the last push, and said why.
 * - `missing`: ticked, and the parent has none to lend — the key was cleared here.
 */
export type GrantState = "off" | "held" | "sending" | "waiting" | "forgetting" | "failed" | "missing";

export interface GrantInput {
  grant: GrantRecord | undefined;
  spec: KindSpec;
  /** The digest of what the parent holds now, or null when it holds none. */
  source: string | null;
  /** The link is up and the child has said what it holds. */
  ready: boolean;
}

export function grantState({ grant, spec, source, ready }: GrantInput): GrantState {
  if (!grant) return "off";
  if (!grant.on) return grant.holds ? (ready ? "forgetting" : "waiting") : "off";
  if (source === null) return "missing";
  if (grant.holds && (grant.holds.digest === source || !spec.follows)) return "held";
  if (grant.failed && grant.failed.digest === source) return "failed";
  return ready ? "sending" : "waiting";
}

export type PlanStep = { op: "put"; kind: string } | { op: "forget"; kind: string };

export interface PlanInput {
  grants: Readonly<Record<string, GrantRecord>>;
  /** The digest of each kind the parent holds now. */
  sources: ReadonlyMap<string, string>;
  /** Pushes on their way and not yet acknowledged, by kind, with the digest each carries. */
  inflight: ReadonlyMap<string, string>;
  /** Try again a push the child refused: on a fresh link, or when asked to. */
  retry: boolean;
}

/**
 * What to send a child that has said what it holds: the whole rule.
 *
 * A ticked kind is pushed when the child holds none of it, or — for a kind
 * that follows its source — holds another version. A kind not ticked that
 * the child holds is taken back. A ticked kind the parent no longer has is
 * left as the child holds it: clearing a key on the Mac is not a decision to
 * take it away from a node, and unticking is. A push already on its way with
 * the same digest is not made twice, and one the child refused for the same
 * digest waits for `retry`.
 */
export function plan({ grants, sources, inflight, retry }: PlanInput): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const [kind, grant] of Object.entries(grants)) {
    const spec = kindOf(kind);
    if (!spec) continue;
    if (!grant.on) {
      if (grant.holds && !inflight.has(kind)) steps.push({ op: "forget", kind });
      continue;
    }
    const source = sources.get(kind);
    if (source === undefined) continue;
    if (grant.holds && (grant.holds.digest === source || !spec.follows)) continue;
    if (inflight.get(kind) === source) continue;
    if (!retry && grant.failed?.digest === source) continue;
    steps.push({ op: "put", kind });
  }
  return steps;
}

/**
 * Tick or untick, as a new set of grants. Ticking a kind in a group unticks
 * the others in it for that node: two Claude tokens would be one variable,
 * and the second would silently win.
 */
export function withGrant(grants: Readonly<Record<string, GrantRecord>>, kind: string, on: boolean, now: number): Record<string, GrantRecord> {
  const spec = kindOf(kind);
  const next: Record<string, GrantRecord> = { ...grants };
  if (!spec) return next;
  const was = next[kind] ?? emptyGrant(now);
  next[kind] = { ...was, on, at: now, failed: on ? was.failed : null, forgotAt: on ? null : was.forgotAt };
  if (on && spec.group) {
    for (const [other, grant] of Object.entries(next)) {
      if (other !== kind && grant.on && kindOf(other)?.group === spec.group) next[other] = { ...grant, on: false, at: now };
    }
  }
  return next;
}

/**
 * The child's report of what it holds, folded into the grants: every kind it
 * holds gets a record (one with no grant is then taken back by `plan`), and
 * every record of a kind it no longer holds says so.
 */
export function withReport(grants: Readonly<Record<string, GrantRecord>>, held: ReadonlyMap<string, Holding>, now: number): Record<string, GrantRecord> {
  const next: Record<string, GrantRecord> = {};
  for (const [kind, grant] of Object.entries(grants)) {
    const holds = held.get(kind) ?? null;
    next[kind] = { ...grant, holds, ...(holds ? {} : { hint: null, heldSince: null }) };
  }
  for (const [kind, holds] of held) {
    if (!next[kind] && kindOf(kind)) next[kind] = { ...emptyGrant(now), holds };
  }
  return next;
}

/** Records with nothing left to say: off, held by nobody, and not just taken back. Dropped so the file does not grow with every kind ever ticked. */
export function prunedGrants(grants: Readonly<Record<string, GrantRecord>>): Record<string, GrantRecord> {
  const next: Record<string, GrantRecord> = {};
  for (const [kind, grant] of Object.entries(grants)) if (grant.on || grant.holds || grant.forgotAt !== null) next[kind] = grant;
  return next;
}

/** A grants file off the disk, every field checked: a hand-edited one is read, not trusted. */
export function adoptGrants(raw: unknown): Record<string, Record<string, GrantRecord>> {
  const out: Record<string, Record<string, GrantRecord>> = {};
  const nodes = record(record(raw)?.nodes);
  if (!nodes) return out;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  for (const [nodeId, kinds] of Object.entries(nodes)) {
    if (!/^n[0-9a-f]{12}$/.test(nodeId)) continue;
    const mine: Record<string, GrantRecord> = {};
    for (const [kind, rawGrant] of Object.entries(record(kinds) ?? {})) {
      const g = record(rawGrant);
      if (!g || !kindOf(kind)) continue;
      const holds = record(g.holds);
      const failed = record(g.failed);
      mine[kind] = {
        on: g.on === true,
        at: num(g.at) ?? 0,
        holds: holds && typeof holds.digest === "string" && num(holds.seq) !== null ? { digest: holds.digest, seq: num(holds.seq)! } : null,
        failed: failed && typeof failed.digest === "string" && typeof failed.error === "string" ? { digest: failed.digest, error: failed.error.slice(0, 300), at: num(failed.at) ?? 0 } : null,
        forgotAt: num(g.forgotAt),
        hint: typeof g.hint === "string" ? g.hint.slice(0, 200) : null,
        heldSince: num(g.heldSince),
      };
    }
    out[nodeId] = mine;
  }
  return out;
}

// ---------------------------------------------------------------------------
// On a child
// ---------------------------------------------------------------------------

/** One kind a child holds, as `secrets-held.json` keeps it: never the value. */
export interface HeldEntry {
  digest: string;
  seq: number;
  hint: string;
  /** When it first arrived. */
  since: number;
  /** When the version held now arrived. */
  updated: number;
  /** For a Codex login written into a Codex home: that this node put it there, so taking it back removes only what it wrote. */
  placed?: string;
}

export interface HeldFile {
  /** The parent these came from. A different parent, or none, and they are all forgotten. */
  from: string | null;
  held: Record<string, HeldEntry>;
  /** The highest push number taken or refused per kind, kept after a take-back so an older push is never taken again. */
  seen: Record<string, number>;
}

export function adoptHeld(raw: unknown): HeldFile {
  const r = record(raw);
  const held: Record<string, HeldEntry> = {};
  const seen: Record<string, number> = {};
  for (const [kind, rawEntry] of Object.entries(record(r?.held) ?? {})) {
    const e = record(rawEntry);
    if (!e || !kindOf(kind) || typeof e.digest !== "string" || typeof e.seq !== "number" || typeof e.hint !== "string") continue;
    held[kind] = {
      digest: e.digest,
      seq: e.seq,
      hint: e.hint.slice(0, 200),
      since: typeof e.since === "number" ? e.since : 0,
      updated: typeof e.updated === "number" ? e.updated : 0,
      ...(typeof e.placed === "string" ? { placed: e.placed } : {}),
    };
  }
  for (const [kind, seq] of Object.entries(record(r?.seen) ?? {})) if (kindOf(kind) && typeof seq === "number" && Number.isFinite(seq)) seen[kind] = seq;
  return { from: typeof r?.from === "string" ? r.from : null, held, seen };
}

// ---------------------------------------------------------------------------
// What a client is told
// ---------------------------------------------------------------------------

export interface CatalogueEntry {
  kind: string;
  family: KindFamily;
  label: string;
  unlocks: string;
  revoke: string;
  follows: boolean;
  /** The parent's hint for what it holds, or null when it holds none. */
  hint: string | null;
}

export interface GrantView {
  kind: string;
  on: boolean;
  state: GrantState;
  /** The child's hint for what it holds. */
  hint: string | null;
  heldSince: number | null;
  /** Why it was refused, while `failed`. */
  error: string | null;
  /** When it was taken back, while it is off. */
  forgotAt: number | null;
  /** A kind that does not follow, held, while the parent's copy has changed since. */
  older: boolean;
}

export interface HeldView {
  kind: string;
  label: string;
  hint: string;
  since: number;
  updated: number;
}

export interface ClaudeLend {
  /** `machine` or a login key. */
  login: string;
  /** Who it is: the account Claude Code recorded for that login, if any. */
  account: string | null;
  hint: string;
  at: number;
}

/** Settings → Nodes → Secrets on the parent, and the "held from" lines on a child. Hints only, on both. */
export interface SecretsView {
  /** On the parent, or a node about to be one: every kind it could lend. */
  catalogue: CatalogueEntry[];
  /** On the parent: each child's grants, by node id. */
  grants: Record<string, GrantView[]>;
  /** On a child: what it holds, and from whom. */
  held: HeldView[];
  heldFrom: string | null;
  /** On the parent: the Claude tokens made for lending, one per Mac login. */
  lends: ClaudeLend[];
}

export const EMPTY_SECRETS: SecretsView = { catalogue: [], grants: {}, held: [], heldFrom: null, lends: [] };

/** The line a granted kind's page draws on a child in place of its field. */
export function heldLine(held: HeldView, from: string): string {
  return `Held from ${from} · ${held.hint}`;
}

/** How a grant reads on the parent's page, in a few words. */
export function grantText(view: GrantView, node: string): string {
  switch (view.state) {
    case "off":
      return view.forgotAt ? `taken back from ${node}` : "not lent";
    case "held":
      return view.older ? `held by ${node} · ${view.hint ?? ""} · this Mac's copy has changed since; Push again to send it` : `held by ${node} · ${view.hint ?? ""}`;
    case "sending":
      return `sending to ${node}…`;
    case "waiting":
      return view.on ? `sent when ${node} links` : `taken back when ${node} links`;
    case "forgetting":
      return `taking it back from ${node}…`;
    case "failed":
      return `${node} refused it: ${view.error ?? "no reason given"}`;
    case "missing":
      return "this Mac has none to lend: set it on this Mac first";
  }
}
