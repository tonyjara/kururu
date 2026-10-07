/**
 * The profile's board, drawn over the window: columns of cards that belong to
 * no workspace yet — three to start with, and whatever else a person makes.
 *
 * It exists because a workspace's board is a place for work you know the
 * checkout of, and a lot of work is written down before that is known — "the
 * login page flickers on the phone" is a card before it is anybody's branch.
 * Written on some workspace's board it would be filed in the wrong place, and
 * the robot on it would start an agent in the wrong directory. So the profile
 * gets a board of its own, and the one thing it does that a workspace's board
 * does not is *send* a card to a workspace, where the robot is.
 *
 * An overlay rather than a tab, which is the decision worth defending. A tab
 * lives in a workspace's layout, and this board is precisely the one that is
 * no workspace's: a tab for it would have to be in every workspace or in one
 * arbitrarily, and either way switching workspace would move it. Over the
 * window it is the same board from wherever it is opened, on the phone as on
 * the desktop.
 *
 * Deliberately a smaller thing than `BoardView` rather than that component
 * with half of it switched off. Everything that makes that one long — runs,
 * worktrees, dev servers, the questions a move to Done asks — is about an
 * agent, and there is no agent here; a flag threaded through all of it would
 * be a second component hiding inside the first. What is shared is what is
 * the same: the composer, the columns' order, and the stylesheet.
 *
 * It has two views, and the second is `Timeline.tsx`: the same cards by when
 * they are for. Which card is being edited is kept here rather than in either
 * view, so that a card opened in one is still open in the other.
 */
import { useEffect, useRef, useState } from "react";
import { boardLanes, cardCode, columnCards, LANE_NAME_MAX, LANES_MAX, type BoardLane, type Card } from "../../../shared/board";
import type { Profile } from "../../../shared/model";
import { colorValue } from "../colors";
import * as api from "../session";
import { CardWhen, Composer, dropDraft, useComposerInView } from "./Board";
import { Icon } from "./Icon";
import { Menu, type MenuAt, type MenuItem } from "./Menu";
import { ColorPicker } from "./Sidebar";
import { PROFILE_CARD_MIME as CARD_MIME, Timeline } from "./Timeline";

/**
 * Which view the board was last left in, so that it opens in it. Out here for
 * the reason `drafts` is in `Board.tsx`: the sheet is unmounted every time it
 * is closed, and somebody who plans by the timeline should not be shown the
 * columns first each time they look.
 */
type View = "board" | "timeline";
let lastView: View = "board";
/** Not an id a column can have: those are the fixed three and `mintLaneId`'s `k…`. */
const NEW_LANE = "\0new";

/**
 * A column in flight, as against a card: its own type so a column dropped on a
 * column's cards is not read as a card, and a card over a column's header is
 * not read as a column. Lower case because `dataTransfer.types` is.
 */
const LANE_MIME = "application/x-kururu-lane";

