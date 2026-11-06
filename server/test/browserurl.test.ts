/**
 * What the browser will go to. The server persists what this lets through
 * and main loads it, so a scheme let through here is a scheme a tab can be
 * put at from any client.
 */
import { describe, expect, it } from "bun:test";
import { BROWSER_TITLE_MAX, browserLabel, browserTitle, browserUrl } from "../../shared/browser";

describe("browserUrl", () => {
  it("takes http, https and about:blank", () => {
    expect(browserUrl("http://localhost:5173/")).toBe("http://localhost:5173/");
    expect(browserUrl("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(browserUrl("about:blank")).toBe("about:blank");
  });

  it("reads a typed host the way an address bar does", () => {
    expect(browserUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(browserUrl("localhost")).toBe("http://localhost/");
    expect(browserUrl("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
    expect(browserUrl("app.localhost:3000")).toBe("http://app.localhost:3000/");
    expect(browserUrl("example.com")).toBe("https://example.com/");
    expect(browserUrl("docs.example.com/guide")).toBe("https://docs.example.com/guide");
    expect(browserUrl("  example.com  ")).toBe("https://example.com/");
    expect(browserUrl("192.168.1.4:3000")).toBe("http://192.168.1.4:3000/");
    expect(browserUrl("mac-mini.local:5173")).toBe("http://mac-mini.local:5173/");
  });

  it("refuses every other scheme", () => {
    for (const bad of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "about:config",
      "ftp://example.com/",
      "blob:https://example.com/1",
      "view-source:https://example.com",
    ]) {
      expect(browserUrl(bad)).toBeNull();
    }
  });

  it("refuses credentials in the address, words, and nothing", () => {
    expect(browserUrl("http://user:pass@localhost:3000/")).toBeNull();
    expect(browserUrl("how do I center a div")).toBeNull();
    expect(browserUrl("hello")).toBeNull();
    expect(browserUrl("")).toBeNull();
    expect(browserUrl("http://")).toBeNull();
    expect(browserUrl("http://exa\nmple.com")).toBeNull();
    expect(browserUrl(42)).toBeNull();
    expect(browserUrl("https://example.com/" + "a".repeat(9000))).toBeNull();
  });
});

describe("browserTitle and browserLabel", () => {
  it("keeps a title to one line, cut", () => {
    expect(browserTitle("  Two\n lines\t ")).toBe("Two lines");
    expect(browserTitle("x".repeat(400)).length).toBe(BROWSER_TITLE_MAX);
    expect(browserTitle(null)).toBe("");
  });

  it("labels by title, then host, then New tab", () => {
    expect(browserLabel({ url: "http://localhost:3000/a", title: "Checkout" })).toBe("Checkout");
    expect(browserLabel({ url: "http://localhost:3000/a", title: "" })).toBe("localhost:3000");
    expect(browserLabel({ url: "https://example.com/", title: "" })).toBe("example.com");
    expect(browserLabel({ url: "about:blank", title: "" })).toBe("New tab");
  });
});
