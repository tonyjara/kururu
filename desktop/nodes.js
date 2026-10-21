/**
 * The other kururus, as the window's two choosers offer them: the tray's
 * "Open <node>" and the picker's list.
 *
 * Since remote workspaces, a node this window can drive is not *opened*
 * here any more: its workspaces come into this window from the sidebar,
 * through the Mac's server, with the Mac's own agents still beside them.
 * What moving the whole window to the node is still for is the node's own
 * Settings, which no road here reaches, so that is what such a node's row
 * says (`settings`) and where the window lands. A node from before keeps
 * "Open", since moving the window is still its only road.
 *
 * The local server knows every member of the roster and whether each one's
 * link is up (`server/src/nodes.ts`), so this asks it rather than keeping a
 * list of its own: `/api/nodes`, on loopback. On the parent each node's URL
 * carries that node's share token, which is what lets one click be a window
 * let in rather than a window on a page asking for a token.
 *
 * A served page is never told any of this through the bridge, and cannot
 * use it: moving the window to another address stays the picker's and the
 * tray's, for the reason `preload.js` gives. The tokens are held in memory
 * here and nowhere else — never in `servers.json`, which the backup carries.
 */
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");

/**
 * The token a caller on this machine presents to the local server, when
 * loopback wants one: `access.json` first, then `KURURU_TOKEN`. The rule of
 * `server/localtoken.mjs`, spelt again because that file is a module and
 * this one is the main process's CommonJS.
 */
function localToken(env = process.env) {
  try {
    const dir = env.KURURU_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "kururu");
    const saved = JSON.parse(readFileSync(path.join(dir, "access.json"), "utf8"));
    if (typeof saved?.token === "string" && saved.token.length >= 16) return saved.token;
  } catch {
    // None here; the environment is the other place.
  }
  return env.KURURU_TOKEN || null;
}

/** The local server's nodes view, or null when it is down or from before nodes. */
async function fetchNodes(local) {
  const token = localToken();
  try {
    const response = await fetch(`${local}/api/nodes`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const view = await response.json();
    return view && Array.isArray(view.nodes) ? view : null;
  } catch {
    return null;
  }
}

/**
 * The view's members as the choosers want them: the origin the window
 * connects to, and the token apart from it, so a URL with a secret in it is
 * never what gets remembered or drawn. Pure, for the test.
 */
function nodeChoices(view) {
  if (!view || !Array.isArray(view.nodes)) return [];
  const out = [];
  for (const node of view.nodes) {
    let url;
    try {
      url = new URL(node.url);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    out.push({
      id: String(node.id),
      name: String(node.name),
      address: url.origin,
      token: url.searchParams.get("k") || null,
      state: node.state,
      since: typeof node.since === "number" ? node.since : null,
      parent: node.parent === true,
      // Its workspaces open in this window; moving there is for its Settings.
      settings: Boolean(node.summary && node.summary.watchable),
    });
  }
  return out;
}

/** `23:10` today, `Oct 17 23:10` otherwise, as the tray says times. */
function clock(ms) {
  const at = new Date(ms);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (at.toDateString() === new Date().toDateString()) return time;
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/**
 * Why a node cannot be opened, or null when it can. A node whose link is
 * not up is offered greyed with this as its reason, rather than left out:
 * a Mac asleep, seen from a child, is exactly the node somebody looks for,
 * and a list that dropped it would say it had been removed. And not
 * offered as a click, because the link being down is the server's best
 * knowledge that nothing would answer, and a window sent there would sit
 * on a dead page until the health watch gave up on it.
 */
function whyNot(node) {
  if (node.state === "up") return null;
  if (node.state === "away") return node.since ? `away since ${clock(node.since)}` : "away";
  return "not linked yet";
}

module.exports = { fetchNodes, localToken, nodeChoices, whyNot };
