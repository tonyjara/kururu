/**
 * The gate, which is the one piece of kururu where being wrong hands somebody
 * else a shell.
 *
 * Everything here is a header and a string comparison — no socket, no config the
 * test did not write, and `XDG_CONFIG_HOME` pointed at a temp directory so the
 * token minted below is not the user's. The bind address is read once per
 * process by construction (see `bindAddress`), so this file runs the whole thing
 * in the *shared* mode: the loopback mode's answer is "yes, the kernel already
 * decided", and it is the shared one where there is anything to get wrong.
 *
 * The cases are chosen from what an attack actually looks like rather than from
 * the branches. A page on another site opening a socket to `127.0.0.1` is the
 * one that works against a kururu nobody shared at all, and is therefore the
 * only one in here that is not about the token.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "kururu-access-"));
process.env.KURURU_BIND = "0.0.0.0";
delete process.env.KURURU_ALLOWED_ORIGINS;

const { chooseBind, decide, hasToken, isShared, listenAddressesFor, originAllowed, token, verdict } = await import("../src/access");

/** Enough of a request for the gate, which reads two headers and one address. */
function req(headers: Record<string, string>, remoteAddress = "192.168.1.50"): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

const at = (path: string) => new URL(path, "http://100.101.102.103:7717");

describe("the mode this file runs in", () => {
  it("is shared, which is the half with a decision in it", () => {
    expect(isShared()).toBe(true);
  });

  it("mints a token long enough to be one", () => {
    expect(token().length).toBeGreaterThanOrEqual(24);
  });
});

describe("originAllowed", () => {
  it("allows a request with no Origin, which is everything that is not a browser", () => {
    expect(originAllowed(req({}))).toBe(true);
  });

  it("allows the page this server serves", () => {
    expect(originAllowed(req({ origin: "http://100.101.102.103:7717", host: "100.101.102.103:7717" }))).toBe(true);
  });

  /**
   * Vite in front of the server forwards the browser's `Origin` untouched while
   * rewriting `Host` to the upstream, so these two never match in development
   * and loopback has to be allowed on its own.
   */
  it("allows vite in front of it, whose Origin and Host cannot match", () => {
    expect(originAllowed(req({ origin: "http://localhost:5173", host: "127.0.0.1:7717" }))).toBe(true);
  });

  it("allows the phone pointed at vite over the tailnet", () => {
    expect(originAllowed(req({ origin: "http://frog.tail1234.ts.net:5173", host: "127.0.0.1:7717" }))).toBe(true);
  });

  /**
   * The one that matters. A WebSocket is not subject to the same-origin policy
   * and sends no preflight, so without this any page in any tab could open one
   * to a loopback-bound kururu and spawn a pty in it.
   */
  it("refuses a page on somebody else's site", () => {
    expect(originAllowed(req({ origin: "https://evil.example", host: "127.0.0.1:7717" }))).toBe(false);
    expect(originAllowed(req({ origin: "https://evil.example", host: "100.101.102.103:7717" }))).toBe(false);
  });

  it("is not fooled by a name that merely ends in one of ours", () => {
    expect(originAllowed(req({ origin: "https://notlocalhost", host: "127.0.0.1:7717" }))).toBe(false);
    // `.ts.net` is allowed; a domain that only *contains* it is not.
    expect(originAllowed(req({ origin: "https://ts.net.evil.example" }))).toBe(false);
  });

  it("refuses an Origin it cannot parse rather than letting it through", () => {
    expect(originAllowed(req({ origin: "not a url" }))).toBe(false);
  });
});

describe("hasToken", () => {
  it("takes it from the query, which is what a QR code can carry", () => {
    expect(hasToken(req({}), at(`/?k=${token()}`))).toBe(true);
  });

  it("takes it from the cookie, which is what the handshake carries", () => {
    expect(hasToken(req({ cookie: `other=1; kururu_access=${token()}` }), at("/ws"))).toBe(true);
  });

  it("takes it from a bearer header, for anything that is not a browser", () => {
    expect(hasToken(req({ authorization: `Bearer ${token()}` }), at("/api/health"))).toBe(true);
  });

  it("refuses a wrong one, a truncated one and none at all", () => {
    expect(hasToken(req({}), at("/?k=nonsense"))).toBe(false);
    expect(hasToken(req({}), at(`/?k=${token().slice(0, -1)}`))).toBe(false);
    expect(hasToken(req({}), at("/"))).toBe(false);
  });
});

