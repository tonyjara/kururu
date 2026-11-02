/**
 * Kuru on OpenCode, the pure half: the command line, the config kururu
 * writes into Kuru's folder, and the session id kururu picks for it.
 *
 * Why there is a second program at all: Claude Code's harness is billed to
 * the Claude subscription, and a subscription has an allowance. On the day it
 * runs out Kuru stops answering, while the API key OpenCode is signed in to
 * still works. So Settings → Agents lets Kuru run on OpenCode instead, and
 * everything Kuru is — its tools, its role, its folder, its drawer, its voice
 * — has to arrive by OpenCode's doors rather than Claude Code's. They are
 * different doors, and this file and `server/src/opencode.ts` are the map:
 *
 * - **Flags become a config file.** OpenCode's TUI takes no `--model`, no
 *   `--mcp-config` and no `--append-system-prompt`; it reads
 *   `.opencode/opencode.json` from the folder it starts in. Kuru's folder is
 *   kururu's (`harnesshome.ts`), so kururu writes that file on every start,
 *   and the folder's plain `opencode.json` stays the user's.
 * - **The role is an instruction file**, not a system prompt: an agent's
 *   `system` would *replace* OpenCode's own prompt, where Claude Code's flag
 *   appends to it, and the harness should stay a coding agent that can read
 *   a file when the question needs it.
 * - **Hooks become a plugin**, which reports to `/api/report` exactly what
 *   `report-cli.ts` reports for Claude — see `server/src/opencode.ts`.
 * - **The session id is chosen here**, before the start, as Claude Code's
 *   `--session-id` lets kururu do: OpenCode's `--session` continues a session
 *   that exists and creates one that does not, so the same flag is both the
 *   start and the resume, and the MCP address can name the session up front.
 * - **A private server.** OpenCode normally hands every client one shared
 *   background service. Kuru gets `--standalone` instead: a server that is
 *   the TUI's own child, so it has the pty's environment (`KURURU_AGENT_ID`,
 *   which is how the plugin knows which agent it is), loads only this
 *   folder's plugin, and ends with the terminal — closing Kuru's tab ends
 *   Kuru's turn, as it does for Claude Code, rather than leaving it running
 *   in a service nobody is looking at.
 */
import { HARNESS_COMPACT_AT, HARNESS_SERVER, MCP_TIMEOUT_MS, OPENCODE_SESSION_ID } from "./harness";
import { AGENT_HEADER, WEB_SERVER, WEB_TIMEOUT_MS, webUrl } from "./web";
import { shq } from "./text";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * A new OpenCode session id, minted the way OpenCode mints its own: `ses_`,
 * then six bytes of time in hex — inverted, so that newer sorts first, which
 * is how OpenCode lists them — then fourteen random characters of base 62.
 * OpenCode itself asks only that it start with `ses`; the rest is matched so
 * Kuru's session sits in `opencode session list` like any other.
 */
export function mintOpencodeSession(now = Date.now(), random: (n: number) => Uint8Array = randomBytes): string {
  const stamp = ~(BigInt(now) * 0x1000n + 1n) & 0xffffffffffffn;
  const time = stamp.toString(16).padStart(12, "0");
  const tail = Array.from(random(14), (byte) => BASE62[byte % 62]).join("");
  const id = `ses_${time}${tail}`;
  if (!OPENCODE_SESSION_ID.test(id)) throw new Error("minted a session id that is not one");
  return id;
}

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** The oldest OpenCode Kuru runs on: 2 is the one with `--standalone`, `--session` that creates, and the plugin API the plugin is written to. */
export const OPENCODE_MIN_MAJOR = 2;

/** How OpenCode 2 is installed, for the sentence that says it is missing. Its own installer puts it in `~/.opencode/bin`. */
export const OPENCODE_INSTALL = "curl -fsSL https://opencode.ai/v2/install | bash";

/**
 * Where an `opencode` might be, in the order it is wanted: the official
 * installer's folder first, then every folder on the PATH.
 *
 * Found here rather than left to the shell, because the shell gets it
 * wrong. A terminal kururu opens runs its command through `zsh -l -c`, a
 * login shell that is not interactive and so never reads `~/.zshrc` —
 * which is exactly where OpenCode's installer puts its folder on the PATH.
 * On a Mac with an OpenCode 1 from Homebrew as well, `opencode` in Kuru's
 * terminal was that one, which has no `--standalone` and which macOS was
 * killing at launch: the tab opened and was gone before it drew a frame.
 */
export function opencodeCandidates(home: string, path: string): string[] {
  const dirs = [`${home}/.opencode/bin`, ...path.split(":").filter((dir) => dir.startsWith("/"))];
  return [...new Set(dirs.map((dir) => `${dir.replace(/\/+$/, "")}/opencode`))];
}

