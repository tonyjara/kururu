/**
 * Every kururu is a node: what one is, what the roster that says who belongs
 * says, how two of them prove themselves to each other, and what one tells
 * the others about itself.
 *
 * It exists because a second kururu — a child on a box that stays on while
 * the Mac's lid is shut — is only useful if the two can see each other, and
 * the obvious ways of letting them were each wrong somewhere. Sharing one
 * database is a merge problem `docs/data.md` was written to avoid. Handing
 * each child the Mac's share token gives a box other programs run on a shell
 * on the Mac. Trusting the tailnet alone lets every device on it in. So the
 * arrangement is the one in `docs/plans/kururu-parent-child.md`: **the Mac
 * signs a roster, and a key the roster lists is a member.** Two nodes that
 * have never met prove their keys to each other and trust the Mac's
 * signature, and there are no per-pair tokens anywhere to mint, leak or
 * rotate.
 *
 * What crosses between them is a *summary*, never a copy: each node pushes
 * what its own `kururu_status` would say, as data, and the others draw it
 * under a heading of its name. Nothing structural is synchronised, so there
 * is nothing to merge.
 *
 * Pure, in `shared/`, because both halves need the shapes and every rule
 * here is one worth testing as arithmetic: whether a roster is adopted, who
 * leads, which code is accepted, what the handshake does with each message.
 * The crypto is passed in — `node:crypto` on the server, a real key pair in
 * the test — so nothing here imports a runtime.
 */
import type { PeerWho, TurnOrigin } from "./channels";
import { cardCode } from "./board";
import { agentName } from "./harness";
import type { KuruItem } from "./kuru";
import type { AgentSnapshot, Profile } from "./model";
import type { OutboxState } from "./voice";
import { needsOf, type Band, type NeedKind } from "./needs";
import { panes, terminalsOf } from "./layout";
import type { MoveCheck, MoveCheckAsk, MoveDone, MoveOffer } from "./move";
import type { SealedSecret } from "./secrets";

/**
 * The link's own version, said in `hello`. Bumped when a message changes
 * shape in a way an older node would misread; a node refuses a peer that
 * speaks a different one rather than guess, and says which is behind.
 */
export const LINK_PROTOCOL = 1;

/** Every link pings this often, whether or not anything else is said. */
export const PING_MS = 5_000;
/**
 * A node is away after this much silence. A sleeping Mac sends no FIN, so
 * the socket itself never says it is gone; silence is the only signal.
 * Five pings, so one dropped packet or a slow event loop is not an absence —
 * and twenty-five seconds rather than thirty because the silence is looked
 * at once a ping, so the moment it is noticed can be a ping late, and "away
 * within thirty seconds of the lid closing" is the promise.
 */
export const AWAY_MS = 25_000;
/** How long a join command's code is good for. */
export const CODE_TTL_MS = 10 * 60_000;
/** Wrong guesses a code survives before it is burnt and a new one is wanted. */
export const CODE_ATTEMPTS = 5;
/**
 * Eight, because the code travels inside a command that is copied, not
 * typed, so length costs nobody anything: thirty-one symbols to eight places
 * is about 852 billion, against five tries.
 */
export const CODE_LENGTH = 8;
/**
 * No 0/O, 1/I/L, for the day it is read aloud or typed off a phone after
 * all: the letters a person confuses are the letters that cost a retry.
 */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const NODE_NAME_MAX = 24;

// ---------------------------------------------------------------------------
// Members and the roster
// ---------------------------------------------------------------------------

/**
 * A node's public keys, base64 of the raw 32 bytes each. `sign` is Ed25519,
 * for the link's handshake; `box` is X25519, for the sealed secrets phase 4
 * pushes, made now so that phase does not have to re-enrol anybody.
 */
export interface NodeKeys {
  sign: string;
  box: string;
}

/** One member, as the roster lists it. */
export interface NodeEntry {
  /** Random and permanent; a rename does not change it. */
  id: string;
  /** Short, lowercase, what `@omarchy` will address. Unique in a roster. */
  name: string;
  keys: NodeKeys;
  /** Where the others dial it: a tailnet address or a MagicDNS name. */
  address: string;
  port: number;
  /** 1 is first. The highest-ranked reachable node leads. */
  rank: number;
}

/**
 * Who belongs, signed by the parent. Kept whole and passed along whole:
 * every node keeps the newest version it has seen and hands it to every
 * peer it links to, so a change reaches a node the Mac cannot see through
 * one it can.
 *
 * The signature is over every field of the object *as received*, extra
 * fields included, so a later phase can add the channel settings here
 * without an older node stripping them before it checks — which would fail
 * the check, or worse, pass it on a roster it then forwards cut down.
 */
export interface Roster {
  version: number;
  /** The parent's node id. It is always a member. */
  parent: string;
  /** The parent's roster-signing public key, Ed25519, base64 raw. Never changes. */
  signer: string;
  members: NodeEntry[];
  issuedAt: number;
}

export interface SignedRoster {
  roster: Roster;
  /** Ed25519 over `rosterPayload(roster)`, base64. */
  signature: string;
}

export type Verify = (payload: string, signature: string, publicKey: string) => boolean;
export type Sign = (payload: string) => string;

/**
 * JSON with its object keys sorted, at every depth, so the bytes signed on
 * one node are the bytes checked on another whatever order either built
 * the object in.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** What the parent signs. Prefixed, so a roster signature can never be passed off as a link proof or the other way round. */
export function rosterPayload(roster: Roster): string {
  return `kururu-roster-v1\n${canonical(roster)}`;
}

