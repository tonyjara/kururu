/**
 * A popped-out column's window is kept under its id across relaunches, and
 * its page reads which board and which column back off that id. An id read
 * wrong is a window showing another board's column — or, split at the wrong
 * colon, a column that is never found and a window that says it is gone.
 */
import { describe, expect, it } from "bun:test";
import { canPopColumn, columnId, parseColumnId } from "../src/columns";

describe("columnId and parseColumnId", () => {
  it("round-trips a workspace's fixed column and a profile's own", () => {
    expect(parseColumnId(columnId("wk1a2b3c4d5e6", "todo"))).toEqual({ board: "wk1a2b3c4d5e6", lane: "todo" });
    expect(parseColumnId(columnId("pk0f0f0f0f0f0", "needs"))).toEqual({ board: "pk0f0f0f0f0f0", lane: "needs" });
    expect(parseColumnId(columnId("pk0f0f0f0f0f0", "k9a8b"))).toEqual({ board: "pk0f0f0f0f0f0", lane: "k9a8b" });
  });

  it("keeps the same column of two boards apart", () => {
    expect(columnId("wkaaaaaaaaaaaa", "todo")).not.toBe(columnId("wkbbbbbbbbbbbb", "todo"));
  });

  it("splits at the first colon", () => {
    expect(parseColumnId("wkabc:odd:lane")).toEqual({ board: "wkabc", lane: "odd:lane" });
  });

  it("reads anything that is not an id as none", () => {
    for (const bad of ["", "todo", ":todo", "wkabc:", 42, null, undefined, {}]) expect(parseColumnId(bad)).toBeNull();
  });
});

describe("canPopColumn", () => {
  it("is off with no desktop bridge, as in a browser or on the phone", () => {
    expect(canPopColumn()).toBe(false);
    expect(canPopColumn("w3")).toBe(false);
  });
});
