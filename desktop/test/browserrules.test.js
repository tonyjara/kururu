/**
 * The browser's rules. The block on kururu's ports is the one thing between a
 * page in the browser and the agents, so each way a page could name this Mac
 * is tried here, and so is the other side of it: another machine's dev server
 * on the same port, which must load.
 */
import { describe, expect, it } from "bun:test";
import {
  allowedAddress,
  cleanUserAgent,
  downloadPath,
  judgeRequest,
  ownHosts,
  quarantineValue,
  resolvesHere,
} from "../browserrules.js";

const own = ownHosts(
  { lo0: [{ address: "127.0.0.1" }, { address: "::1" }], en0: [{ address: "192.168.1.20" }], utun4: [{ address: "100.101.102.103" }] },
  "Tonys-Mac.local",
);
const rules = { ports: new Set([7717, 5173]), own };

describe("judgeRequest", () => {
  it("blocks kururu's ports on every name for this Mac", () => {
    for (const url of [
      "ws://127.0.0.1:7717/ws",
      "http://localhost:7717/api/health",
      "http://LOCALHOST:7717/",
      "http://[::1]:7717/",
      "http://0.0.0.0:7717/",
      "http://127.1.2.3:7717/",
      "http://app.localhost:7717/",
      "http://[::ffff:7f00:1]:7717/",
      "http://localhost:7800/",
      "http://127.0.0.1:7999/x",
      "http://localhost:5173/@vite/client",
      "wss://localhost:7717/ws",
      "http://192.168.1.20:7717/",
      "http://100.101.102.103:7800/",
      "http://tonys-mac.local:7717/",
      "http://Tonys-Mac:7717/",
    ]) {
      expect([url, judgeRequest(url, rules)]).toEqual([url, "block"]);
    }
  });

  it("lets every other port through without a lookup", () => {
    for (const url of ["http://localhost:3000/", "http://127.0.0.1:5174/", "https://example.com/", "http://localhost:8000/", "http://localhost:7716/"]) {
      expect(judgeRequest(url, rules)).toBe("allow");
    }
  });

  it("lets another machine's address on kururu's ports through", () => {
    expect(judgeRequest("http://192.168.1.44:5173/", rules)).toBe("allow");
    expect(judgeRequest("http://[2001:db8::1]:7717/", rules)).toBe("allow");
  });

  it("asks for a lookup for any other name on kururu's ports", () => {
    expect(judgeRequest("http://127.0.0.1.nip.io:7717/ws", rules)).toBe("resolve");
    expect(judgeRequest("http://box.tailnet.ts.net:5173/", rules)).toBe("resolve");
  });

  it("does not look at what is not http or ws", () => {
    expect(judgeRequest("data:text/plain,hi", rules)).toBe("allow");
    expect(judgeRequest("not a url", rules)).toBe("allow");
  });

  it("blocks a name that resolves to this Mac, and not one that does not", () => {
    expect(resolvesHere(["127.0.0.1"], own)).toBe(true);
    expect(resolvesHere(["93.184.216.34", "100.101.102.103"], own)).toBe(true);
    expect(resolvesHere(["93.184.216.34"], own)).toBe(false);
  });
});

describe("allowedAddress", () => {
  it("holds the top of a tab to http, https and about:blank", () => {
    expect(allowedAddress("https://example.com/", { top: true })).toBe(true);
    expect(allowedAddress("http://localhost:3000/", { top: true })).toBe(true);
    expect(allowedAddress("about:blank", { top: true })).toBe(true);
    for (const bad of ["file:///etc/passwd", "data:text/html,x", "blob:https://e.com/1", "javascript:1", "chrome://gpu", "devtools://x", "about:srcdoc", "x-apple.systempreferences:", "vscode://file/etc"]) {
      expect([bad, allowedAddress(bad, { top: true })]).toEqual([bad, false]);
    }
  });

  it("lets a frame be the opaque schemes pages build frames of, and never the disk", () => {
    expect(allowedAddress("about:srcdoc", { top: false })).toBe(true);
    expect(allowedAddress("data:text/html,x", { top: false })).toBe(true);
    expect(allowedAddress("blob:https://e.com/1", { top: false })).toBe(true);
    expect(allowedAddress("file:///etc/passwd", { top: false })).toBe(false);
    expect(allowedAddress("chrome://gpu", { top: false })).toBe(false);
    expect(allowedAddress("javascript:1", { top: false })).toBe(false);
  });
});

describe("downloadPath", () => {
  const taken = (names) => (path) => names.some((name) => path === `/d/${name}`);

  it("keeps a free name and numbers a taken one, never overwriting", () => {
    expect(downloadPath("/d", "report.pdf", taken([]))).toBe("/d/report.pdf");
    expect(downloadPath("/d", "report.pdf", taken(["report.pdf"]))).toBe("/d/report (1).pdf");
    expect(downloadPath("/d", "report.pdf", taken(["report.pdf", "report (1).pdf"]))).toBe("/d/report (2).pdf");
    expect(downloadPath("/d", "archive.tar.gz", taken(["archive.tar.gz"]))).toBe("/d/archive.tar (1).gz");
  });

  it("keeps a page's name inside the folder", () => {
    expect(downloadPath("/d", "../../.zshrc", taken([]))).toBe("/d/.zshrc");
    expect(downloadPath("/d", "a\\b\\evil.sh", taken([]))).toBe("/d/evil.sh");
    expect(downloadPath("/d", "..", taken([]))).toBe("/d/download");
    expect(downloadPath("/d", "", taken([]))).toBe("/d/download");
  });
});

describe("the user agent and the quarantine flag", () => {
  it("drops Electron's and the app's words and keeps Chrome's", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Kururu/0.6.0 Chrome/140.0.0.0 Electron/44.3.0 Safari/537.36";
    const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
    expect(cleanUserAgent(ua)).toBe(chrome);
    expect(cleanUserAgent(ua.replace("Kururu/0.6.0", "@kururu/desktop/0.6.0"))).toBe(chrome);
    expect(cleanUserAgent(chrome)).toBe(chrome);
  });

  it("writes the flag in xattr's shape", () => {
    expect(quarantineValue(0x65000000 * 1000)).toBe("0083;65000000;Kururu;");
  });
});