const B64_KEY = /^[A-Za-z0-9+/]{43}=$/;
const NODE_ID = /^n[0-9a-f]{12}$/;

export function isNodeId(value: unknown): value is string {
  return typeof value === "string" && NODE_ID.test(value);
}

function isKey(value: unknown): value is string {
  return typeof value === "string" && B64_KEY.test(value);
}

function isEntry(raw: unknown): raw is NodeEntry {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as Record<string, unknown>;
  const keys = e.keys as Record<string, unknown> | undefined;
  return (
    isNodeId(e.id) &&
    typeof e.name === "string" &&
    nodeName(e.name) === e.name &&
    !!keys &&
    isKey(keys.sign) &&
    isKey(keys.box) &&
    typeof e.address === "string" &&
    validHostName(e.address) &&
    typeof e.port === "number" &&
    Number.isInteger(e.port) &&
    e.port > 0 &&
    e.port < 65536 &&
    typeof e.rank === "number" &&
    Number.isInteger(e.rank) &&
    e.rank >= 1
  );
}

/**
 * The shape, checked: what a roster off the wire or the disk must be before
 * its signature is worth checking. The object returned is the one given,
 * not a copy, for the reason `Roster` gives.
 */
export function asSignedRoster(raw: unknown): SignedRoster | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const r = s.roster as Record<string, unknown> | undefined;
  if (typeof s.signature !== "string" || !r || typeof r !== "object") return null;
  if (typeof r.version !== "number" || !Number.isInteger(r.version) || r.version < 1) return null;
  if (!isNodeId(r.parent) || !isKey(r.signer) || typeof r.issuedAt !== "number" || !Number.isFinite(r.issuedAt)) return null;
  if (!Array.isArray(r.members) || r.members.length === 0 || r.members.length > 64 || !r.members.every(isEntry)) return null;
  const members = r.members as NodeEntry[];
  const ids = new Set(members.map((m) => m.id));
  const names = new Set(members.map((m) => m.name));
  if (ids.size !== members.length || names.size !== members.length) return null;
  if (!ids.has(r.parent)) return null;
  return raw as SignedRoster;
}

export type Adoption =
  | { adopted: true; roster: SignedRoster }
  | { adopted: false; why: "malformed" | "stranger" | "forged" | "older" | "same" };

/**
 * Whether to take a roster that arrived, over the one held.
 *
 * Newest wins, and only a roster the anchor signed is a candidate. The
 * anchor is the parent's signing key, learnt once at pairing — trust on
 * first use, made safe by the code the user carried between two screens —
 * and on the parent it is its own key. A node with no anchor yet (one being
 * paired) passes null and takes whatever `signer` the roster names, which
 * the caller only does with a valid code in hand.
 */
export function adoptRoster(current: SignedRoster | null, incoming: unknown, anchor: string | null, verify: Verify): Adoption {
  const signed = asSignedRoster(incoming);
  if (!signed) return { adopted: false, why: "malformed" };
  if (anchor !== null && signed.roster.signer !== anchor) return { adopted: false, why: "stranger" };
  if (!verify(rosterPayload(signed.roster), signed.signature, signed.roster.signer)) return { adopted: false, why: "forged" };
  if (current) {
    if (signed.roster.version < current.roster.version) return { adopted: false, why: "older" };
    if (signed.roster.version === current.roster.version) return { adopted: false, why: "same" };
  }
  return { adopted: true, roster: signed };
}

export function memberOf(roster: Roster | null | undefined, id: string): NodeEntry | undefined {
  return roster?.members.find((m) => m.id === id);
}

/** The members by rank, first first; the id breaks a tie a hand-edited file could make. */
export function byRank(members: readonly NodeEntry[]): NodeEntry[] {
  return [...members].sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1));
}

/**
 * The members this node dials: every one ranked above it. The lower rank
 * dials the higher, so each pair has one dialer and one socket, and the
 * first-ranked node — the Mac, by default — dials nobody and only listens.
 */
export function dialTargets(roster: Roster | null, self: string): NodeEntry[] {
  const me = memberOf(roster, self);
  if (!roster || !me) return [];
  const order = byRank(roster.members);
  const at = order.findIndex((m) => m.id === self);
  return order.slice(0, at);
}

/**
 * Who leads: the highest-ranked of this node and the nodes it can reach.
 * Every node works this out for itself from its own links, which is what
 * makes a child that can reach nothing above it the leader of what it can
 * reach. Null for a node in no roster.
 */
export function leaderOf(roster: Roster | null, reachable: ReadonlySet<string>, self: string): string | null {
  if (!roster || !memberOf(roster, self)) return null;
  return byRank(roster.members).find((m) => m.id === self || reachable.has(m.id))?.id ?? null;
}

/**
 * The parent's edits, each one a new unsigned roster one version on. Ranks
 * are renumbered 1…n every time, so a gap a removal leaves never makes two
 * rosters that mean the same order look different.
 */
function next(roster: Roster, members: readonly NodeEntry[], now: number): Roster {
  return {
    ...roster,
    version: roster.version + 1,
    issuedAt: now,
    members: byRank(members).map((m, i) => ({ ...m, rank: i + 1 })),
  };
}

export function withMember(roster: Roster, entry: Omit<NodeEntry, "rank">, now: number): Roster {
  const others = roster.members.filter((m) => m.id !== entry.id);
  const was = memberOf(roster, entry.id);
  const rank = was?.rank ?? Math.max(0, ...others.map((m) => m.rank)) + 1;
  return next(roster, [...others, { ...entry, rank }], now);
}