/** The version `opencode --version` prints — `opencode v2.2.4` — as numbers, or null when it printed no version. */
export function opencodeVersion(output: string): [number, number, number] | null {
  const match = /\bv?(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}


/**
 * The line that starts Kuru on OpenCode. `--auto` approves OpenCode's own
 * permission prompts, and is passed when Claude Code's harness would have
 * had its bypass flag — the same switch, so the two programs run Kuru with
 * the same leash. The binary is a full path, found by `findOpencode`
 * (`opencodeCandidates` says why), and quoted, since it is a path off the
 * disk going into `sh -c`; the session id is checked again for the same
 * reason.
 */
export function opencodeHarnessCommand(bin: string, sessionId: string, auto: boolean): string {
  if (!bin.startsWith("/")) throw new Error("OpenCode's path must be absolute");
  if (!OPENCODE_SESSION_ID.test(sessionId)) throw new Error("not an OpenCode session id");
  return [shq(bin), "--standalone", "--session", sessionId, ...(auto ? ["--auto"] : [])].join(" ");
}

/** The private OpenCode process used for an ordinary agent. */
export function opencodeAgentCommand(bin: string, config: string, sessionId: string, auto: boolean): string {
  if (!bin.startsWith("/") || !config.startsWith("/")) throw new Error("OpenCode paths must be absolute");
  if (!OPENCODE_SESSION_ID.test(sessionId)) throw new Error("not an OpenCode session id");
  return `OPENCODE_CONFIG=${shq(config)} ${opencodeHarnessCommand(bin, sessionId, auto)}`;
}

/** A model as OpenCode's session API takes one: `anthropic/claude-opus-5-5#high` in its parts. */
export function opencodeModelRef(model: string): { providerID: string; id: string; variant?: string } | null {
  const match = /^([^/#]+)\/([^#]+)(?:#(.+))?$/.exec(model);
  if (!match) return null;
  const [, providerID = "", id = "", variant] = match;
  return { providerID, id, ...(variant ? { variant } : {}) };
}

/** What `opencodeHarnessConfig` needs: where everything is, and who is asking. */
export interface OpencodeHarnessArgs {
  port: number;
  profileId: string;
  /** OpenCode's session for this harness, minted by `mintOpencodeSession`. */
  sessionId: string;
  /** Whether this server wants its token on loopback too — then each server's headers present it, by name. */
  withToken: boolean;
  /** `provider/model#variant`. */
  model: string;
  /** The folder kururu's plugin is in, written by `server/src/opencode.ts`. */
  plugin: string;
  /** The file the role is in. */
  role: string;
  /** Whether kururu's web tools are on (`WebChain.active`), which adds their server beside kururu's. */
  web: boolean;
}

/**
 * The `.opencode/opencode.json` kururu writes into Kuru's folder before each
 * start. It is merged over the user's global config and the folder's plain
 * `opencode.json`, and wins where they collide; what it sets:
 *
 * - `build`'s model — the built-in agent, kept rather than replaced by an
 *   agent of kururu's, because its permissions are OpenCode's considered
 *   defaults and a new agent's would be a guess;
 * - the role, as an instruction file;
 * - kururu's verbs over MCP, the same endpoint and query Claude Code is
 *   given (`mcpConfig`), with Code Mode off so each verb is a tool of its
 *   own (`kururu_send_agent`), as the role says, and OAuth off because
 *   loopback has nothing to sign in to;
 * - the web tools, when a provider is on, naming the agent as Claude's and
 *   Codex's configs do (`claudeWebConfig`);
 * - the plugin, told the session to listen to, the port to report to, the
 *   model the session should be on, and where to compact.
 *
 * A token is never written: `{env:KURURU_TOKEN}` is OpenCode's own
 * substitution, read in the private server, whose environment is the pty's.
 */
export function opencodeHarnessConfig(args: OpencodeHarnessArgs): Record<string, unknown> {
  const token = args.withToken ? { authorization: "Bearer {env:KURURU_TOKEN}" } : {};
  const url = `http://127.0.0.1:${args.port}/mcp?profile=${encodeURIComponent(args.profileId)}&session=${encodeURIComponent(args.sessionId)}`;
  const servers: Record<string, unknown> = {
    [HARNESS_SERVER]: {
      type: "remote",
      url,
      oauth: false,
      codemode: false,
      timeout: { execution: MCP_TIMEOUT_MS },
      ...(args.withToken ? { headers: token } : {}),
    },
  };
  if (args.web) {
    servers[WEB_SERVER] = {
      type: "remote",
      url: webUrl(args.port),
      oauth: false,
      codemode: false,
      timeout: { execution: WEB_TIMEOUT_MS },
      headers: { [AGENT_HEADER]: "{env:KURURU_AGENT_ID}", ...token },
    };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    default_agent: "build",
    agents: { build: { model: args.model } },
    instructions: [args.role],
    mcp: { servers },
    plugins: [
      {
        package: args.plugin,
        options: { session: args.sessionId, port: args.port, model: args.model, modelRef: opencodeModelRef(args.model), compactAt: HARNESS_COMPACT_AT },
      },
    ],
  };
}

/** A normal agent gets reporting and web tools, but none of Kuru's role or acting tools. */
export function opencodeAgentConfig(args: Omit<OpencodeHarnessArgs, "profileId" | "role">): Record<string, unknown> {
  const token = args.withToken ? { authorization: "Bearer {env:KURURU_TOKEN}" } : {};
  const servers: Record<string, unknown> = {};
  if (args.web) {
    servers[WEB_SERVER] = {
      type: "remote", url: webUrl(args.port), oauth: false, codemode: false,
      timeout: { execution: WEB_TIMEOUT_MS }, headers: { [AGENT_HEADER]: "{env:KURURU_AGENT_ID}", ...token },
    };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    default_agent: "build",
    agents: { build: { model: args.model } },
    ...(args.web ? { mcp: { servers } } : {}),
    plugins: [{ package: args.plugin, options: { session: args.sessionId, port: args.port, model: args.model, modelRef: opencodeModelRef(args.model), compactAt: 0 } }],
  };
}
