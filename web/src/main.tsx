import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Crash } from "./components/Crash";
import { isLoopback } from "./preview";
import "./styles.css";

/**
 * Vite's dev client reads a dropped socket as vite restarting: it polls until
 * the server answers and then reloads the page. For the desktop window that is
 * true — a loopback socket only drops when vite does. For a phone pointed at
 * vite over the tailnet, which is what the Share dialog hands it in dev so that
 * it runs today's code, it is never true: iOS suspends a page the moment Safari
 * goes to the background and its sockets die with it, so every return to the
 * app reloaded everything — every emulator rebuilt, every backlog fetched again
 * — to recover from nothing. `session.ts` already reconnects in place, and that
 * was all the page needed.
 *
 * So a page on any other address holds the reload by never letting its
 * listener settle: vite awaits every `vite:ws:disconnect` listener before it
 * starts polling (`notifyListeners` in `vite/dist/client/client.mjs`, which is
 * the line to recheck after a vite upgrade). The cost is that the phone stops
 * following saves after its first sleep and keeps the code it was loaded with
 * until somebody reloads it — the same as a built bundle, and the right way
 * round for a page that is for watching agents rather than for working on
 * kururu.
 */
if (import.meta.hot && !isLoopback(location.hostname)) {
  import.meta.hot.on("vite:ws:disconnect", () => new Promise<never>(() => {}));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Crash>
      <App />
    </Crash>
  </StrictMode>,
);
