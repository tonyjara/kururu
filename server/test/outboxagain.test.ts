/**
 * A message the outbox tries a second time — after Kuru sat between turns
 * without taking it, or after a Resend — goes to the harness marked as typed
 * before, so the harness looks in the prompt box rather than typing a second
 * copy; and a harness that will not type it again fails it, with its reason,
 * rather than leaving it to be typed a third time. The harness is a stub here;
 * what it does with the mark is `server/test/harness.test.ts`'s.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { Outbox, type OutboxDeps } from "../src/outbox";

describe("a message tried again", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** Let the outbox's promises run, and its clock move. */
  async function pass(ms: number): Promise<void> {
    for (let gone = 0; gone < ms; gone += 500) {
      jest.advanceTimersByTime(500);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
  }

  function rig(refuse: (again: boolean) => string | null) {
    const tries: boolean[] = [];
    const deps: OutboxDeps = {
      broadcast: () => {},
      index: { load: () => [], save: () => {}, remove: () => {} },
      profileIdOf: () => "p1",
      transcribe: () => Promise.resolve(null),
      deliver: (_key, _text, events, again) => {
        tries.push(again);
        const why = refuse(again);
        if (why) events.refused(why);
        else events.typed();
        return Promise.resolve({ outcome: "typed" as const });
      },
      harness: () => ({ agentId: "a1", status: "idle", transcript: null }),
      talk: () => {},
    };
    const outbox = new Outbox(deps);
    outbox.resume();
    return { outbox, tries, state: () => outbox.entriesOf("pk1").find((e) => e.id === "m1") };
  }

  test("is marked as typed before, and fails with the harness's reason when it will not go again", async () => {
    const { outbox, tries, state } = rig((again) => (again ? "the box has other words in it" : null));
    outbox.say("pk1", "m1", Date.now(), "hello there");
    await pass(500);
    expect(tries).toEqual([false]);
    // Kuru sits between turns and never takes it.
    await pass(20_000);
    expect(tries).toEqual([false, true]);
    expect(state()?.state).toBe("failed");
    expect(state()?.note).toBe("the box has other words in it");
    // Nothing more is tried on its own.
    await pass(40_000);
    expect(tries).toEqual([false, true]);
    // A Resend is marked too, since its first copy may still be in the box.
    outbox.resend("m1");
    await pass(500);
    expect(tries).toEqual([false, true, true]);
    outbox.close();
  });

  test("is tried twice at most, the second time marked", async () => {
    const { outbox, tries, state } = rig(() => null);
    outbox.say("pk1", "m1", Date.now(), "hello there");
    await pass(60_000);
    expect(tries).toEqual([false, true]);
    expect(state()?.state).toBe("failed");
    outbox.close();
  });
});
