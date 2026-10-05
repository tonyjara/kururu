/**
 * The profile's board as a timeline: the same cards, laid out by when they are
 * for instead of by how far along they are.
 *
 * It exists because a column answers "what state is this in" and says nothing
 * about *when*. Three cards in To do are three cards whether they are for
 * tomorrow or for the month after, and the only way to plan a week out of them
 * was to hold the dates in your head beside the board. Here each dated card is
 * a bar across the days it covers, and the week can be read — and rearranged —
 * by looking at it.
 *
 * A second view of the one board rather than a second board, which is the
 * decision worth defending. The cards, their columns and their order are all
 * still `Profile.board`; this holds nothing of its own but which five weeks it
 * is showing. Dragging a bar is `edit-profile-card` with new dates, the same
 * verb the composer's date fields send, so the server has one road onto a
 * card's dates and the timeline cannot come to disagree with the board.
 *
 * A window of days with arrows, rather than everything from the first date to
 * the last — see `timeline` in `shared/board.ts`. What is outside the window
 * is counted on the arrow that leads to it.
 *
 * A bar is the colour of the column its card is in (`BoardLane.color`), which
 * is how the one thing this view gives up — the columns — is still on screen:
 * moving a card to In progress changes its bar, and the key above the days
 * says which colour is which.
 *
 * The bars are dragged with a mouse and not with a finger. A thumb on a
 * timeline is nearly always scrolling it, and a bar that came along with the
 * scroll would reschedule somebody's week from a train; on a phone a tap opens
 * the card, where the dates are two fields. That is the phone's half of kururu
 * everywhere else too: it looks and it steers, and the desk arranges.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { boardLanes, cardCode, shiftDates, timeline, type Card, type CardDates, type TimelineRow } from "../../../shared/board";
import { dayAt, dayNumber, today, weekday, weekStart, type Day } from "../../../shared/days";
import type { Profile } from "../../../shared/model";
import { colorValue } from "../colors";
import * as api from "../session";
import { datesLabel, datesTense, dayInFull, dayLabel, dayOfMonth, firstWeekday, monthLabel, weekdayLetter } from "../when";
import { Composer, dropDraft } from "./Board";
import { Icon } from "./Icon";
import type { MenuAt } from "./Menu";

export const PROFILE_CARD_MIME = "application/x-kururu-profile-card";

/**
 * Five weeks, moved a week at a time. Five because that is a month with its
 * edges showing, and is as many days as fit across the sheet at a width a bar
 * can still be caught by; a week a step so that most of what was on screen
 * still is, and the eye keeps its place.
 */
const DAYS = 35;
const STEP = 7;

type Edge = "both" | "start" | "end";

/**
 * A bar in the hand. `from` is the dates it had when it was picked up, which
 * is what `by` is measured against — not the card's, because once the bar is
 * let go the card's change underneath it and the preview must not move twice.
 * `done` is a bar that has been let go and sent: it holds its preview until
 * the snapshot that answers it, so the bar does not spring back for a frame.
 */
interface Held {
  cardId: string;
  edge: Edge;
  from: CardDates;
  x: number;
  width: number;
  by: number;
  done: boolean;
}

