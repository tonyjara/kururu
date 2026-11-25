/**
 * The profile's board: columns of cards that belong to no workspace yet —
 * three to start with, and whatever else a person makes.
 *
 * It exists because a workspace's board is a place for work you know the
 * checkout of, and a lot of work is written down before that is known — "the
 * login page flickers on the phone" is a card before it is anybody's branch.
 * Written on some workspace's board it would be filed in the wrong place, and
 * the robot on it would start an agent in the wrong directory. So the profile
 * gets a board of its own, and the one thing it does that a workspace's board
 * does not is *send* a card to a workspace, where the robot is.
 *
 * A tab, in the profile's Dashboard, and not in any workspace. It was a sheet
 * over the window, on the argument that a tab lives in a workspace's layout
 * and this board is precisely the one that is no workspace's — in every
 * workspace it would be many boards, in one of them it would move with
 * whichever was picked. That argument was right about workspaces and wrong
 * about tabs: what lost was the sheet, which covered the work, held the
 * keyboard and had to be put away to use anything behind it, for the board
 * people plan in. The Dashboard (`shared/dashboard.ts`) is a space that is
 * the profile's, so the board is a fixed tab there — the same board from
 * wherever it is opened, on the phone as on the desktop, with no ✕ because
 * it is not a thing to close.
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
 *
 * It is the profile's own board and nothing else's. For a version a bar under
 * the header listed every workspace's board and drew the picked one here, as
 * the place the whole profile was looked at from; that went, because what it
 * listed was boards when the question was which workspaces were waiting, and
 * the answer to that is the drawer of things that need you (`NeedsDrawer.tsx`).
 * What stayed of the profile-wide job is the search, whose card hits lead to
 * a workspace's board in its own pane.
 *
 * The one column every profile's board has and nobody made is Needs you
 * (`NEEDS_COLUMN`): the user's own to-dos, put there by them or by Kuru, and
 * drawn in that drawer as well as here. It takes no rename and no delete,
 * since the drawer and Kuru find it by its id, and each card in it wears who
 * put it there (`NeedsByMark`).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  boardLanes,
  cardCode,
  columnCards,
  laneFixed,
  laneInto,
  LANES_MAX,
  NEEDS_COLUMN,
  type BoardLane,
  type Card,
  type NeedsBy,
} from "../../../shared/board";
import type { Profile } from "../../../shared/model";
import { cardPlace, cardReference } from "../../../shared/kuru";
import { useCardClick } from "../cardclick";
import { cardTimes } from "../cardtimes";
import { colorValue } from "../colors";
import { canPopColumn, popColumnItem, popOutColumn } from "../columns";
import { referItem } from "../kuru";
import { noteItem, popOutNote } from "../notes";
import { revealCard } from "../reveal";
import * as api from "../session";
import { ago, CARD_KEEP, CardBody, CardFoot, CardWhen, columnEndItems, Composer, dropDraft, showCardNext, useCardOpen, useComposerInView } from "./Board";
import { ColorPicker } from "./ColorPicker";
import { ColumnResizeHandle } from "./ColumnResize";
import { HeadFold } from "./Fold";
import { Icon } from "./Icon";
import {
  AddLane,
  FoldButton,
  FoldedLane,
  isLaneDrag,
  laneMenuItems,
  LaneName,
  NEW_LANE,
  PopOutButton,
  PoppedButtons,
  poppedReferItem,
  useLaneDrag,
  type PoppedColumn,
} from "./Lanes";
import { Menu, type MenuAt, type MenuItem } from "./Menu";
import { quotable, selectNotDrag } from "./Quote";
import { PROFILE_CARD_MIME as CARD_MIME, Timeline } from "./Timeline";
import { BoardSearch } from "./Search";

/**
 * Which view the board was last left in, so that it opens in it. Out here for
 * the reason `drafts` is in `Board.tsx`: the tab is unmounted every time
 * another is shown or the Dashboard is left, and somebody who plans by the
 * timeline should not be shown the columns first each time they look.
 */
type View = "board" | "timeline";
let lastView: View = "board";

