/**
 * A board column popped out as a window of its own, over every application.
 *
 * The owner, 2026-11-25: "I want to be able to pop out a column of a board,
 * same way we do with a card, so I can see it all the time on top of stuff
 * and resize it in kururu." A card already went that way — a note window
 * (`desktop/notes.js`) — and a column goes in the same windows, as their
 * second kind: the desktop keeps where it is, how big, folded or not and
 * whether it is up, and its page (`ColumnPage.tsx`) is the board itself
 * drawn with one column, so a card in it is opened, edited, run, dragged
 * and added exactly as on the board.
 *
 * **A column is named by its board's key and its own id.** Not by a
 * workspace's `id`, which is a counter minted afresh on every cold start
 * (`Workspace.key` says why), so a column left up across a relaunch would
 * come back as another workspace's. A board's key is the profile's for the
 * profile's board and the workspace's for a workspace's, and a lane's id is
 * minted once and never given to another column (`mintLaneId`); the four
 * fixed ones are the same on every workspace, which is why the board's key
 * is in it at all. Neither key has a `:` in it, so the first one splits
 * them.
 *
 * Desktop only. A page has nothing over another application, and a column
 * in a browser or on the phone is already on its board; where the bridge
 * cannot pop one out (`canPopColumn`), the board draws no button for it.
 */
import type { BoardLane } from "../../shared/board";
import type { Profile } from "../../shared/model";
import { isRemote } from "../../shared/remote";
import { desktop } from "./desktop";

/** Where a column is: its board's key — the profile's or a workspace's — and its own id. */
export interface ColumnAt {
  board: string;
  lane: string;
}

/** A column's id, as its window is kept under: `<board key>:<lane id>`. */
export function columnId(board: string, lane: string): string {
  return `${board}:${lane}`;
}

/** A column's id read back, or null for anything that is not one. */
export function parseColumnId(id: unknown): ColumnAt | null {
  if (typeof id !== "string") return null;
  const at = id.indexOf(":");
  if (at <= 0 || at === id.length - 1) return null;
  return { board: id.slice(0, at), lane: id.slice(at + 1) };
}

/**
 * Whether a board drawn here may pop a column out: in the desktop app, from
 * a bridge that knows how, and not for another node's workspace, whose board
 * is in this node's snapshot only while it is on screen.
 */
export function canPopColumn(workspaceId: string | null = null): boolean {
  if (workspaceId !== null && isRemote(workspaceId)) return false;
  return typeof desktop()?.notes?.popColumn === "function";
}

/**
 * Pop a column out, or bring its window forward when it is out already. The
 * names ride along for the menu bar's list until the window's page says them
 * itself.
 */
export function popOutColumn(profile: Profile, board: { key: string; name: string }, lane: BoardLane): void {
  void desktop()
    ?.notes?.popColumn?.({
      columnId: columnId(board.key, lane.id),
      profileKey: profile.key,
      profileName: profile.name,
      title: lane.name,
      board: board.name,
    })
    .catch(() => {});
}

/** The row on a column's menu that pops it out, beside the button in its head. */
export function popColumnItem(run: () => void): { label: string; run: () => void } {
  return { label: "Pop out as a window", run };
}
