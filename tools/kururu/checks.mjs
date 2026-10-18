/**
 * The list of things a child needs, each one a check that only reads and a
 * repair that fixes or guides — one list, read three ways.
 *
 * Setting a child up by hand was a dozen steps on two machines, each with a
 * way to get it slightly wrong, and the doctor that would catch the wrong one
 * afterwards is the same knowledge again. Written twice they drift: the
 * wizard learns that a unit wants node by its full path and the doctor goes
 * on approving one that names a shim. So there is one list, in order, and
 * `kururu child setup` walks it repairing, `kururu child doctor` walks it
 * reading, and the skill walks the wizard. `docs/plans/kururu-parent-child.md`
 * has the table this is the code of; `docs/linux.md` is the prose.
 *
 * What a repair never does is what the wizard refuses: run `tailscale`
 * (CLAUDE.md rule 4), run `sudo`, or print a token or a key. Those are
 * printed for the person to type. Everything else it can do as this user, it
 * does, after saying what and why, and `--dry-run` turns every one of them
 * into a line that says what it would have done.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, networkInterfaces, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { localToken } from "../../server/localtoken.mjs";
import { socketHolders } from "../../server/sockowner.mjs";
import {
  atLeast,
  cgroupUnit,
  isHostUnit,
  keysInEnv,
  lanAddresses,
  lingerOn,
  parseShowEnvironment,
  parseVersion,
  scanForKeys,
  settingsKeys,
  staleBuild,
  tailnetAddress,
  unitActive,
  unitText,
} from "./pure.mjs";

/** `node:sqlite` with `backup()`, which the store needs, is in both. */
const NODE_FLOOR = [24, 0, 0];
const BUN_FLOOR = [1, 2, 0];
const HEALTH_WAIT_MS = 60_000;

/** A step asks for something the person must do or decide; the wizard stops there and says how to go on. */
export class Stop extends Error {
  constructor(message, { code = 4, answer } = {}) {
    super(message);
    this.code = code;
    this.answer = answer;
  }
}

// --- reading the machine -------------------------------------------------------

/** A command's stdout, or null when it is missing or fails. Never a shell: arguments are arguments. */
function run(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, ...options });
  } catch {
    return null;
  }
}

/** The full path of a command on this PATH, or null. */
function which(cmd, env) {
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const path = join(dir, cmd);
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      // Not here.
    }
  }
  return null;
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJson(path) {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const home = homedir();
const short = (path) => (path?.startsWith(home) ? `~${path.slice(home.length)}` : path);

/** The newest file under `dirs`, walked by hand, `node_modules` and dotfiles left out. */
function sourceTimes(root, dirs) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "test") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js|css|html|json)$/.test(entry.name)) out.push([path, statSync(path).mtimeMs]);
    }
  };
  for (const dir of dirs) walk(join(root, dir));
  return out;
}

function mtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

async function get(url, token) {
  try {
    const response = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      // A refusal has no JSON to give.
    }
    return { status: response.status, body };
  } catch (err) {
    return { status: 0, error: err?.cause?.code ?? err?.code ?? err?.message ?? String(err) };
  }
}

/** Whether nothing listens on a port: bind it for a moment on every address and let go. */
function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: "0.0.0.0", exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

function systemctl(args, env) {
  return spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", env, timeout: 30_000 });
}

// --- the context --------------------------------------------------------------

/**
 * Everything a check needs to know about where it is: the checkout, the
 * instance's directories by the server's own rules, the answers given before
 * (`child.json`), and the port and unit those answers chose. The directories
 * follow the `KURURU_*` variables exactly as the server does, so a throwaway
 * instance is set up by the same wizard with nothing but its environment.
 */
export function context({ root, env, flags }) {
  const configDir = env.KURURU_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "kururu");
  const stateDir = env.KURURU_STATE_DIR || join(env.XDG_STATE_HOME || join(home, ".local", "state"), "kururu");
  const dataDir = env.KURURU_DATA_DIR || join(env.XDG_DATA_HOME || join(home, ".local", "share"), "kururu");
  const saved = readJson(join(configDir, "child.json")) ?? {};
  const portText = String(flags.port ?? saved.port ?? env.KURURU_PORT ?? 7717);
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) throw new Stop(`--port must be a port number, not ${portText}`, { code: 2 });
  const unit = String(flags.unit ?? saved.unit ?? "kururu");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(unit)) throw new Stop(`--unit must be a plain unit name, not ${unit}`, { code: 2 });
  /**
   * A runtime unit is a throwaway one: `$XDG_RUNTIME_DIR/systemd/user` is on
   * the user manager's path and is gone at the next boot, which is what a
   * test of the wizard on somebody's real box wants. Chosen once and kept.
   */
  const runtime = flags.runtime === true || saved.runtime === true;
  const runtimeDir = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;
  const unitDir = runtime ? join(runtimeDir, "systemd", "user") : join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user");
  const ctxEnv = { ...env, KURURU_PORT: String(port), XDG_RUNTIME_DIR: runtimeDir };
  return {
    root,
    env: ctxEnv,
    flags,
    saved,
    dryRun: flags["dry-run"] === true,
    configDir,
    stateDir,
    dataDir,
    socket: env.KURURU_HOST_SOCK || join(stateDir, "ptyhost.sock"),
    port,
    unit,
    runtime,
    unitFile: join(unitDir, `${unit}.service`),
    binDir: String(flags.bin ?? saved.bin ?? join(home, ".local", "bin")),
    user: userInfo().username,
    /** What this run changed, for the last line: "nothing to change" is the idempotent run's whole report. */
    changed: [],
    /** Whether this run rebuilt the bundles, which a running server picks up only on a restart. */
    rebuilt: false,
  };
}

