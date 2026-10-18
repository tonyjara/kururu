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
 * **A project's own secrets** go the same road: a workspace's env files, an
 * ssh Host entry and its key, a GitHub login (`shared/vault.ts` has their
 * rules, `vault.ts` their disk). An env file is lent to one node, into the
 * checkout there the node itself said will do, and its kind is made from
 * the two — so where it lands is part of what is digested and a new folder
 * is a push like a new key. Its lend outlives the workspace here, which is
 * the point: a project moved to the node keeps its env files following
 * the Mac's.
 *
 * On the restartable side, with nothing near a pty: a lent Claude token
 * and a lent GitHub login reach a pty through `logins.ts`, read at spawn.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLoginKey } from "../../shared/model";
import { tilde, type MoveCheck } from "../../shared/move";
import type { LinkMessage } from "../../shared/nodes";
import {
  adoptEnvLends,
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
  type EnvLend,
  type EnvValue,
  type GrantRecord,
  type GrantView,
  type HeldFile,
  type Holding,
  type KindSpec,
  type LendAsk,
  type LendCandidate,
  type Lendable,
  type SecretsView,
} from "../../shared/secrets";
import { envHint, sshHint, type GhValue, type SshValue } from "../../shared/vault";
import { configDir, configPath, readConfigFile, removeConfigFile, writeConfigFile } from "./config";
import { codexDirFor } from "./logins";
import { boxPrivateKey, identity, signAsNode, verifySigned } from "./nodekeys";
import type { NodeHost } from "./nodes";
import { digestOf, seal, unseal } from "./seal";
import {
  envKind,
  envStamp,
  findEnvFiles,
  ghAccountsHere,
  ghHostsPath,
  ghToken,
  hostsMentioned,
  placeEnv,
  placeGh,
  placeSsh,
  readEnvSource,
  readSshSource,
  remoteOwnerOf,
  removeGh,
  removeSsh,
  sshHosts,
  sshStamp,
  stampOf,
} from "./vault";

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
  /** The home `~/.ssh` and gh's config are under, on either side. The process's own when not given; a test gives each side its own. */
  home?: string;
  /** A GitHub account's token, read now. `gh auth token` when not given; a test gives a stand-in rather than run gh. */
  ghToken?: (account: string) => string | null;
}

/**
 * Families that are listed by being there and read only once lent to some
 * node: a Codex login is Codex's file, an ssh key is the user's, a gh
 * token is in the Keychain. Kururu otherwise never reads any of them.
 */
const LISTED_UNTIL_LENT = new Set(["codex-auth", "ssh", "gh"]);

