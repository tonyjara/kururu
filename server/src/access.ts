/**
 * Who is allowed to talk to this server, and from where.
 *
 * Kururu spawns processes, types into them, and reads files. It has no accounts
 * and is not going to get any — one person's machine, one person's agents. What
 * it had instead, for as long as it was a thing you ran out of a checkout, was
 * `PLAN.md`'s line: *no auth, by design, tailnet-only*. That is a defensible
 * position for a tool you run on your own tailnet, and it stops being one the
 * moment somebody double-clicks a downloaded app: a server bound to `0.0.0.0`
 * with no gate in front of it hands a shell on your machine, with your accounts
 * signed in, to anybody else on the café Wi-Fi. Shipping is the moment that
 * assumption had to be revisited, and this file is the revisiting.
 *
 * ## Two mechanisms, and the first one is the kernel
 *
 * By default the socket is bound to loopback, so there is nothing to enforce:
 * the only thing that can connect is something already on this machine, and that
 * is decided by the operating system rather than by code in here that could be
 * wrong. Being reachable from anywhere else is a **decision**, made once, in the
 * dialog that exists for exactly that question — the same reasoning that keeps
 * `tailscale` commands out of kururu entirely.
 *
 * When that decision has been made, the second mechanism applies: one token,
 * minted once and kept in the config directory, carried in the QR code the phone
 * scans. The phone that scanned it is in; the laptop on the same Wi-Fi is not.
 * A token rather than a password because nobody is going to type either one and
 * only one of them fits in a QR code — and rather than a certificate because
 * this is a thing that has to work on a plane with no CA anywhere.
 *
 * Loopback is exempt from the token even while sharing is on. Anything that can
 * connect from `127.0.0.1` is already running on the machine and has no need of
 * kururu to get a shell on it, so demanding a secret would be theatre that cost
 * the desktop window a round trip.
 *
 * That argument is the Mac's, and it does not hold on a child. A box other
 * people's long-running programs share is one where "running on the machine"
 * is not "the user", and `tailscale serve` — which a child's phone wants for
 * its microphone — delivers every request it forwards *from* loopback. So
 * there is a switch, `loopbackToken` in `access.json` or
 * `KURURU_LOOPBACK_TOKEN=1`, under which loopback presents the token like
 * anybody else, and kururu's own callers on the machine present it: they read
 * it out of this file (`server/localtoken.mjs`), and the agents kururu starts
 * are handed it as `KURURU_TOKEN` (`tokenEnv`). Off by default, so the Mac
 * behaves as it always has; on for a child.
 *
 * ## The third thing, which is not about the network at all
 *
 * A web page you visit can open a WebSocket to `127.0.0.1` — the same-origin
 * policy does not apply to WebSockets, and no preflight is sent. Without a check
 * that means any site in any tab can connect to a *loopback-bound* kururu, read
 * the snapshot, spawn a pty and type into it, which is remote code execution
 * reached by clicking a link. The defence is the one header a browser always
 * sends on that handshake and a page cannot forge: `Origin`. Absent means not a
 * browser, which is `curl` and the status tool and is fine. Present means a page,
 * and it has to be one of ours — served by this server, or by vite in front of
 * it, or from this machine's own addresses.
 *
 * ## Why it is on the restartable side
 *
 * It is HTTP headers and a file in a config directory; nothing here is near a
 * pty. Which matters more than usual, because the rules in here will be
 * tightened again and tightening the gate must never be a thing that ends
 * somebody's work.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Sharing } from "../../shared/wire";
import { readConfigFile, writeConfigFile } from "./config";
import { supervised } from "./lifecycle";
import { reach } from "./reach";

const FILE = "access.json";
/** A year. The phone should scan the QR once, not once a week. */
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
export const COOKIE = "kururu_access";

interface Access {
  share: boolean;
  token: string;
  /** Whether loopback presents the token too. Absent is false: the Mac's arrangement. */
  loopbackToken?: boolean;
}

/**
 * Read once and held, because the bind address is decided from it at startup and
 * a file edited afterwards would leave the two disagreeing — the socket on one
 * answer and the gate on another, which is the one failure here that could be
 * *open* rather than closed.
 */
let access: Access | null = null;

function mint(): string {
  // base64url so it survives being a query parameter and a QR code without
  // escaping; 24 bytes because the thing it protects is a shell.
  return randomBytes(24).toString("base64url");
}

function load(): Access {
  if (access) return access;
  const raw = readConfigFile(FILE);
  const saved = typeof raw === "object" && raw !== null ? (raw as Partial<Access>) : {};
  const token = typeof saved.token === "string" && saved.token.length >= 16 ? saved.token : mint();
  /**
   * Absent reads as *not shared*. Which means an install that predates this file
   * comes back loopback-only and somebody's phone stops working until they press
   * the button in the dialog — a deliberate choice, and the only safe direction
   * for a default to be wrong in.
   */
  access = { share: saved.share === true, token, ...(saved.loopbackToken === true ? { loopbackToken: true } : {}) };
  if (token !== saved.token) save(access);
  return access;
}

