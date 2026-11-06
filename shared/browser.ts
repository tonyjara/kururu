/**
 * What kururu's browser will go to, decided once for every road a URL takes
 * in.
 *
 * A browser tab's address arrives from four places — the address field, a
 * dev-server row, a card's dev line and, later, an agent — and reaches two:
 * the server, which keeps it on the pane and persists it, and Electron's
 * main, which loads it. If those two disagreed about what is a URL, a tab
 * could be persisted with an address main would refuse, or the other way
 * round, and the second is the dangerous one. So the rule is here, pure,
 * and the server refuses with it; `desktop/browser.js` refuses again by the
 * same three schemes on every navigation, because main is the last thing
 * between a page and a `file:` URL and does not take the server's word.
 *
 * The rule is the plan's (docs/plans/browser-annotate.md, Security 2):
 * `http:`, `https:` and `about:blank`, nothing else. No `file:`, which is the
 * disk; no `javascript:` or `data:`, which are a page made of the address; no
 * `chrome:` or `devtools:`, which are the browser's own insides.
 *
 * Typing is forgiving the way an address bar is: `localhost:3000` is
 * `http://localhost:3000/`, `example.com/docs` is `https://example.com/docs`.
 * Words that are not an address are refused rather than searched for —
 * searching would send what was typed to a search engine, and nothing in the
 * plan asks kururu to choose one.
 */

/** The longest address kept, which is Chromium's own display limit and far past any real one. */
export const BROWSER_URL_MAX = 8192;

/** The schemes a tab may be at. */
const SCHEMES = new Set(["http:", "https:"]);

/**
 * Hosts typed bare that get `http:` rather than `https:`: this machine, a bare
 * IPv4 address and a `.local` name. Those are where dev servers are, on this
 * Mac or the next one on the LAN or the tailnet, and a dev server has no
 * certificate; a public site typed by its name gets `https:`.
 */
const LOCAL_HOST = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[::1\]|[a-z0-9-]+\.localhost|[a-z0-9-]+\.local)(?::\d+)?(?:[/?#]|$)/i;

/** Something that looks like a host: a dotted name or an address, then a port, path, query or nothing. */
const LOOKS_LIKE_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*(?::\d+)?(?:[/?#]|$)|^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#]|$)/i;

/**
 * The address a tab should go to, or null for something it must not.
 *
 * Normalised through `URL`, so what is kept is what the browser would have
 * made of it, and credentials in the address (`http://user:pass@host`) are
 * refused rather than kept: they would be persisted in `session.json` and
 * shown on a phone's placeholder.
 */
export function browserUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const typed = input.trim();
  if (!typed || typed.length > BROWSER_URL_MAX || /[\s\u0000-\u001f]/.test(typed)) return null;
  if (typed === "about:blank") return typed;
  let candidate = typed;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(typed) || /^[a-z0-9.-]+:\d+(?:[/?#]|$)/i.test(typed)) {
    // No scheme — or a host and port, which `URL` would read as a scheme.
    if (LOCAL_HOST.test(typed)) candidate = `http://${typed}`;
    else if (LOOKS_LIKE_HOST.test(typed)) candidate = `https://${typed}`;
    else return null;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (!SCHEMES.has(url.protocol) || !url.hostname) return null;
  if (url.username || url.password) return null;
  const out = url.toString();
  return out.length <= BROWSER_URL_MAX ? out : null;
}

/** The longest title kept; a page's `<title>` is the page's to make as long as it likes. */
export const BROWSER_TITLE_MAX = 300;

/** A page's title as the layout keeps it: one line, cut. */
export function browserTitle(input: unknown): string {
  if (typeof input !== "string") return "";
  const line = input.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length > BROWSER_TITLE_MAX ? `${line.slice(0, BROWSER_TITLE_MAX - 1)}…` : line;
}

/** What a browser tab is called in a strip: its title, else its host, else "New tab". */
export function browserLabel(page: { url: string; title: string }): string {
  if (page.title) return page.title;
  if (page.url === "about:blank" || !page.url) return "New tab";
  try {
    const url = new URL(page.url);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return page.url;
  }
}
