/**
 * An agent reloading the window: when a page may (`reloadHolds`), what the
 * agent is told (`outcomeText`), and the server's bookkeeping in between
 * (`WindowReloads`) — driven with strings for clients and a hand-turned
 * clock, so a ninety-second wait is a number.
 *
 * The page's own half (`web/src/reload.ts`) gathers its inputs from the DOM
 * and the voice and hands them to `reloadHolds`; what it decides with them is
 * all here.
 */
import { describe, expect, it } from "bun:test";
import {
  RELOAD_BACK_MS,
  RELOAD_QUIET_MS,
  outcomeOf,
  outcomeText,
  reloadHolds,
  reloaderName,
  type HoldInputs,
  type ReloadOutcome,
} from "../../shared/reload";
import type { ServerMessage } from "../../shared/wire";
import { Harness, type HarnessDeps } from "../src/harness";
import { WindowReloads } from "../src/reload";

describe("when a page may reload", () => {
  const still: HoldInputs = { voice: "idle", hushed: false, lastInputAt: 0, pressing: false, now: 100_000, dialog: false, draft: false };

  it("goes when nothing is happening", () => {
    expect(reloadHolds(still)).toEqual([]);
  });

  it("holds while anybody is talking: the microphone open, a clip on its way, or the server's hush", () => {
    expect(reloadHolds({ ...still, voice: "listening" })).toEqual(["talking"]);
    expect(reloadHolds({ ...still, voice: "sending" })).toEqual(["talking"]);
    // The pill recording, or a phone: this page's own voice is idle, the hush is not.
    expect(reloadHolds({ ...still, hushed: true })).toEqual(["talking"]);
  });

  it("holds while Kuru speaks, and while the pill still shows what it heard", () => {
    expect(reloadHolds({ ...still, voice: "speaking" })).toEqual(["speaking"]);
    expect(reloadHolds({ ...still, voice: "heard" })).toEqual(["showing"]);
    expect(reloadHolds({ ...still, voice: "error" })).toEqual(["showing"]);
  });

  it("holds until the hands have been still for the quiet time, and while a button is down", () => {
    expect(reloadHolds({ ...still, lastInputAt: still.now - 1 })).toEqual(["hands"]);
    expect(reloadHolds({ ...still, lastInputAt: still.now - RELOAD_QUIET_MS + 1 })).toEqual(["hands"]);
    expect(reloadHolds({ ...still, lastInputAt: still.now - RELOAD_QUIET_MS })).toEqual([]);
    // A drag held for longer than the quiet time is still a drag.
    expect(reloadHolds({ ...still, pressing: true, lastInputAt: still.now - 60_000 })).toEqual(["hands"]);
  });

  it("holds under a dialog or a menu, and over unsent words", () => {
    expect(reloadHolds({ ...still, dialog: true })).toEqual(["dialog"]);
    expect(reloadHolds({ ...still, draft: true })).toEqual(["draft"]);
  });

  it("names every hold at once, so the agent hears all of what it waited for", () => {
    expect(reloadHolds({ ...still, voice: "speaking", hushed: true, lastInputAt: still.now, dialog: true, draft: true })).toEqual([
      "talking",
      "speaking",
      "hands",
      "dialog",
      "draft",
    ]);
  });
});

describe("who asked, as the notice says it", () => {
  it("puts the name first, then the program and the workspace, and no id", () => {
    expect(reloaderName({ name: "tab strip", doing: "Refactor tabs", program: "claude", workspace: "kururu" })).toBe("“tab strip” (claude in kururu)");
    expect(reloaderName({ name: null, doing: "Refactor tabs", program: "claude", workspace: "kururu" })).toBe("“Refactor tabs” (claude in kururu)");
    expect(reloaderName({ name: null, doing: null, program: "claude", workspace: null })).toBe("claude");
  });

  it("keeps a paragraph of a title to one short line", () => {
    const named = reloaderName({ name: null, doing: "word ".repeat(40), program: "claude", workspace: "kururu" });
    expect(named.length).toBeLessThanOrEqual(80);
    expect(named).toContain("…");
    expect(named).not.toContain("  ");
  });
});

