/**
 * The browser: a page in a tab, from a client's socket.
 *
 * The verbs are few on purpose, because the server holds only the tab — where
 * it is in the layout and what address it is at — and never the page, which
 * is the Mac window's (`desktop/browser.js`). So a client can open one,
 * send one somewhere, and say where one went; closing is `close-tab`'s, as it
 * is for every tab. Every address is `browserUrl`'s answer before it touches
 * the layout, because the layout is persisted and shown to every client, and
 * main will load what it says.
 */
import type { WebSocket } from "ws";
import { browserTitle, browserUrl } from "../../../shared/browser";
import { isWebTab } from "../../../shared/layout";
import type { ClientMessage } from "../../../shared/wire";
import { type ClientState, workspaces } from "../context";
import { reply } from "./reply";

/** The sentence for an address the browser will not go to. */
const NOT_AN_ADDRESS = "That is not an address kururu's browser goes to: http and https only.";

export function browserVerbs(ws: WebSocket, _st: ClientState, msg: ClientMessage): boolean {
  switch (msg.type) {
    case "open-browser": {
      const run = () => {
        const url = browserUrl(msg.url);
        if (!url) throw new Error(NOT_AN_ADDRESS);
        const paneId = typeof msg.paneId === "string" ? msg.paneId : undefined;
        const tabId = workspaces.openBrowser(url, paneId, msg.place === "agents" ? "agents" : undefined);
        if (!tabId) throw new Error("There was no pane to open the page in.");
        return { tabId };
      };
      if (typeof msg.id === "number" && Number.isFinite(msg.id)) reply(ws, msg.id, run);
      else {
        try {
          run();
        } catch {
          // Asked for no answer, so there is nobody to tell; nothing was opened.
        }
      }
      return true;
    }

    case "browser-navigate": {
      const url = browserUrl(msg.url);
      if (isWebTab(msg.tabId) && url) workspaces.navigateBrowser(msg.tabId, url);
      return true;
    }

    case "browser-report": {
      // A page that went somewhere the browser does not keep — a `data:` frame
      // promoted to the top, a chrome error page — is not reported as being
      // there; the tab keeps the last address that was one.
      const url = browserUrl(msg.url);
      if (isWebTab(msg.tabId) && url) workspaces.reportBrowser(msg.tabId, url, browserTitle(msg.title));
      return true;
    }

    default:
      return false;
  }
}