export function withoutMember(roster: Roster, id: string, now: number): Roster {
  return next(
    roster,
    roster.members.filter((m) => m.id !== id),
    now,
  );
}

export function withChange(roster: Roster, id: string, change: Partial<Pick<NodeEntry, "name" | "address" | "port">>, now: number): Roster {
  return next(
    roster,
    roster.members.map((m) => (m.id === id ? { ...m, ...change } : m)),
    now,
  );
}

/** A new order, as the ids the drag left. An id it does not name keeps its place after the named ones. */
export function reranked(roster: Roster, order: readonly string[], now: number): Roster {
  const named = order.filter((id, i) => order.indexOf(id) === i && memberOf(roster, id));
  const rest = byRank(roster.members).filter((m) => !named.includes(m.id));
  const members = [...named.map((id) => memberOf(roster, id)!), ...rest].map((m, i) => ({ ...m, rank: i + 1 }));
  return next(roster, members, now);
}

/** A name as it may be stored: lowercase letters, digits and dashes, starting with a letter. Null when nothing is left. */
export function nodeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+/g, "-")
    .slice(0, NODE_NAME_MAX)
    .replace(/-+$/, "");
  return name || null;
}

/**
 * What a node calls itself before anybody renames it. The Mac is "mac",
 * because a Mac's hostname is "Somebodys-MacBook-Pro" and nobody wants to
 * type that after an `@`; anything else is the first label of its hostname,
 * which on a box set up by hand is already the name the user uses.
 */
export function defaultNodeName(hostname: string, platform: string): string {
  if (platform === "darwin") return "mac";
  return nodeName(hostname.split(".")[0] ?? "") ?? "node";
}

/** A name not taken in the roster, by adding -2, -3… */
export function freeName(roster: Roster | null, wanted: string, except?: string): string {
  const taken = new Set((roster?.members ?? []).filter((m) => m.id !== except).map((m) => m.name));
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) {
    const tail = `-${n}`;
    const name = `${wanted.slice(0, NODE_NAME_MAX - tail.length)}${tail}`;
    if (!taken.has(name)) return name;
  }
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** Tailscale's range, 100.64.0.0/10. */
export function isTailnetAddress(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return false;
  const [a, b] = parts.map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

function isLoopback(ip: string): boolean {
  return ip === "::1" || ip.startsWith("127.");
}

/**
 * Whether a request to a node's own routes — joining and the link — came
 * from where a node could be: the tailnet, or this machine. Loopback is in
 * because two isolated instances on one machine are how this is tested,
 * and a process on the box gains nothing by it: joining still wants the
 * code and the link still wants a key the roster lists.
 */
export function nodeRemoteAllowed(remote: string | undefined): boolean {
  if (!remote) return false;
  const bare = remote.replace(/^::ffff:/, "");
  return isTailnetAddress(bare) || isLoopback(bare);
}

/**
 * Headers a proxy adds. A node's routes refuse any request carrying one,
 * because `tailscale serve` in front of a child delivers everything from
 * loopback and the address check above would otherwise wave it through.
 * The same list `/mcp/web` refuses on.
 */
export const FORWARDING_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "tailscale-user-login"] as const;

/** An IPv4 address or a DNS name (a MagicDNS one, usually). Not a URL, not a path, nothing with a space. */
export function validHostName(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host.split(".").every((p) => Number(p) <= 255);
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(host);
}

/**
 * What the user typed into "address" on the parent, as a host and a port:
 * `100.96.1.2`, `100.96.1.2:7717`, `box1`, or the whole URL off the
 * child's Share page, query and all. Null for anything else.
 */
export function parseNodeAddress(raw: unknown, defaultPort: number): { address: string; port: number } | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (!text) return null;
  if (!/^[a-z]+:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.username || url.password) return null;
  const address = url.hostname.replace(/^\[|\]$/g, "");
  if (!validHostName(address)) return null;
  const port = url.port ? Number(url.port) : defaultPort;
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  return { address, port };
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/**
 * Pairing starts on the Mac, which shows one command to run on the new PC:
 * `kururu child join <the Mac's address> <a code>`. It was the other way
 * round first — the PC showed a code, and the person typed it and the PC's
 * address into the Mac — and nobody could tell from the page what the code
 * was for, where to get it, or where to type it. Both directions trust the
 * same thing: a short-lived, single-use code that only the person carried
 * between the two screens, and after that only keys the roster lists. This
 * one is a copy and a paste, and the person never has to know an address.
 */

/** The join code the Mac is showing, and what has happened to it. */
export interface Pairing {
  code: string;
  expiresAt: number;
  /** Wrong codes presented against it so far. */
  misses: number;
}

/** Six symbols out of `CODE_ALPHABET`, from random bytes the caller supplies. The modulo bias over 256 is under one part in eight and does not matter against five tries. */
export function makeCode(random: Uint8Array): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[(random[i] ?? 0) % CODE_ALPHABET.length];
  return code;
}

/** What a person typed, as a code: case and the dash or spaces they put in the middle do not matter. */
export function normalizeCode(raw: unknown): string {
  return typeof raw === "string" ? raw.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}

