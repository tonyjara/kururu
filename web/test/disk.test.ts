/**
 * Which disk a read goes to (`web/src/disk.ts`): this server's routes for
 * its own roots, the node's through this server for a qualified one, with
 * the qualification never sent on.
 */
import { describe, expect, it } from "bun:test";
import { qualify } from "../../shared/remote";
import { readUrl } from "../src/disk";

const OMARCHY = "n0123456789ab";

describe("readUrl", () => {
  it("reads this disk for a root of its own", () => {
    expect(readUrl("ls", { root: "/Users/me/p", path: "src" })).toBe("/api/ls?root=%2FUsers%2Fme%2Fp&path=src");
    expect(readUrl("docs", { root: "" })).toBe("/api/docs?root=");
  });
  it("reads a node's disk for a root of the node's, with the root as the node spells it", () => {
    expect(readUrl("markdown", { root: qualify(OMARCHY, "/home/o/p"), path: "README.md" })).toBe(
      `/api/node/${OMARCHY}/markdown?root=%2Fhome%2Fo%2Fp&path=README.md`,
    );
  });
  it("reads the node a picker with no root yet names", () => {
    expect(readUrl("docs", { root: "" }, OMARCHY)).toBe(`/api/node/${OMARCHY}/docs?root=`);
  });
});
