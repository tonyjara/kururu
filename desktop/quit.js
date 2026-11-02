/**
 * Why quitting has a module of its own: a signal is not somebody choosing,
 * and the app could not tell the two apart (KUR-179).
 *
 * `main.js` asks "N agents are still running" on the way out, with "Quit and
 * end them" one button away, because somebody leaving should be told what
 * stays behind. A SIGTERM — the app swap's watcher, a script, `kill` — is not
 * somebody leaving, and it must quit quietly. The trouble was where the signal
 * went. Electron's browser process installs a SIGTERM/SIGINT handler of its own
 * that calls the ordinary quit, and Node's `process.on("SIGTERM")` is a
 * `sigaction` too; only one per signal can be in place, and whichever is
 * installed last wins. Registered at module load, as it was, Node's lost
 * every time: Electron installs its handler after `main.js` has run, so the
 * signal arrived as a plain quit, `before-quit` saw nobody had said
 * otherwise, and put the dialog up. Tried on Electron's own binary with a
 * windowless app: at load, Node's handler never ran; inside `whenReady`, it
 * ran and Electron's did not.
 *
 * So two things, either of which would do on the Electron of today, and both
 * because the next one may differ:
 *
 * - `listenForSignals` is called from `whenReady`, after Electron's handler is
 *   in, so Node's is the one that stays. libuv installs its `sigaction` on the
 *   first listener for a signal and never again, which is why nothing may
 *   listen for these signals earlier — a stray early `process.on` would put
 *   the bug back.
 * - `QuitGate.beforeQuit` decides a beat late. If a quit arrives that nobody
 *   flagged, the decision waits `DEFER_MS`, and a signal handler that ran in
 *   the meantime has set `quitting` and the dialog is never shown. For ⌘Q the
 *   wait is fifty milliseconds before a dialog nobody times.
 *
 * Rejected: a `kururu://quit` URL or a tray item for scripts to call instead
 * of signalling. It may still be worth having, but a signal is what launchd,
 * `kill` and every supervisor send, and the app must take it either way.
 */

/** Long enough for libuv to deliver a signal that arrived with the quit. */
const DEFER_MS = 50;

const SIGNALS = ["SIGINT", "SIGTERM"];

class QuitGate {
  /**
   * @param {{ defer?: (fn: () => void) => void }} [options]
   */
  constructor({ defer = (fn) => void setTimeout(fn, DEFER_MS) } = {}) {
    /** Set by whatever has already decided — a signal, an update, the dialog's answer. */
    this.quitting = false;
    this.defer = defer;
    this.pending = false;
  }

  /**
   * For `before-quit`: true when the quit should go ahead, false when it is held
   * (the caller calls `preventDefault`). Held, `ask` runs a beat later unless
   * somebody decided in between, and a second quit while one is being decided
   * — ⌘Q again over the dialog — is held without asking twice.
   *
   * @param {() => unknown} ask
   * @returns {boolean}
   */
  beforeQuit(ask) {
    if (this.quitting) return true;
    if (this.pending) return false;
    this.pending = true;
    this.defer(() => {
      if (this.quitting) {
        this.pending = false;
        return;
      }
      void Promise.resolve()
        .then(ask)
        .catch((error) => console.error("kururu: the quit dialog failed:", error))
        .finally(() => {
          this.pending = false;
        });
    });
    return false;
  }
}

/**
 * Listen for the stopping signals. Call it from `whenReady` and nowhere
 * earlier; see above.
 *
 * @param {(signal: string) => void} onSignal
 * @param {(signal: string, fn: () => void) => void} [on]
 */
function listenForSignals(onSignal, on = (signal, fn) => void process.on(signal, fn)) {
  for (const signal of SIGNALS) on(signal, () => onSignal(signal));
}

module.exports = { DEFER_MS, QuitGate, listenForSignals };
