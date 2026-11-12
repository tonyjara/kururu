/**
 * What the filter of Kuru's conversation offers, and what a press on it means.
 *
 * The filter was a row of chips under the header, one per node and one per
 * workspace the loaded lines were about, and with twenty-one workspaces that
 * row was two thousand pixels of chips in a drawer of four hundred: four in
 * view and the rest a sideways scroll nobody could see the end of (the owner,
 * 2026-11-12: "we have a lot of workspaces… they don't all fit, maybe we can
 * have a filters button?"). It is a panel behind a button now
 * (`KuruTags.tsx`), and a panel can do what a row cannot: be typed into.
 *
 * This is the part of it that is sums, kept out of the component so it can be
 * tested: which rows there are for what has been typed, in what groups and
 * order, and what the filter becomes when one is pressed. The filter itself
 * and whether a line passes it are still `shared/kurutags.ts`'s.
 *
 * **The order is the scaling.** Typing is the fast way to one workspace among
 * many, but a list still has to be short where the eye lands: the nodes
 * first, since they are few and were the row's first chips; then the
 * workspaces lately talked about, most recent first and five at most, which
 * is what the old row showed before it ran off the edge; then everything
 * else by name, since a list scanned for a name is scanned alphabetically.
 * A workspace is in one group only: a switch drawn twice is two switches to
 * keep in step by eye.
 */
import type { TagFilter } from "../../shared/kurutags";

/** How many of the workspaces lately talked about stand above the rest. */
export const LATELY_MAX = 5;

/** A node as the panel draws it: this one, or another with how its link stands. */
export interface FilterNode {
  name: string;
  /** The node's id, which its hue is taken from; null for this node, which wears none. */
  id: string | null;
  state: "up" | "connecting" | "away";
  unheard: number;
  /** Whether its kururu is new enough to be talked to. */
  talks: boolean;
}

export type FilterRow = { kind: "todo" } | ({ kind: "node" } & FilterNode) | { kind: "space"; key: string; name: string };

export interface FilterGroup {
  /** Null for the rows that need no heading: Todo, and what a search found. */
  title: string | null;
  rows: FilterRow[];
}

/** A name as it is compared: any case, and an accent typed or not. */
function plain(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * How well a name answers what was typed: 2 when it starts with it, 1 when a
 * word in it does or it is anywhere inside, 0 when it is not there. Every
 * word typed has to be found, so "mv ad" is MV Admin and not MV Landing.
 */
export function nameMatch(name: string, typed: string): 0 | 1 | 2 {
  const words = plain(typed).split(/\s+/).filter(Boolean);
  if (!words.length) return 2;
  const hay = plain(name);
  if (!words.every((word) => hay.includes(word))) return 0;
  return hay.startsWith(words[0]!) ? 2 : 1;
}

/**
 * The panel's rows. With nothing typed: Todo, the nodes when there are
 * others, the workspaces lately talked about, and the rest by name. With
 * something typed: only what answers it, in one list, the names that start
 * with it first — and no Todo, which is not a thing one searches for.
 */
export function filterGroups(input: {
  typed: string;
  /** This node first, then the others; empty on a kururu linked with none. */
  nodes: readonly FilterNode[];
  /** Workspace keys, the most recently talked about first. */
  lately: readonly string[];
  /** Every workspace of the profile. */
  spaces: readonly { key: string; name: string }[];
}): FilterGroup[] {
  const { typed, nodes, lately, spaces } = input;
  const byName = [...spaces].sort((a, b) => a.name.localeCompare(b.name));
  const nodeRow = (node: FilterNode): FilterRow => ({ kind: "node", ...node });
  const spaceRow = (space: { key: string; name: string }): FilterRow => ({ kind: "space", key: space.key, name: space.name });
  if (typed.trim()) {
    const found = [...nodes.map(nodeRow), ...byName.map(spaceRow)]
      .map((row) => ({ row, score: row.kind === "todo" ? 0 : nameMatch(row.name, typed) }))
      .filter((hit) => hit.score > 0)
      // A stable sort: within a score, the nodes stay first and the names in order.
      .sort((a, b) => b.score - a.score)
      .map((hit) => hit.row);
    return found.length ? [{ title: null, rows: found }] : [];
  }
  const recent = lately
    .filter((key, i, all) => all.indexOf(key) === i)
    .map((key) => spaces.find((space) => space.key === key))
    .filter((space): space is { key: string; name: string } => space !== undefined)
    .slice(0, LATELY_MAX);
  const rest = byName.filter((space) => !recent.some((r) => r.key === space.key));
  const groups: FilterGroup[] = [{ title: null, rows: [{ kind: "todo" }] }];
  if (nodes.length > 1) groups.push({ title: "Nodes", rows: nodes.map(nodeRow) });
  if (recent.length) groups.push({ title: "Lately", rows: recent.map(spaceRow) });
  if (rest.length) groups.push({ title: recent.length ? "Everything else" : "Workspaces", rows: rest.map(spaceRow) });
  return groups;
}

/** Whether a row is on: Todo while nothing is picked, the others while they are. */
export function rowOn(filter: TagFilter, row: FilterRow): boolean {
  if (row.kind === "todo") return !filter.spaces.length && !filter.nodes.length;
  return row.kind === "node" ? filter.nodes.includes(row.name) : filter.spaces.includes(row.key);
}

function flip(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** A row pressed: Todo lets go of everything, any other is switched on or off beside what is already picked. */
export function pressRow(filter: TagFilter, row: FilterRow): TagFilter {
  if (row.kind === "todo") return { spaces: [], nodes: [] };
  return row.kind === "node" ? { ...filter, nodes: flip(filter.nodes, row.name) } : { ...filter, spaces: flip(filter.spaces, row.key) };
}

/** "only" on a row: this one thing and nothing else, of either kind. */
export function onlyRow(row: FilterRow): TagFilter {
  if (row.kind === "todo") return { spaces: [], nodes: [] };
  return row.kind === "node" ? { spaces: [], nodes: [row.name] } : { spaces: [row.key], nodes: [] };
}

/** Backspace in the empty field: the last one picked is let go — a workspace before a node, since the strip draws the workspaces last. */
export function dropLast(filter: TagFilter): TagFilter {
  if (filter.spaces.length) return { ...filter, spaces: filter.spaces.slice(0, -1) };
  return { ...filter, nodes: filter.nodes.slice(0, -1) };
}

/** A row's id among its siblings, for keys and for `aria-activedescendant`. */
export function rowId(row: FilterRow): string {
  return row.kind === "todo" ? "todo" : row.kind === "node" ? `node-${row.name}` : `space-${row.key}`;
}