/** 0600, since the token in it is a shell on this machine to whoever holds it. */
function save(value: Access): void {
  writeConfigFile(FILE, value, 0o600);
}

/**
 * Where to bind — decided once, and then *held*, which is the whole of the
 * difference between what the socket is doing and what the config file says.
 *
 * Those two are the same thing right up until somebody presses the button, and
 * then they are not: the bind address cannot move without the socket being
 * opened again, so between the decision and the restart there is a window in
 * which the file says shared and the kernel says otherwise. Answering from the
 * file during that window would have the dialog draw a QR code for an address
 * nothing is listening on, which is the worst of the available lies — it looks
 * like the feature working and fails on the device that is furthest away.
 *
 * The environment wins over both, so that a deployment with its own idea of the
 * network — a container, a VM with one interface — can say so without a config
 * file, and so this can be tested without writing one.
 *
 * `KURURU_BIND=tailscale` is a child's: this machine's tailnet address and
 * nothing else of its networks, found the way `reach.ts` finds it — in the
 * interface list, never by asking `tailscale`. A child with no tailnet address
 * when it starts binds loopback instead and says why (`bindProblem`): a
 * server that refused to start would leave the box's own tools nothing to
 * talk to, and loopback is the one bind that cannot be wrong. It is fixed
 * when the server is next started, which is what `systemctl --user restart
 * kururu` is.
 */
let bound: string | null = null;
let bindWhy: string | null = null;

/** What `KURURU_BIND` and the saved decision come to, given this machine's tailnet address. Pure, for the test. */
export function chooseBind(env: string | undefined, share: boolean, tailscale: string | null): { address: string; problem: string | null } {
  if (env === "tailscale") {
    if (tailscale) return { address: tailscale, problem: null };
    return { address: "127.0.0.1", problem: "KURURU_BIND=tailscale, and this machine has no tailnet address yet, so this server is on loopback only until it is restarted" };
  }
  return { address: env || (share ? "0.0.0.0" : "127.0.0.1"), problem: null };
}

export function bindAddress(): string {
  if (bound === null) {
    const env = process.env.KURURU_BIND;
    const chosen = chooseBind(env, env ? false : load().share, env === "tailscale" ? reach(0).tailscale : null);
    bound = chosen.address;
    bindWhy = chosen.problem;
  }
  return bound;
}

/** Why the server is not where it was asked to be, or null when it is. */
export function bindProblem(): string | null {
  bindAddress();
  return bindWhy;
}

/**
 * Every address to listen on: the bind address, and loopback beside it when
 * that is one other address and not every address. Every caller on this
 * machine dials 127.0.0.1 — the hooks, the tools, the agents' MCP configs — so
 * a child bound to its tailnet address alone would be a server its own agents
 * cannot report to. Pure over the bind address, for the test.
 */
export function listenAddressesFor(address: string): string[] {
  if (address === "127.0.0.1" || address === "0.0.0.0" || address === "::" || address === "::1" || address === "localhost") return [address];
  return [address, "127.0.0.1"];
}

export function listenAddresses(): string[] {
  return listenAddressesFor(bindAddress());
}

/**
 * Whether loopback must present the token too, decided once and held for
 * the reason the bind address is: the gate and the configs agents are
 * started with must not disagree about it inside one process. The
 * environment wins in both directions, `1` and `0`, over `access.json`.
 */
let loopbackHeld: boolean | null = null;

export function loopbackTokenRequired(): boolean {
  if (loopbackHeld === null) {
    const env = process.env.KURURU_LOOPBACK_TOKEN;
    loopbackHeld = env === "1" || env === "true" ? true : env === "0" || env === "false" ? false : load().loopbackToken === true;
  }
  return loopbackHeld;
}

/**
 * What a pty the server opens is given on top of its own environment, so the
 * agent in it can present the token: `KURURU_TOKEN`, while loopback wants
 * one, and nothing otherwise. The hooks (`report-cli.ts`), `reload-window`,
 * nvim's buffer hook and both MCP configs read it from there — the configs as
 * `${KURURU_TOKEN}`, which Claude Code and Codex expand themselves, so the
 * token is in no file and on no command line, where any user on the box
 * could read it in `/proc`.
 */
export function tokenEnv(): Record<string, string> | undefined {
  return loopbackTokenRequired() ? { KURURU_TOKEN: token() } : undefined;
}

/** What the socket is actually doing, which is what a client can rely on. */
export function isShared(): boolean {
  return bindAddress() !== "127.0.0.1";
}

export function token(): string {
  return load().token;
}

