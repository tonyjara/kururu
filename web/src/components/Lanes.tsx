/**
 * The parts of a board's columns that a person arranges — a name typed in, a
 * grip dragged, a column folded to a strip, one more added at the end, and
 * the menu that does each by a click — shared by the two boards that have
 * them.
 *
 * They were the profile's board's alone until a workspace's board took
 * columns of its own beside its four (a Backlog, say), and a second copy of
 * each would have been two columns that look alike and behave a little
 * differently on the day one of them is fixed. What stays with each board is
 * what differs: the profile's colour and its Needs you, a workspace's run
 * automation, and which verbs each sends — those come in as callbacks, so
 * nothing here knows which board it is drawing for.
 */
import { useEffect, useRef, useState } from "react";
import { LANE_NAME_MAX, type BoardLane } from "../../../shared/board";
import { Icon } from "./Icon";
import type { MenuItem } from "./Menu";

/**
 * A column in flight, as against a card: its own type so a column dropped on a
 * column's cards is not read as a card, and a card over a column's header is
 * not read as a column. Lower case because `dataTransfer.types` is.
 */
export const LANE_MIME = "application/x-kururu-lane";

/** Not an id a column can have: those are the fixed ones and `mintLaneId`'s `k…`. */
export const NEW_LANE = "\0new";

/**
 * A column being dragged by its grip, and the gap it would land in, counted
 * among all the columns including itself. Held in the board rather than read
 * off the drag, because a `dragover` may see a drag's types but never its
 * data. `onMove` is the board's move verb, given `moveLane`'s index.
 */
