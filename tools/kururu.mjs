#!/usr/bin/env node
/**
 * `kururu`: the one command on a child, for setting it up and keeping it up.
 *
 * A child is the whole server on another PC, headless, run by systemd and
 * reached by a phone over the tailnet (`docs/linux.md`). Getting one running
 * was a dozen hand steps across two machines, and the person doing them is
 * usually an agent on that box with the user beside it. So the steps are code:
 * a wizard that checks, fixes or guides, and checks again; a doctor that runs
 * the same checks and changes nothing; and the few verbs a child needs after
 * that. The checks are one list in `tools/kururu/checks.mjs`.
 *
 * Plain node and nothing to install, like `server/run.mjs`, because the first
 * time it runs is before `bun install`: `node tools/kururu.mjs child setup`
 * from a fresh clone, and the setup links it as `~/.local/bin/kururu`.
 *
 * It asks when a terminal is there to answer. With none — an agent's tool, a
 * pipe — a question stops the run with exit 3, says which flag answers it,
 * and the same command with that flag carries on; a thing only the person can
 * do (sign in, `sudo`, `tailscale up`) stops it with exit 4 and the exact
 * line to type. Running it again is always safe: what is done is checked and
 * left alone, which is what makes stopping and starting again a workflow
 * rather than a hazard.
 *
 *   kururu child setup [--dry-run] [--port=N] [--account=this|dedicated] [--codex=yes|no] [--join="<address> <code>"] [--yes]
 *   kururu child doctor           the same checks, read-only; exit 1 on a ✗
 *   kururu child update           pull, install, build, restart the server, doctor
 *   kururu child status           the service, then `bun run status`
 *   kururu child join <address> <code>  join the Mac: the command its Settings → Nodes → Add a computer shows
 *   kururu child restart-host     a new pty host, which ends every agent it holds
 *   kururu share [--url|--rotate] the phone's link and QR code
 *
 * `doctor`, `update`, `status` and `join` answer without `child` too.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { context, JOIN_HOW, joinParent, lifecycleTail, remember, Stop, STEPS } from "./kururu/checks.mjs";
import { doctorExit, parseArgs, table, tailnetAddress } from "./kururu/pure.mjs";

/** The checkout, found from this file and not the working directory, through the link in `~/.local/bin`. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const tty = process.stdout.isTTY;
const paint = (code, text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (text) => paint("1", text);
const dim = (text) => paint("2", text);
const markColour = (state, text) => paint(state === "ok" ? "32" : state === "fail" ? "31" : "2", text);

/** Prose at a readable width, since the explanations are the point. */
function wrap(text, width = Math.min(process.stdout.columns || 88, 88) - 4) {
  const out = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (line && line.length + word.length + 1 > width) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}

/**
 * How the steps talk to the person: `say`, `ask`, and `waitFor`. Interactive
 * when stdin is a terminal; otherwise a question that its flag does not
 * already answer stops the run with the flag named, which is the whole of how
 * an agent relays one.
 */
function makeIo(flags) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && flags["no-input"] !== true;
  return {
    interactive,
    say(text) {
      for (const line of wrap(text)) console.log(`  ${line}`);
    },
    async ask(question, options, flag) {
      const given = flags[flag];
      if (given !== undefined) {
        const answer = given === true ? options[0] : String(given);
        if (!options.includes(answer)) throw new Stop(`--${flag} takes ${options.join(" or ")}, not ${answer}`, { code: 2 });
        console.log(`  ${question} ${bold(answer)} ${dim(`(--${flag})`)}`);
        return answer;
      }
      if (!interactive) {
        throw new Stop(`${question}\nAnswer it by running this again with --${flag}=${options.join(" or --" + flag + "=")}.`, { code: 3 });
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (;;) {
          const said = (await rl.question(`  ${question} [${options.join("/")}] `)).trim().toLowerCase();
          const answer = said === "" ? options[0] : options.find((option) => option.startsWith(said));
          if (answer) return answer;
        }
      } finally {
        rl.close();
      }
    },
    /**
     * A line of free text — the join command, pasted — or null for Enter.
     * Without a terminal it is null at once: every caller treats the answer
     * as optional and has a flag of its own for an agent to pass.
     */
    async askText(question) {
      if (!interactive) return null;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const said = (await rl.question(`  ${question} `)).trim();
        return said || null;
      } finally {
        rl.close();
      }
    },
    /** Poll `test` until it holds, the time runs out, or the person presses Enter. */
    async waitFor(test, ms) {
      const until = Date.now() + ms;
      let stopped = false;
      const rl = interactive ? createInterface({ input: process.stdin }) : null;
      rl?.once("line", () => (stopped = true));
      try {
        while (!stopped && Date.now() < until) {
          if (await test()) return true;
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        return false;
      } finally {
        rl?.close();
      }
    },
  };
}

