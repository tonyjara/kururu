/**
 * The nodes the window's choosers offer, read off the local server's view:
 * the origin apart from the token, so a URL with a secret in it is never what
 * gets remembered or drawn, and the reason a node cannot be opened.
 */
import { describe, expect, it } from "bun:test";
import { nodeChoices, whyNot } from "../nodes.js";

describe("nodeChoices", () => {
  it("splits each node's URL into the origin and its token", () => {
    const view = {
      nodes: [
        { id: "n1", name: "box", url: "http://100.64.0.2:7717/?k=secret-token-value", state: "up", since: 5, parent: false, summary: { watchable: 2 } },
        { id: "n2", name: "mac", url: "http://100.64.0.1:7717/", state: "away", since: null, parent: true },
        { id: "n3", name: "bad", url: "not a url", state: "up" },
      ],
    };
    expect(nodeChoices(view)).toEqual([
      { id: "n1", name: "box", address: "http://100.64.0.2:7717", token: "secret-token-value", state: "up", since: 5, parent: false, settings: true },
      { id: "n2", name: "mac", address: "http://100.64.0.1:7717", token: null, state: "away", since: null, parent: true, settings: false },
    ]);
    expect(nodeChoices(null)).toEqual([]);
  });

  it("says why a node whose link is down cannot be opened", () => {
    expect(whyNot({ state: "up" })).toBeNull();
    expect(whyNot({ state: "away", since: null })).toBe("away");
    expect(whyNot({ state: "away", since: new Date().setHours(23, 10, 0, 0) })).toBe("away since 23:10");
    expect(whyNot({ state: "connecting" })).toBe("not linked yet");
  });
});
