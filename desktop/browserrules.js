/**
 * The browser's rules, with no Electron in them, so they can be read and
 * tested as arithmetic: which requests are kururu's own and refused, which
 * addresses a page may be at, what a download is called on disk, and the user
 * agent the pages are shown.
 *
 * **Why the browser must not reach kururu.** `originOk` (`server/src/access.ts`)
 * accepts any port on a loopback host, and `decide` lets loopback in without a
 * token. So a page at `http://localhost:3000` — or any script a dependency of
 * that dev app ships — can open `ws://127.0.0.1:7717/ws` and type into an
 * agent. That is already true of the same page in Safari, and the user decided
 * the wider fix is not wanted (docs/plans/browser-annotate.md, "What the user
 * decided"). But this browser makes "a dev app beside your agents" the normal
 * case and loads any website, so its own session, and only its own, is cut
 * off from kururu's ports: the server's, the preview proxies', and kururu's
 * own vite while it serves.
 *
 * **By port first, then by where the name goes.** Only a request to one of
 * those ports is looked at at all, so every other site pays nothing. A
 * loopback name or one of this Mac's own addresses or names is refused
 * outright. Any other host on such a port is resolved, and refused if it
 * resolves to this Mac — which is what stops `127.0.0.1.nip.io:7717` and
 * every other name pointed at loopback, a check by name alone would let
 * through. What it cannot stop is a name that answers differently to this
 * lookup and to Chromium's a moment later (DNS rebinding with a TTL of
 * nothing); both go through the system resolver and its cache, so the window
 * is small, and the token on every non-loopback address stays the second
 * lock. Another machine's dev server on 5173 is untouched: it is not this
 * Mac.
 */
const { join, parse } = require("node:path");
const { existsSync } = require("node:fs");

/** The preview proxies' ports: `BASE_PORT` and the 200 above it in `server/src/proxy.ts`. */
const PROXY_FIRST = 7800;
const PROXY_LAST = 7999;

/** Names that are this machine whatever the network says. */
function isLoopbackName(host) {
  const h = bare(host);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0.0.0.0" || h === "::" || h === "0:0:0:0:0:0:0:1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // IPv4 inside IPv6, which URL keeps in hex: ::ffff:7f00:1 is 127.0.0.1.
  if (/^::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(h)) return true;
  return false;
}

/** A host as a lookup key: lowercase, no brackets, no trailing dot. */
function bare(host) {
  return String(host || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

/** The port a URL goes to, its scheme's when it names none. */
function portOf(url) {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80;
}

/** Whether a port is one of kururu's: the server's, a proxy's, or one more named in `extra`. */
function isKururuPort(port, extra) {
  if (port >= PROXY_FIRST && port <= PROXY_LAST) return true;
  return extra.has(port);
}

/**
 * What to do with a request: `"allow"`, `"block"`, or `"resolve"` — the host
 * must be looked up and blocked if it is this Mac (`resolvesHere`).
 *
 * `ports` is the set of kururu's ports beyond the proxies (the server's, the
 * vite's while it serves); `own` is this Mac's addresses and names. Anything
 * that is not a URL is allowed through to Chromium, which has its own opinion
 * of it and is not the thing this check is for.
 */
function judgeRequest(raw, { ports, own }) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "allow";
  }
  if (!/^(https?|wss?):$/.test(url.protocol)) return "allow";
  if (!isKururuPort(portOf(url), ports)) return "allow";
  const host = bare(url.hostname);
  if (isLoopbackName(host) || own.has(host)) return "block";
  // A bare address that is not this Mac's needs no lookup: it is somewhere else.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return "allow";
  return "resolve";
}

/** Whether any of a name's addresses is this Mac. */
function resolvesHere(addresses, own) {
  return addresses.some((address) => isLoopbackName(address) || own.has(bare(address)));
}

/**
 * This Mac's own addresses and names, from `os.networkInterfaces()` and
 * `os.hostname()`: every interface address (the LAN's, the tailnet's), the
 * hostname, and its `.local` form.
 */
function ownHosts(interfaces, hostname) {
  const own = new Set();
  for (const list of Object.values(interfaces || {})) {
    for (const entry of list || []) if (entry && entry.address) own.add(bare(entry.address));
  }
  const name = bare(hostname);
  if (name) {
    own.add(name);
    const short = name.split(".")[0];
    if (short) {
      own.add(short);
      own.add(`${short}.local`);
    }
  }
  return own;
}

/**
 * Whether a frame may be at this address.
 *
 * The top of a tab is held to the plan's three: `http:`, `https:` and
 * `about:blank`. A frame inside a page is allowed the opaque schemes real
 * pages build frames of — `about:srcdoc`, `data:`, `blob:` — because refusing
 * them breaks embeds, payment forms and PDF viewers on ordinary sites, and
 * none of them can reach the disk or the browser's insides. What neither may
 * be at is `file:`, `chrome:`, `devtools:`, `javascript:` (a page made of the
 * address) or any scheme an app on this Mac registered.
 */
function allowedAddress(raw, { top }) {
  if (raw === "about:blank") return true;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "http:" || url.protocol === "https:") return true;
  if (top) return false;
  return url.protocol === "data:" || url.protocol === "blob:" || raw === "about:srcdoc";
}

/**
 * Where a download goes: `dir/name`, or `name (1).ext`, `name (2).ext`… for
 * a name already there — never over a file that is. The name is the page's to
 * suggest and is cut to its last path part, so `../../.zshrc` is `.zshrc` in
 * the folder and not anywhere else; a name with nothing left is `download`.
 */
function downloadPath(dir, suggested, exists = existsSync) {
  const last = (String(suggested || "")
    .split(/[/\\]/)
    .pop() ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  const name = last && last !== "." && last !== ".." ? last.slice(0, 200) : "download";
  const first = join(dir, name);
  if (!exists(first)) return first;
  const { name: stem, ext } = parse(name);
  for (let n = 1; n < 1000; n++) {
    const next = join(dir, `${stem} (${n})${ext}`);
    if (!exists(next)) return next;
  }
  return join(dir, `${stem} (${Date.now()})${ext}`);
}

/**
 * The user agent the pages are shown: Chrome's, built from Chrome's own words
 * in what Electron reports, and nothing else. Electron adds `Electron/44.3.0`
 * and the app's name and version — `Kururu/0.6.0` packaged,
 * `@kururu/desktop/0.6.0` from a checkout — and sites that sniff for Electron,
 * Google's sign-in first among them, refuse it. A page has no business
 * knowing which app it is in, so what is kept is a list of what Chrome sends
 * rather than a list of what to take out, which a renamed app would get past.
 */
function cleanUserAgent(agent) {
  const tokens = String(agent).match(/\([^)]*\)|\S+/g) || [];
  return tokens.filter((token) => token.startsWith("(") || /^(Mozilla|AppleWebKit|Chrome|Safari|Mobile)\/[\w.]+$/.test(token)).join(" ");
}

/**
 * The quarantine flag a browser's download carries on a Mac, in the shape
 * `xattr` writes it: flags, time in hex, the agent's name. `0083` is
 * "downloaded, from a browser, not yet opened", which is what Gatekeeper
 * reads before the first open.
 */
function quarantineValue(now = Date.now()) {
  return `0083;${Math.floor(now / 1000).toString(16)};Kururu;`;
}

module.exports = {
  PROXY_FIRST,
  PROXY_LAST,
  allowedAddress,
  cleanUserAgent,
  downloadPath,
  isLoopbackName,
  judgeRequest,
  ownHosts,
  quarantineValue,
  resolvesHere,
};
