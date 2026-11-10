/**
 * The automations' two tables: that a slot is claimed once however many
 * servers share the file, that a deleted automation keeps its history, and
 * that the list's heads are the live run and the last one that ended.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type AutomationRow } from "../src/store";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-auto-"));
  path = join(dir, "kururu.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const row = (key: string): AutomationRow => ({
  key,
  profileKey: "p1",
  workspaceKey: "w1",
  text: "---\nname: x\nschedule: every 5 minutes UTC\nrun: shell\n---\ntrue\n",
  home: "mac",
  enabled: true,
  whyOff: null,
  anchor: "2026-11-10",
  nextSlot: 1000,
  createdAt: 1,
  updatedAt: 1,
});

const claim = (store: Store, key: string, slot: number) =>
  store.claimRun({ automationKey: key, slot: String(slot), slotAt: slot, why: "schedule", by: null, state: "running", words: null, startedAt: slot, endedAt: null });

describe("automations in the database", () => {
  it("claims a slot once, even with two servers on one file", () => {
    const one = Store.open(path);
    const two = Store.open(path);
    one.putAutomation(row("ak1"));
    expect(claim(one, "ak1", 1000)).toBeNumber();
    expect(claim(two, "ak1", 1000)).toBeNull();
    expect(claim(two, "ak1", 2000)).toBeNumber();
    one.close();
    two.close();
  });

  it("keeps the shape on every open, so an older file grows the tables without a version step", () => {
    Store.open(path).close();
    const again = Store.open(path);
    again.putAutomation(row("ak1"));
    expect(again.automations().map((a) => a.key)).toEqual(["ak1"]);
    again.close();
  });

  it("marks a deleted automation gone and keeps its runs", () => {
    const store = Store.open(path);
    store.putAutomation(row("ak1"));
    const id = claim(store, "ak1", 1000)!;
    store.updateRun(id, { state: "ok", endedAt: 1500 });
    store.deleteAutomation("ak1");
    expect(store.automations()).toEqual([]);
    expect(store.automationRuns("ak1").map((r) => r.state)).toEqual(["ok"]);
    store.close();
  });

  it("gives each automation's live run and its last ended one", () => {
    const store = Store.open(path);
    store.putAutomation(row("ak1"));
    store.putAutomation(row("ak2"));
    const first = claim(store, "ak1", 1000)!;
    store.updateRun(first, { state: "failed", endedAt: 1200, words: "no" });
    const second = claim(store, "ak1", 2000)!;
    store.updateRun(second, { state: "ok", endedAt: 2100 });
    const third = claim(store, "ak1", 3000)!;
    const { live, last } = store.runHeads();
    expect(live.get("ak1")?.id).toBe(third);
    expect(last.get("ak1")?.id).toBe(second);
    expect(live.has("ak2")).toBe(false);
    expect(store.openRuns().map((r) => r.id)).toEqual([third]);
    store.updateRun(third, { state: "ok", endedAt: 3100, agentId: "a9" });
    // Ended, with its terminal still open: still the clock's to close.
    expect(store.openRuns().map((r) => r.id)).toEqual([third]);
    store.updateRun(third, { closedAt: 3300 });
    expect(store.openRuns()).toEqual([]);
    store.close();
  });

  it("pauses with a reason, and takes the next slot away", () => {
    const store = Store.open(path);
    store.putAutomation(row("ak1"));
    store.setAutomationEnabled("ak1", false, "paused by you", null);
    expect(store.automations()[0]).toMatchObject({ enabled: false, whyOff: "paused by you", nextSlot: null });
    store.close();
  });
});