function linuxOnly() {
  if (process.platform !== "linux") {
    console.error("kururu child: a child is a Linux box run by systemd. The Mac is the parent, and `bun run status` is its doctor.");
    process.exit(2);
  }
}

// --- setup --------------------------------------------------------------------

async function setup(flags) {
  linuxOnly();
  const ctx = context({ root: ROOT, env: process.env, flags });
  const io = makeIo(flags);
  console.log();
  console.log(bold(`kururu child setup${ctx.dryRun ? " — dry run: nothing will change" : ""}`));
  console.log(dim(`  ${ROOT} · port ${ctx.port} · unit ${ctx.unit}${ctx.runtime ? " (runtime, gone at reboot)" : ""}`));
  // Where this child lives, kept from the first run, so every later command
  // (`doctor`, `update`, the next `setup`) finds it without the flags.
  const where = { port: ctx.port, unit: ctx.unit, runtime: ctx.runtime, bin: ctx.binDir };
  const moved = Object.entries(where).filter(([key, value]) => ctx.saved[key] !== value);
  if (moved.length && !ctx.dryRun) {
    remember(ctx, where);
    ctx.changed.push(`kept ${moved.map(([key, value]) => `${key} ${value}`).join(", ")} in ${ctx.configDir}/child.json`);
  }
  for (const [index, step] of STEPS.entries()) {
    console.log();
    console.log(bold(`── ${index + 1}/${STEPS.length}  ${step.title}`));
    io.say(dim(step.why));
    let rows = await step.check(ctx);
    for (const line of table(rows, markColour)) console.log(line);
    if (rows.every((row) => row.state !== "fail") && !step.pending?.(ctx, rows)) continue;
    try {
      await step.repair(ctx, io, rows, () => step.check(ctx));
    } catch (err) {
      if (!(err instanceof Stop)) throw err;
      if (ctx.dryRun && err.code !== 2) {
        // A dry run goes on to show the rest, since nothing it would have done was done.
        console.log();
        for (const line of wrap(err.message)) console.log(`  ${paint("33", "!")} ${line}`);
        continue;
      }
      return stopped(err, ctx);
    }
    if (ctx.dryRun) continue;
    rows = await step.check(ctx);
    console.log(dim("  checked again:"));
    for (const line of table(rows, markColour)) console.log(line);
    if (rows.some((row) => row.state === "fail")) {
      console.log();
      console.log(paint("31", `  ${step.title} still fails; the wizard stops here. Fix it as shown and run it again.`));
      return 1;
    }
  }
  console.log();
  if (ctx.dryRun) console.log(bold("Dry run over; nothing was changed."));
  else if (!ctx.changed.length) console.log(bold("Nothing to change: this child was already set up."));
  else {
    console.log(bold("Changed:"));
    for (const what of ctx.changed) console.log(`  · ${what}`);
  }
  return doctor(flags, { heading: "The doctor, after setup:" });
}

/** A step that needs the person: what to do, and the exit that says which kind of stop it was. */
function stopped(err, ctx) {
  console.log();
  for (const line of wrap(err.message)) console.log(`  ${err.code === 0 ? "" : paint("33", "→ ")}${line}`);
  if (err.code === 3 || err.code === 4) {
    console.log();
    console.log(dim("  Everything before this step is done and stays done. Run the same command again, with the answer when it asked for one, and it picks up from here."));
  }
  return err.code;
}

// --- doctor -------------------------------------------------------------------

async function doctor(flags, { heading = null } = {}) {
  linuxOnly();
  const ctx = context({ root: ROOT, env: process.env, flags });
  const rows = [];
  for (const step of STEPS) rows.push(...(await step.check(ctx)));
  console.log();
  console.log(bold(heading ?? `kururu child doctor · ${ROOT} · port ${ctx.port} · unit ${ctx.unit}`));
  for (const line of table(rows, markColour)) console.log(line);
  const events = lifecycleTail(ctx);
  console.log();
  console.log(dim(events.length ? `  lifecycle.log, the last ${events.length}:` : "  lifecycle.log: nothing yet"));
  for (const event of events) {
    const bad = event.what === "crash" || event.what === "down" || event.what === "orphaned";
    const line = `${new Date(event.at).toLocaleString()}  ${String(event.by ?? "").padEnd(7)} ${String(event.what ?? "").padEnd(9)} ${event.why}`;
    console.log(`    ${bad ? paint("31", line) : dim(line)}`);
  }
  const exit = doctorExit(rows);
  console.log();
  console.log(exit === 0 ? paint("32", "  All well.") : paint("31", "  Something above needs fixing; each ✗ says how."));
  return exit;
}

