/**
 * The snapshot, sent as what changed since the last one a client was sent.
 *
 * It exists because the snapshot was the whole active profile every time,
 * and the whole profile is mostly its boards: 1.32 MB of a 1.44 MB snapshot
 * on 2026-11-02, re-sent to every client on every hook report of every agent,
 * so a PreToolUse that moved one sidebar line moved a megabyte and a half to
 * each window and phone and cost each of them a 20 ms parse (the 2026-11-02
 * review, §2.1). What a report actually changes is one agent; what a card's
 * run changes is one card on one board.
 *
 * So a client that asks for it (`?delta=1` on its socket) is sent the full
 * snapshot once, on connect, and after that a `delta`: the top-level fields
 * whose JSON moved, whole; the profile without its boards, when anything of
 * it but a board moved; the agents and each board's cards as a keyed patch
 * — the items whose JSON moved, and the order when it did; and a board that
 * appeared whole, one that went as null. Nothing changed is nothing sent.
 *
 * **One message, not a message per board.** The review asked for per-board
 * messages with versions. A board and the profile that lists its workspace
 * are one change — a card sent to a new workspace moves both — and two
 * messages are a frame drawn between them, a workspace whose board has not
 * arrived. One delta is applied whole or not at all, and on one ordered
 * socket the version a board is at is simply the last delta, so none is
 * carried. A client that cannot apply one says so (`resync`) and is sent the
 * full snapshot again.
 *
 * **Whose diff.** The server keeps, per client, the frame it last sent
 * (`Frame`: the JSON of each part, already stringified). Most clients were
 * sent the same frame, so a broadcast computes each distinct delta once. A
 * board's frame is kept by the board's identity: boards are replaced, never
 * edited in place, everywhere in `workspaces.ts` — it already decides
 * whether to save by `next === workspace.board` — so a board that is the same
 * object is not stringified again, which is the 25 ms the old snapshot spent.
 *
 * Old clients, which do not ask, are sent full snapshots as before, so a
 * phone still holding last week's page and a child on an older kururu both
 * keep working; a new client of an old server is sent full snapshots and
 * never sees a delta.
 */
import type { Board, Card } from "./board";
import type { AgentSnapshot, Profile, SessionSnapshot, Workspace } from "./model";

/** A workspace as a delta carries it: its board travels by its key. */
export type BareWorkspace = Omit<Workspace, "board">;
/** The profile as a delta carries it: every board left out. */
export type BareProfile = Omit<Profile, "board" | "workspaces"> & { workspaces: BareWorkspace[] };

/** A list of things with ids, as what changed: the order if it moved, and every item whose JSON did. */
export interface KeyedDelta<T> {
  order?: string[];
  put?: T[];
}

/** A board's fields but its cards: `next`, `columns`, `widths`. */
export type BoardMeta = Omit<Board, "cards">;

export interface BoardDelta {
  meta?: BoardMeta;
  cards?: KeyedDelta<Card>;
}

/** The top-level fields that travel whole. */
type Whole = Omit<SessionSnapshot, "profile" | "agents">;

export interface SnapshotDelta {
  /** Top-level fields whose JSON moved, whole. */
  set?: Partial<Whole>;
  /** Top-level fields that were there and are not any more. */
  drop?: (keyof Whole)[];
  /** The profile, without its boards, when anything of it but a board moved. */
  profile?: BareProfile;
  agents?: KeyedDelta<AgentSnapshot>;
  /** By `boardKey`: what moved on each board, the whole of a new one, null for one that went. */
  boards?: Record<string, BoardDelta | null>;
}

/**
 * The key a board travels under. The profile's id for its own board, and the
 * profile's and the workspace's together for a workspace's, so a switch to
 * another profile is every old key gone and every new one arriving.
 */
export function boardKey(profileId: string, workspaceId: string | null): string {
  return workspaceId === null ? profileId : `${profileId}/${workspaceId}`;
}

