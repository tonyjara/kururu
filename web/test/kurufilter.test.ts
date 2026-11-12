/**
 * The filter of Kuru's conversation as a panel: which rows it offers for what
 * was typed, in what order — the order is how twenty-one workspaces stay
 * findable — and what the filter becomes when a row is pressed, alone or
 * beside the others.
 */
import { describe, expect, it } from "bun:test";
import { LATELY_MAX, dropLast, filterGroups, nameMatch, onlyRow, pressRow, rowId, rowOn, type FilterNode, type FilterRow } from "../src/kurufilter";

const spaces = ["kururu", "Fastermenu", "Platypost", "Pasapy", "Empanada Avatar", "MV Landing", "MV Admin", "Tile Bandit", "Research"].map((name, i) => ({ key: `k${i + 1}`, name }));
const mac: FilterNode = { name: "mac", id: null, state: "up", unheard: 0, talks: true };
const omarchy: FilterNode = { name: "omarchy", id: "n1", state: "up", unheard: 2, talks: true };
const names = (rows: readonly FilterRow[]) => rows.map((row) => (row.kind === "todo" ? "Todo" : row.name));

describe("nameMatch", () => {
  it("puts a name that starts with what was typed over one that only holds it", () => {
    expect(nameMatch("Pasapy", "pa")).toBe(2);
    expect(nameMatch("Empanada Avatar", "pa")).toBe(1);
    expect(nameMatch("kururu", "pa")).toBe(0);
  });

  it("wants every word typed, in any case, with or without the accent", () => {
    expect(nameMatch("MV Admin", "mv ad")).toBe(2);
    expect(nameMatch("MV Landing", "mv ad")).toBe(0);
    expect(nameMatch("Café Añá", "cafe ana")).toBe(2);
  });

  it("takes anything for nothing typed", () => {
    expect(nameMatch("kururu", "  ")).toBe(2);
  });
});

describe("filterGroups", () => {
  it("opens with Todo, the nodes, the workspaces lately talked about, then the rest by name", () => {
    const groups = filterGroups({ typed: "", nodes: [mac, omarchy], lately: ["k4", "k1"], spaces });
    expect(groups.map((g) => g.title)).toEqual([null, "Nodes", "Lately", "Everything else"]);
    expect(names(groups[0]!.rows)).toEqual(["Todo"]);
    expect(names(groups[1]!.rows)).toEqual(["mac", "omarchy"]);
    expect(names(groups[2]!.rows)).toEqual(["Pasapy", "kururu"]);
    expect(names(groups[3]!.rows)).toEqual(["Empanada Avatar", "Fastermenu", "MV Admin", "MV Landing", "Platypost", "Research", "Tile Bandit"]);
  });

  it("draws no nodes on a kururu linked with none", () => {
    const groups = filterGroups({ typed: "", nodes: [], lately: [], spaces });
    expect(groups.map((g) => g.title)).toEqual([null, "Workspaces"]);
  });

  it("keeps the lately group short, and each workspace in one group only", () => {
    const groups = filterGroups({ typed: "", nodes: [], lately: spaces.map((s) => s.key), spaces });
    const lately = groups.find((g) => g.title === "Lately")!.rows;
    const rest = groups.find((g) => g.title === "Everything else")!.rows;
    expect(lately).toHaveLength(LATELY_MAX);
    expect(lately.length + rest.length).toBe(spaces.length);
    expect(names(rest).some((name) => names(lately).includes(name))).toBe(false);
  });

  it("leaves out a key that is no workspace of the profile's any more", () => {
    const groups = filterGroups({ typed: "", nodes: [], lately: ["gone", "k1", "k1"], spaces });
    expect(names(groups.find((g) => g.title === "Lately")!.rows)).toEqual(["kururu"]);
  });

  it("is one list of what answers the typing, the names that start with it first, and no Todo", () => {
    const groups = filterGroups({ typed: "pa", nodes: [mac, omarchy], lately: ["k5"], spaces });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.title).toBeNull();
    expect(names(groups[0]!.rows)).toEqual(["Pasapy", "Empanada Avatar"]);
  });

  it("finds a node by its name", () => {
    expect(names(filterGroups({ typed: "oma", nodes: [mac, omarchy], lately: [], spaces })[0]!.rows)).toEqual(["omarchy"]);
  });

  it("is empty when nothing answers", () => {
    expect(filterGroups({ typed: "zzz", nodes: [mac, omarchy], lately: [], spaces })).toEqual([]);
  });
});

describe("a row pressed", () => {
  const kururu: FilterRow = { kind: "space", key: "k1", name: "kururu" };
  const pasapy: FilterRow = { kind: "space", key: "k4", name: "Pasapy" };
  const node: FilterRow = { kind: "node", ...omarchy };

  it("is switched on beside what is picked, and off again", () => {
    const one = pressRow({ spaces: [], nodes: [] }, kururu);
    const two = pressRow(pressRow(one, pasapy), node);
    expect(two).toEqual({ spaces: ["k1", "k4"], nodes: ["omarchy"] });
    expect(pressRow(two, kururu)).toEqual({ spaces: ["k4"], nodes: ["omarchy"] });
    expect(pressRow(two, node)).toEqual({ spaces: ["k1", "k4"], nodes: [] });
  });

  it("lets go of everything on Todo", () => {
    expect(pressRow({ spaces: ["k1"], nodes: ["omarchy"] }, { kind: "todo" })).toEqual({ spaces: [], nodes: [] });
  });

  it("is the one thing shown with only", () => {
    expect(onlyRow(pasapy)).toEqual({ spaces: ["k4"], nodes: [] });
    expect(onlyRow(node)).toEqual({ spaces: [], nodes: ["omarchy"] });
    expect(onlyRow({ kind: "todo" })).toEqual({ spaces: [], nodes: [] });
  });

  it("says whether it is on, Todo being on while nothing else is", () => {
    expect(rowOn({ spaces: [], nodes: [] }, { kind: "todo" })).toBe(true);
    expect(rowOn({ spaces: ["k1"], nodes: [] }, { kind: "todo" })).toBe(false);
    expect(rowOn({ spaces: ["k1"], nodes: [] }, kururu)).toBe(true);
    expect(rowOn({ spaces: ["k1"], nodes: [] }, pasapy)).toBe(false);
    expect(rowOn({ spaces: [], nodes: ["omarchy"] }, node)).toBe(true);
  });

  it("has an id of its own kind, so a node and a workspace of one name are two rows", () => {
    expect(rowId({ kind: "space", key: "mac", name: "mac" })).not.toBe(rowId({ kind: "node", ...mac }));
  });
});

describe("dropLast", () => {
  it("lets go of the last workspace, then the last node, then nothing", () => {
    const filter = { spaces: ["k1", "k4"], nodes: ["omarchy"] };
    expect(dropLast(filter)).toEqual({ spaces: ["k1"], nodes: ["omarchy"] });
    expect(dropLast({ spaces: [], nodes: ["mac", "omarchy"] })).toEqual({ spaces: [], nodes: ["mac"] });
    expect(dropLast({ spaces: [], nodes: [] })).toEqual({ spaces: [], nodes: [] });
  });
});
