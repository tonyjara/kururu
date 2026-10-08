/**
 * The harness: one agent per profile that drives the others, and the vocabulary
 * it is given to do it with.
 *
 * The decision this module embodies is that the orchestrator is *not* a loop
 * kururu runs. It is a Claude Code session in a terminal like every other
 * agent — started by kururu, named, resumable, billed to the subscription,
 * visible in a pane — and what makes it the harness is only that it is handed
 * kururu's verbs as MCP tools and told who it is. Everything that project
 * after project rebuilt around a coding agent (the loop, context management,
 * permissions, resume) comes with the session for free, and the one thing
 * none of them had, a server that already holds every pty and every board, is
 * the part kururu brings. Models decide; the verbs do.
 *
 * This file is the pure half: the tool catalogue the MCP endpoint publishes,
 * the role the session is told, the grammar of the two channels into a running
 * Claude (its inbox socket, and raw keys into its pty), and the readers that
 * turn a transcript into turns. `server/src/harness.ts` is the half that
 * touches the host and the layout.
 *
 * Two ideas are borrowed from pi, the harness most people build their own on,
 * and are worth naming. A message to a working agent means one of two things —
 * *now*, between its tool calls, or *next*, once its turn is over — and the
 * tool says which rather than guessing. And "finished" is two signals, the turn
 * ending and nothing more being queued; `wait_agent` reports the first and the
 * orchestrator is told to look before trusting it.
 */
import type { HarnessState } from "./model";

/** The session's name, in the prompt box, the tab and `/list-agents`. */
export const HARNESS_NAME = "harness";

/** The MCP server's name, which Claude Code prefixes every tool with: `mcp__kururu__…`. */
export const HARNESS_SERVER = "kururu";

/**
 * How much of a screen or a transcript one read may return. Well under Claude
 * Code's cap on a tool result, and small on purpose: the orchestrator's own
 * context is the scarce thing, and a read that pastes a whole afternoon into it
 * is how it stops being able to think about the afternoon.
 */
export const READ_MAX = 24_000;
/** Lines of screen a read returns unless asked otherwise. A terminal's height, with a little history. */
export const SCREEN_LINES = 60;
/** Turns of transcript a read returns unless asked otherwise. */
export const TRANSCRIPT_TURNS = 8;
/** How long `wait_agent` waits unless told, and the most it will. Under the per-request limit `mcpConfig` sets. */
export const WAIT_DEFAULT_S = 240;
export const WAIT_MAX_S = 540;
/** The per-request ceiling Claude Code is told for this server, so a wait is not cut off at its default minute. */
export const MCP_TIMEOUT_MS = 600_000;

/** What a hook's `transcript_path` and a Stop's last message are kept to. */
export const REPLY_MAX = 20_000;

export type When = "now" | "next" | "later";
export const WHENS: readonly When[] = ["now", "next", "later"];

