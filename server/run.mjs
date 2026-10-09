/**
 * Run the kururu server, and be the thing that can start it again.
 *
 * This job used to be Electron's. The main process forked the server, watched
 * `server/src` and re-forked it on save, and answered `prefix+B` by doing the
 * same on request — all of which was fine while the desktop was the only way to
 * run kururu, and all of which went away when the desktop became one client
 * among several. A server whose restart button only worked when a particular
 * window happened to be open is a server with a restart button that lies.
 *
 * So the supervisor is here, next to the thing it supervises, and it is
 * deliberately the smallest one that works: spawn, wait, start again if the exit
 * code asked for it. What it must never do is reach for the pty host. That
 * process is not this one's child and not this one's business — it holds the
 * ptys, it outlives every server, and the entire reason a restart is cheap is
 * that nothing in this file can touch it.
 *
 * It also writes down what it does. Every start, restart and stop it causes or
 * sees goes into `lifecycle.log` in the state directory, beside the server's own
 * lines, because the terminal this prints to is the only other place any of it
 * is said — and that terminal is the one somebody has just typed `bun run dev`
 * into again, which is the moment the old answer scrolls away.
 *
 *   node server/run.mjs            build, serve, restart on request
 *   node server/run.mjs --watch    ...and on every save, which is `bun run dev`
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ENTRY = join(root, "desktop/dist/server.mjs");
const BUILD = join(root, "desktop/build.mjs");

const watching = process.argv.includes("--watch");

/** Kept in step with `RESTART_EXIT_CODE` in `server/src/index.ts`, which is what sends it. */
const RESTART_EXIT_CODE = 75;

/**
 * How long a server gets to stop on SIGTERM before it is killed outright.
 *
 * A server slow to stop is one whose event loop is busy — the voice making a
 * sentence is the usual one — and it will get to the signal eventually. What
 * it must not do is still be holding the port and the pty host when its
 * replacement arrives, so past this it is SIGKILLed. That is safe here in a
 * way it is nowhere near the host: the agents are a process over. What it
 * costs is a layout change made in the last second, not yet saved.
 */
const STOP_GRACE_MS = 5000;

// --- the record ---------------------------------------------------------------

/**
 * One line of `lifecycle.log`, written the way `server/src/lifecycle.ts` writes
 * it: the same directory, the same size cap, one JSON object per line.
 * `shared/lifecycle.ts` says what the fields are. This file is plain JavaScript
 * that node runs as it is, so it cannot import that, and keeps in step by hand.
 */
const STATE_DIR =
  process.env.KURURU_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kururu");
const LOG = join(STATE_DIR, "lifecycle.log");
const LOG_MAX_BYTES = 256 * 1024;

function record(what, why, extra = {}) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    if (existsSync(LOG) && statSync(LOG).size > LOG_MAX_BYTES) renameSync(LOG, `${LOG}.1`);
    const line = { at: new Date().toISOString(), by: "runner", pid: process.pid, what, why, ...extra };
    appendFileSync(LOG, `${JSON.stringify(line)}\n`);
  } catch {
    // The record is for afterwards. Failing to keep it is no reason to stop serving now.
  }
}

/** How a child ended, as the rest of a sentence about it. */
function ended(code, signal) {
  if (signal === "SIGABRT") return "was killed by SIGABRT — native code aborted, usually a library failing as the process exits";
  if (signal === "SIGKILL") return "was killed by SIGKILL, which nothing can catch: a kill -9, or the system out of memory";
  if (signal) return `was killed by ${signal}`;
  return `exited with code ${code}`;
}

function saved(files) {
  const [first, ...rest] = files;
  return rest.length ? `${first} and ${rest.length} other file${rest.length === 1 ? "" : "s"} were saved` : `${first} was saved`;
}

// --- building -----------------------------------------------------------------

/**
 * Bundle the server. Its stderr is passed through and also kept, because that is
 * where esbuild says what is wrong with the file somebody just saved, and that
 * sentence is the one the record wants.
 */
function build() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUILD], { stdio: ["ignore", "inherit", "pipe"] });
    let said = "";
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      said = (said + chunk).slice(-4000);
    });
    // `close` rather than `exit`: the last of stderr can arrive after the exit.
    child.on("close", (code) => (code === 0 ? resolve() : reject(Object.assign(new Error(`build failed (${code})`), { said }))));
    child.on("error", reject);
  });
}

