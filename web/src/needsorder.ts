/**
 * The order the Needs drawer is drawn in, and which of its groups are folded,
 * as the person left them.
 *
 * It exists because the rule's order is right for a few things and wrong for
 * ten. `shared/needs.ts` sorts a workspace's needs asking first, then cards
 * in board order, and its workspaces in the sidebar's — which is the order
 * nobody has thought about yet, and the first time one workspace has ten
 * cards in it the person wants that block out of the way, or its cards in
 * the order they mean to take them. So this keeps two things beside the
 * rule, and changes nothing the rule decides: what is in the queue, how many
 * there are and which band each workspace is in are still `needsOf`'s.
 *
 * **The order is a list of keys, and what it does not name goes at the
 * end.** A workspace by its `key` and a card by its id, both of which
 * outlive a restart, where a workspace's `id` and an agent's do not. A group
 * or a card that appears after the person sorted is one they have not placed
 * yet, so it goes after the ones they have — at the foot of its group, in
 * the rule's order — rather than being slotted in by a guess. A key whose
 * thing is out of the drawer for now (a workspace gone quiet, a card moved
 * to To do) keeps its place in the list, so it comes back where it was.
 *
 * **An agent row with no card keeps the rule's place.** Its need is a
 * moment's — a question in its terminal, a turn nobody saw end — and it
 * leaves the drawer as soon as it is looked at; its id is reassigned when
 * the host restarts, so a place saved by it would not survive what the
 * place is saved across; and an agent asking holds a turn up, which is why
 * the rule puts it first. So the cards are moved around those rows rather
 * than the rows with them: the rows stay at the indices the rule gave them,
 * and the cards fill the rest in the person's order.
 *
 * **"Your board" is ordered by its column, not here.** Its cards are the
 * profile board's Needs you, in that column's order, and a second order for
 * the same list kept in one browser would make the board and the drawer
 * disagree about the to-dos. So moving one of those is `move-profile-card`,
 * on the server, and the drawer only keeps where the group goes among the
 * workspaces' (`BOARD_GROUP`).
 *
 * Per device, on the fold's argument (`NeedsDrawer.tsx`'s Quiet band, the
 * sidebar's disclosures): this is the way a list is arranged to be read, and
 * a phone sorting its drawer must not rearrange the desktop's. Kept per
 * profile, since the groups are a profile's workspaces.
 */
import { useSyncExternalStore } from "react";
import type { Need, ProfileNeeds, WorkspaceNeeds } from "../../shared/needs";
import type { Profile } from "../../shared/model";

/** The "Your board" group's key among a profile's workspace keys — which are `wk…`, so it is never one. */
export const BOARD_GROUP = "board";

/** One profile's order. Missing is the rule's order. */
export interface NeedsOrder {
  /** Workspace keys and `BOARD_GROUP`, in the order the groups were put. */
  groups: string[];
  /** By workspace key, that group's card ids in the order they were put. */
  cards: Record<string, string[]>;
}

export const NO_ORDER: NeedsOrder = { groups: [], cards: {} };

/**
 * `items` in the saved order: those it names, by their place in it, then the
 * rest in the order they came. Stable, so with nothing saved it is `items`.
 */
export function arrange<T>(items: readonly T[], keyOf: (item: T) => string, saved: readonly string[]): T[] {
  const place = new Map(saved.map((key, index) => [key, index]));
  const placed = items.filter((item) => place.has(keyOf(item)));
  placed.sort((a, b) => place.get(keyOf(a))! - place.get(keyOf(b))!);
  return [...placed, ...items.filter((item) => !place.has(keyOf(item)))];
}

/**
 * The saved list once the drawn keys are in `next`'s order. `drawn` is what
 * is on screen now, as `arrange` put it, and `next` the same keys moved.
 * A saved key not drawn keeps its place among the rest, so a group gone
 * quiet comes back where it was; one `known` no longer knows — a workspace
 * deleted, a card gone from its board — is dropped, which is all the
 * pruning this list ever needs.
 */