/** `ABCD-EFGH`, which is how it is shown. */
export function formatCode(code: string): string {
  return code.length === CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** The command the Mac shows, to run on the new PC. */
export function joinCommand(address: string, port: number, code: string): string {
  return `kururu child join ${address}:${port} ${formatCode(code)}`;
}

/**
 * The Mac's address and the code, out of what was pasted: the whole command
 * (`kururu child join 100.64.0.1:7717 ABCD-EFGH`, with `node tools/kururu.mjs`
 * in front of it too), or just the two words. Null for anything else.
 */
export function parseJoin(text: unknown, defaultPort: number): { address: string; port: number; code: string } | null {
  if (typeof text !== "string") return null;
  const words = text.trim().split(/\s+/).filter(Boolean);
  const at = words.lastIndexOf("join");
  const rest = at === -1 ? words : words.slice(at + 1);
  if (rest.length !== 2) return null;
  const target = parseNodeAddress(rest[0], defaultPort);
  const code = normalizeCode(rest[1]);
  if (!target || code.length !== CODE_LENGTH) return null;
  return { ...target, code };
}

export type CodeCheck = { ok: true } | { ok: false; why: "none" | "expired" | "wrong" | "burnt"; pairing: Pairing | null };

/**
 * A code presented against the one showing. Compared in constant time; a
 * miss counts, and the fifth burns the code, so guessing costs the guesser
 * a new code from the user each time — which is the user noticing.
 */
export function checkCode(pairing: Pairing | null, given: unknown, now: number): CodeCheck {
  if (!pairing) return { ok: false, why: "none", pairing: null };
  if (now >= pairing.expiresAt) return { ok: false, why: "expired", pairing: null };
  const code = normalizeCode(given);
  let diff = code.length ^ pairing.code.length;
  for (let i = 0; i < pairing.code.length; i++) diff |= (code.charCodeAt(i) || 0) ^ pairing.code.charCodeAt(i);
  if (diff === 0) return { ok: true };
  const misses = pairing.misses + 1;
  if (misses >= CODE_ATTEMPTS) return { ok: false, why: "burnt", pairing: null };
  return { ok: false, why: "wrong", pairing: { ...pairing, misses } };
}

/** Why the Mac refused a join, said to the person at the new PC. */
export function codeRefusal(why: "none" | "expired" | "wrong" | "burnt"): string {
  switch (why) {
    case "none":
      return "The Mac is not showing a join command right now. On the Mac, open Settings → Nodes, press Add a computer, and run the command it shows.";
    case "expired":
      return "That command has expired; they last ten minutes. Press Add a computer on the Mac again for a new one.";
    case "burnt":
      return "Too many wrong codes, so that command no longer works. Press Add a computer on the Mac again for a new one.";
    case "wrong":
      return "That code is not the one the Mac is showing. Copy the command from the Mac again.";
  }
}

// ---------------------------------------------------------------------------
// What a node says about itself
// ---------------------------------------------------------------------------

/** An agent, as another node draws it: a snapshot without the parts that are about this machine's processes. */
export type SummaryAgent = Omit<AgentSnapshot, "pid" | "command" | "rss" | "made"> & {
  /** The card it is running, when one claims it. */
  card: { id: string; number: number; title: string; column: string } | null;
};

export interface SummaryNeed {
  kind: NeedKind;
  agentId: string | null;
  cardId: string | null;
  /** The card's title, or the agent's name: what the drawer's row says. */
  title: string;
}

export interface SummaryWorkspace {
  key: string;
  name: string;
  /** The folder its terminals work in, as the server found it; null when it has none yet. */
  folder: string | null;
  band: Band;
  needs: SummaryNeed[];
  agents: SummaryAgent[];
}

/**
 * Everything one node tells the others about itself, pushed when it
 * changes. It is `kururu_status` as data — the profile on screen, its
 * workspaces and agents, what needs the user — and small: a few kilobytes
 * for a busy node, capped below so a runaway one cannot be more.
 */
export interface NodeSummary {
  at: number;
  version: string;
  host: { version: string | null; current: boolean };
  profile: { key: string; name: string };
  workspaces: SummaryWorkspace[];
  needs: { count: number; inWorkspaces: number };
  kuru: { unheard: number; undelivered: number };
  /** Whether this node thinks it leads. */
  leads: boolean;
  /** The member ids it has a link up to. */
  sees: string[];
  /** Moves whenever its database is written; the parent pulls a backup when it does. */
  dataMark: string;
  /**
   * The version of the Kuru-to-Kuru messages this node speaks — `PEER_TALK`
   * — or absent for a kururu from before them, which ignores every one. Said
   * here so that a message for an old node's Kuru is refused with a reason
   * rather than sent into silence.
   */
  talks?: number;
}

/** The version of `say`, `kuru-turns`, `kuru-replied` and the board verbs. See `NodeSummary.talks`. */
export const PEER_TALK = 1;

export const SUMMARY_WORKSPACES_MAX = 60;
export const SUMMARY_AGENTS_MAX = 40;
export const SUMMARY_NEEDS_MAX = 20;
const SUMMARY_TEXT_MAX = 160;

function clipText(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  return value.length > SUMMARY_TEXT_MAX ? `${value.slice(0, SUMMARY_TEXT_MAX - 1)}…` : value;
}

export interface SummaryInput {
  at: number;
  version: string;
  host: { version: string | null; current: boolean };
  profile: Profile;
  agents: readonly AgentSnapshot[];
  folderOf: (workspaceId: string) => string | null;
  kuru: { unheard: number; undelivered: number };
  leads: boolean;
  sees: readonly string[];
  dataMark: string;
}

/**
 * The summary, from what the snapshot already holds. The Needs rule is
 * `needsOf`'s and nobody else's, so a child's band on the Mac is the band
 * the child's own drawer would draw.
 */
export function summarize(input: SummaryInput): NodeSummary {
  const { profile } = input;
  const harness = profile.harness?.agentId ?? null;
  const byId = new Map(input.agents.map((a) => [a.id, a] as const));
  const needs = needsOf(profile, input.agents);
  const cardOf = new Map<string, SummaryAgent["card"]>();
  for (const workspace of profile.workspaces) {
    for (const card of workspace.board?.cards ?? []) {
      if (card.run?.agentId) cardOf.set(card.run.agentId, { id: card.id, number: card.number, title: clipText(card.title) ?? "", column: card.column });
    }
  }
  const agentOf = (agent: AgentSnapshot): SummaryAgent => {
    const { pid: _pid, command: _command, rss: _rss, made: _made, ...rest } = agent;
    return { ...rest, title: clipText(agent.title), activity: clipText(agent.activity ?? null), card: cardOf.get(agent.id) ?? null };
  };
  const nameOf = (agent: AgentSnapshot | null): string => (agent ? agent.titleOverride || agent.agent || agent.lastAgent || agent.kind : "an agent");

  const workspaces = needs.workspaces.slice(0, SUMMARY_WORKSPACES_MAX).map(({ workspace, band, needs: here }): SummaryWorkspace => {
    const ids = panes(workspace.layout).flatMap((pane) => terminalsOf(pane.agentIds));
    const agents = ids
      .filter((id) => id !== harness)
      .map((id) => byId.get(id))
      .filter((a): a is AgentSnapshot => a !== undefined)
      .slice(0, SUMMARY_AGENTS_MAX)
      .map(agentOf);
    return {
      key: workspace.key,
      name: workspace.name,
      folder: input.folderOf(workspace.id),
      band,
      needs: here.slice(0, SUMMARY_NEEDS_MAX).map((need) => ({
        kind: need.kind,
        agentId: need.agent?.id ?? null,
        cardId: need.card?.id ?? null,
        title: clipText(need.card?.title ?? nameOf(need.agent)) ?? "",
      })),
      agents,
    };
  });

  return {
    at: input.at,
    version: input.version,
    host: input.host,
    profile: { key: profile.key, name: profile.name },
    workspaces,
    needs: { count: needs.count, inWorkspaces: needs.inWorkspaces },
    kuru: input.kuru,
    leads: input.leads,
    sees: [...input.sees],
    dataMark: input.dataMark,
    talks: PEER_TALK,
  };
}

/** The same summary, compared without the moment it was made, to tell whether a push is owed. */
export function summaryKey(summary: NodeSummary): string {
  return JSON.stringify({ ...summary, at: 0 });
}

// ---------------------------------------------------------------------------
// What a client is told
// ---------------------------------------------------------------------------

/**
 * `up`: linked and heard from. `connecting`: being dialled, or expected to
 * dial in, and not heard from since this server started. `away`: was up,
 * and has been silent past `AWAY_MS` or its socket closed.
 */
export type LinkState = "up" | "connecting" | "away";

/** Another member, as this node sees it. */
export interface NodeStatus {
  id: string;
  name: string;
  address: string;
  port: number;
  rank: number;
  /** It is the roster's parent. */
  parent: boolean;
  state: LinkState;
  /** When it entered `state` — "away since" — or null when that is not known. */
  since: number | null;
  /** When it was last heard from, by this server. */
  lastSeen: number | null;
  /** Why the last dial or link failed, in a sentence. */
  error: string | null;
  /** The last summary it pushed. Stale while it is not `up`, and drawn greyed. */
  summary: NodeSummary | null;
  leader: boolean;
  /**
   * Where a browser opens it. On the parent, with the node's share token
   * in it, so a tap is a device let in; on a child, the bare address, since
   * a child never holds another node's token.
   */
  url: string;
}

/** `alone`: in no roster. `parent`: holds the signing key. `child`: a member of the parent's roster. */
export type NodeRole = "alone" | "parent" | "child";

export interface NodesView {
  self: { id: string; name: string; address: string | null; port: number; rank: number | null };
  role: NodeRole;
  rosterVersion: number | null;
  /** The node id that leads, by this node's reckoning. */
  leader: string | null;
  /** Every other member, by rank. */
  nodes: NodeStatus[];
  /** On the parent, or a node about to be one: the join command it is showing, while it is. */
  invite: { code: string; expiresAt: number; command: string } | null;
  /** The last node that joined, and when, so the page that showed the command can say it worked. */
  joined: { name: string; at: number } | null;
  /**
   * Whether another node could dial this one: an address on the tailnet
   * that the socket answers on. When not, the sentence that says why, which
   * on the Mac is "turn on sharing".
   */
  reachable: string | null;
}

/**
 * A node's URL for a browser. The token goes in the query because that is
 * what the gate takes from a fresh device and turns into a cookie.
 */
export function nodeUrl(entry: Pick<NodeEntry, "address" | "port">, token: string | null): string {
  return `http://${entry.address}:${entry.port}/${token ? `?k=${encodeURIComponent(token)}` : ""}`;
}

/** Every node's needs, added up: what the tray adds to this node's own count. */
export function nodesNeedCount(nodes: readonly NodeStatus[]): number {
  return nodes.reduce((n, node) => n + (node.state === "up" ? (node.summary?.needs.count ?? 0) : 0), 0);
}

// ---------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------

/**
 * Everything said on `/link`. Phase 2's messages, then phase 3's for the
 * Kurus (`PeerMessage`); the later phases add theirs to this union (the lead
 * handshake, …), and a node that does not know a type ignores it rather
 * than dropping the link, so a node one phase behind is still a node.
 */
export type LinkMessage =
  | { type: "hello"; node: string; challenge: string; roster: SignedRoster | null; protocol: number; version: string }
  | { type: "prove"; signature: string }
  | { type: "refuse"; reason: string }
  | { type: "roster"; roster: SignedRoster }
  | { type: "summary"; summary: NodeSummary }
  | { type: "ping"; at: number }
  | { type: "export-ask"; id: string }
  | { type: "export"; id: string; mark: string; files: Record<string, string> | null; error: string | null }
  // Phase 6: a workspace moved to the peer (`shared/move.ts`). The check
  // asks whether a folder will do; the move carries the board and is
  // answered once per move id, however often it is sent.
  | { type: "workspace-move-check"; id: string; ask: MoveCheckAsk }
  | { type: "workspace-move-checked"; id: string; check: MoveCheck | null; error: string | null }
  | { type: "workspace-move"; id: string; offer: MoveOffer }
  | { type: "workspace-moved"; id: string; done: MoveDone | null; error: string | null }
  | { type: "bye"; reason: string }
  // Phase 4, the lent secrets (`shared/secrets.ts`). Put and forget go from
  // the parent only; held and ack come back from the child.
  | { type: "secrets-put"; envelope: SealedSecret }
  | { type: "secrets-forget"; kind: string; seq: number; sig: string }
  | { type: "secrets-held"; held: Array<{ kind: string; digest: string; seq: number }> }
  | { type: "secrets-ack"; kind: string; op: "put" | "forget"; seq: number; ok: boolean; digest: string | null; hint: string | null; error: string | null }
  | PeerMessage;

/** The board verbs one Kuru may make on another node's boards directly. A run starts an agent, so it is never one of them. */
export type BoardVerb = "cards" | "add_card" | "edit_card" | "move_card";
export const BOARD_VERBS: readonly BoardVerb[] = ["cards", "add_card", "edit_card", "move_card"];

/**
 * What the Kurus say to each other's nodes. `docs/nodes.md`, "Kurus as
 * peers", is the argument; in short:
 *
 * - `kuru-turns`: a node's own conversation, its newest items
 *   (`peerItems`), pushed whenever it changes, for the other drawers.
 * - `say`: words for the receiving node's Kuru, into its outbox — the
 *   user's (`@omarchy …` in a drawer) or the sending Kuru's (`ask_kuru`).
 *   The receiver writes the mark itself, from the link's own peer: a mark
 *   off the wire would be a node saying it is another.
 * - `say-state`: what became of one, back to the node that sent it, each
 *   time it moves, so the sender's drawer and `ask_kuru` follow it.
 * - `kuru-replied`: a node's Kuru ended a turn with this reply; what the
 *   turn answered says who should hear it (`peerReplySpoken`) and which
 *   `ask_kuru` it answers.
 * - `board` / `board-done`: one of `BOARD_VERBS` on the receiver's boards,
 *   and the line that came of it.
 */
export type PeerMessage =
  | { type: "kuru-turns"; items: KuruItem[] }
  | { type: "say"; id: string; at: number; text: string; who: PeerWho; spoken: boolean }
  | { type: "say-state"; id: string; state: OutboxState; note: string | null; typedAt: number | null }
  | { type: "kuru-replied"; item: { id: string; at: number; text: string }; origin: TurnOrigin; answers: string[] }
  | { type: "board"; id: string; verb: BoardVerb; args: Record<string, unknown> }
  | { type: "board-done"; id: string; text: string; error: boolean };

const PEER_TYPES: ReadonlySet<string> = new Set<PeerMessage["type"]>(["kuru-turns", "say", "say-state", "kuru-replied", "board", "board-done"]);

export function isPeerMessage(message: LinkMessage): message is PeerMessage {
  return PEER_TYPES.has(message.type);
}

const LINK_TYPES = new Set<string>([
  "hello",
  "prove",
  "refuse",
  "roster",
  "summary",
  "ping",
  "export-ask",
  "export",
  "workspace-move-check",
  "workspace-move-checked",
  "workspace-move",
  "workspace-moved",
  "bye",
  ...PEER_TYPES,
  "secrets-put",
  "secrets-forget",
  "secrets-held",
  "secrets-ack",
]);

/** A frame off the socket, as a message with a known type, or null. The fields are each handler's to check. */
export function parseLinkMessage(raw: string): LinkMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const type = (parsed as { type?: unknown }).type;
    return typeof type === "string" && LINK_TYPES.has(type) ? (parsed as LinkMessage) : null;
  } catch {
    return null;
  }
}

