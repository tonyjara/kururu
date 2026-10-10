/**
 * The checkout's vite, run by the app so that a change under `web/` is on
 * screen when it is saved.
 *
 * The server serves `web/dist`, and nothing in a checkout keeps that current:
 * `run.mjs --watch` watches `server/src` and `shared`, and the build is a
 * minute of somebody's attention after every edit. In a terminal that was
 * never a problem, because `bun run dev:desktop` loads vite rather than the
 * server and vite is the thing that watches `web/`. The menu bar ran no vite,
 * so a checkout picked from the menu showed the web app as of its last build,
 * and the floating pill — which nothing reloads — showed it as of whenever the
 * app started. This is that vite, run wherever there is a checkout to run it
 * from, so the window and the pill load what `dev:desktop` loads.
 *
 * Vite proxies `/api` and `/ws` to one server, chosen when it starts (see
 * `web/vite.config.ts`), which keeps the websocket same-origin and the web app
 * ignorant of which of the two arrangements it is in. The cost is that a vite
 * serves one server's page, so a different server is a different vite — a
 * second or so, and only when somebody deliberately points the window
 * elsewhere. Teaching the page to talk cross-origin instead would need CORS on
 * a server with no authentication, which is not a trade worth a second.
 *
 * It binds loopback unless told otherwise. `dev:desktop`'s vite binds every
 * address so the phone can reach it too, and somebody who typed that command
 * chose to; an app that starts a vite by itself has not been asked to put a
 * port on the network, so the phone keeps the server's built page.
 *
 * And, like the server, one already on the port is adopted rather than
 * fought — but only when it is plainly the same thing: a vite, serving
 * kururu, whose proxy reaches the very server this one would have. That is a
 * `dev:desktop` beside the app, or an orphan of an app that was killed; it is
 * never another project's vite, which would otherwise be loaded into the
 * window and get its 200s mistaken for ours.
 */
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const { closeSync, existsSync } = require("node:fs");
const path = require("node:path");

/** How long a cold vite gets to answer: a hundred tries, each a short ask and a pause. */
const READY_TRIES = 100;
const READY_PAUSE_MS = 150;
/** How long a vite gets on SIGTERM before it is killed. It needs a fraction of this. */
const STOP_GRACE_MS = 3000;
/** What says a page is kururu's, in `web/index.html` and in what vite makes of it. */
const MARKER = "<title>kururu</title>";

async function ask(url, timeout = 600) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return { ok: response.ok, text: await response.text().catch(() => "") };
  } catch {
    return null;
  }
}

/** Which server answers at an address, as `/api/health` names it, or null. */
async function serverAt(base) {
  const answer = await ask(`${base}/api/health`, 1200);
  if (!answer?.ok) return null;
  try {
    const body = JSON.parse(answer.text);
    return Number.isFinite(body?.pid) ? `${body.pid}@${body.life?.startedAt ?? ""}` : null;
  } catch {
    return null;
  }
}