/**
 * A card of this board somebody asked to see — a reply of Kuru's that named
 * it, a note's button, a row in the Needs drawer — for the board to scroll to
 * and light once it is drawn, or at once if it is. `Board.tsx`'s
 * `showCardNext` for the profile's board: module state, because the asker is
 * not in this tree and the Dashboard may not be on screen yet. Taken once.
 */
let wanted: { cardId: string; at: number } | null = null;
const wantedListeners = new Set<() => void>();
export function showProfileCardNext(cardId: string): void {
  wanted = { cardId, at: Date.now() };
  for (const listener of wantedListeners) listener();
}
function useWantedCard(): typeof wanted {
  return useSyncExternalStore(
    (listener) => {
      wantedListeners.add(listener);
      return () => wantedListeners.delete(listener);
    },
    () => wanted,
  );
}

/**
 * `popped` is the board drawn as a popped-out column's window
 * (`ColumnPage.tsx`), as `BoardView`'s is: that column alone, with no header,
 * search or timeline, and the window's fold and close in its head.
 */
export function ProfileBoard({ profile, popped }: { profile: Profile; popped?: PoppedColumn }) {
  const board = profile.board;
  const lanes = boardLanes(board);
  /**
   * The card last asked for by name, lit for a moment on the columns —
   * `Board.tsx`'s `showCardNext`, for this board. The columns, whichever
   * view the board was in: a bar on the timeline is not where a card is
   * looked for. The time is what lets one card be asked for twice.
   */
  const sheet = useRef<HTMLDivElement>(null);
  const [shownCard, setShownCard] = useState<{ id: string; at: number } | null>(null);
  const showCard = (cardId: string) => {
    setView("board");
    setShownCard({ id: cardId, at: Date.now() });
  };
  const asked = useWantedCard();
  useEffect(() => {
    if (!asked) return;
    // Once, on the ask: what is shown afterwards is the person's, and a
    // re-render must not drag it back.
    wanted = null;
    showCard(asked.cardId);
  }, [asked]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!shownCard) return;
    if (sheet.current) revealCard(sheet.current, shownCard.id);
    const timer = setTimeout(() => setShownCard(null), 1800);
    return () => clearTimeout(timer);
  }, [shownCard]);
  /** The search row under the header, shown on the header's button. Closed again on a pick, since the card is then on screen. */
  const [searching, setSearching] = useState(false);
  const [view, setViewState] = useState<View>(lastView);
  const setView = (next: View) => {
    lastView = next;
    setViewState(next);
  };
  const [adding, setAdding] = useState<string | null>(null);
  const [editing, setEditingState] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ at: MenuAt; items: MenuItem[] } | null>(null);
  const [dropAt, setDropAt] = useState<{ column: string; index: number } | null>(null);
  /** A column dragged by its grip — see `useLaneDrag`. */
  const { overLane, dropLane, laneClasses, grip } = useLaneDrag(lanes, (laneId, index) => api.moveProfileColumn(profile.id, laneId, index));
  /** The column whose colour is being picked, and where its swatches open. */
  const [picking, setPicking] = useState<{ column: string; at: MenuAt } | null>(null);
  /** A popped-out column folded to its bar drops what was open below it — `BoardView`'s reason. */
  const shutAway = popped?.collapsed === true;
  useEffect(() => {
    if (!shutAway) return;
    setMenu(null);
    setPicking(null);
  }, [shutAway]);
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
   * The card's menu: its place in its column (`columnEndItems`), its moves
   * (`profileCardMoves` — the other columns, then Send to and the profile's
   * workspaces), then the verbs every card has. The ends are not in
   * `profileCardMoves` because the Needs drawer, which shares it, has its own.
   */
  const cardMenu = (card: Card, at: MenuAt) => {
    const ends = columnEndItems(board, card, (index) => api.moveProfileCard(profile.id, card.id, card.column, index));
    const [first, ...moves] = profileCardMoves(profile, card, setSent);
    setMenu({
      at,
      items: [
        ...ends,
        ...(first ? [{ ...first, sep: first.sep || ends.length > 0 }, ...moves] : []),
        ...(popped
          ? popped.refer
            ? [poppedReferItem(popped.refer, card.id)]
            : []
          : [referItem({ code: cardCode(profile.name, card.number), title: card.title, place: cardPlace(null, api.nodeNameOf), cardId: card.id })]),
        // A note floats over the board as over everything, and cards are
        // often popped out several at a time.
        noteItem(card.id),
        { label: "Edit", run: () => setEditing(card.id) },
        ...(card.dates
          ? [{ label: "Take the dates off", run: () => api.editProfileCard(profile.id, card.id, { dates: null }) }]
          : []),
        { label: "Delete card", danger: true, run: () => api.deleteProfileCard(profile.id, card.id) },
      ],
    });
  };

  /**
   * A column's menu — `laneMenuItems`, with the colour this board's columns
   * wear on its timeline. Deleting one says where its cards will go.
   */
  const laneMenu = (lane: BoardLane, at: MenuAt) =>
    setMenu({
      at,
      items: laneMenuItems({
        // In its window a column is the only one: no moves along the board.
        lanes: popped ? [lane] : lanes,
        lane,
        count: columnCards(board, lane.id).length,
        into: laneInto(board, lane.id, "profile"),
        fixed: laneFixed(lane.id, "profile"),
        extra: [
          ...(popOut ? [popColumnItem(() => popOut(lane))] : []),
          { label: "Colour", hint: lane.color ?? "none", run: () => setPicking({ column: lane.id, at }) },
        ],
        rename: () => setNaming(lane.id),
        collapse: popped ? undefined : () => api.collapseProfileColumn(profile.id, lane.id, true),
        move: (index) => api.moveProfileColumn(profile.id, lane.id, index),
        remove: () => api.deleteProfileColumn(profile.id, lane.id),
      }),
    });

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

  /** A column popped out into a window of its own — `BoardView`'s, for this board. */
  const popOut = !popped && canPopColumn() ? (lane: BoardLane) => popOutColumn(profile, { key: profile.key, name: profile.name }, lane) : null;

  const addingList = useComposerInView(adding, adding ? columnCards(board, adding).length : 0);

  return (
    <div className="profile-board" aria-label={`${profile.name}'s board`} ref={sheet}>
      {!popped && (
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
          <button
            className={`board-seg-btn board-search-toggle ${searching ? "board-seg-btn-on" : ""}`}
            onClick={() => setSearching((on) => !on)}
            aria-pressed={searching}
            title="Search every board and the conversations"
          >
            Search
          </button>
        </header>
      )}
      {!popped && searching && (
        <BoardSearch
          profileId={profile.id}
          onPickCard={(workspaceId, cardId) => {
            // A workspace's card is on that workspace's board, in its pane,
            // which takes the window off the Dashboard. One of this board's
            // own is here, and is lit on the columns.
            if (workspaceId) {
              showCardNext(workspaceId, cardId);
              api.openBoard(undefined, false, workspaceId);
              return;
            }
            showCard(cardId);
            setSearching(false);
          }}
        />
      )}

      {!popped && view === "timeline" && (
        <Timeline profile={profile} editing={editing} onEdit={setEditing} onMenu={cardMenu} draft={draft} />
      )}

      {(popped || view === "board") && (
        <div className="board profile-board-cols">
          {(popped ? lanes.filter((lane) => lane.id === popped.lane) : lanes).map((lane) => {
            const laneIndex = lanes.indexOf(lane);
            const column = lane.id;
            const cards = columnCards(board, column);
            const shut = !popped && lane.collapsed === true;
            const laneClass = [
              "board-col",
              shut ? "board-col-shut" : "",
              dropAt?.column === column ? "board-col-over" : "",
              laneClasses(column, laneIndex),
            ].join(" ");
            // The same drop target folded or open, so that a folded column
            // takes a card and a column exactly as it would standing up.
            const width = board.widths?.[column];
            const target = {
              className: laneClass,
              style: (lane.color || width !== undefined
                ? {
                    ...(lane.color ? { "--tag": colorValue(lane.color) } : {}),
                    ...(width !== undefined ? { "--col-w": `${width}px` } : {}),
                  }
                : undefined) as React.CSSProperties | undefined,
              onDragOver: (event: React.DragEvent<HTMLElement>) => {
                overLane(laneIndex)(event);
                over(column, cards.length, shut)(event);
              },
              onDragLeave: (event: React.DragEvent<HTMLElement>) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(null);
              },
              onDrop: (event: React.DragEvent<HTMLElement>) => {
                if (isLaneDrag(event)) {
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
                  <FoldedLane lane={lane} count={cards.length} onOpen={() => api.collapseProfileColumn(profile.id, column, false)} />
                </section>
              );
            return (
              <section key={column} {...target}>
                {/* The column's menu off a right-click on its head too, as the
                    cards' is off theirs — the ⋯ at its end opens the same list. */}
                <header
                  className="board-col-head"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!popped?.collapsed) laneMenu(lane, { x: event.clientX, y: event.clientY });
                  }}
                >
                  {popped ? <HeadFold folded={popped.collapsed} onFold={popped.fold} /> : grip(column)}
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
                      <span
                        className="board-col-name"
                        onDoubleClick={laneFixed(column, "profile") ? undefined : () => setNaming(column)}
                        title={
                          laneFixed(column, "profile")
                            ? "Yours to do, put here by you or by Kuru — these cards are in the Needs drawer too"
                            : "Double-click to rename"
                        }
                      >
                        {lane.name}
                      </span>
                      {popped && <span className="board-col-where">{profile.name}</span>}
                      <span className="board-col-count">{cards.length}</span>
                    </>
                  )}
                  {!popped && <FoldButton onFold={() => api.collapseProfileColumn(profile.id, column, true)} />}
                  {popOut && <PopOutButton name={lane.name} onPopOut={() => popOut(lane)} />}
                  {/* Folded, the window is its bar — `BoardView`'s rule. */}
                  {!popped?.collapsed && (
                    <>
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
                        title={
                          popped
                            ? laneFixed(column, "profile")
                              ? "Colour this column"
                              : "Rename, colour or delete this column"
                            : laneFixed(column, "profile")
                              ? "Colour, collapse or move this column"
                              : "Rename, move or delete this column"
                        }
                        aria-label="Column menu"
                        aria-haspopup="menu"
                        onClick={(event) => {
                          const box = event.currentTarget.getBoundingClientRect();
                          laneMenu(lane, { x: box.left, y: box.bottom + 4 });
                        }}
                      >
                        <Icon name="caret" />
                      </button>
                    </>
                  )}
                  {popped && <PoppedButtons popped={popped} />}
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
                        onPopOut={() => popOutNote(card.id)}
                      />
                    ) : (
                      <ProfileCard
                        key={card.id}
                        card={card}
                        code={cardCode(profile.name, card.number)}
                        shown={shownCard?.id === card.id}
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
                {!popped && (
                  <ColumnResizeHandle
                    onResize={(w) => api.resizeProfileColumn(profile.id, column, w)}
                    onReset={() => api.resizeProfileColumn(profile.id, column, null)}
                  />
                )}
              </section>
            );
          })}
          {!popped && lanes.length < LANES_MAX && (
            <AddLane
              naming={naming === NEW_LANE}
              onNaming={(on) => setNaming(on ? NEW_LANE : null)}
              onAdd={(name) => api.addProfileColumn(profile.id, name)}
            />
          )}
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
  );
}