/** A peer message's id: the outbox's alphabet, so the id that crosses is the id the receiving outbox keeps. */
const PEER_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** The most a `say` may carry: the drawer composer's own cap. */
export const SAY_MAX = 20_000;
/** The most items a `kuru-turns` may carry; a node pushes `PEER_RECENT`, and anything past twice that is not a node that means well. */
const TURNS_MAX = 80;
const OUTBOX_STATES: ReadonlySet<string> = new Set<OutboxState>(["transcribing", "queued", "delivered", "failed"]);
const ITEM_KINDS: ReadonlySet<string> = new Set(["you", "kuru", "notice", "session"]);

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Each peer message, checked: the shape a handler may rely on, or null.
 * Members are the user's own machines, but a message is still a number off
 * the wire, and a node on an older or newer build is the ordinary case, so
 * nothing past here trusts a field it did not look at.
 */
export function asSay(message: PeerMessage): Extract<PeerMessage, { type: "say" }> | null {
  if (message.type !== "say") return null;
  const m = message as Partial<Extract<PeerMessage, { type: "say" }>>;
  if (typeof m.id !== "string" || !PEER_ID.test(m.id) || !finite(m.at) || m.at <= 0) return null;
  if (typeof m.text !== "string" || !m.text.trim() || m.text.length > SAY_MAX) return null;
  if (m.who !== "user" && m.who !== "kuru") return null;
  return { type: "say", id: m.id, at: m.at, text: m.text, who: m.who, spoken: m.spoken === true };
}

