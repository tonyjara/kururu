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
 *
 * **A workspace's projects hang under it** (`shared/subprojects.ts`),
 * indented, each a switch of its own: Shared Landings is everything in it,
 * Yetapá is Yetapá. A project lately talked about stands in Lately by itself,
 * with its workspace's name beside it, and is not drawn again under its
 * workspace. Typing finds a project by any of its names, accents aside, so
 * "yeta" is Yetapá and "guasu" is Parque Guasú; a workspace found brings its
 * projects with it.
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

/** A workspace or a project as the panel is given it. */
export interface FilterSpace {
  key: string;
  name: string;
  /** A project's workspace; absent for a workspace. */
  parent?: { key: string; name: string };
  /** A project's other names, which typing finds it by too. */
  names?: readonly string[];
}

export type FilterRow =
  | { kind: "todo" }
  | ({ kind: "node" } & FilterNode)
  | {
      kind: "space";
      key: string;
      name: string;
      /** A project's workspace, by key and by name for the hint beside it; null for a workspace. */
      parent: { key: string; name: string } | null;
      /** 1 for a project drawn under its workspace, which needs no hint. */
      depth: 0 | 1;
    };

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
  /** Workspace and project keys, the most recently talked about first. */
  lately: readonly string[];
  /** Every workspace of the profile, and every project shown in one. */
  spaces: readonly FilterSpace[];
}): FilterGroup[] {
  const { typed, nodes, lately, spaces } = input;
  const tops = spaces.filter((space) => !space.parent);
  const projectsOf = (key: string) => spaces.filter((space) => space.parent?.key === key).sort((a, b) => a.name.localeCompare(b.name));
  const byName = [...tops].sort((a, b) => a.name.localeCompare(b.name));
  const nodeRow = (node: FilterNode): FilterRow => ({ kind: "node", ...node });
  const spaceRow = (space: FilterSpace, depth: 0 | 1 = 0): FilterRow => ({ kind: "space", key: space.key, name: space.name, parent: space.parent ?? null, depth });
  /** A workspace's row with its projects under it, but for the ones drawn elsewhere. */
  const withProjects = (space: FilterSpace, elsewhere: ReadonlySet<string>): FilterRow[] => [
    spaceRow(space),
    ...projectsOf(space.key)
      .filter((p) => !elsewhere.has(p.key))
      .map((p) => spaceRow(p, 1)),
  ];
  if (typed.trim()) {
    const score = (space: FilterSpace) => Math.max(nameMatch(space.name, typed), ...(space.names ?? []).map((n) => nameMatch(n, typed))) as 0 | 1 | 2;
    const hits = [...nodes.map((node) => ({ row: nodeRow(node), space: null as FilterSpace | null, score: nameMatch(node.name, typed) })), ...[...spaces].sort((a, b) => a.name.localeCompare(b.name)).map((space) => ({ row: spaceRow(space), space, score: score(space) }))]
      .filter((hit) => hit.score > 0)
      // A stable sort: within a score, the nodes stay first and the names in order.
      .sort((a, b) => b.score - a.score);
    const foundTops = new Set(hits.filter((hit) => hit.space && !hit.space.parent).map((hit) => hit.space!.key));
    const rows: FilterRow[] = [];
    for (const hit of hits) {
      if (!hit.space) rows.push(hit.row);
      // A project whose workspace was found too is drawn under it.
      else if (hit.space.parent && foundTops.has(hit.space.parent.key)) continue;
      else if (hit.space.parent) rows.push(hit.row);
      else rows.push(...withProjects(hit.space, new Set()));
    }
    return rows.length ? [{ title: null, rows }] : [];
  }
  const recent = lately
    .filter((key, i, all) => all.indexOf(key) === i)
    .map((key) => spaces.find((space) => space.key === key))
    .filter((space): space is FilterSpace => space !== undefined)
    .slice(0, LATELY_MAX);
  const inLately = new Set(recent.map((space) => space.key));
  const rest = byName.filter((space) => !inLately.has(space.key));
  const groups: FilterGroup[] = [{ title: null, rows: [{ kind: "todo" }] }];
  if (nodes.length > 1) groups.push({ title: "Nodes", rows: nodes.map(nodeRow) });
  if (recent.length) groups.push({ title: "Lately", rows: recent.flatMap((space) => (space.parent ? [spaceRow(space)] : withProjects(space, inLately))) });
  if (rest.length) groups.push({ title: recent.length ? "Everything else" : "Workspaces", rows: rest.flatMap((space) => withProjects(space, inLately)) });
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

/** Whether a project's row is covered by its workspace being picked: drawn as on, more quietly, since the workspace is everything in it. */
export function rowCovered(filter: TagFilter, row: FilterRow): boolean {
  return row.kind === "space" && row.parent !== null && filter.spaces.includes(row.parent.key);
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
