/**
 * The clock under a fake one: a real database file, and terminals that are
 * only records. What the plan's phase 1 is done by — a shell automation
 * fires on time and never early, a slot is fired once with two servers on
 * one file, a missed slot inside and outside its window does what `decide`
 * says, a run found again after a restart carries on and one whose terminal
 * went is interrupted, and an agent's run ends on its result line.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSnapshot } from "../../shared/model";
import { Automations, type AutomationDeps } from "../src/automations";
import { Store } from "../src/store";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-clock-"));
  path = join(dir, "kururu.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A world of terminals and a clock, shared by every server in a test, as one host and one wall clock are. */
function world(start: number) {
  const agents = new Map<string, AgentSnapshot>();
  const told: string[] = [];
  const notified: string[] = [];
  const opened: { command: string; cwd: string; kind: string }[] = [];
  const ended: string[] = [];
  const replies = new Map<string, string>();
  let n = 0;
  const clock = { now: start };
  const deps = (store: Store): AutomationDeps => ({
    store,
    clock: true,
    home: () => "mac",
    find: (id) => agents.get(id),
    profileIdOf: (key) => (key === "pk" ? "p1" : null),
    workspaceOf: (_profileId, key) => (key === "wk" ? { id: "w1", name: "Pasapy" } : null),
    folderOf: async () => dir,
    agentLine: async (launcher) => `${launcher.cli} --model ${launcher.model}`,
    open: async (_p, _w, options) => {
      opened.push(options);
      const id = `a${++n}`;
      agents.set(id, { id, command: options.command, status: "idle", exited: false } as unknown as AgentSnapshot);
      return agents.get(id)!;
    },
    launched: () => undefined,
    lastReply: async (agentId) => replies.get(agentId) ?? null,
    screen: async () => null,
    whyAwake: async () => null,
    end: (id) => {
      ended.push(id);
      agents.delete(id);
    },
    activity: () => undefined,
    tell: (_p, line) => told.push(line),
    notify: (title) => notified.push(title),
    changed: () => undefined,
    resume: async () => {
      throw new Error("not here");
    },
    reveal: () => false,
    now: () => clock.now,
  });
  return { agents, told, notified, opened, ended, replies, clock, deps };
}

const SHELL = "---\nname: Tick\nschedule: every 5 minutes UTC\nrun: shell\n---\ntrue\n";
const AT = Date.parse("2026-11-10T12:00:00Z");

