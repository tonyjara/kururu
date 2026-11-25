/**
 * A board column popped out as a window of its own: what a column window
 * loads (`desktop/notes.js`, `kind: "column"`).
 *
 * It is `NotePage.tsx` for a column, and for the same reasons: the same
 * build with most of it not mounted — the session and the board, no panes,
 * no emulators, no notifications — and which column it is is the main
 * process's word, asked over the bridge (`self`), never the address's.
 *
 * **One drawing of a column.** What is in the window is the board itself,
 * `BoardView` or `ProfileBoard`, told to draw one column (`popped`), so a
 * card in it opens, edits, runs, moves and is dragged within the column as
 * it is on the board, the add at its foot is the board's composer, and every
 * change from anywhere is in it on the next snapshot. What is the window's
 * is only its head: it is what the window is dragged by, and the board's
 * fold, grip and width give way there to the window's fold and close.
 *
 * It tells the main process what it is showing, as a note does: the column
 * (`here`), nothing because its profile is not the active one (`away` — the
 * snapshot carries only the active profile's boards), or that the column or
 * its workspace is gone, drawn so it can be closed; with the column's name
 * and its board's for the menu bar's list.
 */
import { useEffect, useRef, useState } from "react";
import { boardLanes, emptyBoard } from "../../../shared/board";
import { visibleLaunchers } from "../../../shared/launchers";
import { mascotFor, type Profile, type Workspace } from "../../../shared/model";
import { parseColumnId } from "../columns";
import type { NoteReport, NoteSelf } from "../desktop";
import { useInterface } from "../fonts";
import { desktopNotes, notesProfile } from "../notes";
import { installReload } from "../reload";
import { useKururu } from "../session";
import { BoardView } from "./Board";
import { Icon } from "./Icon";
import type { PoppedColumn } from "./Lanes";
import { groundOf } from "./NotePage";
import { ProfileBoard } from "./ProfileBoard";

/** The board a column window's column is on: the profile's, a workspace's, or none that is here. */
function boardOf(profile: Profile, key: string): { workspace: Workspace | null } | null {
  if (key === profile.key) return { workspace: null };
  const workspace = profile.workspaces.find((w) => w.key === key);
  return workspace ? { workspace } : null;
}

export function ColumnPage() {
  const { snapshot } = useKururu();
  useInterface(snapshot);
  const [self, setSelf] = useState<NoteSelf | null>(null);
  const [focused, setFocused] = useState(() => document.hasFocus());
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    document.documentElement.classList.add("note-page");
    const notes = desktopNotes();
    // An agent's reload reaches a column as it does a note, and holds the same way.
    const stopReload = installReload("note");
    const stopSelf = notes?.onSelf(setSelf) ?? (() => {});
    const stopFocus = notes?.onFocus(setFocused) ?? (() => {});
    void notes?.self().then(setSelf, () => {});
    return () => {
      stopReload();
      stopSelf();
      stopFocus();
      document.documentElement.classList.remove("note-page");
    };
  }, []);

  const profile = snapshot?.profile ?? null;
  // A card's menu here pops the card out as a note, beside this window.
  useEffect(() => {
    notesProfile(profile);
  }, [profile]);

  const at = self ? parseColumnId(self.cardId) : null;
  const away = !!profile && !!self && profile.key !== self.profileKey;
  const board = profile && at && !away ? boardOf(profile, at.board) : null;
  const lane = board && at && profile ? boardLanes(board.workspace ? (board.workspace.board ?? emptyBoard()) : profile.board).find((l) => l.id === at.lane) : undefined;
  const present: NoteReport["present"] | null = !profile || !self ? null : away ? "away" : lane ? "here" : "gone";
  const title = lane?.name ?? "";
  const boardName = board ? (board.workspace?.name ?? profile?.name ?? "") : "";
  useEffect(() => {
    document.title = title ? `${title} — ${boardName}` : "Column";
  }, [title, boardName]);

  /**
   * Said once the column is drawn, and again only when what is said changes —
   * `NotePage`'s report: the ground under it, so a resize flashes nothing
   * else, and its head's height, which is what a folded column is.
   */
  useEffect(() => {
    const notes = desktopNotes();
    if (!notes || !present) return;
    const head = root.current?.querySelector(".board-col-head, .note-head");
    notes.report({
      present,
      title,
      code: boardName,
      profileName: present === "away" ? undefined : profile?.name,
      background: root.current ? groundOf(root.current.querySelector(".board-col") ?? root.current) : undefined,
      head: head ? Math.ceil(head.getBoundingClientRect().height) : undefined,
    });
  }, [present, title, boardName, profile?.name]);

  if (!snapshot || !self || !profile || !present || present === "away") return null;
  const notes = desktopNotes();
  const popped: PoppedColumn = {
    lane: at?.lane ?? "",
    collapsed: self.collapsed,
    fold: () => {
      const collapsed = !self.collapsed;
      setSelf({ ...self, collapsed });
      notes?.fold(collapsed);
    },
    close: () => notes?.close(),
    leave: () => notes?.raiseMain(),
    refer: notes?.referCard ? (cardId) => notes.referCard?.(cardId) : undefined,
  };
  return (
    <section
      ref={root}
      className={["column-window", self.collapsed ? "column-window-shut" : "", focused ? "column-window-focused" : ""].filter(Boolean).join(" ")}
      aria-label={lane ? `Column: ${lane.name}` : "Column"}
      data-ink-what={lane ? `popped-out column ${lane.name} of ${boardName}` : "popped-out column"}
      data-ink-name={title}
    >
      {present === "gone" || !board ? (
        <header className="note-head">
          <span className="note-title note-title-gone">Column gone</span>
          <span className="note-actions">
            <button className="board-icon-btn" title="Close the window" aria-label="Close" onClick={popped.close}>
              <Icon name="close" />
            </button>
          </span>
        </header>
      ) : board.workspace ? (
        <BoardView
          workspaceId={board.workspace.id}
          workspaceName={board.workspace.name}
          board={board.workspace.board ?? emptyBoard()}
          agents={snapshot.agents}
          mascot={mascotFor(snapshot.mascots, board.workspace.mascotId)}
          launchers={visibleLaunchers(snapshot.launch)}
          focusedAgentId={null}
          popped={popped}
        />
      ) : (
        <ProfileBoard profile={profile} popped={popped} />
      )}
    </section>
  );
}
