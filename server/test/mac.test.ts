/**
 * What the "This Mac" chip says (`shared/mac.ts`): the share of the cores,
 * memory in Activity Monitor's parts, who a process is filed under, and the
 * words for all three. The readings are from a real Mac on 2026-11-19, the
 * day the chip stopped saying "load 146 on 12 cores".
 */
import { describe, expect, it } from "bun:test";
import {
  appName,
  cpuShare,
  gb,
  groupConsumers,
  loadWords,
  macLine,
  macMood,
  type MacView,
  memWords,
  parseMeminfo,
  parsePressure,
  parseSwapUsed,
  parseVmMemory,
  type ProcUse,
  type QueueGates,
  simUdid,
  sortConsumers,
  toolName,
} from "../../shared/mac";
import { loadSeverity } from "../../shared/slots";
import { MacMeter } from "../src/mac";
import { parseProcRows } from "../src/proctable";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4646.
Pages active:                                 458622.
Pages inactive:                               452618.
Pages speculative:                              4614.
Pages throttled:                                   0.
Pages wired down:                             378533.
Pages purgeable:                                  98.
"Translation faults":                    11987866081.
File-backed pages:                            290274.
Anonymous pages:                              625580.
Pages stored in compressor:                  1477470.
Pages occupied by compressor:                 743181.
`;
const GB32 = 34359738368;

describe("the processors", () => {
  it("is the share of every core that was not idle between two readings", () => {
    expect(cpuShare({ idle: 1000, total: 4000 }, { idle: 1150, total: 5000 })).toBe(85);
    expect(cpuShare({ idle: 0, total: 0 }, { idle: 1000, total: 1000 })).toBe(0);
    expect(cpuShare({ idle: 0, total: 0 }, { idle: 0, total: 1000 })).toBe(100);
  });

  it("is nothing when no time passed, and never out of range", () => {
    expect(cpuShare({ idle: 5, total: 10 }, { idle: 5, total: 10 })).toBeNull();
    expect(cpuShare({ idle: 5, total: 10 }, { idle: 30, total: 20 })).toBe(0);
    expect(cpuShare({ idle: 5, total: 10 }, { idle: Number.NaN, total: 20 })).toBeNull();
  });

  it("says a load as work against cores", () => {
    expect(loadWords(146, 12)).toBe("about 12× more work than its 12 cores can run at once");
    expect(loadWords(30, 12)).toBe("about 2.5× more work than its 12 cores can run at once");
    expect(loadWords(14, 12)).toBe("a little more work than its 12 cores can run at once");
    expect(loadWords(3.2, 12)).toBe("work for about 3 of its 12 cores, and nothing waiting");
    expect(loadWords(0.2, 12)).toBe("nothing is waiting for a core");
  });
});

describe("memory", () => {
  it("reads vm_stat as Activity Monitor's parts", () => {
    const m = parseVmMemory(VM_STAT, GB32)!;
    expect(m.totalMb).toBe(32768);
    // Anonymous less purgeable, wired, and what the compressor occupies.
    expect(m.appMb).toBe(Math.round(((625580 - 98) * 16384) / 1048576));
    expect(m.wiredMb).toBe(Math.round((378533 * 16384) / 1048576));
    expect(m.compressedMb).toBe(Math.round((743181 * 16384) / 1048576));
    expect(m.usedMb).toBe(27300);
    // A Mac the old chip called "7 GB free".
    expect(gb(m.usedMb)).toBe("27");
    expect(m.cachedMb).toBe(Math.round(((290274 + 98) * 16384) / 1048576));
    expect(m.usedMb + m.cachedMb).toBeLessThanOrEqual(m.totalMb);
  });

  it("refuses what is not vm_stat, and never says more is in use than there is", () => {
    expect(parseVmMemory("no such command", GB32)).toBeNull();
    expect(parseVmMemory(VM_STAT, 0)).toBeNull();
    const small = parseVmMemory(VM_STAT, 16 * 1024 * 1048576)!;
    expect(small.usedMb).toBe(small.totalMb);
    expect(small.cachedMb).toBe(0);
  });

  it("reads the swap and the pressure sysctl prints", () => {
    expect(parseSwapUsed("total = 21504.00M  used = 19858.62M  free = 1645.38M  (encrypted)")).toBe(19859);
    expect(parseSwapUsed("total = 2,00G  used = 1,50G  free = 0,50G")).toBe(1536);
    expect(parseSwapUsed("")).toBeNull();
    expect(parsePressure("1\n")).toBe("normal");
    expect(parsePressure("2")).toBe("warn");
    expect(parsePressure("4")).toBe("critical");
    expect(parsePressure("")).toBeNull();
  });

  it("reads /proc/meminfo on a Linux node", () => {
    const m = parseMeminfo("MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    6000000 kB\nBuffers:          500000 kB\nCached:          4000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n")!;
    expect(m.totalMb).toBe(15625);
    expect(m.usedMb).toBe(9766);
    expect(m.cachedMb).toBe(4395);
    expect(m.swapMb).toBe(488);
    expect(m.pressure).toBeNull();
    expect(parseMeminfo("nothing")).toBeNull();
  });

  it("writes a figure the way the bar's others are written", () => {
    expect(gb(9779)).toBe("9.5");
    expect(gb(32768)).toBe("32");
    expect(memWords(310)).toBe("310 MB");
    expect(memWords(2355)).toBe("2.3 GB");
  });
});

describe("naming a process", () => {
  it("is the program's file, cut where its arguments start and not at a space in its path", () => {
    expect(toolName("/Library/Developer/CoreSimulator/Volumes/iOS_22F77/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 18.5.simruntime/Contents/Resources/RuntimeRoot/usr/libexec/photoanalysisd")).toBe("photoanalysisd");
    expect(toolName("/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -frontend -c /Users/me/App.swift")).toBe("swift-frontend");
    expect(toolName("/usr/bin/xcodebuild archive -scheme App")).toBe("xcodebuild");
    expect(toolName("node /x/node_modules/.bin/vite --port 5173")).toBe("node");
    expect(toolName("-zsh")).toBe("zsh");
    expect(toolName("sshd: me@ttys001")).toBe("sshd");
    expect(toolName("./node_modules/.bin/vite")).toBe("vite");
    expect(toolName("")).toBe("other");
  });

  it("calls an app's executable by its bundle", () => {
    expect(toolName("/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/131/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer")).toBe("Google Chrome Helper (Renderer)");
    expect(appName("/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/131/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer")).toBe("Google Chrome");
    expect(appName("/System/Library/Frameworks/Contacts.framework/Support/contactsd")).toBe("contactsd");
  });

  it("knows a simulator by its launchd_sim", () => {
    expect(simUdid("launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/dda1a39f-5860-49C4-A3B7-F742AFF61F74/data/var/run/launchd_bootstrap.plist")).toBe("DDA1A39F-5860-49C4-A3B7-F742AFF61F74");
    expect(simUdid("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/DDA1A39F-5860-49C4-A3B7-F742AFF61F74/data/var/run/launchd_bootstrap.plist")).toBe("DDA1A39F-5860-49C4-A3B7-F742AFF61F74");
    expect(simUdid("vim launchd_sim.md /Devices/DDA1A39F-5860-49C4-A3B7-F742AFF61F74/x")).toBeNull();
    expect(simUdid("-zsh")).toBeNull();
  });
});

const SIM = "DDA1A39F-5860-49C4-A3B7-F742AFF61F74";
/** A 12-core Mac mid-archive: an agent's build, a simulator analysing photos, contactsd spinning, Chrome idling. */
const PS = [
  "    1     0    9000    0.1 /sbin/launchd",
  "   50     1   40000    0.3 node /Applications/Kururu.app/Contents/Resources/server/ptyhostd.mjs",
  "   60     1   90000    2.0 node /x/kururu/desktop/dist/server.mjs",
  "  100    50    4000    0.0 -zsh",
  "  101   100  600000   12.0 claude --dangerously-skip-permissions",
  "  102   101   90000   40.0 /usr/bin/xcodebuild archive -scheme App",
  "  103   102  500000  150.0 /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -frontend -c /a.swift",
  "  104   102  500000  146.0 /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -frontend -c /b.swift",
  "  200    50    4000    0.0 -zsh",
  `  300     1    9000    0.5 launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/${SIM}/data/var/run/launchd_bootstrap.plist`,
  "  301   300 1500000   72.0 /Library/Developer/CoreSimulator/Volumes/iOS_22F77/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 18.5.simruntime/Contents/Resources/RuntimeRoot/usr/libexec/photoanalysisd",
  "  302   300  700000    4.0 /Users/me/Library/Developer/CoreSimulator/Devices/X/data/Containers/Bundle/Application/Y/Holapy.app/Holapy",
  "  400     1  300000  146.0 /System/Library/Frameworks/Contacts.framework/Support/contactsd",
  "  500     1  800000    3.0 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "  501   500 2500000    1.0 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/131/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer",
].join("\n");

const ROOTS = [
  { pid: 100, agentId: "a1", name: "HOL-145", workspace: "Holapy" },
  { pid: 200, agentId: "a2", name: "zsh", workspace: "kururu" },
];

function grouped(top?: number) {
  return groupConsumers(parseProcRows(PS).values(), ROOTS, {
    cores: 12,
    self: new Set([50, 60]),
    simName: (udid) => (udid === SIM ? "iPhone 16 Pro" : null),
    top,
  });
}

describe("who is using it", () => {
  it("files a process under its terminal, else its simulator, else its app", () => {
    const { top, sims } = grouped(20);
    const by = new Map(top.map((c) => [c.key, c]));
    expect(sims).toBe(1);
    const build = by.get("agent:a1")!;
    expect(build).toMatchObject({ kind: "agent", name: "HOL-145", where: "Holapy", agentId: "a1", processes: 5 });
    // (0 + 12 + 40 + 150 + 146) of one core, over twelve.
    expect(build.cpu).toBe(29);
    expect(build.what).toBe("swift-frontend ×2, xcodebuild");
    expect(build.memMb).toBe(Math.round((4000 + 600000 + 90000 + 500000 + 500000) / 1024));
    const sim = by.get(`sim:${SIM}`)!;
    expect(sim).toMatchObject({ kind: "sim", name: "iPhone 16 Pro", processes: 3 });
    expect(sim.what).toBe("photoanalysisd, Holapy");
    expect(by.get("app:contactsd")).toMatchObject({ kind: "app", cpu: 12.2, what: null });
    expect(by.get("app:Google Chrome")).toMatchObject({ processes: 2, memMb: Math.round(3300000 / 1024) });
    // The server and the pty host, which no bundle names.
    expect(by.get("app:Kururu")).toMatchObject({ processes: 2 });
    // An idle shell is a terminal too, named by what holds the most memory in it.
    expect(by.get("agent:a2")).toMatchObject({ cpu: 0, what: "zsh" });
  });

  it("sends the heaviest by processor and by memory, once each", () => {
    const { top } = grouped(2);
    expect(sortConsumers(top, "cpu").map((c) => c.key).slice(0, 2)).toEqual(["agent:a1", "app:contactsd"]);
    expect(sortConsumers(top, "mem").map((c) => c.key).slice(0, 2)).toEqual(["app:Google Chrome", `sim:${SIM}`]);
    expect(new Set(top.map((c) => c.key)).size).toBe(top.length);
    expect(top.length).toBe(4);
  });

  it("gives the nearest owner a simulator an agent booted, and survives a table that loops", () => {
    const procs: ProcUse[] = [
      { pid: 100, ppid: 1, rss: 0, cpu: 0, args: "-zsh" },
      { pid: 300, ppid: 100, rss: 0, cpu: 1, args: `launchd_sim /x/Devices/${SIM}/data/var/run/launchd_bootstrap.plist` },
      { pid: 301, ppid: 300, rss: 0, cpu: 50, args: "/x/usr/libexec/photoanalysisd" },
      { pid: 900, ppid: 901, rss: 0, cpu: 1, args: "a" },
      { pid: 901, ppid: 900, rss: 0, cpu: 1, args: "b" },
    ];
    const { top } = groupConsumers(procs, ROOTS, { cores: 10 });
    const by = new Map(top.map((c) => [c.key, c]));
    expect(by.get(`sim:${SIM}`)).toMatchObject({ name: "Simulator", processes: 2, cpu: 5.1 });
    expect(by.get("agent:a1")).toMatchObject({ processes: 1 });
    expect(by.has("app:a")).toBe(true);
  });
});

function view(over: Partial<MacView> = {}): MacView {
  const memory = { ...parseVmMemory(VM_STAT, GB32)!, swapMb: 19859, pressure: "normal" as const };
  return { cores: 12, cpu: 22, history: [20, 22], load1: 3.2, memory, sims: 1, top: grouped(20).top, ...over };
}

/** The slot queue's gates on that Mac: builds wait past twice the cores, tests past three times, and both under 4 GB to hand out. */
function gates(load1: number, freeGb = 10): QueueGates {
  return { load1, freeGb, minFreeGb: 4, buildGate: 24, maestroGate: 36 };
}

describe("what is said about it", () => {
  it("is calm in a sentence when it is", () => {
    expect(macMood(view(), gates(3.2))).toEqual({ severity: "normal", cpu: "normal", mem: "normal", word: "Calm", line: "22% of its 12 cores are in use." });
    expect(macMood(view({ cpu: 60 }), gates(3.2)).word).toBe("Working");
  });

  it("says every core is in use, and who has them, without calling it a warning", () => {
    const mood = macMood(view({ cpu: 97, load1: 13 }), gates(13));
    expect(mood.severity).toBe("normal");
    expect(mood.word).toBe("Busy");
    expect(mood.line).toBe("Every core is in use. Mostly HOL-145 and contactsd.");
  });

  it("keeps the queue's colours, and says the load as the wait it is", () => {
    const amber = macMood(view({ cpu: 99, load1: 30 }), gates(30));
    expect(amber.severity).toBe("warning");
    expect(amber.word).toBe("Very busy");
    expect(amber.line).toBe("Over the last minute there was about 2.5× more work than its 12 cores can run at once, so new builds are waiting for it to ease. Mostly HOL-145 and contactsd.");
    const red = macMood(view({ cpu: 100, load1: 146 }), gates(146));
    expect(red.severity).toBe("critical");
    expect(red.word).toBe("Overloaded");
    expect(red.line).toContain("about 12× more work than its 12 cores can run at once, so builds and tests are waiting");
  });

  it("does not call a Mac overloaded for a minute's average it has already worked off", () => {
    const mood = macMood(view({ cpu: 21, load1: 25 }), gates(25));
    expect(mood.severity).toBe("warning");
    expect(mood.word).toBe("Settling");
    expect(mood.line).toBe("21% of its 12 cores are in use now, but over the last minute there was about 2.1× more work than its 12 cores can run at once, so new builds are waiting for it to ease.");
  });

  it("is the colour loadSeverity gives while the memory pressure is normal", () => {
    for (const load1 of [1, 24, 24.5, 36, 37, 146]) {
      for (const freeGb of [0.5, 1.9, 2, 3.9, 4, 12]) {
        const g = gates(load1, freeGb);
        expect(macMood(view({ load1 }), g).severity).toBe(loadSeverity(g));
      }
    }
  });

  it("adds macOS's own word for memory, which no gate was reading", () => {
    const memory = { ...view().memory!, pressure: "warn" as const };
    const tight = macMood(view({ memory }), gates(3.2));
    expect(tight.severity).toBe("warning");
    expect(tight.word).toBe("Memory is tight");
    // Each figure on the chip wears its own part: the processors are fine here.
    expect(tight).toMatchObject({ cpu: "normal", mem: "warning" });
    expect(tight.line).toBe("22% of its 12 cores are in use. Memory is tight, with 19 GB pushed out to disk. Mostly Google Chrome and the iPhone 16 Pro simulator.");
    // Without swap worth the name, the figures say it.
    expect(macMood(view({ memory: { ...memory, swapMb: 200 } }), gates(3.2)).line).toContain("Memory is tight: 27 of 32 GB in use.");
    // Two simulators are named as a pair, and the same pair is not named twice in one line.
    const sims = view({ cpu: 99, memory, top: [
      { key: "sim:A", kind: "sim", name: "Holapy", where: null, what: null, cpu: 40, memMb: 3600, processes: 200, agentId: null },
      { key: "sim:B", kind: "sim", name: "Pasapy", where: null, what: null, cpu: 30, memMb: 3400, processes: 200, agentId: null },
    ] });
    expect(macMood(sims, gates(13)).line).toBe("Every core is in use. Mostly the Holapy and Pasapy simulators. Memory is tight, with 19 GB pushed out to disk.");
    const both = macMood(view({ cpu: 100, load1: 146, memory: { ...memory, pressure: "critical" } }), gates(146));
    expect(both.severity).toBe("critical");
    expect(both.word).toBe("Overloaded, out of memory");
    expect(macMood(view({ cpu: 100, load1: 146, memory }), gates(146)).word).toBe("Overloaded, memory is tight");
  });

  it("says the queue's own floor when that is what builds wait for", () => {
    const low = macMood(view(), gates(3.2, 3));
    expect(low.severity).toBe("warning");
    expect(low.word).toBe("Memory is low");
    expect(low.line).toContain("Memory is low, with 19 GB pushed out to disk. Builds and simulators are waiting for more of it.");
    expect(macMood(view(), gates(3.2, 1)).severity).toBe("critical");
  });

  it("is one line for Kuru in place of 'load 146 on 12 cores'", () => {
    expect(macLine(view({ cpu: 100, load1: 146 }))).toBe(
      "CPU 100% of 12 cores in use now; load 146 over the last minute, which is about 12× more work than its 12 cores can run at once; memory 27 of 32 GB in use, 19 GB swapped; 1 simulator booted",
    );
    expect(macLine(view({ memory: null, sims: 0 }))).toBe("CPU 22% of 12 cores in use now; load 3.2 over the last minute, which is work for about 3 of its 12 cores, and nothing waiting");
  });
});

describe("MacMeter", () => {
  it("forks nothing and says nothing while no window is open, and lends no stale memory", async () => {
    let said = 0;
    let at = 1_000;
    const meter = new MacMeter({ roots: () => [], self: () => new Set(), watched: () => false, changed: () => said++, now: () => at });
    await meter.see(parseProcRows(PS));
    at += 3_000;
    await meter.see(parseProcRows(PS));
    expect(said).toBe(0);
    expect(meter.view()).toBeNull();
    expect(meter.freeMb()).toBeNull();
  });

  it("reads the Mac for a window, with who is using it off the table it was handed", async () => {
    const views: MacView[] = [];
    const memory = { ...parseVmMemory(VM_STAT, GB32)!, swapMb: 0, pressure: "normal" as const };
    const meter = new MacMeter({ roots: () => ROOTS, self: () => new Set([50, 60]), watched: () => true, changed: (v) => views.push(v), memory: () => memory });
    await meter.see(parseProcRows(PS));
    const seen = views.at(-1)!;
    expect(seen.cores).toBeGreaterThan(0);
    expect(seen.cpu).toBeGreaterThanOrEqual(0);
    expect(seen.cpu).toBeLessThanOrEqual(100);
    expect(seen.sims).toBe(1);
    expect(seen.top.some((c) => c.key === "agent:a1")).toBe(true);
    expect(seen.memory).toBe(memory);
    expect(meter.view()).toBe(seen);
  });
});