/** A tool as the MCP endpoint lists it. The schema is JSON Schema, hand-written and small. */
export interface HarnessTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });
const bool = (description: string) => ({ type: "boolean", description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const AGENT = str("An agent id from kururu_status, such as a12.");
const WORKSPACE = str("A workspace id from kururu_status.");

/**
 * The catalogue. Named for what they do to kururu, in the order somebody would
 * learn them: look, read, talk, wait, start, and the board.
 *
 * Descriptions are written for the model and are the only instructions it has
 * about each verb, so they say what a careless call costs. The destructive ones
 * say to ask first, because the agents are the user's — see `rolePrompt`.
 */
export const HARNESS_TOOLS: readonly HarnessTool[] = [
  {
    name: "kururu_status",
    description:
      "Everything in this profile: its workspaces, every agent (id, program, status, what it is doing, context used, which card and workspace it belongs to), and which agent you are. Call this first, and again whenever you are unsure what is running. Statuses: working, done (its turn ended), blocked (it is asking a question or waiting on a permission prompt), idle.",
    inputSchema: obj({}),
  },
  {
    name: "read_agent",
    description:
      "Read what an agent has said or shown. source=reply (default) is the last message it wrote at the end of a turn, source=transcript is its last turns as a conversation, source=screen is the text of its terminal right now — the only one that shows a permission prompt or a question it is waiting on. Reads are capped; ask for fewer lines or turns rather than more.",
    inputSchema: obj(
      {
        agent: AGENT,
        source: { type: "string", enum: ["reply", "transcript", "screen"], description: "Which view. Default reply." },
        lines: int(`Screen lines from the bottom, default ${SCREEN_LINES}.`),
        turns: int(`Transcript turns from the end, default ${TRANSCRIPT_TURNS}.`),
      },
      ["agent"],
    ),
  },
  {
    name: "send_agent",
    description:
      "Send a message to an agent as if the user had typed it. A Claude Code agent is messaged through its inbox: when=next (default) is read once its current turn ends, when=now is read between its tool calls mid-turn, when=later goes after anything already queued. Any other agent is typed into its terminal and Enter is pressed. A message cannot answer a permission prompt; that takes press_keys, and the user's say-so.",
    inputSchema: obj(
      {
        agent: AGENT,
        text: str("The message. Plain text; a slash command is just text to the receiver."),
        when: { type: "string", enum: [...WHENS], description: "When a Claude agent reads it. Default next." },
      },
      ["agent", "text"],
    ),
  },
  {
    name: "press_keys",
    description:
      "Press keys in an agent's terminal: enter, escape, tab, up, down, left, right, backspace, space, ctrl-c, ctrl-d, or single characters such as y or 2. This is how a permission prompt or a menu is answered. Answering a prompt is the user's decision: read the screen, tell the user what is being asked, and press only what they chose. ctrl-c twice ends a Claude session.",
    inputSchema: obj({ agent: AGENT, keys: { type: "array", items: { type: "string" }, description: "Keys in order." } }, ["agent", "keys"]),
  },
  {
    name: "wait_agent",
    description:
      `Wait until one of the agents reaches a state — done, blocked or exited — and return which, with its last reply. Returns at once if one already is in such a state unless include_current=false; after send_agent, pass include_current=false so a stale done is not mistaken for the answer. Gives up after timeout_s (default ${WAIT_DEFAULT_S}, at most ${WAIT_MAX_S}) and says so; call again to keep waiting. You are also messaged, unasked, whenever an agent in this profile finishes or blocks, so waiting is for when you have nothing else to do.`,
    inputSchema: obj(
      {
        agents: { type: "array", items: { type: "string" }, description: "Agent ids to watch." },
        states: { type: "array", items: { type: "string", enum: ["done", "blocked", "exited"] }, description: "Which states count. Default all three." },
        include_current: bool("Whether an agent already in such a state satisfies the wait. Default true."),
        timeout_s: int(`Seconds to wait. Default ${WAIT_DEFAULT_S}.`),
      },
      ["agents"],
    ),
  },
  {
    name: "start_agent",
    description:
      "Start a coding agent in a workspace, in a terminal of its own, with an opening prompt. Prefer add_card with run=true when the work is a task worth tracking; use this for a quick question or a one-off. Returns the new agent's id. The agent starts in the workspace's current directory unless cwd is given.",
    inputSchema: obj(
      {
        workspace: WORKSPACE,
        prompt: str("The first message the agent is given."),
        launcher: str("Which agent and model, a launcher id from kururu_status. Default: Claude on its default model."),
        cwd: str("An absolute directory to start in. Default: where the workspace's terminals are."),
        name: str("A name for its tab."),
      },
      ["workspace", "prompt"],
    ),
  },
  {
    name: "stop_agent",
    description:
      "End an agent: its whole process group is signalled and its terminal closes. Irreversible, and the user's work may be in it — ask the user before calling this unless they already told you to. Cannot stop yourself.",
    inputSchema: obj({ agent: AGENT }, ["agent"]),
  },
  {
    name: "reveal_agent",
    description: "Bring an agent's terminal onto the user's screen: switches to its workspace and selects its tab. Use when the user asks to see something, or when a prompt needs their eyes.",
    inputSchema: obj({ agent: AGENT }, ["agent"]),
  },
  {
    name: "rename_agent",
    description: "Name an agent's tab, so the user can find it in the sidebar.",
    inputSchema: obj({ agent: AGENT, name: str("The tab's new name.") }, ["agent", "name"]),
  },
  {
    name: "cards",
    description:
      "The board of a workspace: its cards by column (todo, doing, review, done), each with its id, number, title, body, and the run on it if an agent has been handed it. Without a workspace, the profile's own board — the inbox of cards not yet sent to a workspace.",
    inputSchema: obj({ workspace: str("A workspace id. Omit for the profile's board.") }),
  },
  {
    name: "add_card",
    description:
      "Add a card to a workspace's board, and with run=true hand it straight to an agent in a terminal beside the board — the same as the user pressing the robot. The title is the task in one sentence; the body is the detail. isolate=true gives the agent a git worktree of its own. Without a workspace, the card goes on the profile's board, where nothing runs.",
    inputSchema: obj(
      {
        workspace: str("A workspace id. Omit for the profile's board."),
        title: str("One sentence, at most 200 characters."),
        body: str("Detail, markdown, at most 20,000 characters."),
        column: str("todo (default), doing, review or done; on the profile's board, one of its column ids from cards."),
        isolate: bool("Run in a worktree of its own. Default: the project's setting."),
        run: bool("Hand it to an agent now. Default false."),
        launcher: str("With run: which agent and model, a launcher id. Default: Claude on its default model."),
      },
      ["title"],
    ),
  },
  {
    name: "edit_card",
    description: "Change a card's title or body. On a workspace's board, or without a workspace the profile's.",
    inputSchema: obj({ workspace: str("A workspace id, or omit for the profile's board."), card: str("The card id."), title: str("A new title."), body: str("A new body.") }, ["card"]),
  },
  {
    name: "move_card",
    description:
      "Move a card to a column. On a workspace's board: todo, doing, review, done — moving a card to done retires its worktree, which asks the user in place if there is uncommitted work. Without a workspace: a column id of the profile's board.",
    inputSchema: obj({ workspace: str("A workspace id, or omit for the profile's board."), card: str("The card id."), column: str("The column.") }, ["card", "column"]),
  },
  {
    name: "run_card",
    description: "Hand an existing card on a workspace's board to an agent, the same as the robot button. Returns the agent's id. A card whose agent is still running is refused.",
    inputSchema: obj({ workspace: WORKSPACE, card: str("The card id."), launcher: str("A launcher id. Default: Claude on its default model.") }, ["workspace", "card"]),
  },
  {
    name: "send_card_to_workspace",
    description: "Move a card from the profile's board onto a workspace's board, at the foot of To do, where it can be run.",
    inputSchema: obj({ card: str("The card id on the profile's board."), workspace: WORKSPACE }, ["card", "workspace"]),
  },
  {
    name: "new_workspace",
    description: "Make a new, empty workspace in this profile and return its id. A workspace is a project: its own panes, board and branch. The user is not switched to it.",
    inputSchema: obj({ name: str("The workspace's name.") }, ["name"]),
  },
];

/**
 * What a key name becomes on the pty. The names are the ones a person would
 * say — "press enter" — and the bytes are what a terminal sends for them. A
 * single character stands for itself, so `y` is `y`; anything longer that is
 * not in here is refused rather than typed, since "ctrl-z" typed as six
 * letters into a prompt is a worse surprise than an error.
 */
export const KEY_BYTES: Record<string, string> = {
  enter: "\r",
  return: "\r",
  escape: "\x1b",
  esc: "\x1b",
  tab: "\t",
  backspace: "\x7f",
  space: " ",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
  "ctrl-z": "\x1a",
  "ctrl-l": "\x0c",
  "ctrl-u": "\x15",
  "ctrl-r": "\x12",
  "ctrl-o": "\x0f",
  "shift-tab": "\x1b[Z",
};

/** The bytes for a list of key names, or null naming the first one that is not a key. */
export function keyBytes(keys: readonly string[]): { data: string } | { bad: string } {
  let data = "";
  for (const key of keys) {
    const name = key.trim().toLowerCase();
    const bytes = KEY_BYTES[name] ?? ([...key].length === 1 ? key : undefined);
    if (bytes === undefined) return { bad: key };
    data += bytes;
  }
  return { data };
}

/**
 * Text typed into a terminal the way a paste arrives, so that a program which
 * understands bracketed paste — both CLIs do — takes a newline as a newline
 * and not as Enter. A single line is typed plainly, which is what a program
 * that does *not* understand the brackets wants.
 */
export function pasteBytes(text: string): string {
  return text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text;
}

/**
 * The lines a message to a Claude Code session is, on its inbox socket.
 *
 * Newline-delimited JSON. The first line is the session's own token, which is
 * what makes the message count as the session's own rather than a stranger's:
 * a session that runs without permission prompts holds a stranger's message
 * for approval, and a message held is a message that arrives after the user
 * has gone to see why nothing happened. The hook that runs inside the session
 * reports the token to kururu, so kururu has it and nobody else does. The
 * second line is the message, in the shape the session's own stdin takes: a
 * user turn, with a sender for the preview line and a priority for when it is
 * read.
 */
export function inboxFrames(text: string, token: string | null, priority: When, from = HARNESS_SERVER): string {
  const lines: string[] = [];
  if (token) lines.push(JSON.stringify({ type: "auth", token }));
  lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text }, from, priority }));
  return `${lines.join("\n")}\n`;
}