/** Every board of a profile, by `boardKey`. A workspace with no board has none here. */
export function boardsOf(profile: Profile): Map<string, Board> {
  const boards = new Map<string, Board>([[boardKey(profile.id, null), profile.board]]);
  for (const workspace of profile.workspaces) if (workspace.board) boards.set(boardKey(profile.id, workspace.id), workspace.board);
  return boards;
}

export function bareProfile(profile: Profile): BareProfile {
  const { board: _board, workspaces, ...rest } = profile;
  return { ...rest, workspaces: workspaces.map(({ board: _b, ...workspace }) => workspace) };
}

function metaOf(board: Board): BoardMeta {
  const { cards: _cards, ...meta } = board;
  return meta;
}

// --- the server's half ------------------------------------------------------

interface KeyedFrame<T> {
  order: string[];
  json: Map<string, string>;
  items: Map<string, T>;
}

export interface BoardFrame {
  meta: string;
  board: Board;
  cards: KeyedFrame<Card>;
}

/** One snapshot, each part stringified: what a client was last sent, to diff the next against. */
export interface Frame {
  snapshot: SessionSnapshot;
  fields: Map<string, string>;
  profile: string;
  bare: BareProfile;
  agents: KeyedFrame<AgentSnapshot>;
  boards: Map<string, BoardFrame>;
}

function keyed<T extends { id: string }>(items: readonly T[]): KeyedFrame<T> {
  const frame: KeyedFrame<T> = { order: [], json: new Map(), items: new Map() };
  for (const item of items) {
    frame.order.push(item.id);
    frame.json.set(item.id, JSON.stringify(item));
    frame.items.set(item.id, item);
  }
  return frame;
}

/**
 * Builds frames, keeping each board's by the board's identity — see the
 * module comment for why that is safe. One per server, for its life: a
 * board nobody holds any more is let go with it.
 */
export class Framer {
  private readonly boards = new WeakMap<Board, BoardFrame>();

  board(board: Board): BoardFrame {
    let frame = this.boards.get(board);
    if (!frame) {
      frame = { meta: JSON.stringify(metaOf(board)), board, cards: keyed(board.cards) };
      this.boards.set(board, frame);
    }
    return frame;
  }