describe("what the agent is told", () => {
  it("says plainly when there was nothing to reload, and what to do about it", () => {
    const text = outcomeText(outcomeOf([], 0, 2));
    expect(text).toStartWith("Nothing was reloaded");
    expect(text).toContain("⌘R");
    expect(text).toContain("2 other pages");
  });

  it("answers yes on the first line, with what each page waited for", () => {
    const o = outcomeOf(
      [
        { page: "window", result: "back", waitedFor: ["hands"], holds: [], reloadedAfterMs: 6100, backAfterMs: 7000 },
        { page: "pill", result: "back", waitedFor: [], holds: [], reloadedAfterMs: 200, backAfterMs: 900 },
      ],
      7000,
      0,
    );
    expect(o.ok).toBe(true);
    const text = outcomeText(o);
    expect(text.split("\n")[0]).toBe("Reloaded 2 pages in 7.0 s.");
    expect(text).toContain("the Kururu window: reloaded after 6.1 s (waited while the user was typing or clicking in it), and back after 7.0 s.");
    expect(text).toContain("the floating pill: reloaded after 0.2 s, and back after 0.9 s.");
    expect(text).not.toContain("⌘R");
  });

  it("answers no with what was still holding, what held earlier, and the next step", () => {
    const o = outcomeOf(
      [{ page: "window", result: "held", waitedFor: ["hands", "dialog"], holds: ["dialog"], reloadedAfterMs: null, backAfterMs: null }],
      90_000,
      0,
    );
    expect(o.outcome).toBe("held");
    const text = outcomeText(o);
    expect(text.split("\n")[0]).toBe("Not reloaded: gave up after 90 s.");
    expect(text).toContain("still held — a dialog or menu was open. Earlier: the user was typing or clicking in it.");
    expect(text).toContain("press ⌘R");
  });

  it("calls a split answer partly, and a page that never came back by name", () => {
    const o = outcomeOf(
      [
        { page: "window", result: "gone", waitedFor: ["hands"], holds: [], reloadedAfterMs: null, backAfterMs: null },
        { page: "pill", result: "reloaded", waitedFor: [], holds: [], reloadedAfterMs: 100, backAfterMs: null },
      ],
      21_000,
      0,
    );
    expect(o.outcome).toBe("partly");
    expect(outcomeText(o)).toContain("has not come back");
    expect(outcomeText(o)).toContain("closed, or was reloaded by hand");
  });
});

/** The tracker over string clients, with a clock and timers turned by hand. */
function rig(connected = () => 2) {
  let now = 1_000_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const sent: { to: string; msg: ServerMessage }[] = [];
  const reloads = new WindowReloads<string>({
    send: (to, msg) => sent.push({ to, msg }),
    connected,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id as number),
  });
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  const asked = (to: string) => sent.filter((s) => s.to === to && s.msg.type === "reload").map((s) => (s.msg as Extract<ServerMessage, { type: "reload" }>).ask);
  return { reloads, sent, advance, asked, timers };
}

async function settled(promise: Promise<ReloadOutcome>): Promise<ReloadOutcome | "pending"> {
  return Promise.race([promise, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 5))]);
}

