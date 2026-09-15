/**
 * Adding up a process tree is arithmetic, and the two things that can go wrong
 * with it are not. A terminal that has exited must answer "nothing to say"
 * rather than "zero bytes" — the second is a claim about a process, and the row
 * would draw it. And the rounding is not cosmetic: it is what the poll compares
 * against to decide whether to broadcast, so a change that survives it is a
 * snapshot to every client and one that does not is silence.
 *
 * All of it is pure, so none of this needs a pty, a ps, or a machine in any
 * particular state.
 */
import { describe, expect, it } from "bun:test";
import { childIndex, coarsen, measureMemory, memoryUnder, parseProcMem } from "../src/memory";

const MB = 1024 * 1024;

/** `ps -eo pid=,ppid=,rss=` as macOS prints it: leading spaces, kilobytes. */
const PS = `
    1     0  21968
84184 14517   3584
84822 84184 391168
23051 84184   3072
23054 23051  47104
70415 14517   4288
`;

describe("parseProcMem", () => {
  it("reads kilobytes and hands back bytes", () => {
    const table = parseProcMem(PS);
    expect(table.get(84822)).toEqual({ pid: 84822, ppid: 84184, rss: 391168 * 1024 });
  });

  it("ignores anything that is not three numbers", () => {
    const table = parseProcMem("  12  1  400\nnot a process line\n\n  x  y  z\n");
    expect([...table.keys()]).toEqual([12]);
  });
});

describe("memoryUnder", () => {
  const table = parseProcMem(PS);
  const children = childIndex(table);

  it("adds the pty's own process to everything beneath it", () => {
    // The shell, claude, a nested shell and the node it ran: 434.5 MB in all.
    expect(memoryUnder(84184, table, children)).toBe((3584 + 391168 + 3072 + 47104) * 1024);
  });

  it("is just the shell for a terminal with nothing running in it", () => {
    expect(memoryUnder(70415, table, children)).toBe(4288 * 1024);
  });

  /**
   * The distinction the row depends on. A pty that exited between the snapshot
   * and the `ps` is absent from the table, and answering zero there would put
   * "0 MB" beside a dead agent as though it had been measured.
   */
  it("says nothing at all for a process that is not there", () => {
    expect(memoryUnder(999999, table, children)).toBeNull();
  });

  /**
   * A straight read of `ps` describes a forest, but a pid recycled while it was
   * being read can describe a ring, and a walk that believed it would not stop.
   */
  it("counts each process once even if the table describes a cycle", () => {
    const cyclic = parseProcMem("  10  11  1024\n  11  10  1024\n");
    expect(memoryUnder(10, cyclic, childIndex(cyclic))).toBe(2 * 1024 * 1024);
  });
});

describe("measureMemory", () => {
  it("keys the rounded total by agent id, and leaves out what it could not find", () => {
    const table = parseProcMem(PS);
    const found = measureMemory(
      [
        ["a1", 84184],
        ["a2", 70415],
        ["a3", 999999],
      ],
      table,
    );
    expect([...found.keys()]).toEqual(["a1", "a2"]);
    expect(found.get("a1")).toBe(430 * MB); // 434.5 MB, at the ten-megabyte step
    expect(found.get("a2")).toBe(4 * MB);
  });

  it("has nothing to say when the ps failed", () => {
    expect(measureMemory([["a1", 84184]], new Map()).size).toBe(0);
  });
});

describe("coarsen", () => {
  /**
   * The point of it: an agent breathing by a megabyte a poll must land on the
   * same number every time, or every poll is a snapshot to every client.
   */
  it("holds still under the jitter of a working agent", () => {
    expect(coarsen(391 * MB + 300 * 1024)).toBe(coarsen(391 * MB - 300 * 1024));
  });

  it("moves when the drawn figure would", () => {
    expect(coarsen(391 * MB)).toBe(390 * MB);
    expect(coarsen(396 * MB)).toBe(400 * MB);
  });

  it("keeps whole megabytes while they are the second digit", () => {
    expect(coarsen(47 * MB + 100 * 1024)).toBe(47 * MB);
  });

  it("steps by a tenth of a gigabyte once it is drawn in gigabytes", () => {
    expect(coarsen(1434 * MB)).toBe(1400 * MB);
  });

  it("answers zero for a process that measured as nothing", () => {
    expect(coarsen(0)).toBe(0);
  });
});