/** One turn of a transcript, as the orchestrator reads it. */
export interface Turn {
  role: "user" | "assistant";
  text: string;
}

/**
 * The last turns of a Claude Code transcript, newest last, from however much
 * of its tail was read.
 *
 * The file is JSONL and both `user` and `assistant` records carry an API
 * message; the user's may be a string or blocks, the assistant's is blocks.
 * Tool calls are named and tool results are counted rather than quoted,
 * because a transcript read is for "what did it say", and the tool traffic is
 * what the screen is for. Sidechains and meta records are a subagent's or the
 * harness's own and are left out, as `transcript.ts` leaves them out of the
 * ring. A line that will not parse is skipped — the first of a tail read is a
 * fragment by definition.
 */
export function turnsFrom(tail: string, limit: number): Turn[] {
  const turns: Turn[] = [];
  for (const line of tail.split("\n")) {
    if (!line.startsWith("{")) continue;
    let rec: Record<string, any>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.isSidechain || rec.isMeta) continue;
    if (rec.type !== "user" && rec.type !== "assistant") continue;
    const content = rec.message?.content;
    const text = turnText(content);
    if (!text) continue;
    const last = turns[turns.length - 1];
    // Consecutive records of one role are one turn: an assistant's text and its
    // tool calls arrive as separate lines.
    if (last && last.role === rec.type) last.text += `\n${text}`;
    else turns.push({ role: rec.type, text });
  }
  return turns.slice(-limit);
}