// --- update -------------------------------------------------------------------

/**
 * Pull, install, build, restart the server, and ask the doctor. The server
 * only: the host keeps the bundle it started with, and the doctor says when
 * it is behind, as `/api/health` does on the Mac, because restarting it is
 * the one thing that ends agents and is never a side effect.
 */
async function update(flags) {
  linuxOnly();
  const ctx = context({ root: ROOT, env: process.env, flags });
  const git = (args) => spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8" });
  const dirty = git(["status", "--porcelain"]).stdout.trim();
  if (dirty) {
    console.error(`kururu child update: the checkout has changes, and a pull over them is refused:\n${dirty}`);
    return 1;
  }
  const before = git(["rev-parse", "HEAD"]).stdout.trim();
  console.log(dim(`$ git pull --ff-only`));
  if (spawnSync("git", ["-C", ROOT, "pull", "--ff-only"], { stdio: "inherit" }).status !== 0) {
    console.error("kururu child update: the pull failed; the running server is untouched.");
    return 1;
  }
  const after = git(["rev-parse", "HEAD"]).stdout.trim();
  if (before === after) {
    console.log(`Already current at ${after.slice(0, 7)}; nothing rebuilt or restarted.`);
    return doctor(flags);
  }
  console.log(`${before.slice(0, 7)} → ${after.slice(0, 7)}`);
  const steps = [
    ["bun", ["install", "--frozen-lockfile"]],
    ["bun", ["run", "build"]],
  ];
  for (const [cmd, args] of steps) {
    console.log(dim(`$ ${cmd} ${args.join(" ")}`));
    const done = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...ctx.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1" } });
    if (done.status !== 0) {
      console.error(`kururu child update: \`${cmd} ${args.join(" ")}\` failed; the running server is untouched.`);
      return 1;
    }
  }
  console.log(dim(`$ systemctl --user restart ${ctx.unit}`));
  const restarted = spawnSync("systemctl", ["--user", "restart", `${ctx.unit}.service`], { stdio: "inherit", env: ctx.env });
  if (restarted.status !== 0) return 1;
  // The doctor asks the server, which is a moment from listening.
  for (let i = 0; i < 30; i++) {
    const answered = await fetch(`http://127.0.0.1:${ctx.port}/api/health`, { signal: AbortSignal.timeout(1000) }).then(
      (response) => response.status !== 0,
      () => false,
    );
    if (answered) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return doctor(flags);
}

// --- status, restart-host, share, wait-tailnet -----------------------------------

function status(flags) {
  linuxOnly();
  const ctx = context({ root: ROOT, env: process.env, flags });
  const shown = spawnSync("systemctl", ["--user", "show", `${ctx.unit}.service`, "-p", "ActiveState", "-p", "ActiveEnterTimestamp", "-p", "UnitFileState"], {
    encoding: "utf8",
    env: ctx.env,
  });
  const props = Object.fromEntries((shown.stdout ?? "").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  const active = props.ActiveState === "active";
  console.log(`${"service".padEnd(12)}${paint(active ? "32" : "31", props.ActiveState ?? "unknown")}  ${dim(`${ctx.unit}.service · ${props.UnitFileState ?? "?"}${props.ActiveEnterTimestamp ? ` · since ${props.ActiveEnterTimestamp}` : ""}`)}`);
  return spawnSync(process.execPath, [join(ROOT, "server", "status.mjs")], { stdio: "inherit", env: ctx.env }).status ?? 1;
}

/**
 * A new pty host, through the server (`POST /api/host/restart`, the Mac's
 * road): it ends the old one and every agent in it, and the server starts the
 * next as a unit of its own. Asked, with the count, and no by default.
 */
async function restartHost(flags) {
  linuxOnly();
  const ctx = context({ root: ROOT, env: process.env, flags });
  const { tokenHeaders } = await import("../server/localtoken.mjs");
  const headers = tokenHeaders({ KURURU_CONFIG_DIR: ctx.configDir });
  const health = await fetch(`http://127.0.0.1:${ctx.port}/api/health`, { headers, signal: AbortSignal.timeout(2000) })
    .then((response) => response.json())
    .catch(() => null);
  if (!health) {
    console.error(`kururu: no server answers on :${ctx.port}, and the host is restarted through it.`);
    return 1;
  }
  const io = makeIo({ ...flags, yes: flags.yes === true ? "yes" : flags.yes });
  const held = health.agents ?? 0;
  const cost = `It ends every terminal it holds: ${held}, ${health.liveAgents ?? 0} of them agents.`;
  const answer = await io.ask(`Restart the pty host? ${cost}`, ["no", "yes"], "yes").catch((err) => {
    if (err instanceof Stop && err.code === 3) throw new Stop(`Restarting the pty host ends every terminal it holds: ${held}, ${health.liveAgents ?? 0} of them agents. Run it again with --yes to go ahead.`, { code: 3 });
    throw err;
  });
  if (answer !== "yes") return 1;
  const response = await fetch(`http://127.0.0.1:${ctx.port}/api/host/restart`, { method: "POST", headers, signal: AbortSignal.timeout(10_000) });
  console.log(response.ok ? "The host is being restarted; the server comes back to a fresh one." : `The server refused (${response.status}): ${await response.text()}`);
  return response.ok ? 0 : 1;
}

/**
 * Join the Mac: `kururu child join <address> <code>`, the command the Mac's
 * Settings → Nodes → Add a computer shows, run here. Nothing to wait at a
 * terminal for, so it behaves the same for a person and for an agent's tool.
 */
async function joinMac(words) {
  linuxOnly();
  const at = words.indexOf("join");
  const rest = words.slice(at + 1);
  if (rest.length !== 2) throw new Stop(`kururu child join wants the Mac's address and a code, as the Mac shows them. ${JOIN_HOW}`, { code: 2 });
  const ctx = context({ root: ROOT, env: process.env, flags });
  return (await joinParent(ctx, makeIo(flags), rest.join(" "))) ? 0 : 1;
}

/**
 * Where `kururu child code` used to show a code to type into the Mac.
 * Pairing starts on the Mac now, and this says so rather than "no such
 * command" to anyone following an older note.
 */
function code() {
  console.error(`kururu: pairing starts on the Mac now. ${JOIN_HOW}`);
  return 2;
}

/** `bun run share`, from wherever `kururu` is typed, for this instance's port and config. */
function share(argv) {
  const ctx = context({ root: ROOT, env: process.env, flags: {} });
  return spawnSync("bun", [join(ROOT, "server", "src", "share-cli.ts"), ...argv], { stdio: "inherit", cwd: ROOT, env: ctx.env }).status ?? 1;
}

/**
 * The unit's pre-start: wait up to `--timeout` seconds for a tailnet address,
 * so a boot that starts the user manager before `tailscaled` has one does not
 * leave the server bound to loopback until somebody restarts it.
 */
async function waitTailnet(flags) {
  const until = Date.now() + Number(flags.timeout ?? 90) * 1000;
  while (Date.now() < until) {
    if (tailnetAddress(networkInterfaces())) return 0;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.error("kururu: no tailnet address yet; the server starts on loopback and says why in lifecycle.log");
  return 1;
}

function help() {
  const text = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const usage = text.split("\n").filter((line) => /^ \* {3}kururu /.test(line) || /^ \*\s+`doctor`/.test(line));
  console.log(usage.map((line) => line.replace(/^ \* ?/, "")).join("\n"));
  return 0;
}

// --- dispatch -----------------------------------------------------------------

const VALUED = ["port", "unit", "account", "codex", "bin", "timeout", "join"];
const argv = process.argv.slice(2);
const { flags, words } = parseArgs(argv, VALUED);
const [first, second] = words;
const verb = first === "child" ? second : first;

const verbs = {
  setup: () => setup(flags),
  doctor: () => doctor(flags),
  update: () => update(flags),
  status: () => status(flags),
  "restart-host": () => restartHost(flags),
  "wait-tailnet": () => waitTailnet(flags),
  join: () => joinMac(words),
  code,
  share: () => share(argv.slice(argv.indexOf("share") + 1)),
  help,
};

const handler = verbs[verb ?? "help"];
if (!handler) {
  console.error(`kururu: no such command \`${words.join(" ")}\``);
  help();
  process.exit(2);
}
try {
  process.exitCode = await handler();
} catch (err) {
  if (err instanceof Stop) {
    console.error(`kururu: ${err.message}`);
    process.exitCode = err.code;
  } else throw err;
}