class Vite extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} options.port  `KURURU_VITE_PORT`, or vite's own 5173 — where `dev:desktop` looks
   * @param {string|null} options.host  the address to bind, or null for `web/vite.config.ts`'s
   * @param {() => object} options.env  the environment the runner gives its children
   * @param {() => number} options.openLog  a file descriptor to write vite's output into
   */
  constructor({ port, host, env, openLog }) {
    super();
    this.port = port;
    /**
     * An address and never `localhost`, because `localhost` is two addresses
     * and the port is only ours on one of them. Our vite binds IPv4, so
     * another project's vite on its default `localhost` binds `[::1]` on the
     * *same port* without either one seeing `EADDRINUSE` — and `localhost`
     * resolves to `::1` first. The readiness probe would get its 200 from the
     * other project and the window would load it. That is not hypothetical:
     * it is how a Platypost renderer turned up in this window.
     */
    this.url = `http://127.0.0.1:${port}`;
    this.host = host;
    this.env = env;
    this.openLog = openLog;

    this.child = null;
    this.checkout = null;
    this.target = null;
    /** `off`, `starting`, `up` (ours), `adopted` (somebody's), `failed`. */
    this.status = "off";
    this.error = null;
    this.pending = null;
    /** Bumped by every start and stop, so a start that was overtaken does not write its result over the next one's. */
    this.generation = 0;
  }

  set(status, error = null) {
    this.status = status;
    this.error = error;
    this.emit("change");
  }

  /** The address that serves this checkout's web app against this server, if vite is serving exactly that right now. */
  urlFor(checkout, target) {
    if (this.checkout !== checkout || this.target !== target) return null;
    return this.status === "up" || this.status === "adopted" ? this.url : null;
  }

  running() {
    return this.status === "starting" || this.status === "up" || this.status === "adopted";
  }

  /**
   * Make sure vite serves this checkout against this server, and resolve to
   * its address once it does, or to null. A vite that failed is not tried
   * again unless `retry` says somebody asked — otherwise every probe of the
   * port would be another launch into the same taken port.
   */
  async ensure(checkout, target, { retry = false } = {}) {
    const same = this.checkout === checkout && this.target === target;
    if (same && (this.status === "up" || this.status === "adopted")) return this.url;
    if (same && this.status === "starting") return this.pending;
    if (same && this.status === "failed" && !retry) return null;
    await this.stop();
    const generation = ++this.generation;
    this.checkout = checkout;
    this.target = target;
    this.status = "starting";
    this.error = null;
    // Kept before anybody is told, because the telling is what calls back in
    // here, and a second caller must get this promise rather than a null.
    this.pending = this.launch(checkout, target, generation);
    this.emit("change");
    return this.pending;
  }

  /** A failure is forgotten, so the next `ensure` tries again. For a Start or a Restart somebody clicked. */
  forgive() {
    if (this.status !== "failed") return;
    this.set("off");
  }

  async launch(checkout, target, generation) {
    const fail = (why) => {
      if (generation === this.generation) this.set("failed", why);
      return null;
    };

    const there = await ask(`${this.url}/`);
    if (generation !== this.generation) return null;
    if (there) {
      const client = await ask(`${this.url}/@vite/client`);
      const kururu = there.text.includes(MARKER) && Boolean(client?.ok);
      if (!kururu) return fail(`something else answers on :${this.port}`);
      const [through, direct] = await Promise.all([serverAt(this.url), serverAt(target)]);
      if (generation !== this.generation) return null;
      if (!through || through !== direct) return fail(`a kururu vite on :${this.port} is pointed at another server`);
      this.set("adopted");
      return this.url;
    }

    const bin = path.join(checkout, "node_modules/vite/bin/vite.js");
    if (!existsSync(bin)) return fail("vite is not installed in the checkout — run `bun install`");
    const args = [bin];
    if (this.host) args.push("--host", this.host);
    const log = this.openLog();
    const child = spawn(process.execPath, args, {
      cwd: path.join(checkout, "web"),
      stdio: ["ignore", log, log],
      env: { ...this.env(), KURURU_SERVER: target, KURURU_VITE_PORT: String(this.port) },
    });
    closeSync(log);
    this.child = child;

    let gone = null;
    // Gone by itself, while starting or after: a crash, or a port somebody
    // took between the look above and the bind. Not started again by itself,
    // for the reason `ensure` gives. A spawn that failed outright says so on
    // `error` and may never say `exit`, so either is the end.
    const ended = (why) => {
      if (gone) return;
      gone = why;
      if (this.child !== child) return;
      this.child = null;
      if (generation === this.generation) this.set("failed", `vite ${why} — see vite.log`);
    };
    child.on("error", (err) => ended(`could not start (${err.message})`));
    child.on("exit", (code, signal) => ended(signal ? `was killed by ${signal}` : `exited with ${code}`));

    for (let attempt = 0; attempt < READY_TRIES; attempt++) {
      if (gone || generation !== this.generation) return null;
      if ((await ask(`${this.url}/@vite/client`))?.ok && !gone && this.child === child) {
        if (generation !== this.generation) return null;
        this.set("up");
        return this.url;
      }
      await new Promise((resolve) => setTimeout(resolve, READY_PAUSE_MS));
    }
    void this.stop();
    return fail(`vite did not answer on :${this.port} — see vite.log`);
  }

  /** Stop the vite this app started and wait until it has. An adopted one is let go of, not stopped: it is somebody's. */
  stop() {
    this.generation++;
    const child = this.child;
    this.child = null;
    this.pending = null;
    if (this.status !== "off") this.set("off");
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, STOP_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  /** What the menu draws, as plain data. */
  view() {
    return { status: this.status, port: this.port, error: this.error };
  }
}

module.exports = { Vite };