function turnText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  let results = 0;
  for (const block of content as Record<string, unknown>[]) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) parts.push(block.text.trim());
    else if (block.type === "tool_use" && typeof block.name === "string") parts.push(`[tool: ${block.name}]`);
    else if (block.type === "tool_result") results++;
  }
  if (results) parts.push(`[${results} tool result${results === 1 ? "" : "s"}]`);
  return parts.join("\n");
}

/** Cut a read to `READ_MAX`, keeping the end, which is the newest part. */
export function clip(text: string, max = READ_MAX): string {
  return text.length > max ? `…[${text.length - max} characters before this were cut]\n${text.slice(-max)}` : text;
}

/**
 * Who the session is told it is.
 *
 * Appended to Claude Code's own system prompt rather than replacing it, so the
 * session keeps everything that makes it a coding agent — it can still read
 * the user's files and run git when the question needs it. What is added is
 * the part no prompt it was shipped with could know: that there are other
 * agents, that they are reached by tool and not by typing, and that they are
 * the user's.
 *
 * The rules are few and they are the ones every manager-over-agents project
 * converged on: relay a permission prompt rather than answer it, ask before
 * ending anything, and keep your own context small by reading with limits and
 * using the board as memory. The profile and its workspaces are named so the
 * first turn does not have to go and look.
 */