export function asSayState(message: PeerMessage): Extract<PeerMessage, { type: "say-state" }> | null {
  if (message.type !== "say-state") return null;
  const m = message as Partial<Extract<PeerMessage, { type: "say-state" }>>;
  if (typeof m.id !== "string" || !PEER_ID.test(m.id) || typeof m.state !== "string" || !OUTBOX_STATES.has(m.state)) return null;
  return {
    type: "say-state",
    id: m.id,
    state: m.state,
    note: typeof m.note === "string" ? m.note.slice(0, 400) : null,
    typedAt: finite(m.typedAt) ? m.typedAt : null,
  };
}

export function asReplied(message: PeerMessage): Extract<PeerMessage, { type: "kuru-replied" }> | null {
  if (message.type !== "kuru-replied") return null;
  const m = message as Partial<Extract<PeerMessage, { type: "kuru-replied" }>>;
  const item = m.item;
  if (!item || typeof item.id !== "string" || item.id.length > 64 || !finite(item.at) || typeof item.text !== "string" || !item.text.trim()) return null;
  const o = (m.origin ?? {}) as Partial<TurnOrigin>;
  const strings = (value: unknown, max: number): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length <= 64).slice(0, max) : []);
  return {
    type: "kuru-replied",
    item: { id: item.id, at: item.at, text: item.text.slice(0, SAY_MAX) },
    origin: { here: o.here === true, channels: strings(o.channels, 8) as TurnOrigin["channels"], peers: strings(o.peers, 16) },
    answers: strings(m.answers, 32).filter((id) => PEER_ID.test(id)),
  };
}