export function ProfileBoard({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const board = profile.board;
  const lanes = boardLanes(board);
  const [view, setViewState] = useState<View>(lastView);
  const setView = (next: View) => {
    lastView = next;
    setViewState(next);
  };
  const [adding, setAdding] = useState<string | null>(null);
  const [editing, setEditingState] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ at: MenuAt; items: MenuItem[] } | null>(null);
  const [dropAt, setDropAt] = useState<{ column: string; index: number } | null>(null);
  /**
   * The column being dragged by its grip, and the gap it would land in, counted
   * among all the columns including itself. Held here rather than read off the
   * drag, because a `dragover` may see a drag's types but never its data.
   */
  const [laneDrag, setLaneDrag] = useState<{ id: string; gap: number | null } | null>(null);
  /** The column whose colour is being picked, and where its swatches open. */
  const [picking, setPicking] = useState<{ column: string; at: MenuAt } | null>(null);
  /** The column whose name is an input, for a rename; `NEW_LANE` for the one being made. */
  const [naming, setNaming] = useState<string | null>(null);
  /**
   * The card that was just sent, and where — said once in the board's header,
   * because the card leaves this board on the click and a card that simply
   * vanished reads as one that was lost.
   */
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => setSent(null), 4000);
    return () => clearTimeout(timer);
  }, [sent]);

  const draft = (key: string) => `profile\0${profile.id}\0${key}`;
  // A composer put away takes its draft with it, as on a workspace's board —
  // and here it has to: a card's dates can be changed by dragging its bar, and
  // a draft kept from the last edit would open the card on the dates it had.
  const setEditing = (cardId: string | null) => {
    if (editing && editing !== cardId) dropDraft(draft(`card\0${editing}`));
    setEditingState(cardId);
  };

  /**
   * The card's menu: the other columns, then every workspace in the profile as
   * a place to send it — the one specialised thing this board does. A
   * workspace with no board yet says so in its hint, since sending there is
   * also what makes one.
   */
  const cardMenu = (card: Card, at: MenuAt) =>
    setMenu({
      at,
      items: [
        ...lanes
          .filter((lane) => lane.id !== card.column)
          .map((lane) => ({
            label: `Move to ${lane.name}`,
            run: () => api.moveProfileCard(profile.id, card.id, lane.id),
          })),
        ...profile.workspaces.map((workspace, index) => ({
          label: `Send to ${workspace.name}`,
          sep: index === 0,
          hint: workspace.board ? `${workspace.board.cards.length} on its board` : "makes its board",
          run: () => {
            api.sendProfileCard(profile.id, card.id, workspace.id);
            setSent(`${card.title} → ${workspace.name}`);
          },
        })),
        { label: "Edit", sep: true, run: () => setEditing(card.id) },
        ...(card.dates
          ? [{ label: "Take the dates off", run: () => api.editProfileCard(profile.id, card.id, { dates: null }) }]
          : []),
        { label: "Delete card", danger: true, run: () => api.deleteProfileCard(profile.id, card.id) },
      ],
    });

  /**
   * A column's menu. Deleting one says where its cards will go, which is the
   * whole of what could surprise anybody about it — see `removeLane`.
   */
  const laneMenu = (lane: BoardLane, at: MenuAt) => {
    const index = lanes.indexOf(lane);
    const count = columnCards(board, lane.id).length;
    const into = lanes[index === 0 ? 1 : index - 1];
    setMenu({
      at,
      items: [
        { label: "Rename", run: () => setNaming(lane.id) },
        { label: "Colour", hint: lane.color ?? "none", run: () => setPicking({ column: lane.id, at }) },
        { label: "Collapse", run: () => api.collapseProfileColumn(profile.id, lane.id, true) },
        ...(index > 0
          ? [{ label: "Move left", run: () => api.moveProfileColumn(profile.id, lane.id, index - 1) }]
          : []),
        ...(index < lanes.length - 1
          ? [{ label: "Move right", run: () => api.moveProfileColumn(profile.id, lane.id, index + 1) }]
          : []),
        ...(into
          ? [
              {
                label: "Delete column",
                sep: true,
                danger: true,
                hint: count ? `${count} card${count === 1 ? "" : "s"} → ${into.name}` : undefined,
                run: () => api.deleteProfileColumn(profile.id, lane.id),
              },
            ]
          : []),
      ],
    });
  };

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
    if (from >= 0 && to !== from) api.moveProfileColumn(profile.id, laneDrag.id, to);
    setLaneDrag(null);
  };

  /**
   * A card over a column's own background goes to its foot; over a card, the
   * card's `onOver` has already said which side of it. A folded column has no
   * cards to point between, so anywhere on it is its foot.
   */
  const over = (column: string, foot: number, anywhere = false) => (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes(CARD_MIME)) return;
    event.preventDefault();
    if (anywhere || event.target === event.currentTarget) setDropAt({ column, index: foot });
  };

  /**
   * The handle a column is dragged by, open or folded. Only the grip is
   * draggable, so the header's buttons and a rename's input keep their clicks
   * and their text selection.
   */
  const grip = (column: string) => (
    <span
      className="board-col-grip"
      draggable
      title="Drag to move this column"
      aria-hidden="true"
      onDragStart={(event) => {
        event.dataTransfer.setData(LANE_MIME, column);
        event.dataTransfer.effectAllowed = "move";
        const col = event.currentTarget.closest(".board-col");
        if (col) {
          const box = col.getBoundingClientRect();
          event.dataTransfer.setDragImage(col, event.clientX - box.left, event.clientY - box.top);
        }
        setLaneDrag({ id: column, gap: null });
      }}
      onDragEnd={() => setLaneDrag(null)}
    >
      <Icon name="grip" />
    </span>
  );

  const addingList = useComposerInView(adding, adding ? columnCards(board, adding).length : 0);

  return (
    <div className="scrim profile-board-scrim" onPointerDown={onClose}>
      <div
        className="profile-board"
        role="dialog"
        aria-modal
        aria-label={`${profile.name}'s board`}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="profile-board-head">
          <Icon name="board" />
          <h2 className="dialog-title">{profile.name}</h2>
          <span className="board-seg" role="tablist" aria-label="View">
            {(["board", "timeline"] as const).map((name) => (
              <button
                key={name}
                role="tab"
                aria-selected={view === name}
                className={`board-seg-btn ${view === name ? "board-seg-btn-on" : ""}`}
                onClick={() => setView(name)}
              >
                {name === "board" ? "Board" : "Timeline"}
              </button>
            ))}
          </span>
          <span className="profile-board-note" role="status">
            {sent ? `Sent: ${sent}` : "Cards for any workspace — send one to its board from the card's menu"}
          </span>
          <button className="sidebar-close" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" />
          </button>
        </header>

        {view === "timeline" && (
          <Timeline profile={profile} editing={editing} onEdit={setEditing} onMenu={cardMenu} draft={draft} />
        )}

        {view === "board" && (
          <div className="board profile-board-cols">
            {lanes.map((lane, laneIndex) => {
              const column = lane.id;
              const cards = columnCards(board, column);
              const shut = lane.collapsed === true;
              const gap = laneDrag?.gap;
              const laneClass = [
                "board-col",
                shut ? "board-col-shut" : "",
                dropAt?.column === column ? "board-col-over" : "",
                laneDrag?.id === column ? "board-col-lifted" : "",
                gap === laneIndex ? "board-col-before" : "",
                gap === laneIndex + 1 && laneIndex === lanes.length - 1 ? "board-col-after" : "",
              ].join(" ");
              // The same drop target folded or open, so that a folded column
              // takes a card and a column exactly as it would standing up.
              const target = {
                className: laneClass,
                style: lane.color ? ({ "--tag": colorValue(lane.color) } as React.CSSProperties) : undefined,
                onDragOver: (event: React.DragEvent<HTMLElement>) => {
                  overLane(laneIndex)(event);
                  over(column, cards.length, shut)(event);
                },
                onDragLeave: (event: React.DragEvent<HTMLElement>) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(null);
                },
                onDrop: (event: React.DragEvent<HTMLElement>) => {
                  if (event.dataTransfer.types.includes(LANE_MIME)) {
                    event.preventDefault();
                    return dropLane();
                  }
                  const cardId = event.dataTransfer.getData(CARD_MIME);
                  const index = dropAt?.column === column ? dropAt.index : undefined;
                  setDropAt(null);
                  if (!cardId) return;
                  event.preventDefault();
                  api.moveProfileCard(profile.id, cardId, column, index);
                },
              };
              if (shut)
                return (
                  <section key={column} {...target}>
                    {grip(column)}
                    {/* The whole strip is the button that opens it again, as
                        in Jira: the name on its side is the thing to press. */}
                    <button
                      className="board-col-open"
                      title={`Expand ${lane.name}`}
                      aria-label={`Expand ${lane.name}, ${cards.length} card${cards.length === 1 ? "" : "s"}`}
                      aria-expanded={false}
                      onClick={() => api.collapseProfileColumn(profile.id, column, false)}
                    >
                      <Icon name="caret" />
                      <span className="board-col-dot" />
                      <span className="board-col-count">{cards.length}</span>
                      <span className="board-col-name">{lane.name}</span>
                    </button>
                  </section>
                );
              return (
                <section key={column} {...target}>
                  <header className="board-col-head">
                    {grip(column)}
                    {naming === column ? (
                      <LaneName
                        name={lane.name}
                        onDone={(name) => {
                          if (name && name !== lane.name) api.renameProfileColumn(profile.id, column, name);
                          setNaming(null);
                        }}
                      />
                    ) : (
                      <>
                        {/* The column's colour, and the way to change it: the
                            swatch is the thing you would point at to ask. */}
                        <button
                          className="board-col-dot"
                          title="The colour this column's cards wear on the timeline"
                          aria-label={`Colour: ${lane.color ?? "none"}`}
                          aria-haspopup="listbox"
                          onClick={(event) => {
                            const box = event.currentTarget.getBoundingClientRect();
                            setPicking({ column, at: { x: box.left, y: box.bottom + 4 } });
                          }}
                        />
                        <span className="board-col-name" onDoubleClick={() => setNaming(column)} title="Double-click to rename">
                          {lane.name}
                        </span>
                        <span className="board-col-count">{cards.length}</span>
                      </>
                    )}
                    <button
                      className="pane-btn board-col-fold"
                      title="Collapse this column — it still takes a card dropped on it"
                      aria-label="Collapse column"
                      aria-expanded
                      onClick={() => api.collapseProfileColumn(profile.id, column, true)}
                    >
                      <Icon name="caret" />
                    </button>
                    <button
                      className="pane-btn"
                      title={`Add a card to ${lane.name}`}
                      aria-label="Add a card"
                      onClick={() => setAdding(column)}
                    >
                      <Icon name="add" />
                    </button>
                    <button
                      className="pane-btn"
                      title="Rename, move or delete this column"
                      aria-label="Column menu"
                      aria-haspopup="menu"
                      onClick={(event) => {
                        const box = event.currentTarget.getBoundingClientRect();
                        laneMenu(lane, { x: box.left, y: box.bottom + 4 });
                      }}
                    >
                      <Icon name="caret" />
                    </button>
                  </header>

                  <div
                    className="board-cards"
                    ref={adding === column ? addingList : undefined}
                    onDragOver={over(column, cards.length)}
                  >
                    {cards.map((card, index) =>
                      editing === card.id ? (
                        <Composer
                          key={card.id}
                          draft={draft(`card\0${card.id}`)}
                          title={card.title}
                          body={card.body}
                          isolate={false}
                          offerIsolate={false}
                          dates={card.dates}
                          offerDates
                          bodyHint="Details"
                          submit="Save"
                          onSubmit={(title, body, _isolate, dates) => {
                            api.editProfileCard(profile.id, card.id, { title, body, dates });
                            setEditing(null);
                          }}
                          onCancel={() => setEditing(null)}
                        />
                      ) : (
                        <ProfileCard
                          key={card.id}
                          card={card}
                          code={cardCode(profile.name, card.number)}
                          insertBefore={dropAt?.column === column && dropAt.index === index}
                          onMenu={(at) => cardMenu(card, at)}
                          onEdit={() => setEditing(card.id)}
                          onOver={(event) => {
                            if (!event.dataTransfer.types.includes(CARD_MIME)) return;
                            event.preventDefault();
                            event.stopPropagation();
                            const box = event.currentTarget.getBoundingClientRect();
                            setDropAt({ column, index: event.clientY > box.top + box.height / 2 ? index + 1 : index });
                          }}
                        />
                      ),
                    )}
                    {dropAt?.column === column && dropAt.index === cards.length && (
                      <span className="board-insert" aria-hidden="true" />
                    )}
                    {adding === column ? (
                      <Composer
                        draft={draft(`new\0${column}`)}
                        title=""
                        body=""
                        isolate={false}
                        offerIsolate={false}
                        offerDates
                        bodyHint="Details"
                        submit="Add"
                        onSubmit={(title, body, _isolate, dates) => api.addProfileCard(profile.id, title, body, column, dates)}
                        onCancel={() => setAdding(null)}
                        keepOpen
                      />
                    ) : (
                      <button className="board-empty" onClick={() => setAdding(column)}>
                        Add a card
                      </button>
                    )}
                  </div>
                </section>
              );
            })}
            {lanes.length < LANES_MAX &&
              (naming === NEW_LANE ? (
                <section className="board-col board-col-new">
                  <header className="board-col-head">
                    <LaneName
                      name=""
                      onDone={(name) => {
                        if (name) api.addProfileColumn(profile.id, name);
                        setNaming(null);
                      }}
                    />
                  </header>
                </section>
              ) : (
                <button className="board-col-add" onClick={() => setNaming(NEW_LANE)}>
                  <Icon name="add" /> Add column
                </button>
              ))}
          </div>
        )}

        {menu && <Menu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
        {picking && (
          <ColorPicker
            at={picking.at}
            current={lanes.find((lane) => lane.id === picking.column)?.color ?? null}
            onPick={(color) => {
              api.colorProfileColumn(profile.id, picking.column, color);
              setPicking(null);
            }}
            onClose={() => setPicking(null)}
          />
        )}
      </div>
    </div>
  );
}

