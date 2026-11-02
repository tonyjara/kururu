import { describe, expect, it } from "bun:test";
import { abbreviateHome, randomHex, shq } from "../../shared/text";

describe("shq", () => {
  it("is one argument for sh, quote and all", () => {
    expect(shq("plain")).toBe("'plain'");
    expect(shq("it's")).toBe(`'it'\\''s'`);
    expect(shq("")).toBe("''");
  });

  it("drops control characters but keeps a tab and a newline", () => {
    expect(shq("a\u001b[2Jb\rc\u0003")).toBe("'a[2Jbc'");
    expect(shq("a\tb\nc")).toBe("'a\tb\nc'");
  });
});

describe("abbreviateHome", () => {
  it("writes the home as ~, and only the home", () => {
    expect(abbreviateHome("/Users/me", "/Users/me")).toBe("~");
    expect(abbreviateHome("/Users/me/Projects/x", "/Users/me")).toBe("~/Projects/x");
    expect(abbreviateHome("/Users/meg/x", "/Users/me")).toBe("/Users/meg/x");
    expect(abbreviateHome("/opt/x", "/Users/me")).toBe("/opt/x");
    expect(abbreviateHome("/opt/x", "")).toBe("/opt/x");
  });
});

describe("randomHex", () => {
  it("is twice as many lowercase hex digits as bytes, and not the same twice", () => {
    expect(randomHex(6)).toMatch(/^[0-9a-f]{12}$/);
    expect(randomHex(6)).not.toBe(randomHex(6));
  });
});