describe("verdict", () => {
  it("lets this machine in without a token", () => {
    // Anything that can connect from here can already start a shell; asking it
    // for a secret would be theatre with a round trip in it.
    expect(verdict(req({}, "127.0.0.1"), at("/api/health"))).toBe("ok");
    expect(verdict(req({}, "::1"), at("/api/health"))).toBe("ok");
    expect(verdict(req({}, "::ffff:127.0.0.1"), at("/api/health"))).toBe("ok");
  });

  it("wants a token from anywhere else", () => {
    expect(verdict(req({}), at("/api/health"))).toBe("no-token");
    expect(verdict(req({}), at(`/api/health?k=${token()}`))).toBe("ok");
  });

  /**
   * Order matters here and the test is what holds it: a page from somewhere else
   * is refused *as* a cross-origin request even when it is carrying a perfectly
   * good token, because a token it got hold of is precisely the case where the
   * second check is the only one left.
   */
  it("refuses a foreign page before it looks at what it is holding", () => {
    expect(verdict(req({ origin: "https://evil.example" }), at(`/ws?k=${token()}`))).toBe("cross-origin");
  });
});

/**
 * The decision as a table, every row of it, with the switch a child turns on
 * and the Mac leaves off. Pure, so the mode this file's process runs in does
 * not limit which rows can be checked.
 */
describe("decide", () => {
  const rows: [origin: boolean, shared: boolean, loopback: boolean, loopbackToken: boolean, token: boolean, want: string][] = [
    // A page from somewhere else, whatever else is true.
    [false, false, true, false, true, "cross-origin"],
    [false, true, false, false, true, "cross-origin"],
    [false, true, true, true, true, "cross-origin"],
    // The Mac: loopback is in, with or without a token, shared or not.
    [true, false, true, false, false, "ok"],
    [true, true, true, false, false, "ok"],
    [true, true, true, false, true, "ok"],
    // The Mac shared: anybody else presents the token.
    [true, true, false, false, false, "no-token"],
    [true, true, false, false, true, "ok"],
    // A child: loopback presents it too.
    [true, true, true, true, false, "no-token"],
    [true, true, true, true, true, "ok"],
    [true, false, true, true, false, "no-token"],
    [true, false, true, true, true, "ok"],
    // And the tailnet presents it as before.
    [true, true, false, true, false, "no-token"],
    [true, true, false, true, true, "ok"],
    // Not shared and not loopback is a socket the kernel would not have handed us; it is let through as it always was.
    [true, false, false, false, false, "ok"],
  ];

  for (const [origin, shared, loopback, loopbackToken, token, want] of rows) {
    it(`origin ${origin}, shared ${shared}, loopback ${loopback}, loopback token ${loopbackToken}, token ${token} → ${want}`, () => {
      expect(decide({ origin, shared, loopback, loopbackToken, token })).toBe(want);
    });
  }
});

describe("chooseBind", () => {
  it("is loopback unless something says otherwise", () => {
    expect(chooseBind(undefined, false, null)).toEqual({ address: "127.0.0.1", problem: null });
  });

  it("is every address once sharing was chosen", () => {
    expect(chooseBind(undefined, true, "100.101.102.103")).toEqual({ address: "0.0.0.0", problem: null });
  });

  it("takes an address from the environment as it is", () => {
    expect(chooseBind("100.64.0.9", false, null)).toEqual({ address: "100.64.0.9", problem: null });
  });

  it("is a child's tailnet address and nothing else for KURURU_BIND=tailscale", () => {
    expect(chooseBind("tailscale", false, "100.101.102.103")).toEqual({ address: "100.101.102.103", problem: null });
  });

  it("falls back to loopback, and says why, with no tailnet address to bind", () => {
    const chosen = chooseBind("tailscale", false, null);
    expect(chosen.address).toBe("127.0.0.1");
    expect(chosen.problem).toContain("no tailnet address");
  });
});

describe("listenAddressesFor", () => {
  it("is the one address for loopback and for every address, which already has loopback in it", () => {
    expect(listenAddressesFor("127.0.0.1")).toEqual(["127.0.0.1"]);
    expect(listenAddressesFor("0.0.0.0")).toEqual(["0.0.0.0"]);
    expect(listenAddressesFor("::")).toEqual(["::"]);
  });

  it("adds loopback beside one other address, since every caller on the machine dials 127.0.0.1", () => {
    expect(listenAddressesFor("100.101.102.103")).toEqual(["100.101.102.103", "127.0.0.1"]);
  });
});
