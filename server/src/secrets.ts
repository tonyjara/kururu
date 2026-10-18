/**
 * The secrets the parent lends its children, both halves: on the parent the
 * catalogue, the grants, the pushes and the acknowledgements; on a child the
 * taking, the writing at `0600`, and the letting go.
 *
 * `shared/secrets.ts` has the argument for a store of kururu's own and every
 * rule; this is the part with a disk and a link. Its one promise is the one
 * every key in kururu already keeps — read off the disk at the moment it is
 * needed and dropped with the need, never logged, never sent to a client —
 * now with a second place it may go: sealed, to a node the user ticked it
 * for, over that node's link.
 *
 * **On the parent**, a few files are looked at every two seconds (a stat
 * each), and when one changes its secret part is read, digested and
 * dropped; the digest is what tells a push is owed. A push happens when a
 * kind is ticked, when a child links and says what it holds, and when the
 * parent's copy changes, which is how pasting a new key on the Mac reaches
 * every node that holds it within seconds. Unticking sends a take-back.
 *
 * **On a child**, a push is taken only from the roster's parent, signed by
 * its node key, sealed to this node, newer than the last; the value is
 * written as the same file the readers here already read — `openrouter.ts`,
 * the web providers, `telegram.ts` — so none of them knows it was lent. A
 * child that leaves the roster lets go of everything it held, at once.
 *
 * On the restartable side, with nothing near a pty: a lent Claude token
 * reaches a pty through `logins.ts`, read at spawn.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLoginKey } from "../../shared/model";
import type { LinkMessage } from "../../shared/nodes";
import {
  adoptGrants,
  adoptHeld,
  asSealed,
  checkValue,
  CLAUDE_LEND_FILE,
  emptyGrant,
  extract,
  FIXED_KINDS,
  forgetSigned,
  forgotten,
  grantState,
  GRANTS_FILE,
  HELD_FILE,
  hintOf,
  kindOf,
  landed,
  nextSeq,
  plan,
  prunedGrants,
  sealSigned,
  validClaudeToken,
  withGrant,
  withReport,
  type CatalogueEntry,
  type ClaudeLend,
  type GrantRecord,
  type GrantView,
  type HeldFile,
  type Holding,
  type KindSpec,
  type SecretsView,
} from "../../shared/secrets";
import { configDir, configPath, readConfigFile, removeConfigFile, writeConfigFile } from "./config";
import { codexDirFor } from "./logins";
import { boxPrivateKey, identity, signAsNode, verifySigned } from "./nodekeys";
import type { NodeHost } from "./nodes";
import { digestOf, seal, unseal } from "./seal";

/** How often the parent looks at its secret files. A stat each; "within seconds" is the promise for a rotated key. */
const LOOK_MS = 2_000;

type Nodes = Pick<NodeHost, "role" | "selfId" | "parentId" | "member" | "linked" | "send" | "on" | "onLinkUp" | "onLinkDown" | "onUnpair">;

export interface SecretsDeps {
  nodes: Nodes;
  /** A kind was written or removed on this node: whatever holds its hint reads it again. */
  landed: (spec: KindSpec) => void;
  /** Something the page draws moved. */
  changed: () => void;
  log: (line: string) => void;
}

/** The Codex home a login uses: `machine` is the default one, as every pty without a profile login has it. */
function codexHome(login: string): string {
  if (login === "machine") return process.env.CODEX_HOME || join(homedir(), ".codex");
  return codexDirFor(login);
}

