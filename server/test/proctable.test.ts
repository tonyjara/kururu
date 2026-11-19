/**
 * The one `ps` read the dev-server scan and the memory column share
 * (`server/src/proctable.ts`): the columns both need and the processor share
 * the "This Mac" chip reads, `args` last because it has spaces in it.
 */
import { describe, expect, it } from "bun:test";
import { resolveDevCommand } from "../src/devservers";
import { measureMemory } from "../src/memory";
import { parseProcRows } from "../src/proctable";

const PS = [
  "    1     0   9000   0.1 /sbin/launchd",
  "  500     1   2048   0.0 -zsh",
  "  510   500   1024   0,5 npm run dev",
  "  520   510 204800 146.2 node /x/node_modules/.bin/vite --port 5173",
  "  530   500      4   0.0 ",
  "garbage line",
  "    0     0     0  12.0 kernel_task",
].join("\n");

describe("parseProcRows", () => {
  it("reads pid, ppid, rss in bytes, the processor share and argv, and skips what does not parse", () => {
    const rows = parseProcRows(PS);
    expect(rows.get(520)).toEqual({ pid: 520, ppid: 510, rss: 204800 * 1024, cpu: 146.2, args: "node /x/node_modules/.bin/vite --port 5173" });
    // A process whose argv came back empty is still a process, with its memory.
    expect(rows.get(530)).toEqual({ pid: 530, ppid: 500, rss: 4 * 1024, cpu: 0, args: "" });
    // A locale with a decimal comma prints the share with one.
    expect(rows.get(510)?.cpu).toBe(0.5);
    expect(rows.has(0)).toBe(false);
    expect(rows.size).toBe(5);
  });

  it("answers both questions off one read", () => {
    const rows = parseProcRows(PS);
    expect(resolveDevCommand(520, rows)).toMatchObject({ program: "vite", pid: 520 });
    // The shell, npm, vite and the empty one, summed and rounded to what the sidebar draws.
    expect(measureMemory([["a1", 500]], rows).get("a1")).toBe(200 * 1024 * 1024);
  });
});