describe("the clock", () => {
  it("fires a five-minute shell automation on time, never early, and never twice for one slot", async () => {
    const w = world(AT + 1000);
    const store = Store.open(path);
    const clock = new Automations(w.deps(store));
    clock.save("pk", "wk", null, SHELL);
    const view = clock.view("pk")[0]!;
    expect(new Date(view.next!).toISOString()).toBe("2026-11-10T12:05:00.000Z");
    expect(view.description).toBeNull();

    w.clock.now = view.next! - 1;
    await clock.tick();
    expect(w.opened).toHaveLength(0);

    w.clock.now = view.next! + 20_000;
    await clock.tick();
    expect(w.opened).toHaveLength(1);
    expect(w.opened[0]!.kind).toBe("shell");
    expect(w.opened[0]!.command).toMatch(/^sh -c 'true'; printf/);
    await clock.tick();
    expect(w.opened).toHaveLength(1);
    expect(store.automationRuns(view.key).map((r) => [r.state, r.why])).toEqual([["running", "schedule"]]);
    expect(new Date(clock.view("pk")[0]!.next!).toISOString()).toBe("2026-11-10T12:10:00.000Z");
    store.close();
  });

  it("lets only one of two servers on one database fire a slot", async () => {
    const w = world(AT);
    const one = Store.open(path);
    const two = Store.open(path);
    const first = new Automations(w.deps(one));
    first.save("pk", "wk", null, SHELL);
    const second = new Automations(w.deps(two));
    w.clock.now = AT + 5 * 60_000 + 1000;
    await Promise.all([first.tick(), second.tick()]);
    expect(w.opened).toHaveLength(1);
    expect(one.automationRuns(first.view("pk")[0]!.key)).toHaveLength(1);
    one.close();
    two.close();
  });

  it("reads a shell run's status off its screen, and writes it ok or failed with its output", async () => {
    const w = world(AT);
    const store = Store.open(path);
    const deps = w.deps(store);
    let screen = "";
    const clock = new Automations({ ...deps, screen: async () => screen });
    const { key } = clock.save("pk", "wk", null, SHELL.replace("true", "false"));
    const { agentId } = await clock.runNow("pk", key, "you");
    const run = store.automationRuns(key)[0]!;
    expect(clock.holds(agentId!)).toBe(true);
    screen = `some output\n${run.tag} 1\n`;
    w.agents.set(agentId!, { ...w.agents.get(agentId!)!, exited: true });
    await clock.tick();
    expect(store.automationRuns(key)[0]).toMatchObject({ state: "failed", words: "it exited with status 1.", output: "some output" });
    expect(clock.holds(agentId!)).toBe(false);
    expect(w.ended).toEqual([agentId!]);
    expect(w.notified).toEqual(["Tick failed"]);
    expect(w.told[0]).toBe('[kururu] Automation "Tick" (in Pasapy) failed: it exited with status 1.');
    store.close();
  });

  it("runs a slot found late inside its window once, as a catch-up, and writes one past it missed", async () => {
    const w = world(AT);
    const store = Store.open(path);
    const clock = new Automations(w.deps(store));
    const daily = "---\nname: Daily\nschedule: every day at 09:00 UTC\nrun: shell\ncatch-up: 3h\n---\ntrue\n";
    const { key } = clock.save("pk", "wk", null, daily);
    // Asleep from before 09:00 on the 11th until 11:00: two hours late, inside three.
    w.clock.now = Date.parse("2026-11-11T11:00:00Z");
    await clock.tick();
    expect(store.automationRuns(key).map((r) => [r.state, r.why])).toEqual([["running", "catch-up"]]);
    expect(store.automationRuns(key)[0]!.words).toContain("late by 2 h");
    // End it, then sleep through the 12th's and 13th's slots, waking at 13:00 on the 13th: four hours late, past the window.
    const live = store.automationRuns(key)[0]!;
    store.updateRun(live.id, { state: "ok", endedAt: w.clock.now, closedAt: w.clock.now });
    w.agents.clear();
    w.clock.now = Date.parse("2026-11-13T13:00:00Z");
    await clock.tick();
    const latest = store.automationRuns(key)[0]!;
    expect(latest.state).toBe("missed");
    expect(new Date(latest.slotAt).toISOString()).toBe("2026-11-13T09:00:00.000Z");
    expect(latest.words).toContain("1 earlier slot went by");
    expect(w.opened).toHaveLength(1);
    expect(new Date(clock.view("pk")[0]!.next!).toISOString()).toBe("2026-11-14T09:00:00.000Z");
    store.close();
  });

  it("never stacks: a slot that comes while the last run is going is written skipped", async () => {
    const w = world(AT);
    const store = Store.open(path);
    const clock = new Automations(w.deps(store));
    const { key } = clock.save("pk", "wk", null, SHELL.replace("true", "sleep 900"));
    w.clock.now = AT + 5 * 60_000;
    await clock.tick();
    w.clock.now = AT + 10 * 60_000;
    await clock.tick();
    expect(store.automationRuns(key).map((r) => r.state)).toEqual(["skipped", "running"]);
    expect(w.opened).toHaveLength(1);
    store.close();
  });

  it("finds a run again after a restart, and writes interrupted one whose terminal went", async () => {
    const w = world(AT);
    const store = Store.open(path);
    const before = new Automations(w.deps(store));
    const { key } = before.save("pk", "wk", null, SHELL.replace("true", "sleep 120"));
    const { key: other } = before.save("pk", "wk", null, SHELL.replace("Tick", "Other").replace("true", "sleep 120"));
    const kept = await before.runNow("pk", key, "you");
    const lost = await before.runNow("pk", other, "you");
    // The server restarts; the host kept one terminal and lost the other.
    w.agents.delete(lost.agentId!);
    const after = new Automations(w.deps(store));
    await after.start();
    after.stop();
    expect(store.automationRuns(key)[0]!.state).toBe("running");
    expect(after.holds(kept.agentId!)).toBe(true);
    expect(store.automationRuns(other)[0]).toMatchObject({ state: "interrupted", words: "its terminal was gone when kururu started again." });
    // A terminal of the same id that is not the run's — ids are given out again after a host restart — is not taken for it.
    w.agents.set(kept.agentId!, { ...w.agents.get(kept.agentId!)!, command: "something else" });
    const third = new Automations(w.deps(store));
    await third.start();
    third.stop();
    expect(store.automationRuns(key)[0]!.state).toBe("interrupted");
    store.close();
  });

  it("ends an agent run on its result line, asks and works as the agent does, and closes it after", async () => {
    const w = world(AT);
    const store = Store.open(path);
    const clock = new Automations(w.deps(store));
    const text = "---\nname: Review\nschedule: manual\nrun: agent\nlauncher: claude:claude-opus-5-5\n---\n/crawl-maintenance\n";
    const { key } = clock.save("pk", "wk", null, text);
    const { agentId } = await clock.runNow("pk", key, "you");
    const command = w.opened[0]!.command;
    expect(command).toMatch(/^claude --model claude-opus-5-5 --session-id [0-9a-f-]{36} '\/crawl-maintenance\n\n\(This is an unattended run/);
    const set = (status: AgentSnapshot["status"]) => w.agents.set(agentId!, { ...w.agents.get(agentId!)!, status });
    set("blocked");
    await clock.tick();
    expect(store.automationRuns(key)[0]!.state).toBe("asking");
    set("working");
    await clock.tick();
    expect(store.automationRuns(key)[0]!.state).toBe("running");
    w.replies.set(agentId!, "Done the review.\n\nRESULT: finding: three sources silent since 12 Nov");
    set("done");
    await clock.tick();
    expect(store.automationRuns(key)[0]).toMatchObject({ state: "finding", words: "three sources silent since 12 Nov", closedAt: null });
    // Two minutes on, the sleeper's checks pass and its terminal is ended.
    w.clock.now += 2 * 60_000 + 1;
    await clock.tick();
    expect(w.ended).toEqual([agentId!]);
    expect(store.automationRuns(key)[0]!.closedAt).not.toBeNull();
    // A quiet finding tells nobody in this phase.
    expect(w.told).toEqual([]);
    store.close();
  });

  it("ends a run past its time limit, and says it asked when it did", async () => {
    const w = world(AT);
    const store = Store.open(path);
    const clock = new Automations({ ...w.deps(store), activity: () => "Allow Bash: rm -rf build?" });
    const text = "---\nname: Slow\nschedule: manual\nrun: agent\nlauncher: claude:claude-opus-5-5\ntimeout: 10m\n---\ngo\n";
    const { key } = clock.save("pk", "wk", null, text);
    const { agentId } = await clock.runNow("pk", key, "you");
    w.agents.set(agentId!, { ...w.agents.get(agentId!)!, status: "blocked" });
    await clock.tick();
    w.clock.now += 10 * 60_000 + 1;
    await clock.tick();
    expect(store.automationRuns(key)[0]).toMatchObject({ state: "failed", words: 'it asked "Allow Bash: rm -rf build?" and nobody answered in 10 min.' });
    expect(w.ended).toEqual([agentId!]);
    store.close();
  });

  it("refuses what phase 1 does not offer, a clash of names, and Run now while a run is going", async () => {
    const w = world(AT);
    const store = Store.open(path);
    const clock = new Automations(w.deps(store));
    expect(() => clock.save("pk", "wk", null, SHELL.replace("run: shell", "run: card\nlauncher: claude:claude-opus-5-5"))).toThrow("card task");
    const { key } = clock.save("pk", "wk", null, SHELL.replace("true", "sleep 100"));
    expect(() => clock.save("pk", "wk", null, SHELL)).toThrow('already an automation called "Tick"');
    await clock.runNow("pk", key, "you");
    await expect(clock.runNow("pk", key, "you")).rejects.toThrow("already running");
    expect(() => clock.delete("pk", key)).toThrow("running");
    store.close();
  });

  it("keeps the anchor across an edit, so every second week stays the same weeks", () => {
    const w = world(Date.parse("2026-11-10T12:00:00Z"));
    const store = Store.open(path);
    const clock = new Automations(w.deps(store));
    const line = "---\nname: Fortnight\nschedule: every 2 weeks on mon at 09:00 UTC\nrun: shell\n---\ntrue\n";
    const { key } = clock.save("pk", "wk", null, line);
    expect(new Date(clock.view("pk")[0]!.next!).toISOString()).toBe("2026-11-23T09:00:00.000Z");
    // A week later the command is edited; the next run is still the 23rd, not the 16th or 30th.
    w.clock.now = Date.parse("2026-11-17T12:00:00Z");
    clock.save("pk", "wk", key, line.replace("true", "echo hi"));
    expect(clock.view("pk")[0]!.anchor).toBe("2026-11-10");
    expect(new Date(clock.view("pk")[0]!.next!).toISOString()).toBe("2026-11-23T09:00:00.000Z");
    // Paused and resumed, it works the next slot out from now.
    clock.setEnabled("pk", key, false, "paused by you");
    expect(clock.view("pk")[0]!.next).toBeNull();
    clock.setEnabled("pk", key, true, null);
    expect(new Date(clock.view("pk")[0]!.next!).toISOString()).toBe("2026-11-23T09:00:00.000Z");
    store.close();
  });

  it("takes a description on an edit without moving the schedule or starting anything, and shows it", async () => {
    const w = world(Date.parse("2026-11-10T12:00:00Z"));
    const store = Store.open(path);
    const clock = new Automations(w.deps(store));
    const line = "---\nname: Fortnight\nschedule: every 2 weeks on mon at 09:00 UTC\nrun: shell\n---\ntrue\n";
    const { key } = clock.save("pk", "wk", null, line);
    const before = clock.view("pk")[0]!;
    clock.save("pk", "wk", key, line.replace("schedule:", "description: Checks the disk every other Monday.\nschedule:"));
    await clock.tick();
    const after = clock.view("pk")[0]!;
    expect(after.description).toBe("Checks the disk every other Monday.");
    expect([after.anchor, after.next, after.enabled]).toEqual([before.anchor, before.next, true]);
    expect(store.automations()[0]!.text).toContain("\ndescription: Checks the disk every other Monday.\n");
    expect(w.opened).toHaveLength(0);
    expect(store.automationRuns(key)).toHaveLength(0);
    store.close();
  });
});
