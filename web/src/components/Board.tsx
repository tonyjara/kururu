/**
 * A workspace's board, drawn: four columns of cards, and a robot on each that
 * hands the card to an agent.
 *
 * It decides nothing, like `Panes`. The board arrives on the workspace in the
 * snapshot and every change is a verb; the only state held here is what is
 * half-typed and which menu is open — things about this window, not about the
 * board, which is also why a phone and a desktop can edit one board at once.
 *
 * **Every move has a button as well as a drag.** HTML drag and drop does not
 * exist on a touch screen, and the phone is where somebody watching agents
 * goes to check on a card — so the card's menu carries the columns, and a drag
 * on the desktop is the shortcut, never the only door.
 *
 * The run on a card is read two ways at once. `card.run` is what the server
 * recorded — the launcher, when, and the state it last carried over — and the
 * live `AgentSnapshot` is what is happening in that terminal this second. The
 * card draws the agent's own status dot when there is one, so the board and the
 * sidebar can never disagree about the same terminal, and falls back to the
 * recorded state when the terminal has gone.
 */
import { useEffect, useRef, useState } from "react";
import {
  BOARD_COLUMNS,
  columnCards,
  COLUMN_LABELS,
  runLive,
  type Board,
  type BoardColumn,
  type Card,
  type CardRun,
} from "../../../shared/board";
import type { Launcher } from "../../../shared/launchers";
import type { AgentSnapshot, MascotConfig } from "../../../shared/model";
import * as api from "../session";
import { Icon } from "./Icon";
import { Menu, type MenuAt, type MenuItem } from "./Menu";
import { Status } from "./Status";

const CARD_MIME = "application/x-kururu-card";

/** What each recorded state says in words, when there is no live dot to say it. */
const RUN_WORDS: Record<CardRun["state"], string> = {
  starting: "starting…",
  working: "working",
  blocked: "needs you",
  finished: "finished",
  ended: "ended",
};

export function BoardView({
  workspaceId,
  board,
  agents,
  mascot,
  launchers,
}: {
  workspaceId: string;
  board: Board;
  agents: AgentSnapshot[];
  mascot: MascotConfig;
  launchers: Launcher[];
}) {
  /** The column a new card is being written in, or null. One composer at a time. */
  const [adding, setAdding] = useState<BoardColumn | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ at: MenuAt; items: MenuItem[] } | null>(null);
  /** A spawn that failed, by card, until the next try. The snapshot cannot say this. */
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Where a dragged card would land: a column and a place among its cards. */
  const [dropAt, setDropAt] = useState<{ column: BoardColumn; index: number } | null>(null);

  const run = (card: Card, launcher: Launcher) => {
    setErrors(({ [card.id]: _, ...rest }) => rest);
    api.runCard(workspaceId, card.id, launcher.id).catch((err: unknown) => {
      setErrors((all) => ({ ...all, [card.id]: err instanceof Error ? err.message : String(err) }));
    });
  };

  const robotMenu = (card: Card, at: MenuAt) =>
    setMenu({
      at,
      items: launchers.map((launcher, index) => ({
        label: launcher.label,
        hint: launcher.model ? undefined : "default model",
        sep: index > 0 && launchers[index - 1]?.cli !== launcher.cli,
        run: () => run(card, launcher),
      })),
    });

  const cardMenu = (card: Card, at: MenuAt) =>
    setMenu({
      at,
      items: [
        ...BOARD_COLUMNS.filter((column) => column !== card.column).map((column) => ({
          label: `Move to ${COLUMN_LABELS[column]}`,
          run: () => api.moveCard(workspaceId, card.id, column),
        })),
        { label: "Edit", sep: true, run: () => setEditing(card.id) },
        {
          label: "Delete card",
          danger: true,
          /* Says what it leaves alone, because the robot made a terminal and a
             person tidying a list should not have to wonder whether it goes too. */
          hint: runLive(card.run) ? "the agent keeps running" : undefined,
          run: () => api.deleteCard(workspaceId, card.id),
        },
      ],
    });

  const dropOn = (event: React.DragEvent, column: BoardColumn) => {
    const cardId = event.dataTransfer.getData(CARD_MIME);
    const index = dropAt?.column === column ? dropAt.index : undefined;
    setDropAt(null);
    if (!cardId) return;
    event.preventDefault();
    api.moveCard(workspaceId, cardId, column, index);
  };

  return (
    <div className="board">
      {BOARD_COLUMNS.map((column) => {
        const cards = columnCards(board, column);
        return (
          <section
            key={column}
            className={`board-col ${dropAt?.column === column ? "board-col-over" : ""}`}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(CARD_MIME)) return;
              event.preventDefault();
              // Over the column but past its cards: the foot.
              if (event.target === event.currentTarget) setDropAt({ column, index: cards.length });
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(null);
            }}
            onDrop={(event) => dropOn(event, column)}
          >
            <header className="board-col-head">
              <span className="board-col-name">{COLUMN_LABELS[column]}</span>
              <span className="board-col-count">{cards.length}</span>
              <button
                className="pane-btn"
                title={`Add a card to ${COLUMN_LABELS[column]}`}
                aria-label="Add a card"
                onClick={() => setAdding(column)}
              >
                <Icon name="add" />
              </button>
            </header>

            <div
              className="board-cards"
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(CARD_MIME)) return;
                event.preventDefault();
                if (event.target === event.currentTarget) setDropAt({ column, index: cards.length });
              }}
            >
              {cards.map((card, index) =>
                editing === card.id ? (
                  <Composer
                    key={card.id}
                    title={card.title}
                    body={card.body}
                    submit="Save"
                    onSubmit={(title, body) => {
                      api.editCard(workspaceId, card.id, { title, body });
                      setEditing(null);
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <CardView
                    key={card.id}
                    card={card}
                    agent={card.run?.agentId ? agents.find((a) => a.id === card.run?.agentId) : undefined}
                    mascot={mascot}
                    error={errors[card.id]}
                    insertBefore={dropAt?.column === column && dropAt.index === index}
                    canRun={launchers.length > 0}
                    onRobot={(at) => robotMenu(card, at)}
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
                  title=""
                  body=""
                  submit="Add card"
                  onSubmit={(title, body) => {
                    api.addCard(workspaceId, title, body, column);
                    // Stays open for the next one: cards are written in runs.
                  }}
                  onCancel={() => setAdding(null)}
                  keepOpen
                />
              ) : (
                cards.length === 0 && (
                  <button className="board-empty" onClick={() => setAdding(column)}>
                    Add a card
                  </button>
                )
              )}
            </div>
          </section>
        );
      })}

      {menu && <Menu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function CardView({
  card,
  agent,
  mascot,
  error,
  insertBefore,
  canRun,
  onRobot,
  onMenu,
  onEdit,
  onOver,
}: {
  card: Card;
  agent: AgentSnapshot | undefined;
  mascot: MascotConfig;
  error: string | undefined;
  insertBefore: boolean;
  canRun: boolean;
  onRobot: (at: MenuAt) => void;
  onMenu: (at: MenuAt) => void;
  onEdit: () => void;
  onOver: (event: React.DragEvent) => void;
}) {
  const running = runLive(card.run) && agent !== undefined && !agent.exited;
  const below = (event: React.MouseEvent<HTMLElement>): MenuAt => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: box.left, y: box.bottom + 4 };
  };
  return (
    <>
      {insertBefore && <span className="board-insert" aria-hidden="true" />}
      <article
        className={`board-card ${card.run ? `board-card-${card.run.state}` : ""}`}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(CARD_MIME, card.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={onOver}
        onDoubleClick={onEdit}
      >
        <div className="board-card-top">
          <span className="board-card-title">{card.title}</span>
          <button
            className="pane-btn board-robot"
            disabled={running || !canRun}
            title={
              running
                ? "An agent is already on this card"
                : canRun
                  ? "Hand this card to an agent"
                  : "Every agent is switched off in Settings → Agents"
            }
            aria-label="Hand to an agent"
            aria-haspopup="menu"
            onClick={(event) => onRobot(below(event))}
          >
            <Icon name="bot" />
          </button>
          <button
            className="pane-btn"
            title="Move, edit or delete"
            aria-label="Card menu"
            aria-haspopup="menu"
            onClick={(event) => onMenu(below(event))}
          >
            <Icon name="caret" />
          </button>
        </div>
        {card.body && <p className="board-card-body">{card.body}</p>}
        {card.run && <RunLine run={card.run} agent={agent} mascot={mascot} />}
        {error && <p className="board-card-error">{error}</p>}
      </article>
    </>
  );
}