/** Write the answers back, so a second run asks nothing it was told. */
export function remember(ctx, values) {
  Object.assign(ctx.saved, values);
  if (ctx.dryRun) return;
  mkdirSync(ctx.configDir, { recursive: true });
  writeFileSync(join(ctx.configDir, "child.json"), `${JSON.stringify(ctx.saved, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Do something that changes the machine, or in a dry run say it would. The
 * description is what the person reads either way, so it is written as what
 * happens, not as a command.
 */
function act(ctx, io, description, fn) {
  if (ctx.dryRun) {
    io.say(`would ${description}`);
    return false;
  }
  io.say(`${description[0].toUpperCase()}${description.slice(1)}…`);
  fn();
  ctx.changed.push(description);
  return true;
}

/** A command run where the person can see it, failing the step when it fails. */
function visibly(cmd, args, options) {
  const done = spawnSync(cmd, args, { stdio: "inherit", timeout: 20 * 60_000, ...options });
  if (done.status !== 0) throw new Stop(`\`${[cmd, ...args].join(" ")}\` failed (${done.error?.message ?? `exit ${done.status}`})`, { code: 1 });
}

/**
 * The node the unit runs: this one. By mise's own name for it when mise is
 * what resolved it — `installs/node/26/bin/node`, a link that follows the
 * next 26.x — rather than the versioned directory behind the link, which a
 * `mise prune` after an upgrade deletes from under a running unit.
 */
let resolvedNode = null;
function unitNode(env = process.env) {
  if (resolvedNode) return resolvedNode;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const self = real(process.execPath);
  const mise = which("mise", env) && run("mise", ["which", "node"], { env })?.trim();
  resolvedNode = mise && real(mise) === self ? mise : self;
  return resolvedNode;
}

/**
 * The PATH the server and its ptys are given. Built rather than copied from
 * the shell the wizard ran in, which differs between ssh, tmux and an agent's
 * tool and would make every second run rewrite the unit.
 */
function unitPath(ctx) {
  const bun = which("bun", ctx.env);
  const dirs = [dirname(unitNode(ctx.env)), bun && dirname(bun), join(home, ".local", "bin")];
  const shims = join(ctx.env.XDG_DATA_HOME || join(home, ".local", "share"), "mise", "shims");
  if (existsSync(shims)) dirs.push(shims);
  dirs.push("/usr/local/bin", "/usr/bin", "/bin");
  return [...new Set(dirs.filter(Boolean))].join(":");
}

/** Variables an isolated instance is made of, carried into its unit when the wizard was run with them. */
const ISOLATION = ["KURURU_STATE_DIR", "KURURU_DATA_DIR", "KURURU_CONFIG_DIR", "KURURU_HOST_SOCK", "KURURU_AGENT_CWD"];

export function wantedUnit(ctx) {
  const env = { KURURU_BIND: "tailscale", KURURU_LOOPBACK_TOKEN: "1", PATH: unitPath(ctx) };
  if (ctx.port !== 7717) env.KURURU_PORT = String(ctx.port);
  for (const name of ISOLATION) if (ctx.env[name]) env[name] = ctx.env[name];
  return unitText({
    description: ctx.unit === "kururu" ? "kururu, a child: the server (its pty host is a unit of its own)" : `kururu (${ctx.unit}), a child: the server`,
    node: unitNode(ctx.env),
    checkout: ctx.root,
    env,
  });
}

function token(ctx) {
  return localToken({ KURURU_CONFIG_DIR: ctx.configDir });
}

async function health(ctx, host = "127.0.0.1") {
  return get(`http://${host}:${ctx.port}/api/health`, token(ctx));
}

// --- the steps ----------------------------------------------------------------

/**
 * Each step: a title, why it matters (said by the wizard before it looks),
 * `check` returning rows — `{ title, state, detail, fix }`, read-only, the
 * doctor's whole job — and `repair`, the wizard's, which fixes or guides and
 * throws `Stop` when it needs the person. After a repair the wizard checks
 * again, and goes on only when the step's rows have no failure.
 */