describe("the server's part", () => {
  it("answers at once when no page on this Mac said it can be reloaded, counting the ones that did not", async () => {
    const { reloads, sent } = rig(() => 3);
    reloads.declare("window", "window", []);
    reloads.leave("window");
    const o = await reloads.ask("why", "me", 90_000);
    expect(o.outcome).toBe("no-window");
    expect(o.others).toBe(3);
    expect(sent).toEqual([]);
  });

  it("asks every page there is, and answers once each has reloaded and come back", async () => {
    const { reloads, advance, asked } = rig();
    reloads.declare("w1", "window", []);
    reloads.declare("p1", "pill", []);
    const answer = reloads.ask("new tab strip", "“tabs” (claude in kururu)", 90_000);
    const [ask] = asked("w1");
    expect(ask).toMatchObject({ by: "“tabs” (claude in kururu)", why: "new tab strip" });
    expect(asked("p1")).toEqual([ask!]);

    reloads.reloading("p1", [ask!.id]);
    reloads.held("w1", [ask!.id], ["hands"]);
    advance(3000);
    reloads.held("w1", [ask!.id], ["hands", "dialog"]);
    advance(3000);
    reloads.reloading("w1", [ask!.id]);
    // The page going is what a reload looks like from here: not an answer yet.
    reloads.leave("w1");
    reloads.leave("p1");
    expect(await settled(answer)).toBe("pending");

    advance(500);
    reloads.declare("p2", "pill", [ask!.id]);
    expect(await settled(answer)).toBe("pending");
    advance(700);
    reloads.declare("w2", "window", [ask!.id]);
    const o = await answer;
    expect(o.ok).toBe(true);
    const window = o.pages.find((p) => p.page === "window")!;
    expect(window).toMatchObject({ result: "back", waitedFor: ["hands", "dialog"], reloadedAfterMs: 6000, backAfterMs: 7200 });
    expect(o.pages.find((p) => p.page === "pill")).toMatchObject({ result: "back", reloadedAfterMs: 0, backAfterMs: 6500 });
  });

  it("gives up at the deadline, tells the held page so, and says what held it", async () => {
    const { reloads, advance, asked, sent } = rig();
    reloads.declare("w1", "window", []);
    const answer = reloads.ask("why", "me", 90_000);
    const id = asked("w1")[0]!.id;
    reloads.held("w1", [id], ["speaking"]);
    advance(89_999);
    expect(await settled(answer)).toBe("pending");
    advance(1);
    const o = await answer;
    expect(o.outcome).toBe("held");
    expect(o.pages[0]).toMatchObject({ result: "held", holds: ["speaking"] });
    expect(sent.at(-1)).toEqual({ to: "w1", msg: { type: "reload-cancel", id } });
    // A word arriving after the answer changes nothing and throws nothing.
    reloads.reloading("w1", [id]);
  });

  it("calls a page closed while it waited gone, and lets a lost word be found by the page that came back", async () => {
    const { reloads, asked, advance } = rig();
    reloads.declare("w1", "window", []);
    reloads.declare("p1", "pill", []);
    const answer = reloads.ask("why", "me", 90_000);
    const id = asked("w1")[0]!.id;
    // The window's `reloading` never arrived; its new page carries the id.
    reloads.leave("w1");
    reloads.leave("p1");
    reloads.declare("w2", "window", [id]);
    // The pill's new page never names it, so it is gone once its grace runs out.
    expect(await settled(answer)).toBe("pending");
    advance(5000);
    const o = await answer;
    expect(o.pages.find((p) => p.page === "window")?.result).toBe("back");
    expect(o.pages.find((p) => p.page === "pill")?.result).toBe("gone");
    expect(o.outcome).toBe("partly");
  });

  it("stops waiting for a page that reloaded and never came back", async () => {
    const { reloads, advance, asked } = rig();
    reloads.declare("w1", "window", []);
    const answer = reloads.ask("why", "me", 5000);
    const id = asked("w1")[0]!.id;
    reloads.reloading("w1", [id]);
    reloads.leave("w1");
    // Past the ask's own deadline, which no longer applies to a page that went.
    advance(RELOAD_BACK_MS - 1);
    expect(await settled(answer)).toBe("pending");
    advance(1);
    const o = await answer;
    expect(o.pages[0]?.result).toBe("reloaded");
    expect(o.ok).toBe(true);
  });

  it("lets a page answer two asks with one reload", async () => {
    const { reloads, asked } = rig();
    reloads.declare("w1", "window", []);
    const first = reloads.ask("one", "a", 90_000);
    const second = reloads.ask("two", "b", 90_000);
    const ids = asked("w1").map((ask) => ask.id);
    expect(ids).toHaveLength(2);
    reloads.reloading("w1", ids);
    reloads.leave("w1");
    reloads.declare("w2", "window", ids);
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
  });

  it("ends the wait when the asker hangs up, and lets the pages go", async () => {
    const { reloads, asked, sent, timers } = rig();
    reloads.declare("w1", "window", []);
    const hangup = new AbortController();
    const answer = reloads.ask("why", "me", 90_000, hangup.signal);
    const id = asked("w1")[0]!.id;
    hangup.abort();
    expect((await answer).outcome).toBe("held");
    expect(sent.at(-1)).toEqual({ to: "w1", msg: { type: "reload-cancel", id } });
    expect(timers.size).toBe(0);
  });

  it("does not ask a page that arrives after the ask: it loaded after the change", async () => {
    const { reloads, asked, advance } = rig();
    reloads.declare("w1", "window", []);
    const answer = reloads.ask("why", "me", 1000);
    reloads.declare("w2", "window", []);
    expect(asked("w2")).toEqual([]);
    advance(1000);
    expect((await answer).pages).toHaveLength(1);
  });
});

describe("the harness's reload_window", () => {
  function rig() {
    const calls: { why: string; timeoutMs: number }[] = [];
    const deps = {
      workspaces: { profileOf: () => "p", profile: () => ({ id: "p", harness: { agentId: "h" }, workspaces: [] }), agentsInWorkspace: () => [] },
      host: { isLive: () => true, find: () => undefined },
      activity: new Map<string, string>(),
      launch: () => ({ bypassClis: [] }),
      reloadWindow: async (why: string, timeoutMs: number) => {
        calls.push({ why, timeoutMs });
        return outcomeOf([{ page: "window", result: "back", waitedFor: [], holds: [], reloadedAfterMs: 0, backAfterMs: 800 }], 800, 0);
      },
    } as unknown as HarnessDeps;
    return { harness: new Harness(deps), calls };
  }

  it("asks with its words and its time, and returns what happened", async () => {
    const { harness, calls } = rig();
    const result = JSON.stringify(await harness.call("p", "h", "reload_window", { why: "  the agent's\nnew pill  ", seconds: 30 }));
    expect(calls).toEqual([{ why: "the agent's new pill", timeoutMs: 30_000 }]);
    expect(result).toContain("Reloaded the Kururu window in 0.8 s.");
  });

  it("will not ask without a why, and keeps the wait inside its bounds", async () => {
    const { harness, calls } = rig();
    expect(JSON.stringify(await harness.call("p", "h", "reload_window", {}))).toContain("Say why");
    await harness.call("p", "h", "reload_window", { why: "x", seconds: 100_000 });
    await harness.call("p", "h", "reload_window", { why: "x", seconds: 0 });
    await harness.call("p", "h", "reload_window", { why: "x" });
    expect(calls.map((c) => c.timeoutMs)).toEqual([600_000, 2000, 90_000]);
  });
});
