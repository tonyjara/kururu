/**
 * What kururu knows about the agents it is running, and where they live.
 *
 * This replaces `ghosttown.ts`, which mirrored somebody else's protocol. Kururu
 * owns its ptys now, so these types are not a copy of anything and cannot drift
 * from a second source — they are the source.
 *
 * It was flat for a while, and the note here said a layout tree was geometry no
 * client had to learn. That was true of a window with one tab strip in it. It
 * stopped being true the moment panes tiled: a client that draws a layout has to
 * be told the layout, and the only question left was who owns it. The server
 * does — same as ghosttown's daemon — which is what makes an arrangement survive
 * a window reload, reach a second client, and be worth writing to disk.
 *
 * So the hierarchy is ghosttown's, on purpose and with the same words:
 *
 *   profile   a named session; a list of workspaces. Switching one swaps the
 *             whole window, and what you left keeps running.
 *   workspace one split tree, named. The thing prefix+1..9 jump between.
 *   pane      a leaf of that tree, holding tabs.
 *   tab       one terminal. An agent lives in exactly one.
 *
 * The one place kururu differs is what a profile *is* underneath. Ghosttown
 * gives each its own daemon; kururu has one server that owns every pty, so a
 * profile here is a namespace, not a process. The visible behaviour is the same
 * — and the agents in the profile you are not looking at are still running.
 */
import type { LayoutNode } from "./layout";

/**
 * `idle`, `working` and `done` are inferred from output timing (agents/status.ts).
 * `blocked` is not inferable — nothing about the byte stream says "waiting for a
 * human" — so it only ever arrives from an agent that reports it (agents/report.ts).
 */
export type AgentStatus = "idle" | "working" | "blocked" | "done";

/**
 * What kururu was *asked* to start, which is not the same as what ended up
 * running in there. `agent` is "start me an agent"; `shell` is "give me a
 * terminal". They are the same machinery — a pty kururu owns — and the
 * distinction is only about what the user meant, which is why a shell someone
 * has since typed `claude` into reports `kind: "shell"` and `agent: "claude"`
 * at the same time. Both are true, and the sidebar shows the second one.
 */
export type PtyKind = "agent" | "shell";

/** How full an agent's context window is, in the two numbers it takes to say it. */
export interface ContextUsage {
  used: number;
  window: number;
}

export interface AgentSnapshot {
  /** Stable for the life of the pty. Every message about an agent is keyed on it. */
  id: string;
  /** What it was started as. See PtyKind: it says nothing about what is running. */
  kind: PtyKind;
  /** What to call it in a tab: the basename of `cwd`, which is the project. */
  title: string;
  status: AgentStatus;
  /**
   * The agent program actually running in there right now — "claude", "codex" —
   * found by walking the process tree, not by trusting what we launched. A shell
   * that has not started one yet, or has exited back to a prompt, reports null.
   */
  agent: string | null;
  /** Output has arrived that nobody watching this agent has seen. */
  unread: boolean;
  cwd: string;
  /**
   * The pid on the end of the pty — the login shell, since a command runs under
   * one. It is here so the server can ask the kernel where that terminal *is*
   * now rather than where it was opened: a new tab should land in the directory
   * you cd'd to. Signalling stays the host's business; this is for reading.
   */
  pid: number;
  /** argv as launched, for a tooltip and for relaunching. */
  command: string;
  /** Wall clock at spawn. Sorting the tab strip by this keeps tabs from reordering. */
  createdAt: number;
  /** Only ever non-null if the agent reports it; see agents/report.ts. */
  contextUsage: ContextUsage | null;
  /**
   * What this agent last said it was doing, in whatever words it used — the
   * prompt it was handed, or the thing it is asking permission for. Reported,
   * never inferred: a terminal carries a picture of a turn, not a description
   * of one.
   *
   * Optional because, unlike everything above it, this does not come from the
   * pty host. The host knows nothing about it; the server holds it beside the
   * snapshot and merges it on the way out. That is deliberate — it is the only
   * field here that is *about* the work rather than about the process, it goes
   * stale the moment the work moves on, and keeping it on the restartable side
   * means improving it never costs anybody their agents. A server restart
   * forgets it, and the next report fills it in again.
   */
  activity?: string | null;
  /**
   * The agent program last seen in this pty, even if it is not there now — the
   * pty's memory of having been an agent, as opposed to `agent` above, which is
   * whether one is running in it this second.
   *
   * It exists because "is this an agent?" and "is an agent running in it right
   * now?" are different questions and the sidebar asks the first. Detection is a
   * poll of the process table, so `agent` blinks off whenever claude is between
   * things; a list filtered on it alone would drop rows and put them back, which
   * is worse than showing a shell. And an agent that has *exited* reports null
   * forever after, so filtering on `agent` would hide exactly the terminals whose
   * screen is the only record of what they said.
   *
   * Server-side, like `activity`, and for the same reason: it is accumulated from
   * snapshots the host already sends, so learning it costs no edit to the half
   * that owns the ptys. A restart forgets it and the next poll relearns it for
   * everything still running.
   */
  lastAgent?: string | null;
  /**
   * A name the user typed (rename-tab). Wins over everything else a tab could
   * be called, and unlike the detected program it is never overwritten.
   */
  titleOverride: string | null;
  /**
   * The pty has closed but the agent is still listed, because its screen is the
   * only record of what it said — including whatever it printed on the way out.
   * Killing it is what removes it from the list.
   */
  exited: boolean;
  exitCode: number | null;
}