export function Timeline({
  profile,
  editing,
  onEdit,
  onMenu,
  draft,
}: {
  profile: Profile;
  /** The card whose composer is open, which the board owns so that switching views keeps it. */
  editing: string | null;
  onEdit: (cardId: string | null) => void;
  onMenu: (card: Card, at: MenuAt) => void;
  /** The board's key for a composer's draft — see `drafts` in `Board.tsx`. */
  draft: (key: string) => string;
}) {
  const board = profile.board;
  const now = today(new Date());
  const nowAt = dayNumber(now) ?? 0;
  const [week] = useState(firstWeekday);
  const [first, setFirst] = useState(() => weekStart(nowAt, week));
  /** The day a new card is being written for, or null. */
  const [adding, setAddingState] = useState<Day | null>(null);
  const [held, setHeld] = useState<Held | null>(null);
  /** The day an unscheduled card is being dragged over. */
  const [over, setOver] = useState<number | null>(null);

  const newDraft = draft("when\0new");
  const setAdding = (day: Day | null) => {
    dropDraft(newDraft);
    setAddingState(day);
  };
  const edit = (cardId: string) => {
    setAdding(null);
    onEdit(cardId);
  };
  const write = (day: Day) => {
    onEdit(null);
    setAdding(day);
  };

  useEffect(() => {
    setHeld((was) => (was?.done ? null : was));
  }, [board]);
  // And if no snapshot answers — the server refused the dates, say, for being
  // past the end of the calendar — the bar goes back to where the card is.
  useEffect(() => {
    if (!held?.done) return;
    const timer = setTimeout(() => setHeld(null), 1500);
    return () => clearTimeout(timer);
  }, [held]);

  const { rows, earlier, later, loose } = timeline(board, first, DAYS);
  const days = Array.from({ length: DAYS }, (_, index) => first + index);
  const lanes = boardLanes(board);
  const edited = editing ? board.cards.find((card) => card.id === editing) : undefined;

  /**
   * Which day is under a point, measured off the first day's heading: the
   * columns are all one width, and that cell scrolls with them, so its left
   * edge and its width are the whole of the geometry.
   */
  const firstHead = useRef<HTMLDivElement>(null);
  const dayWidth = () => firstHead.current?.getBoundingClientRect().width ?? 0;
  const dayUnder = (x: number): number | null => {
    const box = firstHead.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return null;
    const index = Math.floor((x - box.left) / box.width);
    return index >= 0 && index < DAYS ? first + index : null;
  };

  /**
   * Where a row is drawn. The row being dragged is placed by its preview but
   * keeps its place in the order, since a bar that changed rows as it crossed
   * its neighbour's start would be pulled out from under the pointer.
   */
  const place = (row: TimelineRow): TimelineRow => {
    if (!held || held.cardId !== row.card.id || held.by === 0) return row;
    const card = { ...row.card, dates: shiftDates(held.from, held.by, held.edge) };
    return timeline({ cards: [card], next: 1 }, first, DAYS).rows[0] ?? row;
  };

  /**
   * A click that ended a drag is not a click. Set on the way out of a drag
   * and cleared on the way into the next press, so that a drag whose click
   * never arrived cannot swallow the one after it.
   */
  const dragged = useRef(false);
  const grab = (card: Card, edge: Edge) => (event: React.PointerEvent<HTMLElement>) => {
    dragged.current = false;
    if (event.pointerType !== "mouse" || event.button !== 0 || !card.dates) return;
    const width = dayWidth();
    if (width <= 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setHeld({ cardId: card.id, edge, from: card.dates, x: event.clientX, width, by: 0, done: false });
  };
  const drag = (event: React.PointerEvent) => {
    if (!held || held.done) return;
    const by = Math.round((event.clientX - held.x) / held.width);
    if (by !== held.by) setHeld({ ...held, by });
  };
  const release = () => {
    if (!held || held.done) return;
    if (held.by === 0) {
      setHeld(null);
      return;
    }
    dragged.current = true;
    api.editProfileCard(profile.id, held.cardId, { dates: shiftDates(held.from, held.by, held.edge) });
    setHeld({ ...held, done: true });
  };

  /** The arrows move a focused bar a day, and with shift its end — the drag, for a keyboard. */
  const nudge = (card: Card) => (event: React.KeyboardEvent) => {
    if (!card.dates || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    event.stopPropagation();
    const by = event.key === "ArrowLeft" ? -1 : 1;
    api.editProfileCard(profile.id, card.id, { dates: shiftDates(card.dates, by, event.shiftKey ? "end" : "both") });
  };

  /** A column's colour as the `--tag` its cards are drawn in, or nothing for a column with none. */
  const tag = (column: string): React.CSSProperties => {
    const color = colorValue(lanes.find((lane) => lane.id === column)?.color);
    return color ? ({ "--tag": color } as React.CSSProperties) : {};
  };

  const waiting = (count: number, side: string) =>
    count ? `${side} — ${count} card${count === 1 ? "" : "s"} that way` : side;

  return (
    <div className="timeline">
      <div className="timeline-bar">
        <span className="board-seg">
          <button
            className="board-seg-btn timeline-earlier"
            title={waiting(earlier, "A week earlier")}
            aria-label={waiting(earlier, "A week earlier")}
            onClick={() => setFirst(first - STEP)}
          >
            <Icon name="caret" />
            {earlier > 0 && <span className="timeline-waiting">{earlier}</span>}
          </button>
          <button className="board-seg-btn" title="Back to this week" onClick={() => setFirst(weekStart(nowAt, week))}>
            Today
          </button>
          <button
            className="board-seg-btn timeline-later"
            title={waiting(later, "A week later")}
            aria-label={waiting(later, "A week later")}
            onClick={() => setFirst(first + STEP)}
          >
            {later > 0 && <span className="timeline-waiting">{later}</span>}
            <Icon name="caret" />
          </button>
        </span>
        <span className="timeline-range">
          {dayLabel(first, now)} – {dayLabel(first + DAYS - 1, now)}
        </span>
        <span className="timeline-key" aria-label="Columns">
          {lanes.map((lane) => (
            <span key={lane.id} className="timeline-key-lane" style={tag(lane.id)}>
              {lane.name}
            </span>
          ))}
        </span>
        <button className="board-btn board-btn-quiet" title="Write a card for today" onClick={() => write(now)}>
          <Icon name="add" /> New card
        </button>
      </div>

      {edited ? (
        <div className="timeline-editor">
          <Composer
            key={edited.id}
            draft={draft(`card\0${edited.id}`)}
            title={edited.title}
            body={edited.body}
            isolate={false}
            offerIsolate={false}
            dates={edited.dates}
            offerDates
            bodyHint="Details"
            submit="Save"
            onSubmit={(title, body, _isolate, dates) => {
              api.editProfileCard(profile.id, edited.id, { title, body, dates });
              onEdit(null);
            }}
            onCancel={() => onEdit(null)}
          />
        </div>
      ) : (
        adding && (
          <div className="timeline-editor">
            <Composer
              key={adding}
              draft={newDraft}
              title=""
              body=""
              isolate={false}
              offerIsolate={false}
              dates={{ start: adding, end: adding }}
              offerDates
              bodyHint="Details"
              submit="Add"
              onSubmit={(title, body, _isolate, dates) => {
                api.addProfileCard(profile.id, title, body, lanes[0]?.id, dates);
                setAdding(null);
              }}
              onCancel={() => setAdding(null)}
            />
          </div>
        )
      )}

      <div className="timeline-scroll">
        <div
          className="timeline-grid"
          // Two counts, and the stylesheet decides what a day and a row measure.
          style={{ "--days": DAYS, "--rows": Math.max(rows.length, 1) } as React.CSSProperties}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(PROFILE_CARD_MIME)) return;
            event.preventDefault();
            setOver(dayUnder(event.clientX));
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
          }}
          onDrop={(event) => {
            const cardId = event.dataTransfer.getData(PROFILE_CARD_MIME);
            const day = dayUnder(event.clientX);
            setOver(null);
            if (!cardId || day === null) return;
            event.preventDefault();
            api.editProfileCard(profile.id, cardId, { dates: { start: dayAt(day), end: dayAt(day) } });
          }}
        >
          <div className="timeline-corner" />
          {days.map((day, index) => (
            <div
              key={day}
              ref={index === 0 ? firstHead : undefined}
              className={`timeline-head ${day === nowAt ? "timeline-head-now" : ""}`}
              style={{ gridColumn: index + 2 }}
              title={dayInFull(day)}
            >
              <span className="timeline-month">{index === 0 || dayOfMonth(day) === 1 ? monthLabel(day) : ""}</span>
              <span className="timeline-weekday">{weekdayLetter(day)}</span>
              <span className="timeline-date">{dayOfMonth(day)}</span>
            </div>
          ))}
          {days.map((day, index) => (
            <div
              key={day}
              className={[
                "timeline-day",
                weekday(day) === week ? "timeline-day-week" : "",
                weekday(day) === 0 || weekday(day) === 6 ? "timeline-day-rest" : "",
                day === nowAt ? "timeline-day-now" : "",
                day === over ? "timeline-day-over" : "",
              ].join(" ")}
              style={{ gridColumn: index + 2 }}
              onDoubleClick={() => write(dayAt(day))}
            />
          ))}

          {rows.length === 0 && (
            <p className="timeline-none">
              {board.cards.length === loose.length
                ? "Nothing has a date yet — double-click a day to write a card for it"
                : "Nothing in these five weeks"}
            </p>
          )}

          {rows.map((row, index) => {
            const { card } = row;
            const at = place(row);
            const dates = held?.cardId === card.id ? shiftDates(held.from, held.by, held.edge) : card.dates;
            const lane = lanes.find((l) => l.id === card.column);
            return (
              // A fragment and not a row of its own: the label and the bar are
              // each placed on the one grid, which is what lines a bar up
              // with the day headings without measuring anything.
              <Fragment key={card.id}>
                <div className="timeline-label" style={{ gridRow: index + 2 }} onDoubleClick={() => edit(card.id)}>
                  <span className="board-card-code">{cardCode(profile.name, card.number)}</span>
                  <span className="timeline-title" title={card.title}>
                    {card.title}
                  </span>
                  <button
                    className="board-icon-btn"
                    title="Move, send to a workspace, edit or delete"
                    aria-label="Card menu"
                    aria-haspopup="menu"
                    onClick={(event) => {
                      const box = event.currentTarget.getBoundingClientRect();
                      onMenu(card, { x: box.left, y: box.bottom + 4 });
                    }}
                  >
                    <Icon name="caret" />
                  </button>
                </div>
                <button
                  type="button"
                  className={[
                    "timeline-span",
                    dates ? `timeline-span-${datesTense(dates, now)}` : "",
                    at.cutStart ? "timeline-span-cut-start" : "",
                    at.cutEnd ? "timeline-span-cut-end" : "",
                    held?.cardId === card.id ? "timeline-span-held" : "",
                  ].join(" ")}
                  style={{ gridRow: index + 2, gridColumn: `${at.at + 2} / span ${at.span}`, ...tag(card.column) }}
                  title={[card.title, dates ? datesLabel(dates, now) : "", lane?.name ?? ""].filter(Boolean).join(" · ")}
                  aria-label={`${card.title}, ${dates ? datesLabel(dates, now) : ""}`}
                  onPointerDown={grab(card, "both")}
                  onPointerMove={drag}
                  onPointerUp={release}
                  onPointerCancel={() => setHeld(null)}
                  onKeyDown={nudge(card)}
                  onClick={() => {
                    if (dragged.current) dragged.current = false;
                    else edit(card.id);
                  }}
                >
                  {/* An end that is cut off by the window has no grip: the day
                      it would be dragging is not one of the days on screen. */}
                  {!at.cutStart && <span className="timeline-grip timeline-grip-start" onPointerDown={grab(card, "start")} />}
                  {!at.cutEnd && <span className="timeline-grip timeline-grip-end" onPointerDown={grab(card, "end")} />}
                </button>
              </Fragment>
            );
          })}
        </div>
      </div>

      {loose.length > 0 && (
        <section className="timeline-loose">
          <header className="timeline-loose-head">
            No date
            <span className="board-col-count">{loose.length}</span>
            <span className="timeline-hint">drag one onto a day, or open it to give it a range</span>
          </header>
          <div className="timeline-loose-cards">
            {loose.map((card) => (
              <button
                key={card.id}
                className="timeline-chip"
                style={tag(card.column)}
                draggable
                title={card.title}
                onDragStart={(event) => {
                  event.dataTransfer.setData(PROFILE_CARD_MIME, card.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => setOver(null)}
                onClick={() => edit(card.id)}
              >
                <span className="board-card-code">{cardCode(profile.name, card.number)}</span>
                <span className="timeline-title">{card.title}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