export function reorder(
  saved: readonly string[],
  drawn: readonly string[],
  next: readonly string[],
  known: (key: string) => boolean,
): string[] {
  const all = [...saved.filter((key) => known(key) || drawn.includes(key))];
  for (const key of drawn) if (!all.includes(key)) all.push(key);
  const moving = new Set(next);
  const queue = [...next];
  return all.map((key) => (moving.has(key) ? queue.shift()! : key));
}

/** `list` with `key` taken out and put back at `index`, counted with it out — `moveCard`'s index. */
export function moveTo(list: readonly string[], key: string, index: number): string[] {
  const rest = list.filter((k) => k !== key);
  if (rest.length === list.length) return [...list];
  const at = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, at), key, ...rest.slice(at)];
}

/**
 * Where a drop lands, as a `moveTo` index: `dragged` let go before or after
 * `target`, in the drawn `rows`. Counted over the rows `counts` — the cards,
 * in a group whose agent rows stay put — with the dragged one taken out, so
 * a card dropped on an agent row lands among the cards beside it.
 */
export function dropIndex(
  rows: readonly string[],
  dragged: string,
  target: string,
  after: boolean,
  counts: (key: string) => boolean = () => true,
): number {
  const rest = rows.filter((key) => key !== dragged);
  const at = rest.indexOf(target);
  const upTo = at === -1 ? rest.length : at + (after ? 1 : 0);
  return rest.slice(0, upTo).filter(counts).length;
}

/** Where one thing can go from where it is in a list: the four moves a menu offers, each an index for `moveTo`, or absent where it is a no-op. */
export function movesFrom(at: number, length: number): { up?: number; down?: number; top?: number; bottom?: number } {
  if (at < 0 || length < 2) return {};
  return {
    ...(at > 0 ? { up: at - 1, top: 0 } : {}),
    ...(at < length - 1 ? { down: at + 1, bottom: length - 1 } : {}),
  };
}

/**
 * A workspace's needs with its cards in the saved order and every row
 * without a card where the rule put it — see the module comment for why
 * those stay. The cards fill the indices cards had, so a group sorted once
 * and grown since has its new cards in its last card places.
 */
export function arrangeNeeds(needs: readonly Need[], saved: readonly string[] | undefined): Need[] {
  if (!saved?.length) return [...needs];
  const cards = arrange(
    needs.filter((need) => need.card),
    (need) => need.card!.id,
    saved,
  );
  return needs.map((need) => (need.card ? cards.shift()! : need));
}

/**
 * The profile's needs as the drawer draws them, and so as Next walks them:
 * the waiting workspaces in the saved order, each with its cards arranged.
 * Only the `needs` band moves, into the places it held, so the Working and
 * Quiet bands keep the sidebar's order — sorting is a thing done to the
 * queue. The counts are untouched; they are the same things in another order.
 */
export function arrangedNeeds(needs: ProfileNeeds, order: NeedsOrder): ProfileNeeds {
  if (order.groups.length === 0 && Object.keys(order.cards).length === 0) return needs;
  const waiting = arrange(
    needs.workspaces.filter((w) => w.band === "needs"),
    (w) => w.workspace.key,
    order.groups,
  ).map((w): WorkspaceNeeds => ({ ...w, needs: arrangeNeeds(w.needs, order.cards[w.workspace.key]) }));
  return {
    ...needs,
    workspaces: needs.workspaces.map((w) => (w.band === "needs" ? waiting.shift()! : w)),
  };
}

/**
 * The order with one group's cards put in `next`'s order. Cards no longer on
 * that workspace's board are dropped, and so is any workspace the profile no
 * longer has, while there is a profile to ask.
 */
export function withCards(
  order: NeedsOrder,
  profile: Profile,
  workspaceKey: string,
  drawn: readonly string[],
  next: readonly string[],
): NeedsOrder {
  const workspace = profile.workspaces.find((w) => w.key === workspaceKey);
  if (!workspace) return order;
  const onBoard = new Set((workspace.board?.cards ?? []).map((card) => card.id));
  const cards = { ...pruneCards(order.cards, profile) };
  cards[workspaceKey] = reorder(order.cards[workspaceKey] ?? [], drawn, next, (id) => onBoard.has(id));
  return { groups: order.groups, cards };
}

