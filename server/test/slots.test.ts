/**
 * The slot queue: who may take a lane now, which simulator a project lends,
 * what the machine readings say, and the queue held by the server — a take,
 * a grant, a lease that ends with its agent.
 *
 * The rule's cases are the script's: its lanes, widths and gates are kept so
 * a brief written for `ios-q` reads the same, and these are the behaviours
 * an agent relies on — one build at a time, a Maestro run never on another
 * agent's simulator but always on its own, the load closing a lane for
 * everyone in it at once, the user's priority going first.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptSlotSettings,
  adoptSlotState,
  admission,
  agentSlotLines,
  briefFor,
  decide,
  DEFAULT_BRIEF,
  DEFAULT_SLOT_SETTINGS,
  emptySlotState,
  fmtDur,
  loadSeverity,
  longWaits,
  parseDuration,
  parseSimctlList,
  parseVmStat,
  pickPort,
  planSim,
  poolOf,
  type Lease,
  type Reading,
  type Simulator,
  type SlotState,
  type SlotsView,
  sortedWaiters,
  type Waiter,
  waitLine,
} from "../../shared/slots";
import { Slots, type SimRow } from "../src/slots";

const calm: Reading = { load1: 1, cores: 12, freeMb: 16_000, booted: 1 };
const S = DEFAULT_SLOT_SETTINGS;

function waiter(id: string, lane: Waiter["lane"], over: Partial<Waiter> = {}): Waiter {
  return {
    id,
    lane,
    who: id.toUpperCase(),
    why: "why",
    holder: { agentId: `a-${id}`, pid: null, pstart: null },
    cliPid: null,
    since: 0,
    seq: Number(id.replace(/\D/g, "")) || 1,
    seen: 0,
    udid: null,
    root: null,
    maxMs: 60_000,
    noBoot: false,
    ...over,
  };
}

function lease(id: string, lane: Lease["lane"], over: Partial<Lease> = {}): Lease {
  return {
    id,
    lane,
    who: id.toUpperCase(),
    why: "held",
    holder: { agentId: `a-${id}`, pid: null, pstart: null },
    since: 0,
    until: 60 * 60_000,
    udid: null,
    port: null,
    project: null,
    name: null,
    root: null,
    ...over,
  };
}

function state(leases: Lease[], waiters: Waiter[], priority: Record<string, number> = {}): SlotState {
  return { ...emptySlotState(), leases, waiters, priority };
}

describe("who goes next", () => {
  it("grants the front of a free lane, and holds the next one behind a full one", () => {
    const w1 = waiter("w1", "build");
    const w2 = waiter("w2", "build", { seq: 2 });
    expect(decide(state([], [w1, w2]), w1, calm, S, 0).ok).toBe(true);
    const behind = decide(state([], [w1, w2]), w2, calm, S, 0);
    expect(behind).toMatchObject({ ok: false, place: 2, ahead: ["W1"], reason: "lane is full (width 1)" });
    const held = decide(state([lease("l1", "build")], [w1]), w1, calm, S, 30_000);
    expect(held.ok).toBe(false);
    expect(held.holders).toEqual(['L1 "held" (30s of 1h00m)']);
  });

  it("lets two Maestro runs go at once, never two on one simulator", () => {
    const a = waiter("w1", "maestro", { udid: "U1" });
    const b = waiter("w2", "maestro", { udid: "U1", seq: 2 });
    const c = waiter("w3", "maestro", { udid: "U2", seq: 3 });
    const st = state([], [a, b, c]);
    expect(decide(st, a, calm, S, 0).ok).toBe(true);
    // The second on U1 is held by the first, which does not use up a place for the third.
    expect(decide(st, b, calm, S, 0)).toMatchObject({ ok: false, reason: "simulator U1 is in use" });
    expect(decide(st, c, calm, S, 0).ok).toBe(true);
  });

  it("keeps another agent's simulator from a Maestro run, and never its own", () => {
    const mine = lease("s1", "sim", { udid: "U1", holder: { agentId: "a-w1", pid: null, pstart: null } });
    const theirs = lease("s2", "sim", { udid: "U2", who: "OTHER" });
    const a = waiter("w1", "maestro", { udid: "U1" });
    const b = waiter("w1", "maestro", { udid: "U2" });
    expect(decide(state([mine, theirs], [a]), a, calm, S, 0).ok).toBe(true);
    expect(decide(state([mine, theirs], [b]), b, calm, S, 0)).toMatchObject({ ok: false, reason: "simulator U2 is lent to OTHER" });
  });

  it("closes a lane while the load is high, and lets the user's priority through", () => {
    const busy: Reading = { ...calm, load1: 30 };
    const w1 = waiter("w1", "build");
    expect(decide(state([], [w1]), w1, busy, S, 0)).toMatchObject({ ok: false, reason: "load 30 is over 24 (2x 12 cores)" });
    expect(decide(state([], [w1], { W1: 10 }), w1, busy, S, 0).ok).toBe(true);
    // Maestro's gate is four times the cores.
    const m = waiter("w2", "maestro");
    expect(decide(state([], [m]), m, busy, S, 0).ok).toBe(true);
    // The phone has no gate at all.
    const d = waiter("w3", "device");
    expect(decide(state([], [d]), d, { ...calm, load1: 999, freeMb: 10 }, S, 0).ok).toBe(true);
  });

  it("never lets a priority past the memory floor", () => {
    const w1 = waiter("w1", "build");
    const low: Reading = { ...calm, freeMb: 2048 };
    expect(decide(state([], [w1], { W1: 10 }), w1, low, S, 0)).toMatchObject({ ok: false, reason: "free memory 2.0 GB is under 4 GB" });
  });

  it("puts the user's priority at the front, by its who or by its agent, until it runs out", () => {
    const st = state([], [waiter("w1", "build"), waiter("w2", "build", { seq: 2 }), waiter("w3", "build", { seq: 3 })], { "agent:a-w3": 100 });
    expect(sortedWaiters(st, "build", 50).map((w) => w.id)).toEqual(["w3", "w1", "w2"]);
    expect(sortedWaiters(st, "build", 150).map((w) => w.id)).toEqual(["w1", "w2", "w3"]);
  });

  it("refuses a boot over the booted ceiling, one more when the user waits", () => {
    const full: Reading = { ...calm, booted: 3 };
    expect(admission("boot", false, full, S)).toContain("3 simulators are booted (at most 3; 4 when the user is waiting)");
    expect(admission("boot", true, full, S)).toBeNull();
    expect(admission("boot", true, { ...full, booted: 4 }, S)).not.toBeNull();
  });

  it("keeps two builds of one copy apart when the lane is wider than one", () => {
    const wide = { ...S, widths: { ...S.widths, build: 2 } };
    const w1 = waiter("w1", "build", { root: "/r" });
    const st = state([lease("l1", "build", { root: "/r" })], [w1]);
    expect(decide(st, w1, calm, wide, 0).reason).toContain("two builds must not share one DerivedData");
    expect(decide({ ...st, waiters: [{ ...w1, root: "/other" }] }, { ...w1, root: "/other" }, calm, wide, 0).ok).toBe(true);
  });
});

describe("simulators", () => {
  const sims: Simulator[] = [
    { udid: "B", name: "Acme B", state: "Shutdown", runtime: "r" },
    { udid: "A", name: "Acme", state: "Booted", runtime: "r" },
    { udid: "X", name: "Acme Tablet", state: "Booted", runtime: "r" },
    { udid: "O", name: "Other", state: "Booted", runtime: "r" },
  ];

  it("finds a project's pool by name, in lending order", () => {
    expect(poolOf(sims, "acme", "exact").map((s) => s.udid)).toEqual(["A", "B"]);
    expect(poolOf(sims, "Acme", "prefix").map((s) => s.udid)).toEqual(["A", "B", "X"]);
    expect(poolOf(sims, "none", "exact")).toEqual([]);
  });

  it("lends the booted one, boots the next for the waiter nothing is left for, and waits behind a boot", () => {
    const pool = poolOf(sims, "Acme", "exact");
    const w1 = waiter("w1", "sim:Acme");
    const w2 = waiter("w2", "sim:Acme", { seq: 2 });
    const st = state([], [w1, w2]);
    expect(planSim(st, w1, pool, calm, S, 0)).toMatchObject({ kind: "lend", sim: { udid: "A" } });
    expect(planSim(st, w2, pool, calm, S, 0)).toMatchObject({ kind: "boot", sim: { udid: "B" } });
    const lent = state([lease("s1", "sim", { udid: "A" })], [w2]);
    expect(planSim(lent, w2, pool, calm, S, 0)).toMatchObject({ kind: "boot", sim: { udid: "B" } });
    const booting = state([lease("s1", "sim", { udid: "A" }), lease("b1", "boot", { udid: "B" })], [w2]);
    expect(planSim(booting, w2, pool, calm, S, 0)).toMatchObject({ kind: "wait", reason: "a simulator is booting" });
    expect(planSim(lent, { ...w2, noBoot: true }, pool, calm, S, 0)).toMatchObject({ kind: "wait", reason: "every 'Acme' simulator is lent out" });
    expect(planSim(state([], [w1]), w1, [], calm, S, 0)).toEqual({ kind: "none" });
  });

  it("will not boot past the ceiling", () => {
    const pool = poolOf(sims, "Acme", "exact");
    const w = waiter("w1", "sim:Acme");
    const plan = planSim(state([lease("s1", "sim", { udid: "A" })], [w]), w, pool, { ...calm, booted: 3 }, S, 0);
    expect(plan.kind).toBe("wait");
  });

  it("reads simctl's JSON, leaving out what is not available", () => {
    const text = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-27-1": [
          { udid: "U1", name: "Acme (2)", state: "Booted", isAvailable: true },
          { udid: "U2", name: "Gone", state: "Shutdown", isAvailable: false },
        ],
      },
    });
    expect(parseSimctlList(text)).toEqual([{ udid: "U1", name: "Acme (2)", state: "Booted", runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-1" }]);
    expect(parseSimctlList("xcrun: error")).toEqual([]);
  });

  it("hands out Metro ports past the base, around the ones held and the ones listening", () => {
    const st = state([lease("s1", "sim", { port: 8082 })], []);
    expect(pickPort(st, 8081, new Set([8083]))).toBe(8084);
    expect(pickPort(emptySlotState(), 8081, new Set())).toBe(8082);
  });
});

describe("readings and words", () => {
  it("adds up the pages macOS hands out without swapping", () => {
    const text = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            500000.
Pages inactive:                           20000.
Pages speculative:                         3000.
Pages purgeable:                           1000.
`;
    expect(parseVmStat(text)).toBe(Math.floor((34_000 * 16384) / 1048576));
    expect(parseVmStat("nothing")).toBeNull();
  });

  it("reads durations the way the script took them", () => {
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("15")).toBe(15 * 60_000);
    expect(parseDuration("soon")).toBeNull();
    expect(fmtDur(3_725_000)).toBe("1h02m");
  });

  it("says a wait the way the script said it", () => {
    expect(waitLine("build", 2, ["P2"], ['P1 "dev client" (3m of 1h00m)'], "lane is full (width 1)", 125_000)).toBe(
      'waiting for build, 2nd in line behind P2; held by P1 "dev client" (3m of 1h00m). Why: lane is full (width 1). Waiting 2m.',
    );
    expect(waitLine("sim:Acme", 1, [], [], "", 0)).toContain("waiting for a 'Acme' simulator, 1st in line");
  });

  it("keeps settings that make sense and defaults the rest", () => {
    const got = adoptSlotSettings({ widths: { build: 2, maestro: 0 }, load: { heavy: null, build: Number.NaN }, minFreeGb: -1, bootedMax: 5, simMatch: "prefix" });
    expect(got.widths).toEqual({ ...S.widths, build: 2 });
    expect(got.load).toEqual({ ...S.load, heavy: null });
    expect(got.minFreeGb).toBe(4);
    expect(got.bootedMax).toBe(5);
    expect(got.bootedMaxPriority).toBe(5);
    expect(got.simMatch).toBe("prefix");
    expect(adoptSlotSettings("nonsense")).toEqual(S);
  });

  it("drops a state record that does not hold together", () => {
    const got = adoptSlotState({
      seq: 4,
      leases: [lease("build.1", "build"), { id: "x", lane: "nope", holder: { pid: 5 }, since: 0, until: 1 }, { id: "y", lane: "build", since: 0, until: 1 }],
      waiters: [waiter("w1", "sim:Acme"), { ...waiter("w2", "build"), since: "then" }],
      priority: { P5: 99, bad: "x" },
      sweptOn: "2026-11-02",
    });
    expect(got.leases.map((l) => l.id)).toEqual(["build.1"]);
    expect(got.waiters.map((w) => w.id)).toEqual(["w1"]);
    expect(got.priority).toEqual({ P5: 99 });
    expect(got.sweptOn).toBe("2026-11-02");
    expect(adoptSlotState(null)).toEqual(emptySlotState());
  });

  const view: SlotsView = {
    load1: 30,
    cores: 12,
    freeGb: 10,
    booted: 2,
    buildGate: 24,
    maestroGate: 48,
    minFreeGb: 4,
    bootedMax: 3,
    leases: [{ id: "build.1", lane: "build", who: "P2", why: "dev client", agentId: "a2", since: 0, until: 3_600_000, udid: null, port: null, name: null }],
    waiting: [
      { id: "w1", lane: "build", who: "P5", why: "smoke", agentId: "a5", since: 0, place: 1, ahead: [], reason: "lane is full", long: true, priority: false },
      { id: "w2", lane: "maestro", who: "P6", why: "x", agentId: "a6", since: 0, place: 1, ahead: [], reason: "", long: false, priority: false },
    ],
    priority: [],
  };

  it("colours the load by the queue's own gates", () => {
    expect(loadSeverity(view)).toBe("warning");
    expect(loadSeverity({ ...view, load1: 50 })).toBe("critical");
    expect(loadSeverity({ ...view, load1: 3 })).toBe("normal");
    expect(loadSeverity({ ...view, load1: 3, freeGb: 1 })).toBe("critical");
  });

  it("hands Needs only the waits past ten minutes", () => {
    expect([...longWaits(view).entries()]).toEqual([["a5", { lane: "build", since: 0, reason: "lane is full" }]]);
    expect(longWaits(null).size).toBe(0);
  });

  it("says what a pane's agents hold and wait for", () => {
    expect(agentSlotLines(view, new Set(["a5", "a2"]), 14 * 60_000)).toEqual(["P5 · waiting for build behind P2 (14m in)", "P2 · build (14m of 1h00m)"]);
    expect(agentSlotLines(view, new Set(["zz"]), 0)).toEqual([]);
  });

  it("fills the command into the brief, and the default names no project", () => {
    const brief = briefFor(DEFAULT_BRIEF, "/s/bin/slot");
    expect(brief).toContain("/s/bin/slot run build");
    expect(brief).not.toContain("{slot}");
  });
});

// ---------------------------------------------------------------------------
// The queue the server holds
// ---------------------------------------------------------------------------

describe("the server's queue", () => {
  let dir: string;
  let alive: Set<string>;
  let views: SlotsView[];
  let slots: Slots;
  const pool = new Map<string, SimRow>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "slots-test-"));
    alive = new Set(["a1", "a2"]);
    views = [];
    pool.clear();
    slots = new Slots(
      {
        agentAlive: (id) => alive.has(id),
        whoOf: (id) => `CARD-${id}`,
        changed: (view) => views.push(view),
        watched: () => false,
        store: { simPool: () => [...pool.values()], putSim: (row) => pool.set(row.udid, row), dropSim: (udid) => pool.delete(udid) },
        reading: () => ({ load1: 1, freeMb: 16_000, cores: 12 }),
      },
      { state: join(dir, "slots.json"), settings: join(dir, "none.json"), log: join(dir, "slots.log") },
    );
  });

  afterEach(() => {
    slots.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const take = (agentId: string, lane: "build" | "maestro" = "build", over: Record<string, unknown> = {}) => ({
    kind: "take" as const,
    lane,
    project: null,
    who: null,
    why: "a build",
    maxMs: 0,
    udid: null,
    root: null,
    holder: { agentId, pid: null, pstart: null },
    cliPid: null,
    waiter: null,
    noBoot: false,
    ...over,
  });

  it("grants a free lane at once, names it after the card, and ends the lease when the agent exits", async () => {
    const got = await slots.take(take("a1"), new AbortController().signal);
    expect(got.state).toBe("granted");
    if (got.state !== "granted") return;
    expect(got.lease.who).toBe("CARD-a1");
    expect(got.lease.until - got.lease.since).toBe(60 * 60_000);
    expect(slots.view().leases.map((l) => l.id)).toEqual([got.lease.id]);
    alive.delete("a1");
    slots.onAgents();
    expect(slots.view().leases).toEqual([]);
  });

  /** A take as the CLI makes it: the first ask answered at once, then asked again with the waiter's id and held. */
  async function queueUp(agentId: string): Promise<{ held: ReturnType<Slots["take"]> }> {
    const first = await slots.take(take(agentId), new AbortController().signal);
    if (first.state !== "waiting") throw new Error(`expected to wait, got ${first.state}`);
    const held = slots.take({ ...take(agentId), waiter: first.waiter }, new AbortController().signal);
    await Bun.sleep(5);
    return { held };
  }

  it("answers a new waiter's first ask at once, with its place", async () => {
    await slots.take(take("a1"), new AbortController().signal);
    const t0 = Date.now();
    const first = await slots.take(take("a2"), new AbortController().signal);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(first).toMatchObject({ state: "waiting", place: 1 });
    if (first.state === "waiting") expect(first.line).toContain("waiting for build, 1st in line; held by CARD-a1");
  });

  it("holds the second taker until the first releases, then hands it over", async () => {
    const first = await slots.take(take("a1"), new AbortController().signal);
    const { held: second } = await queueUp("a2");
    expect(slots.view().waiting.map((w) => w.who)).toEqual(["CARD-a2"]);
    if (first.state !== "granted") throw new Error("not granted");
    expect(slots.release({ lease: first.lease.id, lane: null, who: null, anyHolder: false, holder: { agentId: "a1", pid: null, pstart: null } })).toHaveLength(1);
    const got = await second;
    expect(got.state).toBe("granted");
  });

  it("answers a waiter whose terminal has gone, and refuses a holder that is not running", async () => {
    await slots.take(take("a1"), new AbortController().signal);
    const { held: waiting } = await queueUp("a2");
    alive.delete("a2");
    slots.onAgents();
    expect((await waiting).state).toBe("failed");
    await expect(slots.take(take("zz"), new AbortController().signal)).rejects.toThrow("is not running");
  });

  it("keeps the line across a restart, on disk", async () => {
    await slots.take(take("a1"), new AbortController().signal);
    const answer = await slots.take(take("a2"), new AbortController().signal);
    expect(answer.state).toBe("waiting");
    slots.stop();
    const again = new Slots(
      { agentAlive: (id) => alive.has(id), whoOf: (id) => id, changed: () => {}, watched: () => false, store: null },
      { state: join(dir, "slots.json"), settings: join(dir, "none.json"), log: join(dir, "slots.log") },
    );
    const v = again.view();
    expect(v.leases.map((l) => l.who)).toEqual(["CARD-a1"]);
    expect(v.waiting.map((w) => w.who)).toEqual(["CARD-a2"]);
    again.stop();
  });

  it("releases only the caller's own leases, by its terminal even when two share a pid", async () => {
    const one = { agentId: "a1", pid: 4242, pstart: null };
    const two = { agentId: "a2", pid: 4242, pstart: null };
    alive.add("a1");
    await slots.take({ ...take("a1", "maestro"), holder: { ...one, pid: process.pid } }, new AbortController().signal);
    await slots.take({ ...take("a2", "maestro"), holder: { ...two, pid: process.pid } }, new AbortController().signal);
    expect(slots.release({ lease: null, lane: "maestro", who: null, anyHolder: false, holder: { ...one, pid: process.pid } })).toHaveLength(1);
    expect(slots.view().leases.map((l) => l.agentId)).toEqual(["a2"]);
  });

  it("says nothing to Kuru about an empty queue, and names agents when there is one", async () => {
    expect(slots.statusForKuru((id) => id)).toBeNull();
    await slots.take(take("a1"), new AbortController().signal);
    expect(slots.statusForKuru((id) => `"the ${id} agent"`)).toContain(`"the a1 agent" (as CARD-a1) holds build for "a build"`);
  });

  it("puts the agent the user waits on first, and answers the others when the server stops", async () => {
    await slots.take(take("a1"), new AbortController().signal);
    alive.add("a3");
    const { held: a2 } = await queueUp("a2");
    const { held: a3 } = await queueUp("a3");
    slots.prioritize("agent:a3", 60_000);
    const view = slots.view();
    expect(view.waiting.find((w) => w.agentId === "a3")?.priority).toBe(true);
    slots.release({ lease: null, lane: "build", who: null, anyHolder: false, holder: { agentId: "a1", pid: null, pstart: null } });
    expect((await a3).state).toBe("granted");
    slots.stop();
    expect((await a2).state).toBe("failed");
  });
});