export function asBoard(message: PeerMessage): Extract<PeerMessage, { type: "board" }> | null {
  if (message.type !== "board") return null;
  const m = message as Partial<Extract<PeerMessage, { type: "board" }>>;
  if (typeof m.id !== "string" || !PEER_ID.test(m.id) || !(BOARD_VERBS as readonly unknown[]).includes(m.verb)) return null;
  const args = m.args && typeof m.args === "object" && !Array.isArray(m.args) ? m.args : {};
  return { type: "board", id: m.id, verb: m.verb!, args };
}

export function asBoardDone(message: PeerMessage): Extract<PeerMessage, { type: "board-done" }> | null {
  if (message.type !== "board-done") return null;
  const m = message as Partial<Extract<PeerMessage, { type: "board-done" }>>;
  if (typeof m.id !== "string" || !PEER_ID.test(m.id) || typeof m.text !== "string") return null;
  return { type: "board-done", id: m.id, text: m.text.slice(0, 40_000), error: m.error === true };
}

/** A node's pushed conversation: enough of each item's shape to draw it without a throw, and nothing more. */
export function asKuruTurns(message: PeerMessage): KuruItem[] | null {
  if (message.type !== "kuru-turns" || !Array.isArray(message.items) || message.items.length > TURNS_MAX) return null;
  const ok = message.items.every((raw: unknown) => {
    if (!raw || typeof raw !== "object") return false;
    const item = raw as Record<string, unknown>;
    if (typeof item.kind !== "string" || !ITEM_KINDS.has(item.kind) || typeof item.id !== "string" || item.id.length > 80 || !finite(item.at)) return false;
    if (item.kind === "kuru") return typeof item.text === "string";
    if (item.kind === "notice") return typeof item.from === "string" && typeof item.what === "string" && typeof item.text === "string";
    if (item.kind === "you") return (item.text === null || typeof item.text === "string") && typeof item.state === "string" && OUTBOX_STATES.has(item.state);
    return true;
  });
  return ok ? message.items : null;
}

/**
 * What each side signs in the handshake: the *other* side's challenge, and
 * both ids in the order signer then verifier, so a proof made for one
 * direction or one pair cannot be replayed in another.
 */
export function linkProof(challenge: string, signer: string, verifier: string): string {
  return `kururu-link-v1\n${challenge}\n${signer}\n${verifier}`;
}

export interface HandshakeDeps {
  self: string;
  version: string;
  /** Fresh per link, from the caller's random source. */
  challenge: string;
  sign: Sign;
  verify: Verify;
  /** The newest roster this node holds, asked fresh each time since `adopt` can change it. */
  roster: () => SignedRoster | null;
  /** Offer a roster the peer brought; the caller adopts it if it is newer and signed. */
  adopt: (incoming: unknown) => void;
  /** The member this side dialled, when it dialled; a different member answering is refused. */
  expect?: string;
}

export type HandshakeStep =
  | { kind: "send"; message: LinkMessage }
  | { kind: "up"; peer: string }
  | { kind: "refuse"; reason: string; tell: boolean };

/**
 * One link's handshake, as a state machine with no socket in it.
 *
 * Both ends run the same thing: say `hello` with a challenge and the roster
 * held, and on the peer's `hello` adopt its roster if it is newer, check the
 * peer is a member of the roster now held — and that this node still is —
 * and answer the peer's challenge. On the peer's `prove`, check it against
 * the key the roster lists, and the link is up. Symmetric on purpose: there
 * is no client and server in a mesh, only which side happened to dial.
 *
 * The roster rides in `hello` so that a node that missed a change learns it
 * from whoever it next meets: a new member is let in by a peer that had not
 * heard of it yet, and a removed one learns it is removed from the first
 * node it dials.
 */
export class LinkHandshake {
  private peer: NodeEntry | null = null;
  private proven = false;
  private done = false;

