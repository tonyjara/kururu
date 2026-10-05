import { describe, expect, it } from "bun:test";

import {
  adoptVpsList,
  formatBytes,
  parseVpsSample,
  validHost,
  validPanel,
  VPS_SEP,
} from "../../shared/vps";

/** What the script printed on a real two-core Dokploy box, the second cpu line a second on. */
const SAMPLE = [
  "cpu  22898 1260 23485 3841499 1777 0 2487 2013 0 0",
  ["MemTotal:        8131476 kB", "MemAvailable:    6379064 kB"].join("\n"),
  "/dev/sda1        100476656 13246084  87214188      14% /",
  // 200 jiffies later, 50 of them busy.
  "cpu  22928 1260 23500 3841649 1777 0 2492 2013 0 0",
].join(`\n${VPS_SEP}\n`);

describe("parseVpsSample", () => {
  const r = parseVpsSample(SAMPLE, 1);

  it("reads cpu as a rate between the two lines, not as the counters since boot", () => {
    expect(r.cpu).toBeCloseTo(25, 5);
  });

  it("counts memory as total minus available", () => {
    expect(r.mem).toEqual({ used: (8131476 - 6379064) * 1024, total: 8131476 * 1024 });
  });

  it("takes the disk total as used plus available, the way df's percentage does", () => {
    expect(r.disk).toEqual({ used: 13246084 * 1024, total: (13246084 + 87214188) * 1024 });
  });

  it("survives a truncated run", () => {
    const partial = parseVpsSample(SAMPLE.split(VPS_SEP).slice(0, 2).join(VPS_SEP), 1);
    expect(partial.cpu).toBeNull();
    expect(partial.disk).toBeNull();
    expect(partial.mem).toEqual(r.mem);
  });
});

describe("validHost", () => {
  it("takes an alias, a user@host and an address", () => {
    for (const host of ["my-vps", "root@203.0.113.7", "db.example.com", "deploy_user@box"]) {
      expect(validHost(host)).toBe(true);
    }
  });

  it("refuses anything ssh could read as an option or a shell could read at all", () => {
    for (const host of ["-oProxyCommand=touch x", "a b", "a;b", "", "@host", "user@", "a@b@c", "$(id)", 3]) {
      expect(validHost(host)).toBe(false);
    }
  });
});

describe("validPanel", () => {
  it("keeps http(s) and refuses the rest", () => {
    expect(validPanel("https://dp.example.com")).toBe("https://dp.example.com/");
    expect(validPanel("javascript:alert(1)")).toBeNull();
    expect(validPanel("not a url")).toBeNull();
    expect(validPanel("")).toBeNull();
  });
});

describe("adoptVpsList", () => {
  it("drops entries whose host would not be run, and duplicate ids", () => {
    const list = adoptVpsList([
      { id: "a", name: "one", host: "vps", panel: "ftp://x" },
      { id: "a", name: "dup", host: "vps2" },
      { id: "b", host: "-oFoo" },
      { id: "c", name: "  ", host: "root@vps" },
      null,
    ]);
    expect(list).toEqual([
      { id: "a", name: "one", host: "vps", panel: null },
      { id: "c", name: "root@vps", host: "root@vps", panel: null },
    ]);
    expect(adoptVpsList("nope")).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("prints sizes the way free -h does", () => {
    expect(formatBytes(8131476 * 1024)).toBe("7.8G");
    expect(formatBytes(512)).toBe("512B");
  });
});
