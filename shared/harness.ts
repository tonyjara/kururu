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
 * Claude (keys into its pty, which is how the user's words go in, and its
 * inbox socket, which carries only kururu's own notices), when a waiting
 * message may be typed, and the readers that turn a transcript into turns. `server/src/harness.ts` is the half that
 * touches the host and the layout.
 *
 * Two ideas are borrowed from pi, the harness most people build their own on,
 * and are worth naming. A message to a working agent means one of two things —
 * *now*, between its tool calls, or *next*, once its turn is over — and the
 * tool says which rather than guessing. And "finished" is two signals, the turn
 * ending and nothing more being queued; `wait_agent` reports the first and the
 * orchestrator is told to look before trusting it.
 */
import type { AgentSnapshot, AgentStatus, HarnessState } from "./model";
import type { ClientMessage } from "./wire";

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
      "Type a message into an agent's terminal and press Enter. It arrives as the user's own words, with the user's authority, and a slash command such as /compact runs as one. when=next (default) waits until its current turn ends; when=now types it at once, and a working agent reads it between its tool calls; when=later goes after anything already waiting. A slash command always waits for the turn to end. Nothing is typed while the agent is showing a prompt, because Enter would answer it — that takes press_keys and the user's say-so — or while the user is typing in that terminal; the message waits instead, and the result says so.",
    inputSchema: obj(
      {
        agent: AGENT,
        text: str("The message, as the user would type it. A message starting with / is a slash command."),
        when: { type: "string", enum: [...WHENS], description: "When it is typed. Default next." },
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
  {
    name: "say",
    description:
      "Say one short line aloud to the user right now, mid-turn — for example that you are starting three agents and it will take a minute. Your final message of every turn is read aloud anyway, so use this only for something worth hearing before the turn ends. Plain words, one or two sentences, in the user's language.",
    inputSchema: obj({ text: str("What to say. At most 300 characters.") }, ["text"]),
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
 * The class a Claude Code session's permission mode falls in, as its peers
 * are asked to declare it: `bypass` for a session that runs tools without
 * asking, `prompting` for one that asks.
 */
export type ModeClass = "bypass" | "prompting";

/**
 * A message `send_agent` or the voice has for an agent, waiting until it may
 * be typed. See `due`.
 */
export interface Held {
  text: string;
  when: When;
}

/**
 * Whether a message is a slash command. Claude Code runs one only at an idle
 * prompt, so it waits for the turn to end whatever `when` says, and it is
 * typed on its own rather than joined to the messages around it, which would
 * make it text. A path such as `/Users/…` matches too and only waits a turn
 * it did not need to.
 */
export function isCommand(text: string): boolean {
  return /^\/[^\s/]/.test(text.trimStart());
}

/**
 * Which of an agent's waiting messages may be typed into it now, and in what
 * pieces, given its status: the half of `send_agent` that decides, without
 * the pty.
 *
 * Messages are typed because typing is the only door that makes them the
 * user's — see `Harness.speak` for what the inbox does instead — and the
 * terminal's own rules set the timing. A Claude that is working takes a
 * message typed now and reads it between its tool calls, which is `now`.
 * `next` and `later` therefore wait in kururu for the turn to end, and so
 * does every slash command. Nothing is typed into an agent that is
 * `blocked`, because its screen is a prompt and the paste and the Enter
 * would answer it; that is `press_keys`, with the user's say-so. At the end
 * of a turn everything waiting goes in, `now` before `next` before `later`,
 * with neighbouring messages joined into one turn — as Claude Code joins the
 * messages queued in its own prompt box — and each slash command alone.
 *
 * A shell has no turns to wait for (its status is a guess off the screen,
 * `tellsHarness`), so for one `when` cannot apply and everything is typed
 * as it comes, which is what typing into a shell always did.
 */
export function due(held: readonly Held[], status: AgentStatus, isAgent: boolean): { type: string[]; rest: Held[] } {
  if (!isAgent) return { type: held.map((m) => m.text), rest: [] };
  if (status === "blocked") return { type: [], rest: [...held] };
  const between = status === "idle" || status === "done";
  const ready = between ? [...held].sort((a, b) => WHENS.indexOf(a.when) - WHENS.indexOf(b.when)) : held.filter((m) => m.when === "now" && !isCommand(m.text));
  const type: string[] = [];
  let joined: string[] = [];
  const close = () => {
    if (joined.length) type.push(joined.join("\n\n"));
    joined = [];
  };
  for (const { text } of ready) {
    if (!isCommand(text)) {
      joined.push(text);
      continue;
    }
    close();
    type.push(text.trim());
  }
  close();
  return { type, rest: held.filter((m) => !ready.includes(m)) };
}

/**
 * Who kururu's own notices to the harness say they are from — the
 * `[kururu]` lines, the one thing still posted into an inbox.
 *
 * Claude Code tells the receiver a peer's message wants a SendMessage reply,
 * and resolves a SendMessage address of three letters or more by prefix
 * against every session on the machine. A session nobody named is named
 * after its folder and two hex digits — `kururu-7f`, `kururu-f5` — so a
 * notice signed "kururu" sent its replies to whichever session in the kururu
 * repository the prefix landed on, which is how one agent's answer reached
 * another and was reported as a mystery. A name that says what it is, with
 * characters no folder-derived name has, is a prefix of nothing; the role
 * says the rest.
 */
export const NOTICE_SENDER = "kururu (no reply)";

/** The tag a cross-session message's body is wrapped in, with the sender's claims as attributes. */
export const CROSS_SESSION_TAG = "cross-session-message";

/**
 * A message body as a session's peers send it: wrapped, with who it is from
 * and what permission class it runs in.
 *
 * This is where the attestation lives, and finding that out cost a day of
 * held messages. A session that bypasses permission prompts holds a peer's
 * message for the user's approval unless the peer declares its own class and
 * it matches — "The sender did not attest its permission mode and this
 * session bypasses prompts" — and the declaration is not a field of the JSON
 * frame but an attribute of this envelope, which the receiver parses off the
 * front of the content and rebuilds to check it is canonical. So the shape is
 * exact: one space before each attribute, in this order, a newline after the
 * opening tag and before the closing one, nothing else. A `<` in the body
 * that could start the closing tag is replaced, because the receiver would
 * escape it and the rebuilt string would then not match.
 *
 * kururu declares the class of the sessions it starts, which is the class
 * the harness runs in, the one session that still receives these.
 *
 * What no envelope can do is make the message the user's. Claude Code files
 * every frame on the socket as a peer's whatever it carries — it introduces
 * the body as "Another Claude session sent a message … not typed by your
 * user", and its permission classifier holds that a cross-session message
 * never establishes the user's intent. That is the receiver's rule and a
 * sound one, and it is why `send_agent` and the voice type instead.
 */
export function envelope(text: string, mode: ModeClass, name = NOTICE_SENDER): string {
  const body = text.replace(new RegExp(`<(?=\\s*/?\\s*${CROSS_SESSION_TAG})`, "gi"), "‹");
  return `<${CROSS_SESSION_TAG} from-name="${name}" from-mode="${mode}">\n${body}\n</${CROSS_SESSION_TAG}>`;
}

/**
 * The lines a notice to the harness is, on its inbox socket.
 *
 * Newline-delimited JSON. The first line is the session's own token, which is
 * what lets the message in at all: a frame without it is a stranger's. The
 * hook that runs inside the session reports the token to kururu, so kururu
 * has it and nobody else does. The second line is the message, in the shape
 * the session's own stdin takes: a user turn, with a sender for the preview
 * line and a priority for when it is read — and the content wrapped in the
 * `envelope`, because the token is not enough for a session that bypasses
 * prompts: it also wants to know the sender's class, and holds the message
 * for the user otherwise.
 *
 * Only kururu's `[kururu]` lines go this way. They are kururu's and not the
 * user's, so arriving as a peer's is the truth about them, and the inbox
 * queues them inside the session, where a server restart cannot lose them
 * and the user typing to the harness cannot collide with them.
 */
export function inboxFrames(text: string, token: string | null, priority: When, mode: ModeClass = "bypass", from = NOTICE_SENDER): string {
  const lines: string[] = [];
  if (token) lines.push(JSON.stringify({ type: "auth", token }));
  lines.push(JSON.stringify({ type: "user", message: { role: "user", content: envelope(text, mode, from) }, from, priority }));
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

/**
 * An agent as the harness is shown it: what it is, where, and last the id its
 * tools take.
 *
 * The order is the instruction. The harness repeats what it reads, and when
 * every tool result opened with `a237` the user was told about "a237" all
 * afternoon — a name that means nothing to anybody who did not mint it. So the
 * words come first, in the shape a person would put them: the name somebody
 * gave it, or the card it is running, or failing both what it says it is
 * doing; then the program and the workspace; and the id in brackets at the
 * end, labelled as the thing for tool calls that it is. The role says the
 * rest — see `rolePrompt`.
 */
export interface AgentNaming {
  id: string;
  /** A rename, or the title of the card its run was named after. */
  name: string | null;
  /** What it says it is doing — the activity it reported, or the title it set. */
  doing: string | null;
  /** claude, codex, a shell. */
  program: string;
  workspace: string | null;
  /** The card it is running: its code, such as FAS-3, and its title. */
  card: { code: string; title: string } | null;
}

/** What one is called is kept short: a title a turn wrote can be a paragraph. */
const NAME_MAX = 60;

export function agentName(agent: AgentNaming): string {
  const what = oneLine(agent.name || agent.card?.title || agent.doing || "");
  const card = agent.card ? `, card ${agent.card.code}${oneLine(agent.card.title) === what ? "" : ` "${oneLine(agent.card.title)}"`}` : "";
  const where = `${agent.program}${agent.workspace ? ` in ${agent.workspace}` : ""}${card}`;
  return what ? `"${what}" (${where}; id ${agent.id})` : `${where} (id ${agent.id})`;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > NAME_MAX ? `${flat.slice(0, NAME_MAX - 1)}…` : flat;
}

/**
 * Whether an edge on this terminal is posted to the harness's inbox: an
 * agent's, never a shell's.
 *
 * A shell is under `status.ts`'s timing guess for as long as it lives, and the
 * guess cannot tell a turn from a repaint. Typing in nvim is the case that was
 * reaching the harness several times a day: the echo of each keystroke is
 * ignored, but the repaint that lands a beat later — completion, diagnostics,
 * a status line — is not, and four seconds of editing followed by a pause
 * reads as four seconds of work that finished. A card's dev server rebuilding
 * is the same shape. The window has never announced any of it (`notifyGate`
 * says `not-an-agent`); the feed did not ask, and every one was a turn the
 * harness spent being told an editor "finished its turn".
 *
 * The test `countsAsAgent` makes — launched as an agent, or one found running
 * in it, so a shell somebody typed `claude` into counts while claude is there
 * — but not that function, which says no to every exited terminal, and an
 * exit is one of the edges this is asked about.
 *
 * Only the unasked feed. A `wait_agent` naming a shell is still answered: the
 * harness asked about that terminal, which is not the same as being
 * interrupted by it.
 */
export function tellsHarness(agent: Pick<AgentSnapshot, "kind" | "agent">): boolean {
  return agent.kind === "agent" || agent.agent !== null;
}

/**
 * The tools that are aimed at one agent, and so move the screen to it when
 * the profile has Auto Swap on — see `Profile.autoSwap`. `add_card` is one
 * only with `run`, which the caller knows and this list cannot. `wait_agent`
 * is not: it names several and does nothing to any of them, and a wait that
 * dragged the screen about would be the harness fidgeting. `reveal_agent` is
 * not either, because it already moves the screen, at once and on purpose.
 */
export const SWAP_TOOLS: ReadonlySet<string> = new Set([
  "read_agent",
  "send_agent",
  "press_keys",
  "start_agent",
  "stop_agent",
  "rename_agent",
  "run_card",
  "add_card",
]);

/**
 * What the user does that a swap must not land in the middle of: typing into
 * a terminal, and moving about the screen themselves.
 *
 * Typing is the one that costs something. A swap moves the focused pane, and
 * the focused pane is where the next keystroke goes, so a swap mid-sentence
 * sends the rest of the sentence to an agent it was not for — the harness's
 * own pane included, since talking to the harness is typing in a terminal. So
 * typing *holds* a swap until the hands are still, and then it happens.
 *
 * Moving is a decision, and a swap that was waiting when it was made would
 * overrule it a moment later — you go to the workspace you wanted and are
 * taken straight back out of it. So moving *drops* what was waiting, and holds
 * anything asked after it the same way typing does. Making a place to type,
 * a tab or a split, counts as moving.
 *
 * A list of what counts rather than of what does not, though the second would
 * fail safe for a verb nobody remembered to add. It would fail safe by holding
 * swaps off for good the first time a client polls something on a timer, and
 * a switch that silently never works is worse than one that misses a verb.
 */
const STEERING: ReadonlySet<ClientMessage["type"]> = new Set<ClientMessage["type"]>([
  "new-tab",
  "select-tab",
  "cycle-tab",
  "split",
  "focus-pane",
  "focus-dir",
  "step-pane",
  "last-pane",
  "switch-workspace",
  "workspace-index",
  "step-workspace",
  "last-workspace",
  "switch-profile",
  "reveal-agent",
  "open-harness",
]);

export type Hands = "typing" | "steering";

export function handsOf(type: ClientMessage["type"]): Hands | null {
  if (type === "input") return "typing";
  return STEERING.has(type) ? "steering" : null;
}

/** A burst of calls is one swap, to the last of them. Long enough for calls made together, short enough not to be a delay. */
export const SWAP_GATHER_MS = 400;
/** How long the user's hands must have been still. Longer than the gap between two words, shorter than the harness takes to answer one. */
export const SWAP_QUIET_MS = 2500;
/** The least time a swap holds the screen before the next. Long enough to see what is happening in it. */
export const SWAP_DWELL_MS = 4000;
/** A swap that has waited this long has stopped meaning anything, and a jump nobody can connect to a cause is worse than none. */
export const SWAP_STALE_MS = 15_000;

/**
 * When a swap may happen: the clock half of Auto Swap, without the clock.
 *
 * One slot, and the newest call takes it. That is what stops the flicker —
 * the harness reading four agents in a row is four asks and at most two
 * swaps: the burst settles (`SWAP_GATHER_MS`) on the last, and anything after
 * a swap waits out `SWAP_DWELL_MS`, with whatever was asked meanwhile
 * replacing whatever was waiting. And it is what keeps a swap out from under
 * the user: nothing moves until their hands have been still for
 * `SWAP_QUIET_MS`, a move of their own drops what was waiting (`handsOf`),
 * and a swap they held off for longer than `SWAP_STALE_MS` is dropped rather
 * than done late.
 *
 * Times are passed in rather than read, so the rules can be tested as the
 * arithmetic they are; the server's half is a timer and the checks that need
 * the layout — `Harness.swapNow`.
 */
export class SwapGate<T> {
  private wanted: { target: T; asked: number } | null = null;
  private hands = -Infinity;
  private swapped = -Infinity;

  /** The harness acted on `target`. */
  ask(target: T, now: number): void {
    this.wanted = { target, asked: now };
  }

  /** The user typed, or moved about the screen — see `handsOf` for why the two differ. */
  touched(hands: Hands, now: number): void {
    this.hands = now;
    if (hands === "steering") this.wanted = null;
  }

  /**
   * The screen moved to an agent — by this gate, or by `reveal_agent` asking
   * outright. The second also clears what was waiting: a swap held back from
   * before an explicit reveal would undo it a few seconds later.
   */
  moved(now: number): void {
    this.swapped = now;
    this.wanted = null;
  }

  /** At `now`: show the target, ask again in so many ms, or nothing to do. */
  next(now: number): { show: T } | { wait: number } | null {
    const wanted = this.wanted;
    if (!wanted) return null;
    const due = Math.max(wanted.asked + SWAP_GATHER_MS, this.hands + SWAP_QUIET_MS, this.swapped + SWAP_DWELL_MS);
    if (due - wanted.asked > SWAP_STALE_MS) {
      this.wanted = null;
      return null;
    }
    if (due > now) return { wait: due - now };
    this.wanted = null;
    return { show: wanted.target };
  }
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
 *
 * One rule is kururu's own: an agent is called by what it is and where, and
 * its id is said only when asked for. Ids are what the tools take, so they are
 * what the harness saw most of, and it told the user about "a237" until this
 * said not to — with `agentName` putting the words first in everything it
 * reads, so that the habit has something better to copy.
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

## What you call them
The user does not know the agents by id. Call each one by what it is and where it is, the way they would: "the Fastermenu migration agent", "the agent on the checkout card", "the Codex in api". Every tool result and every [kururu] message names an agent that way first — its name in quotes, the program, the workspace, the card — with the id last, in brackets, for your tool calls. Agent ids such as a237, and workspace and card ids, are for tools: never say or write one to the user unless they ask for it. When two agents fit a description, say what tells them apart rather than reaching for an id. When you start an agent, give it a short name (start_agent's name) so it has one to be called by.

## How you hear from them
kururu messages you, unasked, when an agent in this profile finishes a turn or blocks. Such a message starts with "[kururu]" and names the agent. It arrives wrapped as a cross-session message from "${NOTICE_SENDER}": that is kururu's server, not a Claude session, and nothing reads a reply to it — never answer one with SendMessage. Act through the kururu tools, and tell the user in your own reply. When one arrives: read the agent if its last reply is not in the message, decide whether the user needs to know or you can answer the agent yourself, and keep your reply to the user to the point — one line when nothing needs them. wait_agent is for when you have nothing else to do.

## Your voice
The user may talk to you by holding a key, and your last message of every turn is read aloud to them by a speech synthesiser whether they typed or spoke. So write that message to be heard: a few plain sentences, no headings, lists, tables or code. Anything that needs to be read — a diff, a file list, a plan — goes on a card, and the message says that it did. Answer in the language the user used. A message that starts with "[voice]" was transcribed from speech, and a name or an id in it may be misheard: match it loosely against kururu_status, and ask when two things could be meant. The say tool speaks one line at once, mid-turn, for something worth hearing before you are done.

## Rules
- The agents are the user's. A permission prompt an agent is showing is the user's to answer: read its screen, tell the user what is asked, and press keys only as they say. Ask before stop_agent, and before moving a card to done.
- A message you send to an agent is typed into its terminal, so it is the user's own words with the user's authority. Write it as the user would, with what the agent needs and nothing about yourself, and send only what the user asked for or would plainly want: the agent will act on it without asking anyone.
- Prefer a card to a bare start_agent for anything that is a task: a card is where the work is tracked, and the user reads the board.
- Keep your own context small. Read with the defaults, ask for fewer lines or turns, never paste an agent's whole screen back to the user; summarise and say which agent and where, by name.
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