/**
 * The colours a workspace can be tagged with.
 *
 * Names rather than CSS values, and the server only ever accepts one of these.
 * Two reasons, and the second is the one that matters: a name can be restyled
 * later without rewriting everybody's saved session, and kururu is reachable
 * from the tailnet — a colour field that took arbitrary text would be a client
 * writing directly into a style attribute. What each name looks like is the
 * web's business; see `colors.ts`.
 */
export const WORKSPACE_COLORS = [
  "green",
  "blue",
  "amber",
  "coral",
  "violet",
  "cyan",
  "rose",
  "lime",
] as const;

export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];

export function isWorkspaceColor(value: unknown): value is WorkspaceColor {
  return typeof value === "string" && (WORKSPACE_COLORS as readonly string[]).includes(value);
}

/** One split tree with a name. What prefix+1..9 switch between. */
export interface Workspace {
  id: string;
  name: string;
  layout: LayoutNode;
  focusedPaneId: string;
  /**
   * A tag, not a theme: it marks the workspace's number in the sidebar and rules
   * a line down the left of every agent living in it, so "which of these is the
   * one I have the browser open for" is answered by glancing rather than by
   * reading. Null is the default and stays untagged rather than being assigned a
   * colour automatically — a palette where everything is coloured says nothing,
   * and the point of the mark is that you chose it.
   */
  color: WorkspaceColor | null;
}

/** A named session: a list of workspaces, and which of them you are in. */
export interface Profile {
  id: string;
  name: string;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  /**
   * The workspace you were in before this one — tmux's last-window, which is
   * what makes prefix+z a toggle between the two you are actually working in
   * rather than a walk through the list.
   */
  lastWorkspaceId: string | null;
}

/** A profile you are not in, as much of it as a switcher needs to draw. */
export interface ProfileSummary {
  id: string;
  name: string;
  workspaces: number;
  /** Live ptys inside it. The reason switching away is not the same as closing. */
  agents: number;
}

/**
 * Everything a client needs to draw the window, in one message.
 *
 * Only the active profile is sent in full. The others are a name and two counts,
 * because a switcher is all you can do with a profile you are not in, and
 * sending every workspace of every profile would put a layout nobody is looking
 * at on the wire on every status change.
 */
export interface SessionSnapshot {
  session: string;
  /** The active profile, whole. */
  profile: Profile;
  /** Every profile including the active one, in creation order. */
  profiles: ProfileSummary[];
  /** Every agent in the active profile, in creation order. */
  agents: AgentSnapshot[];
}

/** What an agent (or a Claude Code hook) may tell kururu about itself. */
export interface AgentReport {
  status?: AgentStatus;
  /** Free text for a notification; not rendered in the tab strip. */
  message?: string;
  context?: ContextUsage;
}

/**
 * Whether this one is somebody's work — what a quit confirmation counts.
 *
 * A terminal you opened to run `ls` in is not worth a dialog, so shells are not
 * counted; a shell you then typed `claude` into is, which is why this asks what
 * is *running* as well as what was asked for. Erring towards counting is the
 * right way round: a needless dialog costs a keystroke, a missed one costs a turn.
 *
 * It lives here because two processes ask it — the pty host, for the dialog, and
 * the server, for `/api/health` — and two spellings of this rule would disagree
 * on exactly the case that matters.
 */
export function countsAsAgent(agent: AgentSnapshot): boolean {
  return !agent.exited && (agent.kind === "agent" || agent.agent !== null);
}

export const AGENT_STATUSES: readonly AgentStatus[] = ["idle", "working", "blocked", "done"];

export function isAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === "string" && (AGENT_STATUSES as readonly string[]).includes(value);
}
