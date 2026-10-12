/**
 * An agent reloading the window, instead of asking the user to press ⌘R.
 *
 * Reloading is something only a page can do to itself, so an agent that had
 * changed `web/` and needed a fresh load — the change did not hot-apply, or a
 * hot update left an old copy of a module running, or it wants to measure the
 * window as a fresh load draws it — had to stop and ask for a key. This asks
 * the server instead, and the server asks every Kururu page on this Mac, each
 * of which reloads once it is safe: not while the user is talking to Kuru or
 * Kuru is speaking, not within a few seconds of a keystroke or a click, not
 * with a dialog or a menu open. See `shared/reload.ts`.
 *
 * It knows which agent it is the way the report hook does: kururu starts every
 * pty with `KURURU_AGENT_ID` and `KURURU_PORT` in its environment, and a
 * command typed there inherits both. The window's notice then says who asked.
 *
 * It waits for the answer and prints it, and exits 0 only when every page
 * reloaded — so an agent can tell "reloaded and back, measure now" from "held
 * by a dialog for ninety seconds, ask the user". A server that restarts while
 * it waits, which is what saving a server file does under `bun run dev`, drops
 * the request; the pages reconnect rather than reload, so the ask is simply
 * made again once the server is back, for the time that is left.
 *
 *   bun run reload-window --why "the new tab strip"            wait up to 90 s
 *   bun run reload-window --why "measure the pill" --timeout 20
 *
 * Plain `node:http` rather than `fetch`, whose client gives up on a response
 * after five minutes and so could not wait the ten an agent may ask for.
 */
import { request } from "node:http";

/** The server answers at its own deadline; this is the slack past it before deciding the server is not coming back. */
const SLACK_MS = 30_000;
const RETRY_MS = 1000;
/** A restart under `bun run dev` is back in a few seconds; a server silent for longer than this is not restarting, it is down. */
const DOWN_MS = 15_000;
const DEFAULT_S = 90;
const MAX_S = 600;

function usage(problem) {
  if (problem) console.error(`kururu: ${problem}`);
  console.error('usage: bun run reload-window --why "what changed" [--timeout seconds]');
  process.exit(2);
}

function parse(argv) {
  const words = [];
  let why = null;
  let timeout = DEFAULT_S;
  let port = process.env.KURURU_PORT || "7717";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
    const value = () => inline ?? argv[++i] ?? usage(`${flag} wants a value`);
    if (flag === "--why" || flag === "-w") why = value();
    else if (flag === "--timeout" || flag === "-t") timeout = Number(value());
    else if (flag === "--port") port = value();
    else if (flag === "--help" || flag === "-h") usage();
    else if (arg.startsWith("-")) usage(`no such option ${arg}`);
    else words.push(arg);
  }
  why = (why ?? words.join(" ")).trim();
  if (!why) usage("say why — the window shows it in the notice after the reload");
  if (!Number.isFinite(timeout) || timeout <= 0) usage("--timeout is a number of seconds");
  return { why, timeout: Math.min(MAX_S, timeout), port };
}

function post(port, body, waitMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      { host: "127.0.0.1", port: Number(port), path: "/api/reload-window", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: { ok: false, error: text.trim() || `the server said ${res.statusCode}` } });
          }
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(waitMs, () => req.destroy(new Error("the server did not answer in time")));
    req.on("error", reject);
    req.end(payload);
  });
}

const { why, timeout, port } = parse(process.argv.slice(2));
const agent = process.env.KURURU_AGENT_ID || null;
const deadline = Date.now() + timeout * 1000;
let told = false;
let downSince = null;

for (;;) {
  const left = Math.max(2, Math.round((deadline - Date.now()) / 1000));
  try {
    const { status, body } = await post(port, { why, agent, timeout: left }, left * 1000 + SLACK_MS);
    if (status !== 200 || typeof body.text !== "string") {
      console.error(`kururu: ${body.error ?? `the server said ${status}`}`);
      process.exit(2);
    }
    console.log(body.text);
    process.exit(body.ok ? 0 : 1);
  } catch (err) {
    downSince ??= Date.now();
    if (Date.now() >= deadline || Date.now() - downSince >= DOWN_MS) {
      console.error(`kururu: no server answered on :${port} (${err.message}). Nothing was reloaded.`);
      process.exit(2);
    }
    if (!told) {
      console.error(`kururu: the server on :${port} is not answering (${err.message}) — a restart, most likely; asking again once it is back`);
      told = true;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}