  frame(snapshot: SessionSnapshot): Frame {
    const fields = new Map<string, string>();
    for (const [key, value] of Object.entries(snapshot)) {
      if (key === "profile" || key === "agents" || value === undefined) continue;
      fields.set(key, JSON.stringify(value));
    }
    const bare = bareProfile(snapshot.profile);
    const boards = new Map<string, BoardFrame>();
    for (const [key, board] of boardsOf(snapshot.profile)) boards.set(key, this.board(board));
    return { snapshot, fields, profile: JSON.stringify(bare), bare, agents: keyed(snapshot.agents), boards };
  }
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function diffKeyed<T>(prev: KeyedFrame<T> | null, cur: KeyedFrame<T>): KeyedDelta<T> | null {
  const delta: KeyedDelta<T> = {};
  if (!prev || !sameOrder(prev.order, cur.order)) delta.order = cur.order;
  const put: T[] = [];
  for (const id of cur.order) {
    const json = cur.json.get(id);
    if (prev?.json.get(id) !== json) put.push(cur.items.get(id)!);
  }
  if (put.length) delta.put = put;
  return delta.order || delta.put ? delta : null;
}

function diffBoard(prev: BoardFrame | undefined, cur: BoardFrame): BoardDelta | null {
  if (prev === cur) return null;
  const delta: BoardDelta = {};
  if (prev?.meta !== cur.meta) delta.meta = metaOf(cur.board);
  const cards = diffKeyed(prev?.cards ?? null, cur.cards);
  if (cards) delta.cards = cards;
  // A new board is sent whole even when it is empty: its order is what says it is there.
  if (!prev) delta.cards = { order: cur.cards.order, ...(cards?.put ? { put: cards.put } : {}) };
  return delta.meta || delta.cards ? delta : null;
}

/** What turns `prev` into `cur`, or null when a client sent `prev` has nothing to be told. */
export function diffFrames(prev: Frame, cur: Frame): SnapshotDelta | null {
  if (prev === cur) return null;
  const delta: SnapshotDelta = {};
  const set: Record<string, unknown> = {};
  for (const [key, json] of cur.fields) {
    if (prev.fields.get(key) !== json) set[key] = cur.snapshot[key as keyof SessionSnapshot];
  }
  if (Object.keys(set).length) delta.set = set as Partial<Whole>;
  const drop = [...prev.fields.keys()].filter((key) => !cur.fields.has(key));
  if (drop.length) delta.drop = drop as (keyof Whole)[];
  if (prev.profile !== cur.profile) delta.profile = cur.bare;
  const agents = diffKeyed(prev.agents, cur.agents);
  if (agents) delta.agents = agents;
  const boards: Record<string, BoardDelta | null> = {};
  for (const [key, frame] of cur.boards) {
    const moved = diffBoard(prev.boards.get(key), frame);
    if (moved) boards[key] = moved;
  }
  for (const key of prev.boards.keys()) if (!cur.boards.has(key)) boards[key] = null;
  if (Object.keys(boards).length) delta.boards = boards;
  return Object.keys(delta).length ? delta : null;
}

// --- the client's half ------------------------------------------------------

/** A delta that does not fit the snapshot it was applied to. The client asks for a full one. */
export class DeltaMismatch extends Error {}

function applyKeyed<T extends { id: string }>(prev: readonly T[], delta: KeyedDelta<T> | undefined): T[] {
  if (!delta || (!delta.order && !delta.put)) return prev as T[];
  const byId = new Map(prev.map((item) => [item.id, item] as const));
  for (const item of delta.put ?? []) byId.set(item.id, item);
  return (delta.order ?? prev.map((item) => item.id)).map((id) => {
    const item = byId.get(id);
    if (!item) throw new DeltaMismatch(`no item ${id}`);
    return item;
  });
}

function applyBoard(prev: Board | undefined, delta: BoardDelta): Board {
  if (!prev && (!delta.meta || !delta.cards?.order)) throw new DeltaMismatch("a new board arrived without its meta and order");
  const meta = delta.meta ?? metaOf(prev!);
  const cards = applyKeyed(prev?.cards ?? [], delta.cards);
  if (prev && !delta.meta && cards === prev.cards) return prev;
  return { ...meta, cards };
}

/**
 * `prev` with `delta` applied. What did not move keeps its identity — an
 * agent, a card, a workspace whose board and fields are where they were —
 * so a memoised row is not drawn again for a change somewhere else.
 * Throws `DeltaMismatch` when the delta names something `prev` does not have.
 */
export function applyDelta(prev: SessionSnapshot, delta: SnapshotDelta): SessionSnapshot {
  const next: SessionSnapshot = { ...prev, ...(delta.set ?? {}) };
  for (const key of delta.drop ?? []) delete (next as unknown as Record<string, unknown>)[key];
  next.agents = applyKeyed(prev.agents, delta.agents);
  if (!delta.profile && !delta.boards) return next;

  const before = boardsOf(prev.profile);
  const boards = new Map(before);
  for (const [key, moved] of Object.entries(delta.boards ?? {})) {
    if (moved === null) boards.delete(key);
    else boards.set(key, applyBoard(before.get(key), moved));
  }
  const bare = delta.profile;
  if (!bare) {
    // Only boards moved: the same profile, with the workspaces whose board did.
    const board = boards.get(boardKey(prev.profile.id, null));
    if (!board) throw new DeltaMismatch("the profile's board went");
    next.profile = {
      ...prev.profile,
      board,
      workspaces: prev.profile.workspaces.map((workspace) => {
        const now = boards.get(boardKey(prev.profile.id, workspace.id)) ?? null;
        return now === workspace.board ? workspace : { ...workspace, board: now };
      }),
    };
    return next;
  }
  const board = boards.get(boardKey(bare.id, null));
  if (!board) throw new DeltaMismatch(`no board for profile ${bare.id}`);
  const profile: Profile = {
    ...bare,
    board,
    workspaces: bare.workspaces.map((workspace) => ({ ...workspace, board: boards.get(boardKey(bare.id, workspace.id)) ?? null })),
  };
  next.profile = profile;
  return next;
}
