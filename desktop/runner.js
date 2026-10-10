/**
 * The server, as something the menu bar starts, watches and stops.
 *
 * `server/run.mjs` is the supervisor: it spawns the server, restarts it on
 * exit 75, and in a checkout rebuilds and restarts it on every save. This
 * file is what stands behind *that* — it starts the runner, points it at the
 * right kururu, keeps a health probe on the port, and reads the record the
 * runner and the server write. It used to be a second supervisor of its own,
 * forking `server.mjs` directly and reimplementing the restart-on-75 half of
 * `run.mjs` with none of the rest, and two supervisors written separately
 * drift separately. Now there is one, and the app ships it.
 *
 * Two sources, one shape. From the app the runner is told where the bundled
 * server is and not to build anything, because there is nothing to build
 * from. From a checkout it is `run.mjs --watch`, exactly as `bun run dev`
 * would run it, with the checkout's own esbuild and the checkout's own
 * `web/dist` — which this file builds first when it is missing or older
 * than `web/src`, since nothing else in a checkout does. Both run on this
 * app's own binary as node, so neither needs node, bun or a terminal.
 *
 * What it will not do is start beside a server that is already there. A
 * server answering on the port is adopted — shown, opened, restarted through
 * its own verb — and never stopped, because it is somebody else's, and that
 * somebody is usually a `bun run dev` in a terminal. An adopted server that
 * goes away is left down until somebody asks for a start, on purpose: a
 * `bun run dev` being restarted is the exact race the port rule exists to
 * lose gracefully.
 *
 * And it never reaches for the pty host. A host restart is asked of the
 * server (`POST /api/host/restart`), which is the process that knows how to
 * let the host go and come back to a fresh one; the only thing this file
 * knows about the host is who is holding its socket, for the status line.
 */
const { EventEmitter } = require("node:events");
const { execFile, execFileSync, spawn } = require("node:child_process");
const { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync } = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");

/** How often the port is asked, and how long an answer gets. The window's own probe uses the same numbers. */
const PROBE_EVERY_MS = 3000;
const PROBE_TIMEOUT_MS = 1200;
/** How long a runner gets on SIGTERM. It forwards the signal and leaves; past this it is killed. */
const STOP_GRACE_MS = 6000;
/** The runner's and the server's stdout, moved aside at this size. The lifecycle record is the one worth keeping. */
const LOG_MAX_BYTES = 1024 * 1024;

function stateDir() {
  return (
    process.env.KURURU_STATE_DIR ||
    path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "kururu")
  );
}

/** The pty host's socket, spelled as `server/src/hostsock.ts` spells it. */
function hostSocket() {
  if (process.env.KURURU_HOST_SOCK) return process.env.KURURU_HOST_SOCK;
  const state = process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
  return path.join(state, "kururu", "ptyhost.sock");
}

/** A command that is allowed to fail, since most of these answer by exit code. */
function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

async function fetchJson(url, options = {}, timeout = PROBE_TIMEOUT_MS) {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  } catch {
    return null;
  }
}

/**
 * One line of `lifecycle.log`, as `server/run.mjs` writes it and for the same
 * reason. `shared/lifecycle.ts` says what the fields are; this file is plain
 * JavaScript and keeps in step by hand.
 */