export function sharing(): Sharing {
  return {
    shared: isShared(),
    // The decision, which differs from the line above exactly while a restart
    // is owed — and the dialog says so rather than the two being averaged into
    // one field that is wrong half the time.
    wanted: process.env.KURURU_BIND ? isShared() : load().share,
    token: token(),
    // Only a supervisor can start this process again, and `restart-server`
    // already declines to do half the job without one — or with one that has
    // since died, which the environment cannot tell you.
    restartable: supervised(),
  };
}

/**
 * Change the decision. It takes effect when the server is next started, because
 * the bind address is fixed when the socket opens — the caller is what asks for
 * that restart, since only it knows whether anything is listening to the ask.
 */
export function setShare(share: boolean): Sharing {
  const current = load();
  access = { ...current, share };
  save(access);
  return sharing();
}

/** A fresh token, which is how "that phone is not mine any more" is expressed. */
export function rotateToken(): Sharing {
  access = { ...load(), token: mint() };
  save(access);
  return sharing();
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

function isLoopbackAddress(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");
  return bare === "127.0.0.1" || bare === "::1" || bare === "localhost" || bare.startsWith("127.");
}

function fromLoopback(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress;
  return Boolean(remote && isLoopbackAddress(remote));
}

/** Every cookie on the request, which is one parse rather than a regex per read. */
function cookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    out.set(part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim()));
  }
  return out;
}

/**
 * The token this request is presenting, from any of the three places one can be.
 *
 * The query parameter is what a QR code can carry, the cookie is what the page
 * uses once it has exchanged one for the other, and the header is for anything
 * that is not a browser at all. Compared with a constant-time comparison
 * because it is a secret being compared, and the fact that the timing here is
 * buried under a network round trip is not a reason to write the other kind.
 */
function presented(req: IncomingMessage, url: URL): string | null {
  const query = url.searchParams.get("k");
  if (query) return query;
  const cookie = cookies(req).get(COOKIE);
  if (cookie) return cookie;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function hasToken(req: IncomingMessage, url: URL): boolean {
  const given = presented(req, url);
  return given !== null && sameSecret(given, token());
}

/**
 * Is the page making this request one of ours?
 *
 * The allowances are every arrangement kururu is actually run in, and nothing
 * else. Same origin covers the built app and the desktop window. Loopback covers
 * vite in front of the server in development, which forwards the browser's
 * `Origin` untouched while rewriting `Host` to the upstream — so the two do not
 * match and cannot be compared. This machine's own addresses and `*.ts.net`
 * cover the phone pointed at vite over the tailnet, which is the same case
 * arriving by a name instead of by loopback.
 */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === "null") return true;

  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }

  if (isLoopbackAddress(host)) return true;
  if (req.headers.host && new URL(origin).host === req.headers.host) return true;
  if (host.endsWith(".ts.net")) return true;

  const here = reach(0);
  if (here.lan.includes(host) || here.tailscale === host) return true;

  const extra = (process.env.KURURU_ALLOWED_ORIGINS ?? "").split(",").map((entry) => entry.trim());
  return extra.includes(origin);
}

export type Verdict = "ok" | "cross-origin" | "no-token";

/** What the decision is made from, each found out once per request. */
export interface GateFacts {
  /** `originAllowed`: no page, or one of ours. */
  origin: boolean;
  /** The socket is bound somewhere other than loopback. */
  shared: boolean;
  /** The request came from this machine. */
  loopback: boolean;
  /** `loopbackTokenRequired`. */
  loopbackToken: boolean;
  /** It presented this server's token. */
  token: boolean;
}

/**
 * The whole decision, in the order that makes the refusals mean something: a
 * page from somewhere else is refused whatever it presents, and a token is only
 * ever asked of somebody who is not on this machine — or, with the switch on,
 * of everybody. Pure, which is what lets the test lay out every row.
 */
export function decide(facts: GateFacts): Verdict {
  if (!facts.origin) return "cross-origin";
  if (facts.loopback) return !facts.loopbackToken || facts.token ? "ok" : "no-token";
  if (!facts.shared) return "ok";
  return facts.token ? "ok" : "no-token";
}

export function verdict(req: IncomingMessage, url: URL): Verdict {
  return decide({
    origin: originAllowed(req),
    shared: isShared(),
    loopback: fromLoopback(req),
    loopbackToken: loopbackTokenRequired(),
    token: hasToken(req, url),
  });
}

/**
 * The cookie that turns one scanned QR code into a device that keeps working.
 *
 * `HttpOnly` because nothing in the page reads it — the browser attaches it to
 * every fetch and to the WebSocket handshake by itself, which is the entire
 * reason this is a cookie rather than a header the client would have to
 * remember to add in eleven places. Not `Secure`: this is http over a tailnet,
 * and a flag that made the cookie silently not be set would break the only
 * arrangement it exists for.
 */
export function cookieHeader(value: string): string {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax; HttpOnly`;
}