export function useLaneDrag(lanes: readonly BoardLane[], onMove: (laneId: string, index: number) => void) {
  const [laneDrag, setLaneDrag] = useState<{ id: string; gap: number | null } | null>(null);

  /** Which side of this column the pointer is on picks the gap: its left edge or its right. */
  const overLane = (index: number) => (event: React.DragEvent<HTMLElement>) => {
    if (!laneDrag || !event.dataTransfer.types.includes(LANE_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const box = event.currentTarget.getBoundingClientRect();
    const gap = event.clientX > box.left + box.width / 2 ? index + 1 : index;
    if (gap !== laneDrag.gap) setLaneDrag({ ...laneDrag, gap });
  };

  /**
   * The gap becomes `moveLane`'s index, which counts the columns without the
   * moved one — so a gap to its right is one fewer. The gaps either side of it
   * are where it already is, and send nothing.
   */
  const dropLane = () => {
    if (!laneDrag || laneDrag.gap === null) return setLaneDrag(null);
    const from = lanes.findIndex((lane) => lane.id === laneDrag.id);
    const to = laneDrag.gap > from ? laneDrag.gap - 1 : laneDrag.gap;
    if (from >= 0 && to !== from) onMove(laneDrag.id, to);
    setLaneDrag(null);
  };

  /** The classes a column wears while a column is in flight: lifted, or with the bar of the gap beside it. */
  const laneClasses = (laneId: string, index: number) =>
    [
      laneDrag?.id === laneId ? "board-col-lifted" : "",
      laneDrag?.gap === index ? "board-col-before" : "",
      laneDrag?.gap === index + 1 && index === lanes.length - 1 ? "board-col-after" : "",
    ].join(" ");

  /**
   * The handle a column is dragged by, open or folded. Only the grip is
   * draggable, so the header's buttons and a rename's input keep their clicks
   * and their text selection.
   */
  const grip = (laneId: string) => (
    <span
      className="board-col-grip"
      draggable
      title="Drag to move this column"
      aria-hidden="true"
      onDragStart={(event) => {
        event.dataTransfer.setData(LANE_MIME, laneId);
        event.dataTransfer.effectAllowed = "move";
        const col = event.currentTarget.closest(".board-col");
        if (col) {
          const box = col.getBoundingClientRect();
          event.dataTransfer.setDragImage(col, event.clientX - box.left, event.clientY - box.top);
        }
        setLaneDrag({ id: laneId, gap: null });
      }}
      onDragEnd={() => setLaneDrag(null)}
    >
      <Icon name="grip" />
    </span>
  );

  return { overLane, dropLane, laneClasses, grip };
}

/** Whether a drag is a column's rather than a card's. */
export function isLaneDrag(event: React.DragEvent): boolean {
  return event.dataTransfer.types.includes(LANE_MIME);
}

/**
 * A folded column's strip: the whole of it is the button that opens it
 * again, as in Jira — the name on its side is the thing to press. The dot is
 * the column's colour, on the board that gives columns one.
 */
export function FoldedLane({ lane, count, onOpen, dot = true }: { lane: BoardLane; count: number; onOpen: () => void; dot?: boolean }) {
  return (
    <button
      className="board-col-open"
      title={`Expand ${lane.name}`}
      aria-label={`Expand ${lane.name}, ${count} card${count === 1 ? "" : "s"}`}
      aria-expanded={false}
      onClick={onOpen}
    >
      <Icon name="caret" />
      {dot && <span className="board-col-dot" />}
      <span className="board-col-count">{count}</span>
      <span className="board-col-name">{lane.name}</span>
    </button>
  );
}

/** The fold button in an open column's header; its caret points the way the column would go. */
export function FoldButton({ onFold }: { onFold: () => void }) {
  return (
    <button
      className="pane-btn board-col-fold"
      title="Collapse this column — it still takes a card dropped on it"
      aria-label="Collapse column"
      aria-expanded
      onClick={onFold}
    >
      <Icon name="caret" />
    </button>
  );
}

/**
 * A column's way out of its board into a window of its own (`columns.ts`),
 * in its head beside the add — the pin a card's editor pops a card out with.
 */
export function PopOutButton({ name, onPopOut }: { name: string; onPopOut: () => void }) {
  return (
    <button className="pane-btn" title={`Pop ${name} out as a window over everything`} aria-label="Pop out as a window" onClick={onPopOut}>
      <Icon name="pin" />
    </button>
  );
}

/**
 * What a board drawn as a popped-out column's window (`ColumnPage.tsx`) is
 * told: which column, whether the window is folded to its head, and the
 * window's own verbs, which go to the desktop rather than to the board — a
 * fold is the window getting shorter, not the column folding on the board.
 */
export interface PoppedColumn {
  lane: string;
  collapsed: boolean;
  fold: () => void;
  close: () => void;
  /** Something a card did happens in the main window — an agent revealed — so that is brought up. */
  leave: () => void;
  /**
   * A card pointed at in Kuru's box, which is the main window's: the window
   * has none, so the card's id goes across and the main window writes the
   * reference, as a note's does. Absent, the card's menu has no row for it.
   */
  refer?: (cardId: string) => void;
}

/** A card's "Reference in Kuru" in a popped-out column's window — `referItem`'s row, sent across by id. */
export function poppedReferItem(refer: (cardId: string) => void, cardId: string): MenuItem {
  return { label: "Reference in Kuru", sep: true, run: () => refer(cardId) };
}

/**
 * The window's two buttons, where the board's fold is in a column's head:
 * fold it to the head and back, and close it — the note window's pair, and
 * with the same words.
 */
export function PoppedButtons({ popped }: { popped: PoppedColumn }) {
  return (
    <span className="column-window-actions">
      <button
        className="board-icon-btn"
        title={popped.collapsed ? "Unfold" : "Fold to the title bar"}
        aria-label={popped.collapsed ? "Unfold" : "Fold"}
        aria-expanded={!popped.collapsed}
        onClick={popped.fold}
      >
        <Icon name={popped.collapsed ? "unfold" : "fold"} />
      </button>
      <button className="board-icon-btn" title="Close the window — the column stays on its board" aria-label="Close" onClick={popped.close}>
        <Icon name="close" />
      </button>
    </span>
  );
}

/**
 * The tile after the last column: a button that turns into a column whose
 * name is being typed, and is sent once it has one. `naming` is the board's,
 * since a rename uses the same field and only one is open at a time.
 */
export function AddLane({ naming, onNaming, onAdd }: { naming: boolean; onNaming: (on: boolean) => void; onAdd: (name: string) => void }) {
  if (naming)
    return (
      <section className="board-col board-col-new">
        <header className="board-col-head">
          <LaneName
            name=""
            onDone={(name) => {
              if (name) onAdd(name);
              onNaming(false);
            }}
          />
        </header>
      </section>
    );
  return (
    <button className="board-col-add" onClick={() => onNaming(true)}>
      <Icon name="add" /> Add column
    </button>
  );
}

/**
 * A column's menu, the rows both boards have. Deleting one says where its
 * cards will go, which is the whole of what could surprise anybody about it —
 * see `laneInto`; a column that cannot be deleted or renamed has no row for
 * it. `extra` goes after the rename, for what one board has and the other
 * does not.
 */
export function laneMenuItems(args: {
  lanes: readonly BoardLane[];
  lane: BoardLane;
  count: number;
  /** Where its cards would go, or null for a column that cannot be deleted. */
  into: BoardLane | null;
  fixed: boolean;
  extra?: MenuItem[];
  rename: () => void;
  /** Absent in a popped-out column's window, where the board's fold is not the window's. */
  collapse?: () => void;
  move: (index: number) => void;
  remove: () => void;
}): MenuItem[] {
  const { lanes, lane, count, into, fixed } = args;
  const index = lanes.indexOf(lane);
  return [
    ...(fixed ? [] : [{ label: "Rename", run: args.rename }]),
    ...(args.extra ?? []),
    ...(args.collapse ? [{ label: "Collapse", run: args.collapse }] : []),
    ...(index > 0 ? [{ label: "Move left", run: () => args.move(index - 1) }] : []),
    ...(index < lanes.length - 1 ? [{ label: "Move right", run: () => args.move(index + 1) }] : []),
    ...(into
      ? [
          {
            label: "Delete column",
            sep: true,
            danger: true,
            hint: count ? `${count} card${count === 1 ? "" : "s"} → ${into.name}` : undefined,
            run: args.remove,
          },
        ]
      : []),
  ];
}

/**
 * A column's name as a field, for making one or renaming it. Enter or leaving
 * the field keeps what was typed, since a name half-typed and clicked away from
 * was still meant; Escape is the one way to change nothing — and is stopped
 * here so it means only that.
 */
export function LaneName({ name, onDone }: { name: string; onDone: (name: string) => void }) {
  const [value, setValue] = useState(name);
  const field = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (next: string) => {
    if (done.current) return;
    done.current = true;
    onDone(next.trim());
  };
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  return (
    <input
      ref={field}
      className="board-col-input"
      value={value}
      maxLength={LANE_NAME_MAX}
      placeholder="Column name"
      aria-label="Column name"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(value);
        if (event.key === "Escape") {
          event.stopPropagation();
          finish("");
        }
      }}
    />
  );
}