/** What a kind is on the parent's disk this moment, or null. Read, used, dropped. */
function readSource(spec: KindSpec): unknown {
  if (spec.source.in === "config") return readConfigFile(spec.source.file);
  try {
    return JSON.parse(readFileSync(join(codexHome(spec.login ?? "machine"), "auth.json"), "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** A file's mtime and size, or nothing: enough to notice a save. */
function stamp(path: string): string {
  try {
    const info = statSync(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "";
  }
}

function sourcePath(spec: KindSpec): string {
  return spec.source.in === "config" ? configPath(spec.source.file) : join(codexHome(spec.login ?? "machine"), "auth.json");
}

interface Source {
  digest: string;
  hint: string;
}

/** The Claude tokens made for lending, as `claude-lend.json` keeps them. */
interface LendFile {
  tokens: Record<string, { token: string; account: string | null; at: number }>;
}

function readLends(): LendFile {
  const raw = readConfigFile(CLAUDE_LEND_FILE) as { tokens?: Record<string, unknown> } | null;
  const tokens: LendFile["tokens"] = {};
  for (const [login, entry] of Object.entries(raw?.tokens ?? {})) {
    const e = entry as Record<string, unknown> | null;
    if (!e || !(login === "machine" || isLoginKey(login)) || !validClaudeToken(e.token)) continue;
    tokens[login] = { token: e.token, account: typeof e.account === "string" ? e.account : null, at: typeof e.at === "number" ? e.at : 0 };
  }
  return { tokens };
}

export class Secrets {
  // --- the parent's ---------------------------------------------------------
  private grants: Record<string, Record<string, GrantRecord>>;
  private lastSeq: number;
  /** What the parent holds, by kind, as of the last look. */
  private sources = new Map<string, Source>();
  private stamps = new Map<string, string>();
  /** Nodes that have said what they hold since their link came up: only those are pushed to. */
  private readonly reported = new Set<string>();
  private readonly inflight = new Map<string, Map<string, { digest: string; seq: number; op: "put" | "forget" }>>();
  private readonly timer: ReturnType<typeof setInterval>;

  // --- a child's -------------------------------------------------------------
  private held: HeldFile;

  constructor(private readonly deps: SecretsDeps) {
    const raw = readConfigFile(GRANTS_FILE) as { lastSeq?: unknown } | null;
    this.grants = adoptGrants(raw);
    this.lastSeq = typeof raw?.lastSeq === "number" && Number.isFinite(raw.lastSeq) ? raw.lastSeq : 0;
    this.held = adoptHeld(readConfigFile(HELD_FILE));
    const nodes = deps.nodes;
    nodes.on("secrets-put", (peer, message) => this.onPut(peer, message as Extract<LinkMessage, { type: "secrets-put" }>));
    nodes.on("secrets-forget", (peer, message) => this.onForget(peer, message as Extract<LinkMessage, { type: "secrets-forget" }>));
    nodes.on("secrets-held", (peer, message) => this.onReport(peer, message as Extract<LinkMessage, { type: "secrets-held" }>));
    nodes.on("secrets-ack", (peer, message) => this.onAck(peer, message as Extract<LinkMessage, { type: "secrets-ack" }>));
    nodes.onLinkUp((peer) => this.linkUp(peer));
    nodes.onLinkDown((peer) => {
      this.reported.delete(peer);
      this.inflight.delete(peer);
      this.deps.changed();
    });
    nodes.onUnpair(() => this.forgetAll("this node left the roster"));
    // Held from a parent this node no longer has — removed while the server
    // was down, or paired anew since — is let go of now, not on the next link.
    if (Object.keys(this.held.held).length && (nodes.role() !== "child" || this.held.from !== nodes.parentId())) {
      this.forgetAll(nodes.role() === "child" ? "this node has a different parent now" : "this node is in no parent's roster");
    }
    this.look();
    this.timer = setInterval(() => this.look(), LOOK_MS);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  private get me(): string {
    return this.deps.nodes.selfId();
  }

  private isParent(): boolean {
    return this.deps.nodes.role() === "parent";
  }

  // ---------------------------------------------------------------------------
  // The parent: what there is to lend
  // ---------------------------------------------------------------------------

  /** Every kind the parent could lend now, and every kind somebody holds or is granted. */
  private kinds(): string[] {
    const kinds = new Set<string>(FIXED_KINDS);
    try {
      for (const name of readdirSync(configDir())) {
        const web = /^web-([a-z][a-z0-9-]{0,39})\.json$/.exec(name);
        if (web && kindOf(`web:${web[1]}`)) kinds.add(`web:${web[1]}`);
      }
    } catch {
      // No config directory yet.
    }
    for (const login of Object.keys(readLends().tokens)) kinds.add(`claude-token:${login}`);
    if (existsSync(join(codexHome("machine"), "auth.json"))) kinds.add("codex-auth:machine");
    try {
      for (const key of readdirSync(configPath("profiles")).filter(isLoginKey)) if (existsSync(join(codexDirFor(key), "auth.json"))) kinds.add(`codex-auth:${key}`);
    } catch {
      // No profiles keeping logins.
    }
    for (const grants of Object.values(this.grants)) for (const kind of Object.keys(grants)) kinds.add(kind);
    return [...kinds].filter((kind) => kindOf(kind));
  }

  /**
   * The look: a stat of each kind's file, and for any that moved its secret
   * part read, digested and dropped. A digest that changed is a push owed
   * to every node that holds that kind.
   */
  private look(): void {
    const role = this.deps.nodes.role();
    if (role === "child") {
      if (this.sources.size) {
        this.sources.clear();
        this.stamps.clear();
      }
      return;
    }
    const kinds = this.kinds();
    let moved = false;
    const seen = new Set<string>();
    for (const kind of kinds) {
      const spec = kindOf(kind)!;
      seen.add(kind);
      const now = stamp(sourcePath(spec));
      if (this.stamps.get(kind) === now) continue;
      this.stamps.set(kind, now);
      const value = extract(spec, readSource(spec));
      const before = this.sources.get(kind);
      if (value === null) {
        if (before) {
          this.sources.delete(kind);
          moved = true;
        }
        continue;
      }
      const digest = digestOf(value);
      if (before?.digest !== digest) {
        this.sources.set(kind, { digest, hint: hintOf(spec, value) });
        moved = true;
      }
    }
    for (const kind of [...this.sources.keys()]) {
      if (seen.has(kind)) continue;
      this.sources.delete(kind);
      this.stamps.delete(kind);
      moved = true;
    }
    if (!moved) return;
    if (role === "parent") for (const node of Object.keys(this.grants)) this.reconcile(node, false);
    this.deps.changed();
  }

  /** Look now rather than within two seconds: a key was just pasted here. */
  lookNow(): void {
    this.look();
  }

  // ---------------------------------------------------------------------------
  // The parent: grants, pushes, take-backs
  // ---------------------------------------------------------------------------

  private saveGrants(): void {
    const nodes: Record<string, Record<string, GrantRecord>> = {};
    for (const [node, grants] of Object.entries(this.grants)) {
      // A node no longer in the roster takes its grants with it.
      if (!this.deps.nodes.member(node)) continue;
      const kept = prunedGrants(grants);
      if (Object.keys(kept).length) nodes[node] = kept;
    }
    this.grants = nodes;
    writeConfigFile(GRANTS_FILE, { nodes, lastSeq: this.lastSeq }, 0o600);
  }

  private seq(): number {
    this.lastSeq = nextSeq(this.lastSeq, Date.now());
    return this.lastSeq;
  }

  /** Settings → Nodes → <node> → Secrets: tick or untick. The parent's alone. */
  grant(nodeId: unknown, kind: unknown, on: boolean): SecretsView {
    if (!this.isParent()) throw new Error("Only the parent lends secrets, and this node is not it.");
    if (typeof nodeId !== "string" || nodeId === this.me || !this.deps.nodes.member(nodeId)) throw new Error("That node is not in the roster.");
    const spec = kindOf(kind);
    if (!spec) throw new Error("That is not a kind of secret kururu lends.");
    if (on && !this.sources.has(spec.id)) throw new Error(`This Mac has no ${spec.label.toLowerCase()} to lend. Set it here first.`);
    this.grants[nodeId] = withGrant(this.grants[nodeId] ?? {}, spec.id, on, Date.now());
    this.saveGrants();
    this.deps.log(`secrets: ${spec.id} ${on ? "lent to" : "taken back from"} ${this.deps.nodes.member(nodeId)?.name ?? nodeId}`);
    this.reconcile(nodeId, true);
    this.deps.changed();
    return this.view();
  }

  /** Send a kind again, though the node holds a version: for a kind that does not follow its source, after the parent's copy changed. */
  pushAgain(nodeId: unknown, kind: unknown): SecretsView {
    if (!this.isParent()) throw new Error("Only the parent lends secrets, and this node is not it.");
    const spec = kindOf(kind);
    const grant = typeof nodeId === "string" && spec ? this.grants[nodeId]?.[spec.id] : undefined;
    if (!spec || !grant?.on || typeof nodeId !== "string") throw new Error("That is not lent to that node.");
    if (!this.deps.nodes.linked(nodeId) || !this.reported.has(nodeId)) throw new Error(`${this.deps.nodes.member(nodeId)?.name ?? "That node"} is not linked; it is sent when it links.`);
    this.put(nodeId, spec);
    this.deps.changed();
    return this.view();
  }

  /** What `plan` says to send a node, sent. Only to a node that is linked and has said what it holds. */
  private reconcile(nodeId: string, retry: boolean): void {
    if (!this.isParent() || !this.deps.nodes.linked(nodeId) || !this.reported.has(nodeId)) return;
    const sources = new Map([...this.sources].map(([kind, s]) => [kind, s.digest] as const));
    const inflight = new Map([...(this.inflight.get(nodeId) ?? new Map())].map(([kind, f]) => [kind, f.op === "put" ? f.digest : ""] as const));
    for (const step of plan({ grants: this.grants[nodeId] ?? {}, sources, inflight, retry })) {
      const spec = kindOf(step.kind)!;
      if (step.op === "put") this.put(nodeId, spec);
      else this.forget(nodeId, spec);
    }
  }

  private put(nodeId: string, spec: KindSpec): void {
    const member = this.deps.nodes.member(nodeId);
    if (!member) return;
    const value = extract(spec, readSource(spec));
    if (value === null) return;
    const seq = this.seq();
    let envelope;
    try {
      envelope = seal(value, { kind: spec.id, from: this.me, to: nodeId, seq }, member.keys.box, signAsNode);
    } catch (err) {
      this.deps.log(`secrets: could not seal ${spec.id} for ${member.name}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!this.deps.nodes.send(nodeId, { type: "secrets-put", envelope })) return;
    this.flight(nodeId).set(spec.id, { digest: digestOf(value), seq, op: "put" });
    this.saveGrants();
    this.deps.log(`secrets: sent ${spec.id} to ${member.name}`);
  }

  private forget(nodeId: string, spec: KindSpec): void {
    const seq = this.seq();
    const sig = signAsNode(forgetSigned(spec.id, this.me, nodeId, seq));
    if (!this.deps.nodes.send(nodeId, { type: "secrets-forget", kind: spec.id, seq, sig })) return;
    this.flight(nodeId).set(spec.id, { digest: "", seq, op: "forget" });
    this.saveGrants();
  }

  private flight(nodeId: string): Map<string, { digest: string; seq: number; op: "put" | "forget" }> {
    let map = this.inflight.get(nodeId);
    if (!map) this.inflight.set(nodeId, (map = new Map()));
    return map;
  }

  /** A child's report of what it holds, on every link-up: the moment the parent knows what to send. */
  private onReport(peer: string, message: Extract<LinkMessage, { type: "secrets-held" }>): void {
    if (!this.isParent() || !this.deps.nodes.member(peer)) return;
    const held = new Map<string, Holding>();
    for (const item of Array.isArray(message.held) ? message.held.slice(0, 64) : []) {
      if (item && kindOf(item.kind) && typeof item.digest === "string" && typeof item.seq === "number") held.set(item.kind, { digest: item.digest, seq: item.seq });
    }
    this.grants[peer] = withReport(this.grants[peer] ?? {}, held, Date.now());
    this.reported.add(peer);
    this.saveGrants();
    this.reconcile(peer, true);
    this.deps.changed();
  }

  private onAck(peer: string, message: Extract<LinkMessage, { type: "secrets-ack" }>): void {
    if (!this.isParent()) return;
    const spec = kindOf(message.kind);
    const flight = this.inflight.get(peer)?.get(message.kind);
    if (!spec || !flight || flight.seq !== message.seq) return;
    this.inflight.get(peer)!.delete(message.kind);
    const grants = this.grants[peer] ?? {};
    const was = grants[spec.id] ?? emptyGrant(Date.now());
    const name = this.deps.nodes.member(peer)?.name ?? peer;
    const now = Date.now();
    if (message.op === "put") {
      if (message.ok && typeof message.digest === "string") {
        grants[spec.id] = {
          ...was,
          holds: { digest: message.digest, seq: message.seq },
          hint: typeof message.hint === "string" ? message.hint.slice(0, 200) : null,
          heldSince: was.holds ? (was.heldSince ?? now) : now,
          failed: null,
        };
        this.deps.log(`secrets: ${name} holds ${spec.id}`);
      } else {
        const error = typeof message.error === "string" ? message.error.slice(0, 300) : "no reason given";
        grants[spec.id] = { ...was, failed: { digest: flight.digest, error, at: now } };
        this.deps.log(`secrets: ${name} refused ${spec.id}: ${error}`);
      }
    } else if (message.ok) {
      grants[spec.id] = { ...was, holds: null, hint: null, heldSince: null, forgotAt: now };
      this.deps.log(`secrets: ${name} let go of ${spec.id}`);
    }
    this.grants[peer] = grants;
    this.saveGrants();
    // A take-back that crossed a new tick, or a rotation that landed during a push.
    this.reconcile(peer, false);
    this.deps.changed();
  }

  private linkUp(peer: string): void {
    this.reported.delete(peer);
    this.inflight.delete(peer);
    // A child tells its parent what it holds, and that is what the parent
    // pushes against. Said on every link, since the parent forgets it with
    // the link: a child restarted while the Mac slept may have let go of a
    // kind the parent thinks it holds.
    const nodes = this.deps.nodes;
    if (nodes.role() === "child" && peer === nodes.parentId()) {
      const held = Object.entries(this.held.held).map(([kind, entry]) => ({ kind, digest: entry.digest, seq: entry.seq }));
      nodes.send(peer, { type: "secrets-held", held });
    }
  }

  // ---------------------------------------------------------------------------
  // The parent: Claude tokens made for lending
  // ---------------------------------------------------------------------------

  /**
   * Settings → Agents → Lend this login to a node: the token `claude
   * setup-token` printed, kept per Mac login so that a Mac with two
   * accounts can lend either. The token only makes model requests and lasts
   * a year; nothing here can check it without spending a request, so its
   * shape is checked and the first agent on the node is the proof.
   */
  lend(login: string, raw: unknown, account: string | null): SecretsView {
    if (this.deps.nodes.role() === "child") throw new Error("A child does not lend logins; its parent does.");
    const token = typeof raw === "string" ? raw.trim() : raw;
    if (!validClaudeToken(token)) throw new Error("That is not what claude setup-token prints: it starts sk-ant-oat and is one long line.");
    if (!(login === "machine" || isLoginKey(login))) throw new Error("Not a login this Mac has.");
    const file = readLends();
    file.tokens[login] = { token, account, at: Date.now() };
    writeConfigFile(CLAUDE_LEND_FILE, file, 0o600);
    if (readLends().tokens[login]?.token !== token) throw new Error(`Could not save the token to ~/.config/kururu/${CLAUDE_LEND_FILE}.`);
    this.deps.log(`secrets: a Claude token for ${login === "machine" ? "this Mac's login" : `login ${login}`} was kept for lending`);
    this.look();
    this.deps.changed();
    return this.view();
  }

  unlend(login: unknown): SecretsView {
    const file = readLends();
    if (typeof login === "string" && file.tokens[login]) {
      delete file.tokens[login];
      if (Object.keys(file.tokens).length) writeConfigFile(CLAUDE_LEND_FILE, file, 0o600);
      else removeConfigFile(CLAUDE_LEND_FILE);
      this.look();
      this.deps.changed();
    }
    return this.view();
  }

  // ---------------------------------------------------------------------------
  // A child: take, write, forget
  // ---------------------------------------------------------------------------

  private saveHeld(): void {
    writeConfigFile(HELD_FILE, this.held, 0o600);
  }

  private ack(peer: string, message: Omit<Extract<LinkMessage, { type: "secrets-ack" }>, "type">): void {
    this.deps.nodes.send(peer, { type: "secrets-ack", ...message });
  }

  /** The parent's link-signing key, or null when the peer is not this node's parent. */
  private parentKey(peer: string): string | null {
    const nodes = this.deps.nodes;
    if (nodes.role() !== "child" || peer !== nodes.parentId()) return null;
    return nodes.member(peer)?.keys.sign ?? null;
  }

  private onPut(peer: string, message: Extract<LinkMessage, { type: "secrets-put" }>): void {
    const envelope = asSealed(message.envelope);
    const said = (message.envelope as { kind?: unknown } | undefined)?.kind;
    const kind = envelope?.kind ?? (typeof said === "string" ? said.slice(0, 64) : "");
    const seq = envelope?.seq ?? 0;
    const refuse = (error: string) => this.ack(peer, { kind, op: "put", seq, ok: false, digest: null, hint: null, error });
    const parentKey = this.parentKey(peer);
    if (!parentKey) return refuse("only this node's parent lends it secrets");
    if (!envelope) return refuse("that was not an envelope this node can read; update kururu here");
    const { sig, ...unsigned } = envelope;
    if (envelope.to !== this.me || envelope.from !== peer || !verifySigned(sealSigned(unsigned), sig, parentKey)) return refuse("the envelope is not the parent's, or not for this node");
    if (seq <= (this.held.seen[envelope.kind] ?? 0)) return refuse("an older push than one this node has already had");
    const spec = kindOf(envelope.kind)!;
    let value: unknown;
    try {
      value = unseal(envelope, boxPrivateKey(), identity().keys.box);
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err));
    }
    if (!checkValue(spec, value)) return refuse(`what arrived is not a ${spec.label.toLowerCase()} this kururu knows; update it here`);
    let placed: string | undefined;
    try {
      placed = this.write(spec, value);
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err));
    }
    const now = Date.now();
    const digest = digestOf(value);
    const hint = hintOf(spec, value);
    // Two kinds of one group land in one place, so the newer replaces the
    // older on the disk already; the record of the older goes with it.
    if (spec.group) for (const other of Object.keys(this.held.held)) if (other !== spec.id && kindOf(other)?.group === spec.group) delete this.held.held[other];
    const was = this.held.held[spec.id];
    this.held = {
      from: peer,
      held: { ...this.held.held, [spec.id]: { digest, seq, hint, since: was?.since ?? now, updated: now, ...(placed ? { placed } : {}) } },
      seen: { ...this.held.seen, [spec.id]: seq },
    };
    this.saveHeld();
    this.deps.log(`secrets: holding ${spec.id} from ${this.deps.nodes.member(peer)?.name ?? "the parent"} (${hint})`);
    this.deps.landed(spec);
    this.ack(peer, { kind: spec.id, op: "put", seq, ok: true, digest, hint, error: null });
    this.deps.changed();
  }

  /**
   * Write a kind where it lands, at `0600`, and read it back: a write that
   * did not happen must not be acknowledged as held. Returns the path, for
   * a kind written outside kururu's own directory.
   */
  private write(spec: KindSpec, value: unknown): string | undefined {
    if (spec.lands.in === "config") {
      const file = spec.lands.file;
      const next = landed(spec, value, readConfigFile(file));
      writeConfigFile(file, next, 0o600);
      if (JSON.stringify(readConfigFile(file)) !== JSON.stringify(next)) throw new Error(`could not write ~/.config/kururu/${file}`);
      return undefined;
    }
    // A Codex login, into the Codex home every pty here uses. Over a login
    // this node made itself it does not go: that is somebody's `codex
    // login`, and a grant is not a reason to sign it out.
    const home = codexHome("machine");
    const path = join(home, "auth.json");
    const ours = Object.values(this.held.held).some((entry) => entry.placed === path);
    if (existsSync(path) && !ours) throw new Error(`this node has a Codex login of its own in ${path}; run codex logout there first, or leave it unticked`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const temp = `${path}.kururu-tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    return path;
  }

  /** Remove a kind from where it landed, leaving what was the child's own. */
  private unwrite(spec: KindSpec, placed: string | undefined): void {
    if (spec.lands.in === "config") {
      const next = forgotten(spec, readConfigFile(spec.lands.file));
      if (next === null) removeConfigFile(spec.lands.file);
      else writeConfigFile(spec.lands.file, next, 0o600);
      return;
    }
    if (placed) rmSync(placed, { force: true });
  }

  private onForget(peer: string, message: Extract<LinkMessage, { type: "secrets-forget" }>): void {
    const spec = kindOf(message.kind);
    const seq = typeof message.seq === "number" ? message.seq : 0;
    const answer = (ok: boolean, error: string | null) => this.ack(peer, { kind: spec?.id ?? "", op: "forget", seq, ok, digest: null, hint: null, error });
    const parentKey = this.parentKey(peer);
    if (!parentKey || !spec) return answer(false, "only this node's parent takes its secrets back");
    if (typeof message.sig !== "string" || !verifySigned(forgetSigned(spec.id, peer, this.me, seq), message.sig, parentKey)) return answer(false, "the take-back is not the parent's");
    if (seq <= (this.held.seen[spec.id] ?? 0)) return answer(false, "an older take-back than a push this node has already had");
    const entry = this.held.held[spec.id];
    if (entry) this.unwrite(spec, entry.placed);
    const { [spec.id]: _gone, ...rest } = this.held.held;
    this.held = { from: this.held.from, held: rest, seen: { ...this.held.seen, [spec.id]: seq } };
    this.saveHeld();
    if (entry) {
      this.deps.log(`secrets: let go of ${spec.id}`);
      this.deps.landed(spec);
    }
    answer(true, null);
    this.deps.changed();
  }

  /** Everything held, gone: this node left the roster, or its parent is another now. */
  private forgetAll(why: string): void {
    const kinds = Object.keys(this.held.held);
    if (!kinds.length) return;
    for (const kind of kinds) {
      const spec = kindOf(kind);
      if (!spec) continue;
      try {
        this.unwrite(spec, this.held.held[kind]?.placed);
      } catch {
        // Gone already.
      }
      this.deps.landed(spec);
    }
    this.held = { from: null, held: {}, seen: {} };
    this.saveHeld();
    this.deps.log(`secrets: let go of ${kinds.length} secret${kinds.length === 1 ? "" : "s"} held from the parent: ${why}`);
    this.deps.changed();
  }

  /** On a child: who lent it this kind, and its hint; null for a kind this node holds of its own or not at all. */
  heldFrom(kind: string): { from: string; hint: string; since: number } | null {
    const entry = this.held.held[kind];
    if (!entry || this.deps.nodes.role() !== "child") return null;
    const parent = this.deps.nodes.parentId();
    return { from: (parent && this.deps.nodes.member(parent)?.name) || "the parent", hint: entry.hint, since: entry.since };
  }

  /** The sentence a page's setter throws on a child for a kind it holds. */
  refuseIfHeld(kind: string): void {
    const held = this.heldFrom(kind);
    if (held) throw new Error(`This is held from ${held.from}, which lends it; change it there, in Settings, and it is sent here within seconds.`);
  }

  // ---------------------------------------------------------------------------
  // What a client is told
  // ---------------------------------------------------------------------------

  view(): SecretsView {
    const nodes = this.deps.nodes;
    const role = nodes.role();
    const catalogue: CatalogueEntry[] = [];
    const grants: Record<string, GrantView[]> = {};
    const lends: ClaudeLend[] = [];
    if (role !== "child") {
      for (const kind of this.kinds()) {
        const spec = kindOf(kind)!;
        catalogue.push({ kind, family: spec.family, label: spec.label, unlocks: spec.unlocks, revoke: spec.revoke, follows: spec.follows, hint: this.sources.get(kind)?.hint ?? null });
      }
      for (const [login, entry] of Object.entries(readLends().tokens)) lends.push({ login, account: entry.account, hint: `…${entry.token.slice(-4)}`, at: entry.at });
    }
    if (role === "parent") {
      for (const [nodeId, records] of Object.entries(this.grants)) {
        if (!nodes.member(nodeId) || nodeId === this.me) continue;
        // Linked is enough to read as sending: a child that never says what
        // it holds is one from before secrets, and "sending" with no end is
        // the truth about it.
        const ready = nodes.linked(nodeId);
        grants[nodeId] = Object.entries(records).map(([kind, grant]) => {
          const spec = kindOf(kind)!;
          const source = this.sources.get(kind)?.digest ?? null;
          return {
            kind,
            on: grant.on,
            state: grantState({ grant, spec, source, ready }),
            hint: grant.hint,
            heldSince: grant.heldSince,
            error: grant.failed?.error ?? null,
            forgotAt: grant.forgotAt,
            older: !spec.follows && grant.holds !== null && source !== null && grant.holds.digest !== source,
          };
        });
      }
    }
    const parent = nodes.parentId();
    const held =
      role === "child"
        ? Object.entries(this.held.held).map(([kind, entry]) => ({ kind, label: kindOf(kind)?.label ?? kind, hint: entry.hint, since: entry.since, updated: entry.updated }))
        : [];
    return { catalogue, grants, held, heldFrom: role === "child" && parent ? (nodes.member(parent)?.name ?? null) : null, lends };
  }
}