/** The order with the groups put in `next`'s order. */
export function withGroups(order: NeedsOrder, profile: Profile, drawn: readonly string[], next: readonly string[]): NeedsOrder {
  const keys = new Set(profile.workspaces.map((w) => w.key));
  return {
    groups: reorder(order.groups, drawn, next, (key) => key === BOARD_GROUP || keys.has(key)),
    cards: pruneCards(order.cards, profile),
  };
}

function pruneCards(cards: Record<string, string[]>, profile: Profile): Record<string, string[]> {
  const keys = new Set(profile.workspaces.map((w) => w.key));
  return Object.fromEntries(Object.entries(cards).filter(([key]) => keys.has(key)));
}

/**
 * A saved order read back, or nothing: whatever storage hands over is a
 * value some other version of this page — or a person with the devtools
 * open — may have written, so every field is checked rather than trusted.
 */
export function parseOrders(raw: unknown): Record<string, NeedsOrder> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  const out: Record<string, NeedsOrder> = {};
  for (const [profileKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { groups, cards } = value as { groups?: unknown; cards?: unknown };
    const byGroup: Record<string, string[]> = {};
    if (cards && typeof cards === "object" && !Array.isArray(cards)) {
      for (const [key, ids] of Object.entries(cards as Record<string, unknown>)) {
        const list = strings(ids);
        if (list.length) byGroup[key] = list;
      }
    }
    out[profileKey] = { groups: strings(groups), cards: byGroup };
  }
  return out;
}

// ---------------------------------------------------------------------------
// The device's copy
// ---------------------------------------------------------------------------

const ORDER_KEY = "kururu.needs.order";
/**
 * The folded groups, by a key that is unique across profiles and nodes: a
 * workspace's `key`, `board:<profile key>` for "Your board", and the
 * qualified `n:<node>:<key>` for another node's workspace. A set of the
 * folded, as the sidebar's is, so a group nobody has touched arrives open:
 * a block of needs you cannot see is needs you do not notice.
 */
const SHUT_KEY = "kururu.needs.shut";

interface View {
  orders: Record<string, NeedsOrder>;
  shut: ReadonlySet<string>;
}

let view: View | null = null;
const listeners = new Set<() => void>();

/** Storage can throw — a private window, blocked site data — and then the drawer starts in the rule's order, open. */
function read(): View {
  if (view) return view;
  let orders: Record<string, NeedsOrder> = {};
  let shut: string[] = [];
  try {
    orders = parseOrders(JSON.parse(localStorage.getItem(ORDER_KEY) ?? "{}"));
  } catch {
    // The rule's order.
  }
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SHUT_KEY) ?? "[]");
    if (Array.isArray(saved)) shut = saved.filter((key): key is string => typeof key === "string");
  } catch {
    // Everything open.
  }
  view = { orders, shut: new Set(shut) };
  return view;
}

function write(next: View): void {
  view = next;
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(next.orders));
    localStorage.setItem(SHUT_KEY, JSON.stringify([...next.shut]));
  } catch {
    // Not remembered; still drawn so until the page goes.
  }
  for (const listener of listeners) listener();
}

/** This device's order for one profile, and the folded groups. */
export function useNeedsView(profileKey: string | null): { order: NeedsOrder; shut: ReadonlySet<string> } {
  const now = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
  );
  return { order: (profileKey && now.orders[profileKey]) || NO_ORDER, shut: now.shut };
}

export function setOrder(profileKey: string, order: NeedsOrder): void {
  const was = read();
  write({ ...was, orders: { ...was.orders, [profileKey]: order } });
}

export function toggleShut(groupKey: string): void {
  const was = read();
  const shut = new Set(was.shut);
  if (!shut.delete(groupKey)) shut.add(groupKey);
  write({ ...was, shut });
}