/**
 * The line under a card that has been handed to an agent: whose it is, what it
 * is doing, and the way to it.
 *
 * The dot is the agent's own while the terminal exists, drawn by the same
 * component as the sidebar's — and the words are the run's, because "finished"
 * is a fact about this card that the terminal's `done` only says for as long as
 * nobody has typed into it.
 */
function RunLine({ run, agent, mascot }: { run: CardRun; agent: AgentSnapshot | undefined; mascot: MascotConfig }) {
  return (
    <div className={`board-run board-run-${run.state}`}>
      {agent ? <Status agent={agent} mascot={mascot} /> : <span className="board-run-mark" aria-hidden="true" />}
      <span className="board-run-words">
        {run.label} · {RUN_WORDS[run.state]}
        {run.endedAt && (run.state === "finished" || run.state === "ended") ? ` ${ago(run.endedAt)}` : ""}
      </span>
      {agent && (
        <button className="board-run-open" onClick={() => api.revealAgent(agent.id)} title="Go to this agent's terminal">
          open
        </button>
      )}
    </div>
  );
}

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * Writing a card, new or old. The title is one line and Enter in it saves; the
 * body is the prompt's detail and takes newlines, so there it is ⌘/ctrl+Enter.
 * Escape cancels in both, since a pane has no other way to put the form away
 * from the keyboard.
 */
function Composer({
  title: initialTitle,
  body: initialBody,
  submit,
  onSubmit,
  onCancel,
  keepOpen,
}: {
  title: string;
  body: string;
  submit: string;
  onSubmit: (title: string, body: string) => void;
  onCancel: () => void;
  /** Clear and stay open after saving, for adding several in a row. */
  keepOpen?: boolean;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);

  const save = () => {
    if (!title.trim()) return;
    onSubmit(title, body);
    if (keepOpen) {
      setTitle("");
      setBody("");
      field.current?.focus();
    }
  };
  const keys = (event: React.KeyboardEvent, enterSaves: boolean) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && (enterSaves || event.metaKey || event.ctrlKey) && !event.shiftKey) {
      event.preventDefault();
      save();
    }
  };

  return (
    <form
      className="board-composer"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <input
        ref={field}
        className="dialog-input"
        placeholder="What needs doing"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => keys(event, true)}
      />
      <textarea
        className="dialog-input board-composer-body"
        placeholder="Details — the agent is handed the title and all of this"
        value={body}
        rows={4}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => keys(event, false)}
      />
      <div className="dialog-actions">
        <button type="button" className="button button-quiet" onClick={onCancel}>
          {keepOpen ? "Done" : "Cancel"}
        </button>
        <button type="submit" className="button" disabled={!title.trim()}>
          {submit}
        </button>
      </div>
    </form>
  );
}