function ProfileCard({
  card,
  code,
  shown,
  insertBefore,
  onMenu,
  onEdit,
  onOver,
}: {
  card: Card;
  code: string;
  /** Just asked for by name, and lit for a moment. */
  shown: boolean;
  insertBefore: boolean;
  onMenu: (at: MenuAt) => void;
  onEdit: () => void;
  onOver: (event: React.DragEvent) => void;
}) {
  const opening = useCardOpen(card.title, card.body);
  const click = useCardClick(opening.toggle, onEdit, CARD_KEEP);
  // An open card's words can be quoted to Kuru, by the reference its menu writes.
  const quoteRef = opening.open ? cardReference({ code, title: card.title, place: cardPlace(null, api.nodeNameOf), cardId: card.id }) : null;
  return (
    <>
      {insertBefore && <span className="board-insert" aria-hidden="true" />}
      <article
        className={`board-card ${shown ? "board-card-shown" : ""} ${opening.open ? "board-card-open" : ""}`}
        data-card={card.id}
        data-ink-what={`card ${code}`}
        data-ink-name={card.title}
        draggable
        onPointerDown={selectNotDrag}
        onDragStart={(event) => {
          click.cancel();
          event.dataTransfer.setData(CARD_MIME, card.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={onOver}
        onClick={click.onClick}
        onDoubleClick={click.onDoubleClick}
        /* The caret's menu, under the pointer: one list for both doors. */
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <span ref={opening.titleRef} className="board-card-title" {...(quoteRef ? quotable(quoteRef, "title") : {})}>
          {card.title}
        </span>
        <CardBody text={card.body} opening={opening} quoteRef={quoteRef} />
        {opening.open && card.column === NEEDS_COLUMN && <NeedsTimes card={card} />}
        <CardFoot
          code={code}
          mark={card.column === NEEDS_COLUMN && card.needsBy && <NeedsByMark by={card.needsBy} />}
          when={card.dates && <CardWhen dates={card.dates} />}
        >
          {/* The menu's "Pop out as a note" again, as a button of its own,
              because it is the row pressed far more than any other on this
              board. The menu keeps it, so the list stays the whole list. */}
          <button
            type="button"
            className="board-icon-btn"
            title="Pop out as a note, over the window"
            aria-label="Pop out as a note"
            onClick={() => popOutNote(card.id)}
          >
            <Icon name="pin" />
          </button>
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
        </CardFoot>
      </article>
    </>
  );
}

/**
 * When an open card in Needs you was written, and — when it came later — when
 * it arrived there (`Card.needsSince`): what the user reads to tell how long
 * a thing has been waiting on them. Only on an open card, since a closed one
 * is a line in a column scanned for its title, and only in Needs you, the
 * one column whose cards are waiting on somebody. The wording is
 * `cardtimes.ts`'s; the ages are the hover, in the board's own `ago`.
 */
function NeedsTimes({ card }: { card: Card }) {
  const times = cardTimes(card.createdAt, card.needsSince, Date.now());
  const hover = [`written ${ago(card.createdAt)}`, times.since && card.needsSince ? `in Needs you since ${ago(card.needsSince)}` : ""].filter(Boolean).join(" · ");
  return (
    <span className="board-card-times" title={hover}>
      <span>Added {times.added}</span>
      {times.since && <span>In Needs since {times.since}</span>}
    </span>
  );
}

/**
 * The moves a profile card's menu offers wherever the card is drawn — here,
 * its timeline, and its row in the Needs drawer: the board's other columns,
 * then Send to, the one specialised thing this board does. Send to is one row
 * whose list is every workspace in the profile, in the sidebar's order; it
 * was a row per workspace, which with twenty of them buried the card's own
 * verbs. A workspace with no board yet says so in its hint, since sending
 * there is also what makes one. `onSent` is told what went where, for a place
 * that says so; the drawer needs no word, as the row goes.
 */
export function profileCardMoves(profile: Profile, card: Card, onSent?: (what: string) => void): MenuItem[] {
  return [
    ...boardLanes(profile.board)
      .filter((lane) => lane.id !== card.column)
      .map((lane) => ({
        label: `Move to ${lane.name}`,
        run: () => api.moveProfileCard(profile.id, card.id, lane.id),
      })),
    ...(profile.workspaces.length
      ? [
          {
            label: "Send to",
            sep: true,
            items: profile.workspaces.map((workspace) => ({
              label: workspace.name,
              hint: workspace.board ? `${workspace.board.cards.length} on its board` : "makes its board",
              run: () => {
                api.sendProfileCard(profile.id, card.id, workspace.id);
                onSent?.(`${card.title} → ${workspace.name}`);
              },
            })),
          },
        ]
      : []),
  ];
}

/**
 * Who put a card in Needs you, as a word in a pill: **Kuru** in the accent,
 * since that is the one the user did not do themselves and should notice,
 * and **You** in the quiet ink of a count. Words rather than a glyph, as
 * the board's view toggle is text, so it reads at a glance. One drawing for
 * the card and the drawer's row.
 */
export function NeedsByMark({ by }: { by: NeedsBy }) {
  const kuru = by === "kuru";
  return (
    <span className={`needs-by needs-by-${by}`} title={kuru ? "Kuru put this here for you" : "You put this here"}>
      {kuru ? "Kuru" : "You"}
    </span>
  );
}