function record(what, why, extra = {}) {
  try {
    const dir = stateDir();
    const file = path.join(dir, "lifecycle.log");
    mkdirSync(dir, { recursive: true });
    if (existsSync(file) && statSync(file).size > 256 * 1024) renameSync(file, `${file}.1`);
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), by: "app", pid: process.pid, what, why, ...extra })}\n`);
  } catch {
    // The record is for afterwards; it is not a reason to fail now.
  }
}

/** The newest change under a directory, for telling a built `web/dist` from a stale one. */
function newestMtime(dir) {
  let newest = 0;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        // Gone between the listing and the stat.
      }
    }
  }
  return newest;
}

class Runner extends EventEmitter {
  /**
   * @param {object} options
   * @param {boolean} options.packaged  whether this is a downloaded kururu, with a server in its Resources
   * @param {string} options.resourcesPath
   * @param {string|null} options.shellCheckout  the checkout a dev shell (`electron .`) is running out of
   * @param {number} options.port
   * @param {() => string} options.loginPath  the PATH a login shell would have
   */
  constructor({ packaged, resourcesPath, shellCheckout, port, loginPath }) {
    super();
    this.packaged = packaged;
    this.resourcesPath = resourcesPath;
    this.shellCheckout = shellCheckout;
    this.port = port;
    this.local = `http://127.0.0.1:${port}`;
    this.loginPath = loginPath;

    this.source = "app";
    this.checkout = null;

    /** The runner this app started, while it is alive. */
    this.child = null;
    this.stopping = null;
    /** Why the last runner this app started went away, for the menu. */
    this.lastExit = null;
    /** `web` while a checkout's web app is being built. */
    this.building = null;
    this.buildError = null;

    this.health = null;
    this.healthAt = 0;
    this.downSince = null;
    this.probeTimer = null;
    this.probing = false;
    this.lastSummary = "";
  }

  configure({ source, checkout }) {
    this.source = source;
    this.checkout = checkout;
  }

  // --- where the server comes from -------------------------------------------

  /**
   * The checkout the runner would run from, or null for the bundled server.
   * A dev shell has no bundled server, so "this app" means the checkout it
   * is running out of — which is also what keeps `bun run dev:desktop`
   * honest about what it is a window onto.
   */
  effectiveCheckout() {
    if (this.source === "checkout" && this.checkout) return this.checkout;
    return this.packaged ? null : this.shellCheckout;
  }

  /** A sentence for the menu's first line. */
  sourceLabel() {
    const checkout = this.effectiveCheckout();
    if (!checkout) return "running from this app";
    const home = homedir();
    const shown = checkout.startsWith(home) ? `~${checkout.slice(home.length)}` : checkout;
    return `running from ${shown}, watching`;
  }

  /**
   * Whether a directory is a kururu that has been installed, and whether its
   * web app needs building. Each problem is a sentence somebody can act on,
   * because the alternative is a Start item that does nothing.
   */
  checkoutReport(dir) {
    const problems = [];
    if (!dir || !existsSync(dir)) return { ok: false, problems: ["that folder does not exist"], webStale: false };
    if (!existsSync(path.join(dir, "server/run.mjs")) || !existsSync(path.join(dir, "desktop/build.mjs"))) {
      problems.push("that folder is not a kururu checkout (no server/run.mjs)");
    }
    if (!existsSync(path.join(dir, "node_modules/esbuild"))) problems.push("run `bun install` in it first");
    else if (!existsSync(path.join(dir, "node_modules/vite/bin/vite.js"))) problems.push("run `bun install` in it first (vite is missing)");
    return { ok: problems.length === 0, problems, webStale: problems.length === 0 && this.webStale(dir) };
  }

  /** The checkout's `web/dist` is missing, or older than anything that goes into it. */
  webStale(dir) {
    const built = path.join(dir, "web/dist/index.html");
    if (!existsSync(built)) return true;
    const since = statSync(built).mtimeMs;
    return (
      newestMtime(path.join(dir, "web/src")) > since ||
      newestMtime(path.join(dir, "web/public")) > since ||
      newestMtime(path.join(dir, "shared")) > since ||
      (existsSync(path.join(dir, "web/index.html")) && statSync(path.join(dir, "web/index.html")).mtimeMs > since)
    );
  }

  // --- the log the runner writes to ---------------------------------------------

  serverLog() {
    return path.join(stateDir(), "server.log");
  }

  openLog() {
    const file = this.serverLog();
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`);
    } catch {
      // A log that cannot be moved aside is appended to.
    }
    return openSync(file, "a");
  }

  childEnv(extra = {}) {
    const env = { ...process.env, ...extra };
    // The app's own resource paths must not leak into a checkout's server,
    // which finds its web app and its host beside itself.
    for (const key of ["KURURU_WEB_DIST", "KURURU_ASSETS", "KURURU_SOUNDS", "KURURU_PTYHOSTD"]) {
      if (!(key in extra)) delete env[key];
    }
    return {
      ...env,
      // This binary is Electron; this is what makes it node instead, for the
      // runner and for everything the runner starts.
      ELECTRON_RUN_AS_NODE: "1",
      PATH: this.loginPath(),
      KURURU_RUNNER_LABEL: "the menu bar",
    };
  }

  // --- building a checkout's web app ------------------------------------------

  /**
   * `vite build`, with the checkout's own vite on this app's binary as node.
   * The server serves `web/dist` to every client that is not a vite window,
   * and `bun run dev` never builds it — in a checkout that job is vite's, in
   * the window `bun run dev:desktop` starts. The menu bar runs no vite, so
   * the build is its job.
   */
  buildWeb(checkout) {
    if (this.building) return Promise.resolve(false);
    this.building = "web";
    this.buildError = null;
    this.emit("change");
    record("start", `the menu bar is building the web app in ${checkout}`);
    return new Promise((resolve) => {
      const log = this.openLog();
      const child = spawn(process.execPath, [path.join(checkout, "node_modules/vite/bin/vite.js"), "build"], {
        cwd: path.join(checkout, "web"),
        stdio: ["ignore", log, log],
        env: this.childEnv(),
      });
      closeSync(log);
      child.on("error", (err) => {
        this.building = null;
        this.buildError = err.message;
        this.emit("change");
        resolve(false);
      });
      child.on("exit", (code) => {
        this.building = null;
        this.buildError = code === 0 ? null : `vite build exited with ${code} — see server.log`;
        if (code !== 0) record("down", `the web app build failed (${code}); the checkout's web/dist is what it was`);
        this.emit("change");
        resolve(code === 0);
      });
    });
  }

  // --- starting and stopping -----------------------------------------------------

  /** Whether a start is something this app can do right now, and if not, why. */
  canStart() {
    if (this.child) return { ok: false, why: "it is already running" };
    if (this.health) return { ok: false, why: `a server already answers on :${this.port}` };
    if (this.building) return { ok: false, why: "the web app is still building" };
    const checkout = this.effectiveCheckout();
    if (checkout) {
      const report = this.checkoutReport(checkout);
      if (!report.ok) return { ok: false, why: report.problems[0] };
      return { ok: true };
    }
    if (!existsSync(path.join(this.resourcesPath, "server", "run.mjs"))) return { ok: false, why: "no server is bundled in this app" };
    return { ok: true };
  }

  /**
   * Start the runner, and through it a server. `because` finishes the
   * runner's own first record line.
   */
  async start(because = "the menu bar started it") {
    const can = this.canStart();
    if (!can.ok) return can;
    this.lastExit = null;

    const checkout = this.effectiveCheckout();
    let args;
    let cwd;
    let env;
    if (checkout) {
      if (this.webStale(checkout) && !(await this.buildWeb(checkout))) {
        return { ok: false, why: this.buildError ?? "the web app could not be built" };
      }
      cwd = checkout;
      args = [path.join(checkout, "server/run.mjs"), "--watch"];
      env = this.childEnv();
    } else {
      const server = path.join(this.resourcesPath, "server");
      cwd = server;
      args = [path.join(server, "run.mjs"), "--entry", path.join(server, "server.mjs"), "--no-build"];
      env = this.childEnv({
        KURURU_WEB_DIST: path.join(this.resourcesPath, "web"),
        KURURU_ASSETS: path.join(this.resourcesPath, "assets", "spritesheets"),
        KURURU_SOUNDS: path.join(this.resourcesPath, "assets", "sounds"),
        KURURU_PTYHOSTD: path.join(server, "ptyhostd.mjs"),
      });
    }

    const log = this.openLog();
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", log, log], env });
    closeSync(log);
    this.child = child;
    record("start", `${because}: the runner (pid ${child.pid}) from ${checkout ?? "the app"}`);
    this.emit("change");

    child.on("error", (err) => {
      if (this.child === child) this.child = null;
      this.lastExit = `could not start the runner: ${err.message}`;
      record("crash", this.lastExit);
      this.emit("change");
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) {
        this.emit("change");
        return;
      }
      /**
       * The runner leaving on its own is the server having stopped for good:
       * a crash with no watcher to mend it, a build that could not be made,
       * or a port already taken. Its reason is in the record it wrote on the
       * way out; this line is only that the menu bar's child is gone.
       */
      this.lastExit = signal ? `the runner was killed by ${signal}` : `the runner exited with ${code}`;
      record(code === 0 ? "stop" : "crash", `${this.lastExit}; the menu bar is not starting it again by itself`, { code, signal });
      this.emit("change");
      void this.probe();
    });
    return { ok: true };
  }

  /** Stop the runner this app started, and wait until it has. An adopted server is not ours to stop. */
  stop(why = "the menu bar stopped it") {
    const child = this.child;
    if (!child) return Promise.resolve();
    if (this.stopping) return this.stopping;
    record("stop", `${why}: SIGTERM to the runner (pid ${child.pid})`);
    this.stopping = new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, STOP_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        this.child = null;
        this.stopping = null;
        this.health = null;
        this.emit("change");
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timer);
        this.child = null;
        this.stopping = null;
        resolve();
      }
    });
    return this.stopping;
  }

  /**
   * Restart the server, whoever is supervising it.
   *
   * A server that answers is asked over HTTP and its own runner brings it
   * back — ours or `bun run dev`'s, it makes no difference, which is why it
   * is asked rather than signalled. One that does not answer but whose runner
   * is ours is told to cycle now, which is the one case a save would have
   * covered in a terminal. Nothing running at all is a start.
   */
  async restart() {
    if (this.health) {
      const answer = await fetchJson(`${this.local}/api/restart`, { method: "POST" }, 3000);
      if (!answer) return { ok: false, why: "the server did not answer" };
      if (!answer.ok) return { ok: false, why: answer.body?.error ?? `the server refused (${answer.status})` };
      return { ok: true };
    }
    if (this.child) {
      try {
        this.child.kill("SIGUSR2");
        return { ok: true };
      } catch (err) {
        return { ok: false, why: err.message };
      }
    }
    return this.start("the menu bar asked for a restart");
  }

  /** Ask the server to let the pty host go and come back to a fresh one. The asking is the caller's, after its dialog. */
  async restartHost() {
    const answer = await fetchJson(`${this.local}/api/host/restart`, { method: "POST" }, 5000);
    if (!answer) return { ok: false, why: "the server did not answer" };
    if (!answer.ok) return { ok: false, why: answer.body?.error ?? `the server refused (${answer.status})` };
    return { ok: true };
  }

  // --- what is running -------------------------------------------------------------

  /** The server on the port is the one our runner is holding. */
  ours() {
    return Boolean(this.child && this.health && this.health.life?.supervisor === this.child.pid);
  }

  /** The server on the port is somebody else's. */
  adopted() {
    return Boolean(this.health && !this.ours());
  }

  /** What the adopted server's supervisor is, as a person would name it. */
  adoptedBy() {
    const pid = this.health?.life?.supervisor;
    if (!Number.isFinite(pid)) return this.health?.life?.orphaned ? "nothing (its supervisor has gone)" : "nothing";
    const command = run("ps", ["-o", "command=", "-p", String(pid)]).trim();
    if (!command) return `pid ${pid}`;
    if (command.includes("run.mjs")) return `bun run dev (pid ${pid})`;
    return `${path.basename(command.split(" ")[0] ?? command)} (pid ${pid})`;
  }

  /** Who is holding the host's socket, or null. A file with nobody behind it is a corpse. */
  hostHolder() {
    const socket = hostSocket();
    if (!existsSync(socket)) return null;
    const first = run("lsof", ["-t", socket]).trim().split("\n")[0];
    const pid = Number(first);
    if (!pid) return null;
    // The guard, not the search: something else holding a file of that name
    // is not a pty host.
    if (!run("ps", ["-ww", "-o", "command=", "-p", String(pid)]).includes("ptyhost")) return null;
    const uptime = run("ps", ["-o", "etime=", "-p", String(pid)]).trim();
    return { pid, uptime };
  }

  /**
   * The last lines of the record, tolerant of a torn one, as `status.mjs`
   * reads them. Off the disk and not from the server, because the time this
   * is most wanted is while the server is away.
   */
  recentLife(count = 8) {
    const file = path.join(stateDir(), "lifecycle.log");
    let text = "";
    for (const candidate of [`${file}.1`, file]) {
      try {
        text += `${readFileSync(candidate, "utf8")}\n`;
      } catch {
        // Not written yet, or never moved aside.
      }
    }
    const events = [];
    for (const line of text.split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event && typeof event.at === "string" && typeof event.why === "string") events.push(event);
      } catch {
        // Blank, or torn.
      }
    }
    return events.slice(-count);
  }

  /** The last thing that happened to the server, for the second line of the menu. */
  lastEvent() {
    const events = this.recentLife(24).filter((event) => event.what !== "host");
    return events.at(-1) ?? null;
  }

  // --- the probe -------------------------------------------------------------------

  summary() {
    const h = this.health;
    return [
      h ? "up" : "down",
      h?.liveAgents ?? "",
      h?.host?.current ?? "",
      this.ours() ? "ours" : "",
      this.child ? "child" : "",
      this.building ?? "",
    ].join(":");
  }

  async probe() {
    if (this.probing) return;
    this.probing = true;
    try {
      const answer = await fetchJson(`${this.local}/api/health`);
      this.health = answer?.ok && answer.body?.ok ? answer.body : null;
      this.healthAt = Date.now();
      if (this.health) this.downSince = null;
      else if (!this.downSince) this.downSince = Date.now();
    } finally {
      this.probing = false;
    }
    const now = this.summary();
    if (now !== this.lastSummary) {
      this.lastSummary = now;
      this.emit("change");
    }
  }

  startProbing() {
    if (this.probeTimer) return;
    void this.probe();
    this.probeTimer = setInterval(() => void this.probe(), PROBE_EVERY_MS);
  }

  stopProbing() {
    clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  /**
   * Make sure there is a server, the way the app always has at launch: adopt
   * one that answers, start one otherwise. Resolves to the address once one
   * answers, or null — which is the picker's cue, and the picker's sweep
   * will still find a late one.
   */
  async ensure(autostart) {
    await this.probe();
    if (this.health) return this.local;
    if (!autostart) return null;
    const started = await this.start("the app started it");
    if (!started.ok) return null;
    for (let attempt = 0; attempt < 80; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await this.probe();
      if (this.health) return this.local;
      if (!this.child) break;
    }
    return null;
  }

  /** Everything the menu draws, as plain data. `menu.js` turns it into items. */
  view() {
    const h = this.health;
    const holder = this.hostHolder();
    const checkout = this.effectiveCheckout();
    const report = checkout ? this.checkoutReport(checkout) : { ok: true, problems: [], webStale: false };
    return {
      sourceLabel: this.sourceLabel(),
      checkout,
      checkoutOk: report.ok,
      checkoutProblem: report.problems[0] ?? null,
      building: this.building,
      buildError: this.buildError,
      server: h
        ? {
            up: true,
            ours: this.ours(),
            adoptedBy: this.ours() ? null : this.adoptedBy(),
            since: h.life?.startedAt ?? null,
            because: h.life?.because ?? null,
            version: h.version ?? null,
            liveAgents: Number(h.liveAgents) || 0,
            devServers: Number(h.devServers) || 0,
            supervised: h.life?.supervised === true,
            orphaned: h.life?.orphaned === true,
          }
        : { up: false, starting: Boolean(this.child), downSince: this.downSince, lastExit: this.lastExit },
      host: {
        up: Boolean(holder),
        pid: holder?.pid ?? null,
        uptime: holder?.uptime ?? null,
        version: h?.host?.version ?? null,
        protocol: h?.host?.protocol ?? null,
        behind: Boolean(h && h.host && h.host.current === false),
      },
      lastEvent: this.lastEvent(),
      canStart: this.canStart(),
    };
  }
}

module.exports = { Runner, hostSocket, record, stateDir };