export function rolePrompt(args: { profile: string; workspaces: { id: string; name: string }[]; launchers: { id: string; label: string }[] }): string {
  const workspaces = args.workspaces.map((w) => `  - ${w.name} (${w.id})`).join("\n") || "  (none yet)";
  const launchers = args.launchers.map((l) => `  - ${l.id}: ${l.label}`).join("\n");
  return `# You are the harness

You are the harness of the kururu profile "${args.profile}": one session that oversees every coding agent in it on the user's behalf. The agents are real Claude Code and Codex processes in terminals of their own, each on a task; you start them, read what they say, answer them, and keep the boards that track the work. The user talks to you to steer all of them at once, and often cannot see their terminals — on a phone, they see only you.

## How you reach the agents
Only through the kururu_* tools (prefixed mcp__kururu__). Never run claude or codex yourself and never type into a terminal with Bash; an agent you start with the tools is in a pane the user can see, tracked, and reachable from this session. Call kururu_status first in a conversation and whenever you are unsure what is running.

Workspaces in this profile now:
${workspaces}

Launchers you may start an agent with:
${launchers}

## How you hear from them
kururu messages you, unasked, when an agent in this profile finishes a turn or blocks. Such a message starts with "[kururu]" and names the agent. When one arrives: read the agent if its last reply is not in the message, decide whether the user needs to know or you can answer the agent yourself, and keep your reply to the user to the point — one line when nothing needs them. wait_agent is for when you have nothing else to do.

## Rules
- The agents are the user's. A permission prompt an agent is showing is the user's to answer: read its screen, tell the user what is asked, and press keys only as they say. Ask before stop_agent, and before moving a card to done.
- A message you send to an agent is a message from the user as far as it knows; write it as the user would, with what the agent needs and nothing about yourself.
- Prefer a card to a bare start_agent for anything that is a task: a card is where the work is tracked, and the user reads the board.
- Keep your own context small. Read with the defaults, ask for fewer lines or turns, never paste an agent's whole screen back to the user; summarise and say which agent and where.
- The board is your memory. Decisions, what each agent is on, and what is waiting on the user belong on cards, not in your head; a new session of you should be able to read the boards and carry on.
- Do not do the agents' work for them. If a task needs code written, start an agent on it.
`;
}

/**
 * The `--mcp-config` a harness session is started with: this server, over
 * loopback, with the profile and the session's own agent id in the address so
 * the endpoint knows whose verbs to answer with. The timeout raises Claude
 * Code's one-minute per-request limit, which a wait would otherwise hit.
 */
export function mcpConfig(port: number, profileId: string, sessionId: string): string {
  const url = `http://127.0.0.1:${port}/mcp?profile=${encodeURIComponent(profileId)}&session=${encodeURIComponent(sessionId)}`;
  return JSON.stringify({ mcpServers: { [HARNESS_SERVER]: { type: "http", url, timeout: MCP_TIMEOUT_MS } } });
}

/** A harness off a blob or the disk: a session to resume and a launcher, or nothing. */
export function adoptHarness(value: unknown): HarnessState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.sessionId !== "string" || !/^[0-9a-f-]{36}$/.test(raw.sessionId)) return null;
  return {
    sessionId: raw.sessionId,
    launcher: typeof raw.launcher === "string" ? raw.launcher : "claude",
    agentId: typeof raw.agentId === "string" ? raw.agentId : null,
    startedAt: typeof raw.startedAt === "number" && Number.isFinite(raw.startedAt) ? raw.startedAt : 0,
  };
}