/** The Codex home a login uses: `machine` is the default one, as every pty without a profile login has it. */
function codexHome(login: string): string {
  if (login === "machine") return process.env.CODEX_HOME || join(homedir(), ".codex");
  return codexDirFor(login);
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

  /** The env files lent, by kind: where each is read here and where it goes there. */
  private envLends: Record<string, EnvLend>;

  // --- a child's -------------------------------------------------------------
  private held: HeldFile;

  constructor(private readonly deps: SecretsDeps) {
    const raw = readConfigFile(GRANTS_FILE) as { lastSeq?: unknown } | null;
    this.grants = adoptGrants(raw);
    this.envLends = adoptEnvLends(raw);
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

  private get home(): string {
    return this.deps.home ?? homedir();
  }

  /** What a kind is on the parent's disk this moment, or null. Read, used, dropped. */
  private readSource(spec: KindSpec): unknown {
    switch (spec.source.in) {
      case "config":
        return readConfigFile(spec.source.file);
      case "codex-home":
        try {
          return JSON.parse(readFileSync(join(codexHome(spec.login ?? "machine"), "auth.json"), "utf8")) as unknown;
        } catch {
          return null;
        }
      case "project": {
        const lend = this.envLends[spec.id];
        return lend ? readEnvSource(lend) : null;
      }
      case "ssh":
        return readSshSource(this.home, spec.id.slice("ssh:".length));
      case "gh": {
        const account = spec.id.slice("gh:".length);
        const token = this.deps.ghToken ? this.deps.ghToken(account) : ghToken(this.home, account);
        return token ? ({ account, token } satisfies GhValue) : null;
      }
    }
  }

  /** What moves when a kind should be read again: its file's mtime and size, or the files it is made of. */
  private stampOf(spec: KindSpec): string {
    switch (spec.source.in) {
      case "config":
        return stampOf(configPath(spec.source.file));
      case "codex-home":
        return stampOf(join(codexHome(spec.login ?? "machine"), "auth.json"));
      case "project": {
        const lend = this.envLends[spec.id];
        return lend ? envStamp(lend) : "";
      }
      case "ssh":
        return sshStamp(this.home, spec.id.slice("ssh:".length));
      case "gh":
        return stampOf(ghHostsPath(this.home));
    }
  }

  /**
   * The hint a kind is listed by before it is lent anywhere, or null when it
   * is not here: read without the secret, since until then kururu has no
   * business reading it.
   */
  private listedHint(spec: KindSpec): string | null {
    switch (spec.family) {
      case "codex-auth":
        return existsSync(join(codexHome(spec.login ?? "machine"), "auth.json")) ? "signed in" : null;
      case "ssh": {
        const host = sshHosts(this.home).find((h) => h.alias === spec.id.slice("ssh:".length));
        return host?.keyPath ? sshHint(host.alias, host.keyPath.split("/").pop()!, null) : null;
      }
      case "gh": {
        const account = ghAccountsHere(this.home).find((a) => a.account === spec.id.slice("gh:".length));
        return account ? `${account.account}${account.active ? " · gh's active account" : ""}` : null;
      }
      default:
        return null;
    }
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
    for (const host of sshHosts(this.home)) kinds.add(`ssh:${host.alias}`);
    for (const { account } of ghAccountsHere(this.home)) kinds.add(`gh:${account}`);
    for (const kind of Object.keys(this.envLends)) kinds.add(kind);
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
    // A node gone from the roster takes its grants with it, now rather than
    // at the next save: its id is kept in its own `node.json`, so a node
    // removed and joined again would otherwise be sent everything it was
    // lent before, when joining again is meant to start from nothing.
    if (role === "parent" && Object.keys(this.grants).some((node) => !this.deps.nodes.member(node))) {
      for (const node of Object.keys(this.grants)) if (!this.deps.nodes.member(node)) this.reported.delete(node);
      this.saveGrants();
      this.deps.changed();
    }
    const kinds = this.kinds();
    let moved = false;
    const seen = new Set<string>();
    for (const kind of kinds) {
      const spec = kindOf(kind)!;
      seen.add(kind);
      const now = this.stampOf(spec);
      if (this.stamps.get(kind) === now) continue;
      this.stamps.set(kind, now);
      // A Codex login is Codex's file, which kururu otherwise only stats
      // (`codexusage.ts`), an ssh key is the user's and a gh token is the
      // Keychain's: each is read once somebody has switched it on for a
      // node, and until then listed by being there.
      if (LISTED_UNTIL_LENT.has(spec.family) && !this.lentAnywhere(kind)) {
        const before = this.sources.get(kind);
        const hint = this.listedHint(spec);
        if (hint === null) {
          if (before) {
            this.sources.delete(kind);
            moved = true;
          }
        } else if (before?.digest !== "unread" || before.hint !== hint) {
          this.sources.set(kind, { digest: "unread", hint });
          moved = true;
        }
        continue;
      }
      const value = extract(spec, this.readSource(spec));
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

  private lentAnywhere(kind: string): boolean {
    return Object.values(this.grants).some((grants) => grants[kind]?.on === true);
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
    // An env lend goes with its grant: one nobody holds, ticked or took back is nothing to keep.
    const env: Record<string, EnvLend> = {};
    for (const [kind, lend] of Object.entries(this.envLends)) if (nodes[lend.node]?.[kind]) env[kind] = lend;
    this.envLends = env;
    writeConfigFile(GRANTS_FILE, { nodes, lastSeq: this.lastSeq, env }, 0o600);
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
    if (spec.perNode && this.envLends[spec.id]?.node !== nodeId) throw new Error("That env file is lent to another node, or to none; lend it from the workspace.");
    this.setGrants(nodeId, [spec], on);
    this.reconcile(nodeId, true);
    this.deps.changed();
    return this.view();
  }

  /** Tick or untick some kinds for a node, saved, looked at afresh and logged; pushing is the caller's. */
  private setGrants(nodeId: string, specs: KindSpec[], on: boolean): void {
    // Looked at first, so a key written a moment ago is there to lend.
    this.look();
    for (const spec of specs) if (on && !this.sources.has(spec.id)) throw new Error(`This Mac has no ${spec.family === "env" ? `${this.envLends[spec.id]?.file ?? "such env file"}` : spec.label.toLowerCase()} to lend. Set it here first.`);
    let grants = this.grants[nodeId] ?? {};
    for (const spec of specs) grants = withGrant(grants, spec.id, on, Date.now());
    this.grants[nodeId] = grants;
    this.saveGrants();
    const name = this.deps.nodes.member(nodeId)?.name ?? nodeId;
    for (const spec of specs) this.deps.log(`secrets: ${this.nameOf(spec)} ${on ? "lent to" : "taken back from"} ${name}`);
    // Read afresh: a Codex login, an ssh key and a gh token are only read once they are lent somewhere.
    for (const spec of specs) this.stamps.delete(spec.id);
    this.look();
  }

  /** How a kind is named in a log line: its id, and for an env file which file of which workspace. Never a value. */
  private nameOf(spec: KindSpec): string {
    const lend = this.envLends[spec.id];
    return lend ? `${spec.id} (${lend.file} of ${lend.workspace || lend.from})` : spec.id;
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

  // ---------------------------------------------------------------------------
  // The parent: a project's secrets, for one node
  // ---------------------------------------------------------------------------

  /** How one kind stands for one node, as the page draws it, or null when it was never lent there. */
  private grantViewOf(nodeId: string, kind: string): GrantView | null {
    const grant = this.grants[nodeId]?.[kind];
    const spec = kindOf(kind);
    if (!grant || !spec) return null;
    const source = this.sources.get(kind)?.digest ?? null;
    return {
      kind,
      on: grant.on,
      state: grantState({ grant, spec, source, ready: this.deps.nodes.linked(nodeId) }),
      hint: grant.hint,
      heldSince: grant.heldSince,
      error: grant.failed?.error ?? null,
      forgotAt: grant.forgotAt,
      older: !spec.follows && grant.holds !== null && source !== null && grant.holds.digest !== source,
    };
  }

  /**
   * What a workspace could lend a node: the env files in its checkout here,
   * every ssh entry and GitHub login this Mac has — the ones this project
   * looks like it needs first, and why. `root` is the checkout the server
   * found for the workspace, never a path a client sent; `pinned` is the
   * machine its shells are pinned to, which is a host it plainly needs.
   * Env files are read for their count of variables and dropped; keys and
   * tokens are not read at all.
   */
  offer(input: {
    node: { id: string; name: string };
    workspace: { id: string; name: string };
    root: string | null;
    pinned: string | null;
    check: MoveCheck | null;
    checkError: string | null;
  }): Lendable {
    if (!this.isParent()) throw new Error("Only the parent lends secrets, and this node is not it.");
    this.look();
    const { node, root } = input;
    const env: LendCandidate[] = [];
    if (root) {
      for (const file of findEnvFiles(root)) {
        const kind = envKind(node.id, root, file);
        const value = readEnvSource({ node: node.id, from: root, file, to: root, workspace: input.workspace.name });
        env.push({ kind, name: file, hint: value ? envHint(root, file, value.text) : null, note: value ? null : "too big to be an env file, or not readable", why: null, grant: this.grantViewOf(node.id, kind) });
      }
    }
    const hosts = sshHosts(this.home);
    const mentioned = root ? hostsMentioned(root, hosts.map((h) => h.alias)) : new Map<string, string>();
    const ssh: LendCandidate[] = hosts
      .filter((host) => kindOf(`ssh:${host.alias}`))
      .map((host) => {
        const kind = `ssh:${host.alias}`;
        const itself = host.alias.toLowerCase() === node.name.toLowerCase();
        const why = itself ? null : input.pinned === host.alias ? "its shells are pinned to it" : mentioned.has(host.alias) ? `${mentioned.get(host.alias)} names it` : null;
        return { kind, name: host.alias, hint: this.sources.get(kind)?.hint ?? null, note: host.note, why, grant: this.grantViewOf(node.id, kind) };
      });
    const owner = root ? remoteOwnerOf(root) : null;
    const accounts = ghAccountsHere(this.home);
    const github: LendCandidate[] = accounts.map(({ account, active }) => {
      const kind = `gh:${account}`;
      const why = owner && owner.toLowerCase() === account.toLowerCase() ? "it owns the checkout's origin on github.com" : !owner && active ? "gh's active account here" : null;
      return { kind, name: account, hint: this.sources.get(kind)?.hint ?? account, note: null, why, grant: this.grantViewOf(node.id, kind) };
    });
    const first = (a: LendCandidate, b: LendCandidate) => Number(b.why !== null) - Number(a.why !== null);
    return {
      node,
      workspace: input.workspace,
      from: root ? tilde(root, this.home) : null,
      check: input.check,
      checkError: input.checkError,
      env,
      ssh: ssh.sort(first),
      github: github.sort(first),
    };
  }

  /**
   * Lend a node what was asked of a workspace's: its env files into `to`,
   * the checkout the node said will do, and the ssh entries and GitHub login
   * named. Every env file of this checkout already lent to the node is
   * pointed at `to` as well, so one project never lands in two places.
   * Nothing named is taken back: unticking is `grant`'s.
   */
  lendProject(nodeId: string, input: { root: string | null; to: string | null; workspace: string }, ask: LendAsk): { view: SecretsView; lent: string[] } {
    if (!this.isParent()) throw new Error("Only the parent lends secrets, and this node is not it.");
    const member = this.deps.nodes.member(nodeId);
    if (nodeId === this.me || !member) throw new Error("That node is not in the roster.");
    const specs: KindSpec[] = [];
    const lent: string[] = [];
    if (ask.env.length) {
      const { root, to } = input;
      if (!root) throw new Error("This workspace is in no checkout here, so it has no env files to lend.");
      if (!to) throw new Error(`Which folder on ${member.name}? Its env files go into the project's checkout there.`);
      const found = new Set(findEnvFiles(root));
      for (const file of ask.env) if (!found.has(file)) throw new Error(`${file} is not an env file in ${tilde(root, this.home)}.`);
      for (const [kind, lend] of Object.entries(this.envLends)) if (lend.node === nodeId && lend.from === root) this.envLends[kind] = { ...lend, to };
      for (const file of ask.env) {
        const kind = envKind(nodeId, root, file);
        this.envLends[kind] = { node: nodeId, from: root, file, to, workspace: input.workspace.slice(0, 60) };
        specs.push(kindOf(kind)!);
        lent.push(file);
      }
    }
    for (const alias of ask.ssh) {
      const spec = kindOf(`ssh:${alias}`);
      const host = sshHosts(this.home).find((h) => h.alias === alias);
      if (!spec || !host) throw new Error(`This Mac's ~/.ssh/config has no Host ${alias}.`);
      if (host.note) throw new Error(`Host ${alias} cannot be lent: ${host.note}.`);
      specs.push(spec);
      lent.push(`ssh ${alias}`);
    }
    if (ask.github) {
      const spec = kindOf(`gh:${ask.github}`);
      if (!spec || !ghAccountsHere(this.home).some((a) => a.account === ask.github)) throw new Error(`gh on this Mac is not signed in as ${ask.github}.`);
      specs.push(spec);
      lent.push(`GitHub ${ask.github}`);
    }
    if (!specs.length) return { view: this.view(), lent };
    this.setGrants(nodeId, specs, true);
    this.reconcile(nodeId, true);
    this.deps.changed();
    return { view: this.view(), lent };
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
    const value = extract(spec, this.readSource(spec));
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
    switch (spec.lands.in) {
      case "config": {
        const file = spec.lands.file;
        const next = landed(spec, value, readConfigFile(file));
        writeConfigFile(file, next, 0o600);
        if (JSON.stringify(readConfigFile(file)) !== JSON.stringify(next)) throw new Error(`could not write ~/.config/kururu/${file}`);
        return undefined;
      }
      case "project":
        return placeEnv(value as EnvValue, this.home, (path) => this.placedHere(path), this.held.held[spec.id]?.placed);
      case "ssh":
        return placeSsh(value as SshValue, this.home, this.parentName());
      case "gh":
        return placeGh(value as GhValue, configDir());
      case "codex-home":
        break;
    }
    // A Codex login, into the Codex home every pty here uses. Over a login
    // this node made itself it does not go: that is somebody's `codex
    // login`, and a grant is not a reason to sign it out.
    const home = codexHome("machine");
    const path = join(home, "auth.json");
    if (existsSync(path) && !this.placedHere(path)) throw new Error(`this node has a Codex login of its own in ${path}; run codex logout there first, or leave it unticked`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const temp = `${path}.kururu-tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    return path;
  }

  /** Whether this node put the file at that path there, from a push: what it may write over and remove. */
  private placedHere(path: string): boolean {
    return Object.values(this.held.held).some((entry) => entry.placed === path);
  }

  private parentName(): string {
    const parent = this.deps.nodes.parentId();
    return (parent && this.deps.nodes.member(parent)?.name) || "the parent";
  }

  /** Remove a kind from where it landed, leaving what was the child's own. */
  private unwrite(spec: KindSpec, placed: string | undefined): void {
    switch (spec.lands.in) {
      case "config": {
        const next = forgotten(spec, readConfigFile(spec.lands.file));
        if (next === null) removeConfigFile(spec.lands.file);
        else writeConfigFile(spec.lands.file, next, 0o600);
        return;
      }
      case "ssh":
        removeSsh(this.home, spec.id.slice("ssh:".length));
        return;
      case "gh":
        removeGh(configDir());
        return;
      case "project":
      case "codex-home":
        if (placed) rmSync(placed, { force: true });
    }
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
      const hosts = new Map<string, { note: string | null }>(sshHosts(this.home).map((host) => [`ssh:${host.alias}`, host]));
      for (const kind of this.kinds()) {
        const spec = kindOf(kind)!;
        const lend = this.envLends[kind];
        catalogue.push({
          kind,
          family: spec.family,
          label: spec.label,
          unlocks: spec.unlocks,
          revoke: spec.revoke,
          follows: spec.follows,
          hint: this.sources.get(kind)?.hint ?? null,
          note: hosts.get(kind)?.note ?? null,
          project: lend ? { node: lend.node, workspace: lend.workspace, file: lend.file, from: tilde(lend.from, this.home), to: lend.to } : null,
        });
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
