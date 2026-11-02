/**
 * The snapshot's pace (`server/src/gap.ts`): the first change after a quiet
 * spell goes at the end of its turn, changes inside the gap go once at its
 * end, and `flush` sends a pending one now for a message that must not
 * overtake it.
 */
import { describe, expect, it } from "bun:test";
import { Gap } from "../src/gap";

const tick = () => new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Gap", () => {
  it("runs the first push at the end of its turn, once however many came in it", async () => {
    let runs = 0;
    const gap = new Gap(1_000, () => runs++);
    gap.push();
    gap.push();
    gap.push();
    expect(runs).toBe(0);
    expect(gap.pending).toBe(true);
    await tick();
    expect(runs).toBe(1);
    expect(gap.pending).toBe(false);
  });

  it("holds a push inside the gap to the gap's end, and runs it once", async () => {
    let clock = 0;
    let runs = 0;
    const gap = new Gap(40, () => runs++, () => clock);
    gap.push();
    await tick();
    expect(runs).toBe(1);
    clock = 10;
    gap.push();
    gap.push();
    await tick();
    expect(runs).toBe(1);
    clock = 40;
    await wait(60);
    expect(runs).toBe(2);
  });

  it("runs a pending push now on flush, and the timer that was waiting for it does nothing", async () => {
    let clock = 0;
    let runs = 0;
    const gap = new Gap(30, () => runs++, () => clock);
    gap.push();
    await tick();
    clock = 5;
    gap.push();
    gap.flush();
    expect(runs).toBe(2);
    gap.flush();
    expect(runs).toBe(2);
    await wait(50);
    expect(runs).toBe(2);
  });

  it("does not send what nobody pushed", async () => {
    let runs = 0;
    const gap = new Gap(10, () => runs++);
    gap.flush();
    await wait(20);
    expect(runs).toBe(0);
  });
});
