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
  canResume,
  columnCards,
  COLUMN_LABELS,
  runLive,
  type Board,
  type BoardColumn,
  type Card,
  type CardRun,
  type CardWorktree,
} from "../../../shared/board";
import type { Launcher } from "../../../shared/launchers";
import type { AgentSnapshot, MascotConfig } from "../../../shared/model";
import type { WorktreeStatus } from "../../../shared/projects";
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
  /**
   * The open menu, and whose it is: a card's menu opens before its worktree
   * has been asked how it stands, and the answer only belongs in a menu that
   * is still that card's when it arrives.
   */
  const [menu, setMenu] = useState<{ at: MenuAt; items: MenuItem[]; cardId?: string } | null>(null);
  /** A spawn that failed, by card, until the next try. The snapshot cannot say this. */
  const [errors, setErrors] = useState<Record<string, string>>({});
  /**
   * What the last git action on a card came to — "committed 3 files" — until
   * the next one, or a click on it. Not an error and not in the snapshot: the
   * snapshot says the worktree is gone, not that two commits went with it.
   */
  const [notes, setNotes] = useState<Record<string, string>>({});
  /**
   * A merge waiting for its second click. On the card rather than in the menu,
   * because the menu closes on the click that asks, and because the card is
   * where the consequence — worktree gone, agent ended, column changed — is
   * going to show.
   */
  const [ask, setAsk] = useState<Ask | null>(null);

  const said = (cardId: string, text: string) => {
    setErrors(({ [cardId]: _, ...rest }) => rest);
    setNotes((all) => ({ ...all, [cardId]: text }));
  };
  const failed = (cardId: string) => (err: unknown) => {
    setNotes(({ [cardId]: _, ...rest }) => rest);
    setErrors((all) => ({ ...all, [cardId]: err instanceof Error ? err.message : String(err) }));
  };
  /** Where a dragged card would land: a column and a place among its cards. */
  const [dropAt, setDropAt] = useState<{ column: BoardColumn; index: number } | null>(null);

  const run = (card: Card, launcher: Launcher) => {
    setErrors(({ [card.id]: _, ...rest }) => rest);
    api.runCard(workspaceId, card.id, launcher.id).catch((err: unknown) => {
      setErrors((all) => ({ ...all, [card.id]: err instanceof Error ? err.message : String(err) }));
    });
  };

  /**
   * Whether the card's agent still has a terminal — which is not `runLive`: a
   * run that finished its turn is not live, but its terminal is still open, and
   * that is the agent a move to Done would leave running and a resume would
   * start a second copy of.
   */
  const agentOpen = (card: Card) => {
    const agentId = card.run?.agentId;
    return agentId != null && agents.some((a) => a.id === agentId && !a.exited);
  };

  /**
   * The robot's menu: the launchers, and above them — when the card's last
   * agent has gone and its conversation can be found again — the way back
   * into it. A new launcher on a card that has run starts a fresh
   * conversation with the card as its prompt; resume is the one that
   * remembers what was said.
   */
  const robotMenu = (card: Card, at: MenuAt) => {
    const resume: MenuItem[] = canResume(card.run, agentOpen(card))
      ? [
          {
            label: "Resume conversation",
            hint: card.run?.sessionId ? card.run.label : `${card.run?.label ?? "Codex"} · pick a session`,
            run: () => {
              setErrors(({ [card.id]: _, ...rest }) => rest);
              api.resumeCard(workspaceId, card.id).catch(failed(card.id));
            },
          },
        ]
      : [];
    setMenu({
      at,
      items: [
        ...resume,
        ...launchers.map((launcher, index) => ({
          label: launcher.label,
          hint: launcher.model ? undefined : "default model",
          sep: (index === 0 && resume.length > 0) || (index > 0 && launchers[index - 1]?.cli !== launcher.cli),
          run: () => run(card, launcher),
        })),
      ],
    });
  };

  /**
   * The git a card's worktree needs, as menu rows: commit, set aside, merge,
   * a shell. Drawn twice — once as the menu opens, with the counts not yet
   * known and every row that needs them disabled, and again when the status
   * arrives — so that the menu is there on the click and honest a moment
   * later. "Set aside" is `git stash`, and says so in its hint, because it is
   * the row somebody looks for as "discard" and it is deliberately not one.
   */
  const merge = (card: Card, tree: CardWorktree, commitFirst: boolean) =>
    (commitFirst ? api.commitCard(workspaceId, card.id) : Promise.resolve(null))
      .then(() => api.mergeCard(workspaceId, card.id))
      .then(({ commits }) =>
        said(card.id, `Merged ${commits} ${commits === 1 ? "commit" : "commits"} into ${tree.base}; worktree removed`),
      )
      .catch(failed(card.id));

  /**
   * Every road into a column, the drag and the menu row alike. Done is the one
   * that is not just a move for a card with a worktree: on a board that runs
   * cards in worktrees, done means merged — so the card asks, in place, with
   * what the merge will cost, and a yes is `merge-card`, which rebases, fast-
   * forwards the base, takes the worktree down, ends the agent and lands the
   * card in Done itself. Uncommitted work is offered a commit first rather
   * than a refusal, because the card is its message and the person dragging
   * it to Done has already said the work is finished. "Just move" is there
   * for the card whose merge cannot happen yet — a rebase that conflicts, a
   * base that is somewhere else — and leaves the worktree standing.
   */
  const move = (card: Card, column: BoardColumn, index?: number) => {
    const tree = card.worktree;
    const running = agentOpen(card);
    if (column !== "done" || card.column === "done" || (!tree && !running)) {
      api.moveCard(workspaceId, card.id, column, index);
      return;
    }
    /*
     * No worktree, but an agent still open on the card: the work was merged
     * however it was merged, and the terminal is what is left. Done asks
     * whether that goes too rather than ending it — the agent may be the one
     * that did the merge and still have something to say — and "Just move"
     * leaves it, the way a merge that cannot happen yet leaves a worktree.
     */
    if (!tree) {
      const agentId = card.run?.agentId;
      setErrors(({ [card.id]: _, ...rest }) => rest);
      setAsk({
        cardId: card.id,
        text: `Its agent is still open. End it too?${
          canResume(card.run, false) ? " The conversation can be picked up again from the robot." : ""
        }`,
        yes: "Move and end agent",
        run: () => {
          api.moveCard(workspaceId, card.id, column, index);
          if (agentId) api.closeTab(agentId);
        },
        alt: { label: "Just move", run: () => api.moveCard(workspaceId, card.id, column, index) },
      });
      return;
    }
    api.worktreeStatus(workspaceId, card.id).then((status) => {
      const changes = status.changes.length;
      const commits = `${status.ahead} ${status.ahead === 1 ? "commit" : "commits"}`;
      const dirty = changes ? ` ${changes} uncommitted ${changes === 1 ? "file is" : "files are"} committed first as “${card.title}”.` : "";
      const nothing = !changes && status.ahead === 0 ? " Nothing on the branch is new." : "";
      setErrors(({ [card.id]: _, ...rest }) => rest);
      setAsk({
        cardId: card.id,
        text:
          `Done means merged: ${commits} into ${tree.base}.${dirty}${nothing} ` +
          `The worktree is removed${running ? ", its agent is ended" : ""} and branch ${tree.branch} deleted.`,
        yes: changes ? "Commit and merge" : "Merge",
        run: () => merge(card, tree, changes > 0),
        alt: { label: "Just move", run: () => api.moveCard(workspaceId, card.id, column, index) },
      });
    }, failed(card.id));
  };

  const gitItems = (card: Card, tree: CardWorktree, status: WorktreeStatus | null): MenuItem[] => {
    const changes = status?.changes.length ?? 0;
    const files = status ? (changes ? `${changes} ${changes === 1 ? "file" : "files"}` : "nothing to commit") : "…";
    const gone = status !== null && !status.present;
    const running = agentOpen(card);
    return [
      {
        label: "Commit changes",
        sep: true,
        hint: gone ? "worktree gone" : files,
        disabled: !status || gone || changes === 0,
        run: () =>
          api
            .commitCard(workspaceId, card.id)
            .then(({ files }) => said(card.id, `Committed ${files} ${files === 1 ? "file" : "files"} as “${card.title}”`))
            .catch(failed(card.id)),
      },
      {
        label: "Set changes aside",
        hint: gone ? "worktree gone" : status ? (changes ? `git stash · ${files}` : files) : "…",
        disabled: !status || gone || changes === 0,
        run: () =>
          api
            .stashCard(workspaceId, card.id)
            .then(({ files }) =>
              said(card.id, `${files} ${files === 1 ? "file" : "files"} set aside — in git stash as “kururu: ${card.title}”`),
            )
            .catch(failed(card.id)),
      },
      {
        label: `Merge into ${tree.base}`,
        hint: !status
          ? "…"
          : changes
            ? "commit first"
            : `${status.ahead} ${status.ahead === 1 ? "commit" : "commits"}${status.behind ? `, ${status.behind} behind` : ""}`,
        disabled: !status || changes > 0,
        run: () =>
          setAsk({
            cardId: card.id,
            text: `Merge ${status?.ahead ?? 0} ${status?.ahead === 1 ? "commit" : "commits"} into ${tree.base}? The worktree is removed${running ? ", its agent is ended" : ""} and the card goes to Done.`,
            yes: "Merge",
            run: () => merge(card, tree, false),
          }),
      },
      {
        label: "Open a terminal in the worktree",
        hint: gone ? "worktree gone" : undefined,
        disabled: gone,
        run: () => api.openWorktree(workspaceId, card.id).catch(failed(card.id)),
      },
    ];
  };

  const cardMenu = (card: Card, at: MenuAt) => {
    const items = (status: WorktreeStatus | null): MenuItem[] => [
      ...BOARD_COLUMNS.filter((column) => column !== card.column).map((column) => ({
        label: `Move to ${COLUMN_LABELS[column]}`,
        run: () => move(card, column),
      })),
      ...(card.worktree ? gitItems(card, card.worktree, status) : []),
      { label: "Edit", sep: true, run: () => setEditing(card.id) },
        {
          label: "Delete card",
          danger: true,
          /* Says what it leaves alone, because the robot made a terminal and a
             worktree, and a person tidying a list should not have to wonder
             whether they go too. Neither does: taking a worktree down is the
             merge row's job, and a deleted card has not been through it. */
          hint: runLive(card.run)
            ? card.worktree
              ? "the agent and its worktree stay"
              : "the agent keeps running"
            : card.worktree
              ? "its worktree stays on disk"
              : undefined,
          run: () => api.deleteCard(workspaceId, card.id),
        },
      ];
    setMenu({ at, items: items(null), cardId: card.id });
    if (card.worktree) {
      api.worktreeStatus(workspaceId, card.id).then(
        (status) => setMenu((open) => (open?.cardId === card.id ? { ...open, items: items(status) } : open)),
        // A status that could not be read leaves the rows disabled; the reason
        // goes where a failed action's would.
        failed(card.id),
      );
    }
  };

  const dropOn = (event: React.DragEvent, column: BoardColumn) => {
    const cardId = event.dataTransfer.getData(CARD_MIME);
    const index = dropAt?.column === column ? dropAt.index : undefined;
    setDropAt(null);
    if (!cardId) return;
    event.preventDefault();
    const card = board.cards.find((c) => c.id === cardId);
    if (card) move(card, column, index);
    else api.moveCard(workspaceId, cardId, column, index);
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
                    note={notes[card.id]}
                    onNoteClick={() => setNotes(({ [card.id]: _, ...rest }) => rest)}
                    ask={ask?.cardId === card.id ? ask : null}
                    onAsk={(choice) => {
                      const pending = ask;
                      setAsk(null);
                      if (choice === "yes") pending?.run();
                      else if (choice === "alt") pending?.alt?.run();
                    }}
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
                  onRun={
                    launchers.length > 0
                      ? (title, body, at) =>
                          setMenu({
                            at,
                            items: launchers.map((launcher, index) => ({
                              label: launcher.label,
                              hint: launcher.model ? undefined : "default model",
                              sep: index > 0 && launchers[index - 1]?.cli !== launcher.cli,
                              run: () => {
                                setAdding(null);
                                api.addRunCard(workspaceId, title, body, column, launcher.id).catch((err: unknown) => {
                                  console.error("add-run-card failed", err);
                                  window.alert(err instanceof Error ? err.message : String(err));
                                });
                              },
                            })),
                          })
                      : undefined
                  }
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

/** A question a card is asking in place: what it says, and what yes and the other way out do. */
interface Ask {
  cardId: string;
  text: string;
  yes: string;
  run: () => void;
  alt?: { label: string; run: () => void };
}

function CardView({
  card,
  agent,
  mascot,
  error,
  note,
  onNoteClick,
  ask,
  onAsk,
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
  /** What the last git action came to, until clicked away. */
  note: string | undefined;
  onNoteClick: () => void;
  /** A merge waiting for its second click, or null. */
  ask: Ask | null;
  onAsk: (choice: "yes" | "alt" | "no") => void;
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
        {card.worktree && <TreeLine worktree={card.worktree} />}
        {card.run && <RunLine run={card.run} agent={agent} mascot={mascot} />}
        {error && <p className="board-card-error">{error}</p>}
        {note && (
          <p className="board-card-note" onClick={onNoteClick} title="Click to dismiss">
            {note}
          </p>
        )}
        {ask && (
          <div className="board-card-ask" role="alertdialog" aria-label="Confirm">
            <p className="board-card-ask-text">{ask.text}</p>
            <div className="board-card-ask-actions">
              <button className="button button-quiet" onClick={() => onAsk("no")}>
                Cancel
              </button>
              {ask.alt && (
                <button className="button button-quiet" onClick={() => onAsk("alt")}>
                  {ask.alt.label}
                </button>
              )}
              <button className="button" onClick={() => onAsk("yes")}>
                {ask.yes}
              </button>
            </div>
          </div>
        )}
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

/**
 * The checkout a card's work is in: its branch, and what it was cut from.
 * Above the run line because it outlives the run — the branch is where the
 * afternoon's diff is, whether or not anything is still working on it. The
 * path is a hover rather than a line, being long and the same for every card
 * but its last segment.
 */
function TreeLine({ worktree }: { worktree: CardWorktree }) {
  return (
    <div className="board-tree" title={`${worktree.path}\ncut from ${worktree.base}`}>
      <span className="board-tree-branch">{worktree.branch}</span>
      <span className="board-tree-base">from {worktree.base}</span>
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
  onRun,
  onCancel,
  keepOpen,
}: {
  title: string;
  body: string;
  submit: string;
  onSubmit: (title: string, body: string) => void;
  /** Add the card and hand it straight to an agent; the robot beside the submit button. */
  onRun?: (title: string, body: string, at: MenuAt) => void;
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
  // Grown by hand, not with `field-sizing`: the phone's browser is not always
  // one that has it. The height follows the text; the stylesheet's max-height
  // is where it stops and the textarea scrolls instead.
  const area = useRef<HTMLTextAreaElement | null>(null);
  const grow = (node: HTMLTextAreaElement | null) => {
    area.current = node;
  };
  useLayoutEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, [body]);
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
        ref={grow}
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
        {onRun && (
          <button
            type="button"
            className="pane-btn"
            title="Add and run on an agent"
            aria-label="Add and run on an agent"
            aria-haspopup="menu"
            disabled={!title.trim()}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              onRun(title, body, { x: box.left, y: box.bottom + 4 });
            }}
          >
            <Icon name="bot" />
          </button>
        )}
      </div>
    </form>
  );
}
