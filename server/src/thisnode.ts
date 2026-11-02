/**
 * This node, as the other nodes see it: the summary it publishes, the
 * address they dial, whether it may hold Telegram's poll for them, and what
 * happens here when a lent secret lands.
 *
 * Small and apart from `nodes.ts`, which is the mesh itself and takes all of
 * this as callbacks: these are the answers only the server can give, since
 * each reads the profile on screen, the store, or the channels.
 */
import { nodeSubject } from "../../shared/channels";
import { visibleLaunchers } from "../../shared/launchers";
import { type NodeSummary, summarize } from "../../shared/nodes";
import type { KindSpec } from "../../shared/secrets";
import { listenAddresses } from "./access";
import {
  broadcast,
  channels,
  host,
  hostInfo,
  kuru,
  kuruKey,
  launch,
  lead,
  nodes,
  overlay,
  secrets,
  store,
  usageReader,
  workspaces,
} from "./context";
import { pollOpenRouterAccount, web } from "./sweeps";
import { workspaceDirs } from "./repostatus";
import { loginsActive } from "./lending";
import { claudeDirFor, lentClaudeEnv } from "./logins";
import { openRouterSnapshot, rereadOpenRouterKey } from "./openrouter";
import { reach } from "./reach";
import { claudeSignedIn } from "./usage";
import { VERSION } from "./version";

/**
 * Whether Claude is signed in for this node's Kuru, as last looked: the
 * machine's own login, the profile's when profiles keep their own, or a
 * token the parent lent. Null until the first look, which counts as yes
 * rather than keep a holder that restarts off the poll for a minute.
 */
let claudeReady: boolean | null = null;

export async function refreshClaudeReady(): Promise<void> {
  if (!channels || !nodes) return;
  const key = kuruKey();
  const profile = key ? workspaces.profileByKey(key) : null;
  const ready = Boolean(lentClaudeEnv()) || (await claudeSignedIn(loginsActive() && profile ? claudeDirFor(profile.loginKey) : null));
  if (ready === claudeReady) return;
  claudeReady = ready;
  lead?.evaluate();
  nodes?.queueSummary();
}

/**
 * Whether this node may poll Telegram for the others (`lead.ts`), and the
 * sentence that says why not. Eligible is the plan's three things: the
 * channel is on — the switch as this node last heard it, from the roster or
 * a node's flip — this node holds the bot's token — its own on the parent,
 * lent on a child — and a Kuru that could answer, which is Claude signed in.
 */
export function leadEligibility(): { eligible: boolean; why: string | null } {
  const shared = nodes.rosterTelegram();
  const parentId = nodes.parentId();
  const parent = parentId ? (nodes.nameOf(parentId) ?? "the parent") : "the parent";
  if (!shared) return { eligible: false, why: "the roster carries no Telegram channel" };
  if (!channels.telegram.switchedOn) return { eligible: false, why: "the channel is off (Settings → Channels, on any node)" };
  if (nodes.role() === "child") {
    if (!secrets.heldFrom("telegram")) return { eligible: false, why: `${nodeSubject(parent)} has not lent this node the bot's token (its Settings → Nodes → ${nodes.name()} → Secrets → Telegram)` };
  } else if (!channels.telegram.hasToken) return { eligible: false, why: "no bot token here" };
  if (claudeReady === false) return { eligible: false, why: "Claude is not signed in here, so no Kuru could answer (claude, then /login)" };
  return { eligible: true, why: null };
}

/** Where the poll stands, for `/api/health` and so the doctor's leading row. Null before the links exist. */
export function leadHealth(): { shared: boolean; eligible: boolean; why: string | null; polls: boolean; holder: string | null; rank: number | null } | null {
  if (!lead) return null;
  const eligible = leadEligibility();
  const holder = lead.holder();
  return { shared: channels.telegram.isShared, ...eligible, polls: channels.telegram.polling, holder: holder ? nodes.nameOf(holder) : null, rank: nodes.ownRank() };
}

/**
 * A lent kind was written or taken back on this node, under a reader that
 * holds what it read: each one reads its file again and tells the windows.
 * The web providers and a lent Claude token are read per request and per
 * spawn, so they need only the windows told.
 */
export function secretLanded(spec: KindSpec): void {
  switch (spec.family) {
    case "openrouter":
      if (rereadOpenRouterKey()) {
        broadcast({ type: "openrouter", openrouter: openRouterSnapshot() });
        void pollOpenRouterAccount();
      }
      return;
    case "telegram":
      channels.telegram.reread();
      lead?.evaluate();
      nodes.queueSummary();
      return;
    case "firecrawl-cloud":
    case "web":
      broadcast({ type: "web", web: web.status() });
      return;
    default:
      return;
  }
}

/** What kind of field a web provider's field is, as its Settings page draws it, or null for none by that name. */
export function webFieldKind(provider: unknown, field: unknown): string | null {
  return web.status().providers.find((p) => p.id === provider)?.fields.find((f) => f.name === field)?.kind ?? null;
}

/** When this process started, which a node's data mark carries so a restart is a pull. */
export const STARTED_AT = Date.now();

/**
 * Where the other nodes dial this one: `KURURU_NODE_ADDRESS` when set — two
 * isolated instances on one machine are tested on loopback — else the
 * tailnet address off the interface list, as the Share dialog finds it.
 */
export function nodeAddress(): string | null {
  return process.env.KURURU_NODE_ADDRESS || reach(0).tailscale;
}

/** Why no other node could dial this one, or null when one could. */
export function nodeUnreachable(): string | null {
  const address = nodeAddress();
  if (!address) return "This machine has no tailnet address, so no other node can reach it. Bring Tailscale up, then restart the server.";
  const listening = listenAddresses();
  if (listening.includes("0.0.0.0") || listening.includes("::") || listening.includes(address)) return null;
  return process.platform === "darwin"
    ? "This Mac is not shared, so no node can reach it. Turn sharing on in the Share dialog first."
    : `This server listens on ${listening.join(", ")}, not on ${address}, so no node can reach it.`;
}

/**
 * What this node tells the others about itself: the profile on screen, as
 * `kururu_status` would say it. See `summarize`.
 */
export function nodeSummary(leads: boolean, sees: string[]): NodeSummary {
  const profile = workspaces.active;
  const mine = new Set(workspaces.agentsIn(profile.id));
  const marks = store.marks();
  return summarize({
    at: Date.now(),
    version: VERSION,
    host: hostInfo,
    profile,
    agents: host.agents.filter((agent) => mine.has(agent.id)).map(overlay),
    folderOf: (workspaceId) => {
      const workspace = profile.workspaces.find((w) => w.id === workspaceId);
      return workspace ? (workspaceDirs(workspace)[0] ?? null) : null;
    },
    kuru: kuru.counts(profile.key),
    leads,
    sees,
    dataMark: `${marks.events}.${marks.turns}.${store.changes}@${STARTED_AT}`,
    ...(lead ? { lead: { eligible: leadEligibility().eligible, polls: channels.telegram.polling } } : {}),
    launchers: visibleLaunchers(launch),
    // Nothing watches the parent, so it does not say it can be watched.
    watchable: nodes?.role() !== "parent",
    ledger: usageReader !== null,
  });
}
