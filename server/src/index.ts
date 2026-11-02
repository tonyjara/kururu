/**
 * The kururu server: one process between the agents and every UI.
 *
 * It owns the ptys, holds an emulator per agent, and pushes what changed down a
 * WebSocket to whoever is watching — the desktop window and the phone are the
 * same client code talking to this same server, which is what keeps the two from
 * drifting. It also serves the built web app, so the window loads a URL rather
 * than a file and there is exactly one asset pipeline.
 *
 * It used to poll a ghosttown daemon and forward what it saw. Now it is the
 * source, which removes the polling: a pty raises an event when it has something
 * to say, so snapshots are pushed when something actually changes rather than
 * on a timer. The timers that survive are the ones that could not be events —
 * end-of-work is *silence*, which raises no event, and the process table has to
 * be asked — plus one that coalesces, because output is an event thousands of
 * times a second and a socket should not be.
 *
 * It no longer owns the ptys. They live one process over, in `ptyhost.ts`, and
 * the reason is the dev loop: everything in this process changes weekly, and until
 * the split, restarting it to pick up a change took every agent with it. Now
 * this process can be killed and re-forked in under a second and the terminals
 * do not notice — it asks the host what is running, asks for the arrangement it
 * left behind, and carries on. See `hostlink.ts` for where the line is drawn.
 *
 * Runs on Node rather than Bun, which was once because Electron loaded it and is
 * now simply what it is: the bundle is built for node and the desktop no longer
 * starts it at all. Nothing here may import electron — this process is something
 * you run, possibly on a machine with no window on it, and the window is one
 * client of it exactly as the phone is.
 *
 * What is left in this file is the order of start-up: the two modules that
 * must load first, the sweeps, the link to the host awaited at the top level
 * and what is done when it drops, `attach`, and the signals. Everything else
 * is a module of its own — `context.ts` for what they share, `ws/` and `http/`
 * for what a client can ask, `boot.ts` for coming up and going down — and
 * `docs/map.md` lists them.
 */
// First, so that nothing this server loads opens a connection on Node's 250 ms: see the module.
import "./connectbudget";
// Second, so that every module after it runs with crashes recorded: see the module.
import { RESTART_EXIT_CODE } from "./preamble";
import { hostEnding, readTail, record, socketHeld } from "./lifecycle";
import { startSweeps } from "./sweeps";
import { attach, HOST_LOG, hostRestartAsked, linkToHost, shutdown, SOCKET, stopping } from "./boot";

startSweeps();

const link = await linkToHost();

/**
 * The host going away is not survivable, and pretending otherwise is worse than
 * exiting. Every agent was in that process; what is left here is a layout full
 * of tabs pointing at terminals that no longer exist and a UI that would draw
 * them as though they did.
 *
 * Except that a dropped link does not always mean the host went away. The host
 * keeps one server and lets go of the older when a second connects, so a
 * second server started beside this one, by a second `bun run dev` or by a
 * runner that started a replacement before this one had finished stopping,
 * looks exactly the same from here. That one is not a crash and every agent is
 * fine, so it is told apart before anything is written down that says
 * otherwise.
 */
link.onClose(() => {
  if (stopping) return;
  if (hostRestartAsked) {
    record("stop", "the pty host stopped as asked; this server is restarting to start a new one");
    console.error("kururu: the pty host was stopped on request — restarting to start a new one");
    void shutdown().then(() => process.exit(RESTART_EXIT_CODE));
    return;
  }
  if (socketHeld(SOCKET)) {
    record("stop", "another server connected to the pty host, which lets go of the older of two; this one is stepping aside");
    console.error("kururu: another server has taken over the pty host — this one is stepping aside");
    // Zero, because nothing failed: this server is choosing to stop, and its
    // supervisor should say so rather than report a crash.
    process.exit(0);
  }
  const { how, ...detail } = hostEnding(readTail(HOST_LOG)) ?? { how: null };
  record("crash", `the pty host went away, and every agent with it${how ? `: it ${how}` : ""}`, detail);
  console.error("kururu: the pty host went away — every agent went with it");
  process.exit(1);
});

await attach(link);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Who sent it is not knowable from here. The supervisor writes its own
    // line when it is the sender, so a signal with no such line above it came
    // from somewhere else, and that is worth being able to see.
    if (!stopping) record("stop", `stopped by ${signal}`, { signal });
    void shutdown().then(() => process.exit(0));
  });
}