/** esbuild's own line for the first error and where it is, or the last thing it said. */
function buildError(said) {
  const lines = said.split("\n").map((line) => line.trim()).filter(Boolean);
  const at = lines.findIndex((line) => line.includes("[ERROR]"));
  if (at === -1) return lines.at(-1) ?? "";
  // The location is the next line that is only one: `server/src/x.ts:12:6:`.
  const where = lines.slice(at + 1).find((line) => /^\S+:\d+:\d+:$/.test(line));
  return `${lines[at].replace(/^✘\s*/, "")}${where ? ` at ${where.slice(0, -1)}` : ""}`;
}

// --- the server ---------------------------------------------------------------

/** The server this runner currently stands behind. Any other is on its way out. */
let server = null;
let stopping = false;

/** `because` finishes the sentence "listening on :7717, because …" in the server's own record. */
function start(because) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: "inherit",
    env: {
      ...process.env,
      // How the server knows that asking to be restarted will actually get it
      // restarted, rather than just ending it.
      KURURU_SUPERVISED: "1",
      KURURU_STARTED_BECAUSE: because,
    },
  });
  server = child;

  child.on("exit", (code, signal) => {
    /**
     * Only the current server's exit means anything. One that is being
     * replaced has already been let go of, and its exit arriving late used to
     * be read as the *new* one dying: the runner gave up and left, and the new
     * server ran on with nothing watching it, so the next save did nothing at
     * all and `prefix+B` ended it for good.
     */
    if (child !== server) return;
    server = null;
    if (stopping) return;
    if (code === RESTART_EXIT_CODE) {
      console.log("kururu: restarting the server — the agents are next door and will not notice");
      void cycle({ why: "it asked to be restarted", server: child.pid });
      return;
    }
    /**
     * Anything else is the server deciding to stop, and it is left stopped. A
     * supervisor that resurrects a process which cannot start — a port already
     * taken, a bad build — is a loop that fills a terminal with the same error
     * forever, and the error is the useful part.
     *
     * Left stopped is not the same as left alone, though. Under `--watch` the
     * crash is nearly always an edit still in progress: an agent renames a
     * field in one place and saves, and the server dies on the first request
     * that reaches the other place. The save that finishes the edit is seconds
     * away, and a runner that had already left never sees it. That happened
     * at 15:37 on 2026-10-08: the fix landed at 15:39, and the server stayed
     * down until somebody typed `bun run dev` again. So a crash is treated
     * like a failed build: nothing restarts the server by itself, and the next
     * save does. Zero is not a crash. It is a server that chose to stop, such
     * as one stepping aside for a newer server, and a runner that stayed for
     * that would take the host back on its next save, every save.
     */
    if (watching && code !== 0) {
      record("crash", `the server ${ended(code, signal)}; it stays down until the next save restarts it`, {
        server: child.pid,
        code,
        signal,
      });
      console.error(`kururu: the server ${ended(code, signal)} — down until the next save restarts it`);
      return;
    }
    record(code === 0 ? "stop" : "crash", `the server ${ended(code, signal)}; not restarting it, and the runner is stopping too`, {
      server: child.pid,
      code,
      signal,
    });
    console.error(`kururu: the server ${ended(code, signal)}; not restarting it`);
    process.exit(typeof code === "number" ? code : 1);
  });
}

/**
 * Stop a server and wait until it really has.
 *
 * It used to be SIGTERM and two seconds of patience, after which the
 * replacement was started whether the old one had gone or not. An old server
 * still holding the port and the host is exactly what a new one cannot start
 * beside, so this waits for the exit and makes sure there is one.
 */
function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      record("stop", `the old server had not stopped ${STOP_GRACE_MS / 1000}s after SIGTERM, so it was killed`, {
        server: child.pid,
        signal: "SIGKILL",
      });
      child.kill("SIGKILL");
    }, STOP_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/** Stop the current server, rebuild, start a new one. */
