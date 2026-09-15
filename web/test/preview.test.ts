import { describe, expect, test } from "bun:test";
import type { DevServer } from "../../shared/wire";
import { isLoopback, previewLabel, previewUrl } from "../src/preview";

const dev = (over: Partial<DevServer> = {}): DevServer => ({
  port: 5173,
  pid: 1234,
  command: "vite",
  program: "vite",
  ...over,
});

describe("previewUrl", () => {
  test("goes straight to the dev port on the desktop, proxy or no proxy", () => {
    const origin = { protocol: "http:", hostname: "127.0.0.1" };
    expect(previewUrl(origin, dev())).toBe("http://localhost:5173/");
    expect(previewUrl(origin, dev({ proxyPort: 7800 }))).toBe("http://localhost:5173/");
  });

  test("uses the host the client itself reached kururu by", () => {
    const url = previewUrl({ protocol: "http:", hostname: "100.64.1.2" }, dev({ proxyPort: 7801 }));
    expect(url).toBe("http://100.64.1.2:7801/");
  });

  test("carries the page's own protocol across", () => {
    const url = previewUrl({ protocol: "https:", hostname: "mac.ts.net" }, dev({ proxyPort: 7800 }));
    expect(url).toBe("https://mac.ts.net:7800/");
  });

  /**
   * The one that matters most. An anchor to the dev port from a phone reaches
   * the phone's own localhost, so "no proxy yet" has to be a refusal rather
   * than a best effort.
   */
  test("refuses rather than pointing a remote client at its own localhost", () => {
    expect(previewUrl({ protocol: "http:", hostname: "100.64.1.2" }, dev())).toBeNull();
  });

  test("knows every spelling of this machine", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]) {
      expect(isLoopback(host)).toBe(true);
    }
    expect(isLoopback("100.64.1.2")).toBe(false);
    expect(isLoopback("mac.ts.net")).toBe(false);
  });
});

describe("previewLabel", () => {
  test("names the project when the cwd was readable, the program when it was not", () => {
    expect(previewLabel(dev({ cwd: "/Users/n/Desktop/Nyto/kururu" }))).toBe("kururu · vite");
    expect(previewLabel(dev({ cwd: "/Users/n/Desktop/Nyto/kururu/" }))).toBe("kururu · vite");
    expect(previewLabel(dev())).toBe("vite");
  });
});