function ProfileCard({
  card,
  code,
  insertBefore,
  onMenu,
  onEdit,
  onOver,
}: {
  card: Card;
  code: string;
  insertBefore: boolean;
  onMenu: (at: MenuAt) => void;
  onEdit: () => void;
  onOver: (event: React.DragEvent) => void;
}) {
  return (
    <>
      {insertBefore && <span className="board-insert" aria-hidden="true" />}
      <article
        className="board-card"
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(CARD_MIME, card.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={onOver}
        onDoubleClick={onEdit}
      >
        <div className="board-card-top">
          <span className="board-card-code">{code}</span>
          <span className="board-card-title">{card.title}</span>
          <span className="board-card-actions">
            <button
              className="board-icon-btn"
              title="Move, send to a workspace, edit or delete"
              aria-label="Card menu"
              aria-haspopup="menu"
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                onMenu({ x: box.left, y: box.bottom + 4 });
              }}
            >
              <Icon name="caret" />
            </button>
          </span>
        </div>
        {card.body && <p className="board-card-body">{card.body}</p>}
        {card.dates && <CardWhen dates={card.dates} />}
      </article>
    </>
  );
}

/**
 * A column's name as a field, for making one or renaming it. Enter or leaving
 * the field keeps what was typed, since a name half-typed and clicked away from
 * was still meant; Escape is the one way to change nothing — and is stopped
 * here so it does not close the board too.
 */
function LaneName({ name, onDone }: { name: string; onDone: (name: string) => void }) {
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