async function replace(reason) {
  const why = reason.files?.length ? saved(reason.files) : reason.why;
  const old = server;
  record("restart", why, {
    ...(reason.files?.length ? { file: reason.files[0] } : {}),
    ...(old || reason.server ? { server: old?.pid ?? reason.server } : {}),
  });
  if (old) {
    server = null;
    await stop(old);
  }
  try {
    await build();
  } catch (err) {
    const said = err.said ?? "";
    record("down", `the build failed, so the server stays down until ${watching ? "the next save mends it" : "the runner is started again"}`, {
      ...(reason.files?.length ? { file: reason.files[0] } : {}),
      error: buildError(said) || err.message,
      ...(said.trim() ? { stack: said.trim() } : {}),
    });
    console.error(`kururu: ${err.message} — leaving the server down`);
    return;
  }
  start(why);
}

/** A replacement in progress, and what has asked for another since it began. */
let cycling = null;
let pending = null;

/**
 * Replace the server, one replacement at a time.
 *
 * Saves do not wait for each other — an agent can write three files in the
 * time a build takes — and two replacements running at once each built and each
 * started a server. Two servers both connect to the pty host, which keeps the
 * newer and drops the older, and the older one's exit took the runner with it.
 * So a request that arrives mid-replacement becomes one more replacement after
 * it, which is all it ever needed: the next build sees every save at once.
 */
function cycle(reason) {
  if (cycling) {
    pending = pending ? { ...reason, files: [...new Set([...(pending.files ?? []), ...(reason.files ?? [])])] } : reason;
    return cycling;
  }
  cycling = (async () => {
    let next = reason;
    while (next) {
      pending = null;
      await replace(next);
      next = pending;
    }
    cycling = null;
  })();
  return cycling;
}

/**
 * Editing the server restarts it; editing the pty host does not, and says so.
 *
 * The distinction is the sharpest edge in the project and it is worth one line
 * of output rather than a silent half-measure: `agents/`, `ptyhost*` and
 * `hostsock.ts` are the host's, the host holds every pty, and picking up a
 * change in there means ending every agent. That is a thing to do on purpose,
 * by restarting the host, rather than a thing that happens because you saved.
 */
function watchSources() {
  const roots = [join(root, "server/src"), join(root, "shared")];
  let timer = null;
  const changed = new Set();
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    watch(dir, { recursive: true }, (_event, file) => {
      // Dot-files are an editor's or `sed -i`'s scratch copy, which a rename
      // turns into a save of the real file a moment later.
      if (!file || !file.endsWith(".ts") || basename(file).startsWith(".")) return;
      if (file.includes("agents/") || file.includes("ptyhost") || file.includes("hostsock")) {
        console.log(`kururu: ${file} is the pty host's — restart the host to pick it up, and that ends its agents`);
        return;
      }
      changed.add(relative(root, join(dir, file)));
      clearTimeout(timer);
      timer = setTimeout(() => {
        const files = [...changed];
        changed.clear();
        void cycle({ files });
      }, 250);
    });
  }
}

/**
 * The runner's own end, which takes the record with it unless it is written
 * first. A crash here leaves the server running with nothing behind it — it is
 * not this process's child to take down any more — and the server notices on
 * its own and says so; this is the line that says why.
 */
process.on("uncaughtExceptionMonitor", (err) => {
  record("crash", `the runner itself crashed (${err?.message ?? err}); the server is left running with nothing supervising it`, {
    error: String(err),
    ...(err?.stack ? { stack: err.stack } : {}),
    ...(server ? { server: server.pid } : {}),
  });
});

const SIGNALS = { SIGINT: " (Ctrl-C)", SIGTERM: "", SIGHUP: " (its terminal closed)" };
for (const signal of Object.keys(SIGNALS)) {
  process.on(signal, () => {
    stopping = true;
    record("stop", `stopped by ${signal}${SIGNALS[signal]}`, { signal, ...(server ? { server: server.pid } : {}) });
    // The child is in this process group and has had the signal too; this is for
    // the case where it is not, and costs nothing when it is.
    server?.kill(signal);
    process.exit(0);
  });
}

const invoked = process.env.npm_lifecycle_event ? `bun run ${process.env.npm_lifecycle_event}` : "run.mjs";
record("start", watching ? `${invoked} started, watching server/src and shared` : `${invoked} started`);
try {
  await build();
} catch (err) {
  const said = err.said ?? "";
  record("down", "the first build failed, so there is no server to start", {
    error: buildError(said) || err.message,
    ...(said.trim() ? { stack: said.trim() } : {}),
  });
  console.error(`kururu: ${err.message}`);
  process.exit(1);
}
start(`${invoked} was started`);
if (watching) watchSources();