export const STEPS = [
  {
    id: "runtime",
    title: "node and bun",
    why: "The server runs on node (24 or newer, for node:sqlite) and the checkout is installed and built with bun. The unit names node by its full path, because a service's PATH is not your shell's and mise's shims are on the second.",
    async check(ctx) {
      const node = parseVersion(process.version);
      const bunPath = which("bun", ctx.env);
      const bun = bunPath ? parseVersion(run(bunPath, ["--version"]) ?? "") : null;
      const rows = [
        atLeast(node, NODE_FLOOR)
          ? { title: "node", state: "ok", detail: `${process.version} · ${short(unitNode(ctx.env))}` }
          : { title: "node", state: "fail", detail: `${process.version} is older than 24`, fix: "mise use -g node@26, then run this again with that node" },
        bun && atLeast(bun, BUN_FLOOR)
          ? { title: "bun", state: "ok", detail: `${bun.join(".")} · ${short(bunPath)}` }
          : { title: "bun", state: "fail", detail: bunPath ? `${bun?.join(".") ?? "unknown"} is older than 1.2` : "not on this PATH", fix: "mise use -g bun@latest" },
      ];
      // What the unit was written with, which a mise upgrade can take away from under it.
      const unit = readText(ctx.unitFile);
      const named = unit && /^ExecStart=("?)(\S+?)\1 /m.exec(unit)?.[2];
      if (named && named !== unitNode(ctx.env)) {
        rows.push(
          existsSync(named)
            ? { title: "unit's node", state: "ok", detail: `${short(named)}, not this shell's — \`kururu child setup\` moves it to ${process.version}` }
            : { title: "unit's node", state: "fail", detail: `${short(named)} is gone`, fix: "kururu child setup, which writes the unit with this node" },
        );
      }
      return rows;
    },
    async repair() {
      throw new Stop("Install node 24 or newer and bun first: `mise use -g node@26 bun@latest`, or the system packages. Then run this again with that node.");
    },
  },

  {
    id: "checkout",
    title: "the checkout",
    why: "A child runs this checkout: its server bundle, its web build, and node-pty compiled here, since node-pty ships no Linux build and node-gyp makes one at install. The agents on this box will want their own read access to your private repositories, and push access if they push: `gh auth login` as this user, or an SSH key. The wizard does not do that one.",
    async check(ctx) {
      const rows = [];
      rows.push(
        existsSync(join(ctx.root, ".git"))
          ? { title: "checkout", state: "ok", detail: short(ctx.root) }
          : { title: "checkout", state: "fail", detail: `${short(ctx.root)} is not a git checkout`, fix: "git clone https://github.com/tonyjara/kururu.git ~/kururu" },
      );
      const pty = join(ctx.root, "node_modules", "node-pty", "build", "Release", "pty.node");
      rows.push(
        existsSync(pty)
          ? { title: "installed", state: "ok", detail: "node-pty built for this machine" }
          : { title: "installed", state: "fail", detail: existsSync(join(ctx.root, "node_modules")) ? "node-pty was not built (no pty.node)" : "not installed", fix: "ELECTRON_SKIP_BINARY_DOWNLOAD=1 bun install --frozen-lockfile" },
      );
      const server = staleBuild(
        Math.min(mtime(join(ctx.root, "desktop", "dist", "server.mjs")) ?? -1, mtime(join(ctx.root, "desktop", "dist", "ptyhostd.mjs")) ?? -1),
        sourceTimes(ctx.root, ["server/src", "shared"]),
      );
      const web = staleBuild(mtime(join(ctx.root, "web", "dist", "index.html")), sourceTimes(ctx.root, ["web/src", "shared"]));
      const stale = [server.stale && "the server", web.stale && "the web app"].filter(Boolean);
      const never = !existsSync(join(ctx.root, "desktop", "dist", "server.mjs")) && !existsSync(join(ctx.root, "web", "dist", "index.html"));
      const newest = server.stale ? server.newest : web.newest;
      rows.push(
        never
          ? { title: "built", state: "fail", detail: "not built", fix: "bun run build" }
          : stale.length
          ? { title: "built", state: "fail", detail: `${stale.join(" and ")} ${stale.length > 1 ? "are" : "is"} older than ${newest ? short(newest) : "the sources"}`, fix: "bun run build" }
          : { title: "built", state: "ok", detail: "the server and the web app are current" },
      );
      return rows;
    },
    async repair(ctx, io, rows) {
      if (rows[0].state === "fail") throw new Stop(`This is not a checkout. Clone kururu and run the wizard from there:\n  git clone https://github.com/tonyjara/kururu.git ~/kururu\n  cd ~/kururu && node tools/kururu.mjs child setup`);
      const env = { ...ctx.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1" };
      if (rows[1].state === "fail") {
        act(ctx, io, "install the checkout's packages with bun, which compiles node-pty for this machine", () =>
          visibly("bun", ["install", "--frozen-lockfile"], { cwd: ctx.root, env }),
        );
      }
      if (rows[1].state === "fail" || rows[2].state === "fail") {
        const did = act(ctx, io, "build the server and the web app", () => visibly("bun", ["run", "build"], { cwd: ctx.root, env }));
        if (did) ctx.rebuilt = true;
      }
    },
  },

  {
    id: "command",
    title: "the kururu command",
    why: "So that `kururu child doctor`, `update` and `status` work from any terminal on this box, the wizard links this checkout's tools/kururu.mjs into ~/.local/bin.",
    async check(ctx) {
      const link = join(ctx.binDir, "kururu");
      const target = join(ctx.root, "tools", "kururu.mjs");
      let points = null;
      try {
        points = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : "a file";
      } catch {
        // Not there.
      }
      const onPath = (ctx.env.PATH ?? "").split(":").includes(ctx.binDir);
      if (points === target) {
        return [{ title: "command", state: "ok", detail: `${short(link)}${onPath ? "" : ` · ${short(ctx.binDir)} is not on this PATH`}` }];
      }
      return [
        {
          title: "command",
          state: "fail",
          detail: points ? `${short(link)} is ${points === "a file" ? "a file of somebody else's" : `a link to ${short(points)}`}` : `no ${short(link)}`,
          fix: "kururu child setup",
        },
      ];
    },
    async repair(ctx, io) {
      const link = join(ctx.binDir, "kururu");
      const target = join(ctx.root, "tools", "kururu.mjs");
      let existing = null;
      try {
        existing = lstatSync(link);
      } catch {
        // Free.
      }
      if (existing && !existing.isSymbolicLink()) {
        throw new Stop(`${short(link)} is a file the wizard did not write, so it is left alone. Move it aside and run this again, or link by hand:\n  ln -sf ${target} ${link}`);
      }
      if (existing) {
        const answer = await io.ask(`${short(link)} points at ${short(readlinkSync(link))}. Point it at this checkout instead?`, ["yes", "no"], "relink");
        if (answer !== "yes") throw new Stop("Left as it is; `kururu` runs the other checkout.", { code: 1 });
      }
      act(ctx, io, `link ${short(link)} to this checkout`, () => {
        mkdirSync(ctx.binDir, { recursive: true });
        if (existing) unlinkSync(link);
        symlinkSync(target, link);
      });
    },
  },

  {
    id: "account",
    title: "the user",
    why: "Which account runs the child is the first real decision. Its agents run with bypass permissions, as that account, with everything it can reach. This account is the simple choice on a box that is yours alone. A dedicated user, with no sudo and no docker group, is the stronger one: an injected `rm -rf` then stops at that user's clones.",
    async check(ctx) {
      const groups = (run("id", ["-Gn"]) ?? "").trim().split(/\s+/).filter(Boolean);
      const sudo = groups.filter((g) => g === "wheel" || g === "sudo" || g === "admin");
      const notes = [sudo.length ? `in ${sudo.join(", ")}: an agent can sudo with your password` : "no sudo", groups.includes("docker") ? "in docker: an agent can be root through it" : "not in docker"];
      let mode = null;
      try {
        mode = (statSync(home).mode & 0o777).toString(8);
      } catch {
        // No home to read is a stranger problem than this row.
      }
      if (mode && (Number.parseInt(mode, 8) & 0o007) !== 0) notes.push(`home is ${mode}, readable by every user`);
      const chosen = ctx.saved.account;
      if (!chosen) return [{ title: "user", state: "fail", detail: `not chosen yet · ${ctx.user} · ${notes.join(" · ")}`, fix: "kururu child setup asks which" }];
      if (chosen !== ctx.user) {
        return [{ title: "user", state: "fail", detail: `the child was set up for ${chosen}, and this is ${ctx.user}`, fix: `run kururu as ${chosen}` }];
      }
      return [{ title: "user", state: "ok", detail: `${ctx.user} · ${notes.join(" · ")}` }];
    },
    async repair(ctx, io) {
      if (ctx.saved.account && ctx.saved.account !== ctx.user) {
        throw new Stop(`This child belongs to ${ctx.saved.account}. Switch to that user (\`sudo -iu ${ctx.saved.account}\`) and run the wizard there.`);
      }
      const answer = await io.ask(
        `Run the child as ${ctx.user}, this account, or as a dedicated user?`,
        ["this", "dedicated"],
        "account",
      );
      if (answer === "dedicated") {
        throw new Stop(
          [
            "A dedicated user is made by you, as root — the wizard never runs sudo. For example:",
            "  sudo useradd -m -s /bin/bash kururu",
            "  sudo loginctl enable-linger kururu",
            "  sudo -iu kururu",
            "Then, as that user: node and bun (`mise use -g node@26 bun@latest`), `claude` and `/login`,",
            "a clone of kururu and of the projects its agents will work in, and `node tools/kururu.mjs child setup` from the clone.",
          ].join("\n"),
        );
      }
      if (ctx.dryRun) io.say(`would remember: this child runs as ${ctx.user}`);
      else {
        remember(ctx, { account: ctx.user });
        ctx.changed.push(`chose ${ctx.user} to run the child`);
      }
    },
  },

  {
    id: "linger",
    title: "linger",
    why: "Linger keeps your user's systemd manager running with nobody logged in, which is what lets the child and its agents go on after you close the ssh session or reboot the box.",
    async check(ctx) {
      const said = run("loginctl", ["show-user", ctx.user, "-p", "Linger"]);
      if (said === null) return [{ title: "linger", state: "fail", detail: "loginctl did not answer", fix: `loginctl enable-linger ${ctx.user}` }];
      return lingerOn(said)
        ? [{ title: "linger", state: "ok", detail: "on: the child runs with nobody logged in" }]
        : [{ title: "linger", state: "fail", detail: "off: the child would stop when you log out", fix: `loginctl enable-linger ${ctx.user}` }];
    },
    async repair(ctx, io) {
      act(ctx, io, "turn linger on for this user", () => {
        const done = spawnSync("loginctl", ["enable-linger", ctx.user], { stdio: "inherit", timeout: 60_000 });
        if (done.status !== 0) {
          throw new Stop(`This system wants root for that. Run it yourself, then this again:\n  sudo loginctl enable-linger ${ctx.user}`);
        }
      });
    },
  },

  {
    id: "claude",
    title: "Claude Code",
    why: "Every agent and the child's Kuru are Claude Code, signed in on this machine with its own /login: the same subscription as the Mac, revocable on its own, and nothing copied from the Mac. Codex is optional.",
    async check(ctx) {
      const rows = [];
      const claude = which("claude", ctx.env);
      if (!claude) {
        rows.push({ title: "claude", state: "fail", detail: "not on this PATH", fix: "curl -fsSL https://claude.ai/install.sh | bash" });
      } else {
        const version = (run(claude, ["--version"], { env: ctx.env }) ?? "").trim().split(/\s+/)[0] || "unknown";
        const status = (() => {
          try {
            return JSON.parse(run(claude, ["auth", "status"], { env: ctx.env }) ?? "null");
          } catch {
            return null;
          }
        })();
        if (!status?.loggedIn) {
          rows.push({ title: "claude", state: "fail", detail: `${version}, not signed in`, fix: "claude auth login --claudeai" });
        } else if (status.authMethod !== "claude.ai") {
          rows.push({ title: "claude", state: "fail", detail: `${version}, signed in by ${status.authMethod}, which bills as API usage`, fix: "claude auth logout, then claude auth login --claudeai" });
        } else {
          rows.push({ title: "claude", state: "ok", detail: `${version}, signed in to ${status.subscriptionType ?? "a"} subscription` });
        }
      }
      if (ctx.saved.codex === true) {
        const codex = which("codex", ctx.env);
        // "Logged in using ChatGPT", or an API key, on stdout or stderr by version.
        const said = codex ? spawnSync(codex, ["login", "status"], { encoding: "utf8", env: ctx.env, timeout: 15_000 }) : null;
        const text = said ? `${said.stdout ?? ""}${said.stderr ?? ""}`.trim() : "";
        if (!codex) rows.push({ title: "codex", state: "fail", detail: "wanted, and not on this PATH", fix: "npm i -g @openai/codex" });
        else if (/logged in/i.test(text) && !/not logged in/i.test(text)) rows.push({ title: "codex", state: "ok", detail: text.split("\n")[0] });
        else rows.push({ title: "codex", state: "fail", detail: "wanted, and not signed in", fix: "codex login --device-auth" });
      } else {
        rows.push({ title: "codex", state: "skip", detail: ctx.saved.codex === false ? "not wanted" : "not asked yet" });
      }
      return rows;
    },
    /** Codex is a question even when Claude is fine: the step is not done until it is answered. */
    pending: (ctx) => ctx.saved.codex === undefined,
    async repair(ctx, io, rows) {
      if (ctx.saved.codex === undefined) {
        const has = Boolean(which("codex", ctx.env));
        const answer = await io.ask(`Will agents on this box run Codex too?${has ? " (codex is installed)" : ""}`, ["yes", "no"], "codex");
        if (ctx.dryRun) io.say(`would remember: Codex ${answer === "yes" ? "wanted" : "not wanted"}`);
        else {
          remember(ctx, { codex: answer === "yes" });
          ctx.changed.push(`Codex ${answer === "yes" ? "wanted" : "not wanted"}`);
        }
      }
      const claude = rows.find((row) => row.title === "claude");
      if (claude?.state === "fail") {
        if (!which("claude", ctx.env)) throw new Stop("Install Claude Code, then run this again:\n  curl -fsSL https://claude.ai/install.sh | bash");
        if (!io.interactive) {
          throw new Stop(
            "Sign Claude Code in on this box, in a terminal of your own:\n  claude auth login --claudeai\nIt prints a link; over ssh, open it on any device, sign in to the same Claude account as the Mac, and paste the code back. Then run this again.",
          );
        }
        io.say("Signing Claude Code in. It prints a link: open it on any device, sign in to the same Claude account as the Mac, and paste the code back here.");
        if (!ctx.dryRun) spawnSync("claude", ["auth", "login", "--claudeai"], { stdio: "inherit", env: ctx.env });
      }
      const codex = rows.find((row) => row.title === "codex");
      if (ctx.saved.codex === true && codex?.state !== "ok") {
        throw new Stop(
          which("codex", ctx.env)
            ? "Sign Codex in on this box, in a terminal of your own, then run this again:\n  codex login --device-auth"
            : "Install Codex, sign it in, and run this again:\n  npm i -g @openai/codex\n  codex login --device-auth",
        );
      }
    },
  },

  {
    id: "keys",
    title: "no API key",
    why: "An ANTHROPIC_API_KEY, an ANTHROPIC_AUTH_TOKEN or an apiKeyHelper outranks the login and bills every agent's turn as API usage instead of the subscription; the cloud switches send them to Bedrock or Vertex. A pty inherits them from the server's environment and from your shell's rc files, so the wizard looks everywhere one could come from. It only ever prints where, never the value.",
    async check(ctx) {
      const found = [];
      for (const name of keysInEnv(process.env)) found.push(`this shell: ${name}`);
      const manager = run("systemctl", ["--user", "show-environment"], { env: ctx.env });
      if (manager) for (const name of keysInEnv(parseShowEnvironment(manager))) found.push(`systemctl --user show-environment: ${name}`);
      const files = [
        ".profile", ".bashrc", ".bash_profile", ".bash_login", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".config/fish/config.fish",
      ].map((name) => join(home, name));
      const envd = join(ctx.env.XDG_CONFIG_HOME || join(home, ".config"), "environment.d");
      try {
        for (const name of readdirSync(envd)) if (name.endsWith(".conf")) files.push(join(envd, name));
      } catch {
        // None.
      }
      files.push("/etc/environment", ctx.unitFile);
      for (const file of files) {
        const text = readText(file);
        if (text) for (const hit of scanForKeys(text)) found.push(`${short(file)}:${hit.line}: ${hit.name}`);
      }
      const claudeDir = ctx.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
      for (const name of ["settings.json", "settings.local.json"]) {
        for (const what of settingsKeys(readJson(join(claudeDir, name)))) found.push(`${short(join(claudeDir, name))}: ${what}`);
      }
      // An approved key is kept in Claude's own state file. Its presence, never its value.
      const state = readJson(ctx.env.CLAUDE_CONFIG_DIR ? join(claudeDir, ".claude.json") : join(home, ".claude.json"));
      if (state && typeof state.primaryApiKey === "string" && state.primaryApiKey) found.push("~/.claude.json: an API key Claude Code was given (primaryApiKey)");
      return found.length
        ? [{ title: "no API key", state: "fail", detail: found.join("; "), fix: "remove each one: it outranks the login and bills as API usage" }]
        : [{ title: "no API key", state: "ok", detail: "none in this shell, the user manager, the rc files, the unit or Claude's settings" }];
    },
    async repair(_ctx, _io, rows) {
      throw new Stop(`Found where a pty could inherit an API key:\n  ${rows[0].detail.split("; ").join("\n  ")}\nRemove each (the wizard does not edit your files), open a new shell, and run this again.`);
    },
  },

  {
    id: "tailnet",
    title: "the tailnet",
    why: "A child answers on its tailnet address and nowhere else: the phone and, later, the Mac reach it over WireGuard, and nothing on the LAN can. The wizard reads the address off the interface; it never runs tailscale, which is yours to run.",
    async check(ctx) {
      const interfaces = networkInterfaces();
      const address = tailnetAddress(interfaces);
      const rows = [
        address
          ? { title: "tailnet", state: "ok", detail: address }
          : { title: "tailnet", state: "fail", detail: "no tailnet address on any interface", fix: "sudo tailscale up (yours to run, never the wizard's)" },
      ];
      const ours = await health(ctx);
      if (ours.status === 200 && ours.body?.ok) rows.push({ title: "port", state: "ok", detail: `${ctx.port}, kururu's (v${ours.body.version})` });
      else if (ours.status === 403) rows.push({ title: "port", state: "ok", detail: `${ctx.port}, a kururu that wants a token this config does not have` });
      else if (await portFree(ctx.port)) rows.push({ title: "port", state: "ok", detail: `${ctx.port}, free` });
      else rows.push({ title: "port", state: "fail", detail: `${ctx.port} is held by something that is not kururu`, fix: `kururu child setup --port=<another>` });
      return rows;
    },
    async repair(ctx, _io, rows) {
      if (rows[0].state === "fail") {
        throw new Stop("This machine is not on the tailnet. Bring Tailscale up yourself — the wizard never runs tailscale:\n  sudo tailscale up\nThen run this again.");
      }
      throw new Stop(`Port ${ctx.port} is taken by something else. Choose another and run this again:\n  kururu child setup --port=7718`, { code: 2 });
    },
  },

  {
    id: "service",
    title: "the service",
    why: "The server runs as a systemd user unit, with no window and no voice, bound to the tailnet address and asking for the token on loopback too. Restarting it costs a reconnect; the pty host is a unit of its own that the server starts, so no restart of the server's unit ends an agent.",
    async check(ctx) {
      const rows = [];
      const written = readText(ctx.unitFile);
      const wanted = wantedUnit(ctx);
      const enabled = (systemctl(["is-enabled", `${ctx.unit}.service`], ctx.env).stdout ?? "").trim();
      const active = unitActive(systemctl(["is-active", `${ctx.unit}.service`], ctx.env).stdout ?? "");
      if (written === null) rows.push({ title: "unit", state: "fail", detail: `no ${short(ctx.unitFile)}`, fix: "kururu child setup" });
      else if (written !== wanted) rows.push({ title: "unit", state: "fail", detail: `${short(ctx.unitFile)} differs from what this checkout would write`, fix: "kururu child setup" });
      else if (!/^enabled|^enabled-runtime/.test(enabled)) rows.push({ title: "unit", state: "fail", detail: `written, ${enabled || "not enabled"}`, fix: `systemctl --user enable ${ctx.unit}` });
      else if (!active) rows.push({ title: "unit", state: "fail", detail: "written and enabled, not running", fix: `systemctl --user start ${ctx.unit}; journalctl --user -u ${ctx.unit}` });
      else rows.push({ title: "unit", state: "ok", detail: `${ctx.unit}.service, ${enabled}, active` });

      const ts = tailnetAddress(networkInterfaces());
      const answer = await health(ctx);
      if (answer.status !== 200) {
        rows.push({ title: "health", state: "fail", detail: answer.status ? `loopback answered ${answer.status}` : `nothing answers on :${ctx.port}`, fix: `journalctl --user -u ${ctx.unit} -n 50` });
        return rows;
      }
      const remote = ts ? await get(`http://${ts}:${ctx.port}/api/health`, token(ctx)) : { status: 0 };
      rows.push(
        remote.status === 200
          ? { title: "health", state: "ok", detail: `answers on ${ts}:${ctx.port}, v${answer.body.version}` }
          : { title: "health", state: "fail", detail: `not on the tailnet address (${remote.status || remote.error || "no address"}) — bound to loopback?`, fix: `systemctl --user restart ${ctx.unit} once the tailnet is up` },
      );
      // The gate: a stranger on the LAN reaches nothing, and nobody gets in without the token, loopback included.
      const refused = [];
      const open = [];
      const bare = await get(`http://127.0.0.1:${ctx.port}/api/health`, null);
      (bare.status === 403 ? refused : open).push("loopback without the token");
      if (ts) {
        const stranger = await get(`http://${ts}:${ctx.port}/api/health`, null);
        (stranger.status === 403 ? refused : open).push("the tailnet without the token");
      }
      for (const lan of lanAddresses(networkInterfaces())) {
        const neighbour = await get(`http://${lan}:${ctx.port}/api/health`, null);
        (neighbour.status === 0 ? refused : open).push(`the LAN at ${lan}`);
      }
      rows.push(
        open.length
          ? { title: "gate", state: "fail", detail: `lets in ${open.join(", ")}`, fix: "the unit's KURURU_BIND=tailscale and KURURU_LOOPBACK_TOKEN=1: kururu child setup" }
          : { title: "gate", state: "ok", detail: `refuses ${refused.join(", ")}` },
      );

      const pid = existsSync(ctx.socket) ? socketHolders(ctx.socket)?.[0] : null;
      const unit = pid ? cgroupUnit(readText(`/proc/${pid}/cgroup`) ?? "") : null;
      if (!pid) rows.push({ title: "pty host", state: "fail", detail: `nothing holds ${short(ctx.socket)}`, fix: `journalctl --user -u ${ctx.unit} -n 50` });
      else if (!isHostUnit(unit)) {
        rows.push({
          title: "pty host",
          state: "fail",
          detail: `pid ${pid} is in ${unit ?? "no unit"}, so stopping that ends every agent`,
          fix: `restart the host into a unit of its own, which ends every agent it holds: kururu child restart-host`,
        });
      } else {
        const current = answer.body.host?.current !== false;
        rows.push(
          current
            ? { title: "pty host", state: "ok", detail: `${unit.replace(/\.service$/, "")}, ${answer.body.liveAgents ?? 0} agents, current` }
            : { title: "pty host", state: "fail", detail: `${unit.replace(/\.service$/, "")} speaks an older protocol than this server`, fix: "kururu child restart-host, which ends every agent it holds" },
        );
      }
      return rows;
    },
    async repair(ctx, io, rows) {
      const unitRow = rows.find((row) => row.title === "unit");
      const written = readText(ctx.unitFile);
      const wanted = wantedUnit(ctx);
      const active = unitActive(systemctl(["is-active", `${ctx.unit}.service`], ctx.env).stdout ?? "");
      if (written !== wanted) {
        if (written !== null) {
          io.say(`${short(ctx.unitFile)} differs from what this checkout would write:`);
          for (const line of unitDiff(written, wanted)) io.say(`  ${line}`);
          const answer = await io.ask(`Write over it${active ? `, and restart ${ctx.unit} (a reconnect for any phone; no agent ends)` : ""}?`, ["yes", "no"], "yes");
          if (answer !== "yes") throw new Stop("Left as it is.", { code: 1 });
        }
        act(ctx, io, `write ${short(ctx.unitFile)}`, () => {
          mkdirSync(dirname(ctx.unitFile), { recursive: true });
          writeFileSync(ctx.unitFile, wanted);
        });
        act(ctx, io, "reload the user manager", () => must(systemctl(["daemon-reload"], ctx.env)));
      }
      if (unitRow?.state === "fail" || written !== wanted) {
        const enabled = (systemctl(["is-enabled", `${ctx.unit}.service`], ctx.env).stdout ?? "").trim();
        if (!/^enabled/.test(enabled)) {
          act(ctx, io, `enable ${ctx.unit} so it starts at boot`, () => must(systemctl(["enable", ...(ctx.runtime ? ["--runtime"] : []), `${ctx.unit}.service`], ctx.env)));
        }
      }
      if (!active) {
        act(ctx, io, `start ${ctx.unit}`, () => must(systemctl(["start", `${ctx.unit}.service`], ctx.env)));
      } else if (written !== wanted || ctx.rebuilt) {
        act(ctx, io, `restart ${ctx.unit} onto the ${written !== wanted ? "new unit" : "new build"} (a reconnect; no agent ends)`, () =>
          must(systemctl(["restart", `${ctx.unit}.service`], ctx.env)),
        );
      }
      if (ctx.dryRun) return;
      io.say("Waiting for the server to answer…");
      const until = Date.now() + HEALTH_WAIT_MS;
      while (Date.now() < until) {
        if ((await health(ctx)).status === 200) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Stop(`The server did not answer within a minute. What it said:\n  journalctl --user -u ${ctx.unit} -n 50\n  tail ${short(join(ctx.stateDir, "lifecycle.log"))}`, { code: 1 });
    },
  },

  {
    id: "phone",
    title: "the phone",
    why: "The phone opens the child's tailnet address with the token in the link; the first visit trades it for a cookie. The link is a key to this box, so it is shown only in a terminal of yours, as a QR code: `kururu share`.",
    /** The phone's row is never a failure, so the wizard asks itself whether to show the code. */
    pending: (_ctx, rows) => rows[0]?.state !== "ok",
    async check(ctx) {
      const answer = await health(ctx);
      if (answer.status !== 200) return [{ title: "phone", state: "skip", detail: "no server to ask" }];
      const at = answer.body.clients?.remoteAt;
      return at
        ? [{ title: "phone", state: "ok", detail: `a device on the tailnet connected at ${new Date(at).toLocaleTimeString()}` }]
        : [{ title: "phone", state: "skip", detail: "no device from the tailnet since the server started — `kururu share` shows the code" }];
    },
    async repair(ctx, io) {
      if (ctx.dryRun) {
        io.say("would show the phone's link and its QR code, and wait for the phone");
        return;
      }
      if (!io.interactive) {
        // Not a stop: the child is up, and the rest is the person's, on a screen the link may be shown on.
        io.say("The child is up. Show the phone its link in a terminal of your own — not through an agent, since the link is a key to this box: `kururu share`. Scan it on the phone; `kururu child doctor` then says it connected.");
        return;
      }
      visibly(process.execPath, [join(ctx.root, "tools", "kururu.mjs"), "share"], { env: ctx.env });
      io.say("Waiting for the phone to open it (Enter to stop waiting)…");
      const seen = await io.waitFor(async () => Boolean((await health(ctx)).body?.clients?.remoteAt), 10 * 60_000);
      io.say(seen ? "The phone is in." : "No phone yet; `kururu share` shows the code again whenever you want it.");
    },
  },
];

function must(done) {
  if (done.status !== 0) throw new Stop(`systemctl said: ${(done.stderr || done.stdout || `exit ${done.status}`).trim()}`, { code: 1 });
}

/** The lines that differ between two unit texts, `-` and `+`, for the question before writing over one. */
function unitDiff(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  return [...a.filter((line) => line && !b.includes(line)).map((line) => `- ${line}`), ...b.filter((line) => line && !a.includes(line)).map((line) => `+ ${line}`)];
}

/** The tail of `lifecycle.log`, as the doctor prints it: one line each, oldest first. */
export function lifecycleTail(ctx, count = 6) {
  const lines = [];
  for (const path of [join(ctx.stateDir, "lifecycle.log.1"), join(ctx.stateDir, "lifecycle.log")]) {
    for (const line of (readText(path) ?? "").split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event && typeof event.at === "string" && typeof event.why === "string") lines.push(event);
      } catch {
        // Blank, or torn.
      }
    }
  }
  return lines.slice(-count);
}
