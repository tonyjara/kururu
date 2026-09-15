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
 *   node server/run.mjs            build, serve, restart on request
 *   node server/run.mjs --watch    ...and on every save, which is `bun run dev`
 */
import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ENTRY = join(root, "desktop/dist/server.mjs");
const BUILD = join(root, "desktop/build.mjs");

const watching = process.argv.includes("--watch");

/** Kept in step with `RESTART_EXIT_CODE` in `server/src/index.ts`, which is what sends it. */
const RESTART_EXIT_CODE = 75;

function build() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUILD], { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build failed (${code})`))));
    child.on("error", reject);
  });
}

let server = null;
let stopping = false;
/** Set while a restart is deliberate, so the exit that comes with it is not news. */
let replacing = false;

function start() {
  server = spawn(process.execPath, [ENTRY], {
    stdio: "inherit",
    // How the server knows that asking to be restarted will actually get it
    // restarted, rather than just ending it.
    env: { ...process.env, KURURU_SUPERVISED: "1" },
  });

  server.on("exit", (code, signal) => {
    server = null;
    if (stopping || replacing) return;
    if (code === RESTART_EXIT_CODE) {
      console.log("kururu: restarting the server — the agents are next door and will not notice");
      void cycle();
      return;
    }
    /**
     * Anything else is the server deciding to stop, and it is left stopped. A
     * supervisor that resurrects a process which cannot start — a port already
     * taken, a bad build — is a loop that fills a terminal with the same error
     * forever, and the error is the useful part.
     */
    console.error(`kururu: the server exited (${signal ?? code}); not restarting it`);
    process.exit(typeof code === "number" ? code : 1);
  });
}

/** Stop the current server, rebuild, start a new one. */
async function cycle() {
  replacing = true;
  try {
    if (server) {
      const old = server;
      server = null;
      await new Promise((resolve) => {
        old.once("exit", resolve);
        old.kill();
        setTimeout(resolve, 2000);
      });
    }
    await build();
  } catch (err) {
    console.error(`kururu: ${err.message} — leaving the old server down`);
    replacing = false;
    return;
  }
  replacing = false;
  start();
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
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    watch(dir, { recursive: true }, (_event, file) => {
      if (!file || !file.endsWith(".ts")) return;
      if (file.includes("agents/") || file.includes("ptyhost") || file.includes("hostsock")) {
        console.log(`kururu: ${file} is the pty host's — restart the host to pick it up, and that ends its agents`);
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => void cycle(), 250);
    });
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    // The child is in this process group and has had the signal too; this is for
    // the case where it is not, and costs nothing when it is.
    server?.kill(signal);
    process.exit(0);
  });
}

await build();
start();
if (watching) watchSources();