  constructor(private readonly deps: HandshakeDeps) {}

  get peerId(): string | null {
    return this.peer?.id ?? null;
  }

  get up(): boolean {
    return this.proven && this.peer !== null && !this.done;
  }

  hello(): LinkMessage {
    return { type: "hello", node: this.deps.self, challenge: this.deps.challenge, roster: this.deps.roster(), protocol: LINK_PROTOCOL, version: this.deps.version };
  }

  private refuse(reason: string, tell = true): HandshakeStep[] {
    this.done = true;
    return [{ kind: "refuse", reason, tell }];
  }

  /** A message that arrived before the link was up. After it is up, the caller handles messages itself. */
  receive(message: LinkMessage): HandshakeStep[] {
    if (this.done) return [];
    if (message.type === "refuse") return this.refuse(`the peer refused the link: ${typeof message.reason === "string" ? message.reason : "no reason given"}`, false);
    if (message.type === "hello") {
      if (this.peer) return this.refuse("a second hello");
      if (message.protocol !== LINK_PROTOCOL) {
        const behind = typeof message.protocol === "number" && message.protocol < LINK_PROTOCOL ? "the peer" : "this node";
        return this.refuse(`link protocol ${String(message.protocol)} against ${LINK_PROTOCOL}: ${behind} is behind and wants an update`);
      }
      if (typeof message.challenge !== "string" || message.challenge.length < 16 || !isNodeId(message.node)) return this.refuse("a malformed hello");
      if (message.roster) this.deps.adopt(message.roster);
      const roster = this.deps.roster()?.roster ?? null;
      if (!memberOf(roster, this.deps.self)) return this.refuse("this node is not in the roster it holds", false);
      if (message.node === this.deps.self) return this.refuse("a node cannot link to itself");
      if (this.deps.expect && message.node !== this.deps.expect) return this.refuse("a different member answered at that address");
      const peer = memberOf(roster, message.node);
      if (!peer) return this.refuse("not a member of the roster");
      this.peer = peer;
      return [{ kind: "send", message: { type: "prove", signature: this.deps.sign(linkProof(message.challenge, this.deps.self, peer.id)) } }];
    }
    if (message.type === "prove") {
      if (!this.peer) return this.refuse("a proof before a hello");
      if (typeof message.signature !== "string" || !this.deps.verify(linkProof(this.deps.challenge, this.peer.id, this.deps.self), message.signature, this.peer.keys.sign)) {
        return this.refuse("the proof does not match the key the roster lists");
      }
      this.proven = true;
      return [{ kind: "up", peer: this.peer.id }];
    }
    return this.refuse(`${message.type} before the link was up`);
  }
}

/** Backoff for a dial that failed, forever, as `session.ts` does: a server restart is every save under `bun run dev`. */
export function dialDelay(failures: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
}

/** A time of day the way the sidebar says it, for "away since 23:10". */
function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The other nodes, as `kururu_status` lists them to Kuru: each one's state,
 * its workspaces and its agents, from the last summary it pushed. Read
 * anywhere, act locally — the lines say the agents are another Kuru's to
 * drive, so a Kuru that sees a blocked agent on Omarchy asks that Kuru or
 * tells the user rather than reaching for a tool that cannot touch it. Each
 * agent is named the way `agentName` names one here, with its node and
 * without an id, since no tool on this node takes it.
 */
export function nodesText(nodes: readonly NodeStatus[]): string[] {
  const out: string[] = ["", "nodes (other kururus; read anything here, but their agents are driven by that node's Kuru — ask_kuru asks it, and read_kuru reads what it said):"];
  if (!nodes.length) {
    out.push("  (none — this kururu is not paired with another; Settings → Nodes)");
    return out;
  }
  for (const node of nodes) {
    const state =
      node.state === "up" ? "linked" : node.state === "away" ? `away${node.since ? ` since ${clock(node.since)}` : ""}${node.summary ? ", last summary shown" : ""}` : "not linked yet";
    const talks = node.summary && (node.summary.talks ?? 0) < 1 ? " · its kururu is too old for ask_kuru (kururu child update there)" : "";
    out.push(`  - ${node.name}${node.parent ? " (the parent)" : ""} · ${state}${node.leader ? " · leads" : ""}${talks} · ${node.url.replace(/\?.*$/, "")}`);
    const summary = node.summary;
    if (!summary) continue;
    out.push(`    profile ${summary.profile.name} · ${summary.needs.count} need${summary.needs.count === 1 ? "s" : ""} the user`);
    for (const workspace of summary.workspaces) {
      out.push(`    - ${workspace.name}${workspace.folder ? ` (${workspace.folder})` : ""} · ${workspace.band}`);
      for (const agent of workspace.agents) {
        const doing = agent.activity || agent.title;
        const ctx = agent.contextUsage ? ` · context ${Math.round((agent.contextUsage.used / agent.contextUsage.window) * 100)}%` : "";
        const name = agentName({
          id: null,
          name: agent.titleOverride || null,
          doing: agent.title || null,
          program: agent.agent ?? agent.lastAgent ?? (agent.kind === "shell" ? "shell" : "agent"),
          workspace: workspace.name,
          card: agent.card ? { code: cardCode(workspace.name, agent.card.number), title: agent.card.title } : null,
          node: node.name,
        });
        out.push(`      - ${name} · ${agent.exited ? "exited" : agent.status}${ctx}${doing ? ` · ${doing}` : ""}`);
      }
      for (const need of workspace.needs) out.push(`      ! ${need.kind}: ${need.title}`);
    }
  }
  return out;
}
