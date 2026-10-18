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
 *
 * It is drawn in one place, a workspace's own pane, and a card on it can be
 * asked for by name from elsewhere — a reply of Kuru's that cites it, a
 * search hit, a row in the drawer of things that need you. `showCardNext`
 * is that door: the asker names the workspace and the card, opens the
 * workspace's board the ordinary way, and the board drawn there scrolls
 * the card into view and lights it for a moment. Shown, not opened: the
 * asker wanted to see the card, and the edit is a double-click away if
 * they want that too. For a version the profile's sheet drew any workspace's
 * board over the window instead, and the server's card verbs still take any
 * workspace of the profile for it; the sheet's version went because what
 * it listed was boards and what was wanted was needs.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  BOARD_COLUMNS,
  canResume,
  cardCode,
  columnCards,
  COLUMN_LABELS,
  runLive,
  type Board,
  type BoardColumn,
  type Card,
  type CardDates,
  type CardDev,
  type CardRun,
  type CardWorktree,
} from "../../../shared/board";
import { today, type Day } from "../../../shared/days";
import type { Launcher } from "../../../shared/launchers";
import type { AgentSnapshot, MascotConfig } from "../../../shared/model";
import type { WorktreeStatus } from "../../../shared/projects";
import type { DevServer } from "../../../shared/wire";
import { useCardDone } from "../cardDone";
import { isLoopback, previewUrl, serverIn } from "../preview";
import { sameJson } from "../same";
import * as api from "../session";
import { datesLabel, datesTense } from "../when";
import { ColumnResizeHandle } from "./ColumnResize";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
import { MadeLinks } from "./MadeLinks";
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
  asleep: "asleep after sitting idle",
};

/**
 * Half-written cards, kept out here rather than in the board's state because
 * the board is unmounted whenever its tab or its workspace is left, and a card
 * someone was in the middle of writing should be where they left it when they
 * come back. Which composers were open is kept beside the text, since a draft
 * nobody can see is as good as lost. Memory only, not storage: a draft is a
 * minute's work, and a reload putting it away is less surprising than one
 * reappearing a day later on a board that has moved on.
 */
interface Draft {
  title: string;
  body: string;
  isolate: boolean;
  /** The two date fields as typed, either of which may be empty — see `Composer`. */
  start: string;
  end: string;
}
const drafts = new Map<string, Draft>();
/** Put a composer's draft away, for a board that keeps its own keys — the profile's. */
export const dropDraft = (key: string) => void drafts.delete(key);
const openComposers = new Map<string, { adding: BoardColumn | null; editing: string | null }>();
const newDraft = (workspaceId: string, column: BoardColumn) => `${workspaceId}\0new\0${column}`;
const editDraft = (workspaceId: string, cardId: string) => `${workspaceId}\0card\0${cardId}`;

/**
 * A card somebody asked to be shown, by workspace and id, for the board of
 * that workspace to scroll to when it is next drawn — or at once, if it is
 * on screen already. Module state for `drafts`' reason: the asker is not in
 * this tree, and the board may not be mounted when it asks. Taken once, by
 * the first board that is the right workspace's, and never written to disk.
 */
let wanted: { workspaceId: string; cardId: string } | null = null;
const wantedListeners = new Set<() => void>();
function setWanted(next: typeof wanted): void {
  wanted = next;
  for (const listener of wantedListeners) listener();
}
export function showCardNext(workspaceId: string, cardId: string): void {
  setWanted({ workspaceId, cardId });
}
/** How long a card asked for stays lit, so the eye finds it and then nothing on the board says it was. */
const SHOWN_MS = 1800;
function useWanted(): typeof wanted {
  return useSyncExternalStore(
    (listener) => {
      wantedListeners.add(listener);
      return () => wantedListeners.delete(listener);
    },
    () => wanted,
  );
}

/**
 * Hold a new card's composer in sight, for the list of the column it is open
 * in. It is written at the foot of the column, which in a long one is below
 * the fold: the header's add opened it out of view, and the title field's
 * focus scrolled only that field in, leaving the body and the add button
 * under the edge. And it stays open for the next card, so every card it adds
 * lands above it and pushes it down again — which is why this follows the
 * count and not only the opening. The list is scrolled rather than the form
 * asked into view, because `scrollIntoView` scrolls every ancestor that can,
 * and the board sideways is one of them.
 */
export function useComposerInView(column: string | null, count: number) {
  const list = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = list.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [column, count]);
  return list;
}

export function BoardView({
  workspaceId,
  workspaceName,
  board,
  agents,
  mascot,
  launchers,
  focusedAgentId,
}: {
  workspaceId: string;
  workspaceName: string;
  board: Board;
  agents: AgentSnapshot[];
  mascot: MascotConfig;
  launchers: Launcher[];
  /**
   * The terminal in the focused pane, the one the sidebar marks. The card it
   * is the agent of wears the accent, so that with the board in one pane and
   * an agent in the next the board says which card the keyboard is on.
   * Only a run's agent: a card's dev server or a shell in its worktree is not
   * the work the card is about. Null, as for a pane showing a board, a
   * document or nothing, lights nothing.
   */
  focusedAgentId: string | null;
}) {
  /** The column a new card is being written in, or null. One composer at a time. */
  const [adding, setAddingState] = useState<BoardColumn | null>(() => openComposers.get(workspaceId)?.adding ?? null);
  const [editing, setEditingState] = useState<string | null>(() => openComposers.get(workspaceId)?.editing ?? null);
  /**
   * A card asked for by name — see `showCardNext` — scrolled to and lit.
   * Taken on arrival and on every later ask, so a board already on screen
   * answers too; taken through the store, so that the ask is gone from the
   * next render and a board that re-renders does not scroll again. The time
   * on `shown` is what lets the same card be asked for twice.
   */
  const asked = useWanted();
  const root = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<{ id: string; at: number } | null>(null);
  useEffect(() => {
    if (!asked || asked.workspaceId !== workspaceId) return;
    setWanted(null);
    if (!board.cards.some((c) => c.id === asked.cardId)) return;
    root.current
      ?.querySelector<HTMLElement>(`[data-card="${CSS.escape(asked.cardId)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    setShown({ id: asked.cardId, at: Date.now() });
  }, [asked, workspaceId, board]);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(null), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  // A composer put away on purpose takes its draft with it; one the board was
  // unmounted from underneath keeps it, which is the whole point of `drafts`.
  const setAdding = (column: BoardColumn | null) => {
    if (adding && adding !== column) drafts.delete(newDraft(workspaceId, adding));
    setAddingState(column);
  };
  const setEditing = (cardId: string | null) => {
    if (editing && editing !== cardId) drafts.delete(editDraft(workspaceId, editing));
    setEditingState(cardId);
  };
  useEffect(() => {
    openComposers.set(workspaceId, { adding, editing });
  }, [workspaceId, adding, editing]);
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
   * Cards with a slow git action in flight, and what it is doing. A merge is a
   * commit, a rebase, a worktree removal and an ended agent, and takes seconds
   * in which the card would otherwise sit there looking like nothing happened.
   */
  const [working, setWorking] = useState<Record<string, string>>({});
  const said = (cardId: string, text: string) => {
    setErrors(({ [cardId]: _, ...rest }) => rest);
    setNotes((all) => ({ ...all, [cardId]: text }));
  };
  const failed = (cardId: string) => (err: unknown) => {
    setNotes(({ [cardId]: _, ...rest }) => rest);
    setErrors((all) => ({ ...all, [cardId]: err instanceof Error ? err.message : String(err) }));
  };
  const { devServers } = api.useKururu();
  const reveal = (agentId: string) => api.revealAgent(agentId);
  /** Where a dragged card would land: a column and a place among its cards. */
  const [dropAt, setDropAt] = useState<{ column: BoardColumn; index: number } | null>(null);

  const run = (card: Card, launcher: Launcher, fresh = false) => {
    setErrors(({ [card.id]: _, ...rest }) => rest);
    api.runCard(workspaceId, card.id, launcher.id, fresh).catch((err: unknown) => {
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

  /** Whether the card's dev server still has a tab, whether or not its process is still up. */
  const devOpen = (card: Card) => {
    const agentId = card.dev?.agentId;
    return agentId != null && agents.some((a) => a.id === agentId);
  };

  /**
   * Done's own question — end the agent too, or merge — asked the same way
   * here and from the Needs drawer's "Move to Done": see `useCardDone`.
   */
  const { ask, setAsk, merge, moveToDone } = useCardDone(agentOpen, devOpen, {
    working: (cardId, text) => setWorking((all) => ({ ...all, [cardId]: text })),
    done: (cardId) => setWorking(({ [cardId]: _, ...rest }) => rest),
    note: said,
    error: (cardId, err) => failed(cardId)(err),
    clearError: (cardId) => setErrors(({ [cardId]: _, ...rest }) => rest),
  });

  const restartDev = (card: Card) => {
    setErrors(({ [card.id]: _, ...rest }) => rest);
    api.restartCardDev(workspaceId, card.id).catch(failed(card.id));
  };
  const stopDev = (card: Card) => {
    setErrors(({ [card.id]: _, ...rest }) => rest);
    api.stopCardDev(workspaceId, card.id).catch(failed(card.id));
  };

  const resume = (card: Card) => {
    setErrors(({ [card.id]: _, ...rest }) => rest);
    api.resumeCard(workspaceId, card.id).catch(failed(card.id));
  };

  /**
   * The robot's menu: the launchers, and above them — when the card's last
   * agent has gone and its conversation can be found again — the way back
   * into it. A new launcher on a card that has run starts a fresh
   * conversation with the card as its prompt; resume is the one that
   * remembers what was said. On a card whose agent was put to sleep the
   * server would resume on a launcher row too, as it promised the card, so
   * those rows say "new conversation" and ask for one in so many words.
   */
  const robotMenu = (card: Card, at: MenuAt) => {
    const asleep = card.run?.state === "asleep";
    const resumeRow: MenuItem[] = canResume(card.run, agentOpen(card))
      ? [
          {
            label: "Resume conversation",
            hint: card.run?.sessionId ? `${card.run.label}${asleep ? " · asleep" : ""}` : `${card.run?.label ?? "Codex"} · pick a session`,
            run: () => resume(card),
          },
        ]
      : [];
    setMenu({
      at,
      items: [
        ...resumeRow,
        ...launchers.map((launcher, index) => ({
          label: launcher.label,
          hint: resumeRow.length > 0 && asleep ? "new conversation" : launcher.model ? undefined : "default model",
          sep: (index === 0 && resumeRow.length > 0) || (index > 0 && launchers[index - 1]?.cli !== launcher.cli),
          run: () => run(card, launcher, asleep),
        })),
      ],
    });
  };

  /**
   * Every road into a column, the drag and the menu row alike. Done is asked
   * about through `useCardDone`'s `moveToDone` rather than a second version
   * of the same question here — the Needs drawer asks it too, from its own
   * menu, and the two must never drift into two different dialogs for one
   * move.
   */
  const move = (card: Card, column: BoardColumn, index?: number) => {
    if (column === "done" && card.column !== "done") {
      moveToDone(workspaceId, card, index);
      return;
    }
    api.moveCard(workspaceId, card.id, column, index);
  };

  /**
   * The git a card's worktree needs, as menu rows: commit, set aside, merge,
   * a shell. Drawn twice — once as the menu opens, with the counts not yet
   * known and every row that needs them disabled, and again when the status
   * arrives — so that the menu is there on the click and honest a moment
   * later. "Set aside" is `git stash`, and says so in its hint, because it is
   * the row somebody looks for as "discard" and it is deliberately not one.
   */
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
            title: running ? `Merge and end ${card.run?.label ?? "the agent"}?` : `Merge into ${tree.base}?`,
            hint: `${status?.ahead ?? 0} ${status?.ahead === 1 ? "commit" : "commits"} into ${tree.base}. The worktree is removed and the card goes to Done.`,
            yes: "Merge",
            run: () => merge(workspaceId, card, tree, false),
          }),
      },
      {
        label: "Open a terminal in the worktree",
        hint: gone ? "worktree gone" : undefined,
        disabled: gone,
        // The server focuses the new terminal itself, in this pane's workspace.
        run: () => api.openWorktree(workspaceId, card.id).then(() => undefined, failed(card.id)),
      },
      {
        label: devOpen(card) ? "Restart the dev server" : "Start the dev server",
        hint: gone ? "worktree gone" : card.dev ? `offered :${card.dev.port}` : "the project's dev line",
        disabled: gone,
        run: () => restartDev(card),
      },
      ...(devOpen(card)
        ? [{ label: "Stop the dev server", hint: "and close its tab", run: () => stopDev(card) }]
        : []),
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

  const addingList = useComposerInView(adding, adding ? columnCards(board, adding).length : 0);

  // Rebuilt on every render and read through the ref, so that the cards are
  // handed the same object every time — see `CardView`.
  const cardVerbs: CardVerbs = {
    robot: robotMenu,
    menu: cardMenu,
    edit: setEditing,
    over: (event, column, index) => {
      if (!event.dataTransfer.types.includes(CARD_MIME)) return;
      event.preventDefault();
      event.stopPropagation();
      const box = event.currentTarget.getBoundingClientRect();
      setDropAt({ column, index: event.clientY > box.top + box.height / 2 ? index + 1 : index });
    },
    reveal,
    resume,
    restartDev,
    stopDev,
    dismissNote: (cardId) => setNotes(({ [cardId]: _, ...rest }) => rest),
  };
  const verbs = useRef(cardVerbs);
  verbs.current = cardVerbs;
  // For the dates on a card, which say "today" and "tomorrow": `endedAgo`'s
  // reason, once a day.
  const day = today(new Date());

  return (
    <div className="board" ref={root}>
      {BOARD_COLUMNS.map((column) => {
        const cards = columnCards(board, column);
        return (
          <section
            key={column}
            className={`board-col ${dropAt?.column === column ? "board-col-over" : ""}`}
            style={board.widths?.[column] !== undefined ? ({ "--col-w": `${board.widths[column]}px` } as React.CSSProperties) : undefined}
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
              ref={adding === column ? addingList : undefined}
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
                    draft={editDraft(workspaceId, card.id)}
                    title={card.title}
                    body={card.body}
                    isolate={card.isolate}
                    // A card whose worktree stands goes back into it whatever
                    // the box says, so the box is only offered before there is one.
                    offerIsolate={!card.worktree}
                    // Dates are given on the profile's board, which has the
                    // timeline. A card that was sent here with some can have
                    // them moved or taken off; one without is not asked.
                    dates={card.dates}
                    offerDates={card.dates !== null}
                    submit="Save"
                    onSubmit={(title, body, isolate, dates) => {
                      api.editCard(workspaceId, card.id, { title, body, isolate, ...(card.dates ? { dates } : {}) });
                      setEditing(null);
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <CardView
                    key={card.id}
                    card={card}
                    code={cardCode(workspaceName, card.number)}
                    agent={card.run?.agentId ? agents.find((a) => a.id === card.run?.agentId) : undefined}
                    server={card.dev?.agentId ? agents.find((a) => a.id === card.dev?.agentId) : undefined}
                    devServers={devServers}
                    mascot={mascot}
                    error={errors[card.id]}
                    working={working[card.id]}
                    note={notes[card.id]}
                    insertBefore={dropAt?.column === column && dropAt.index === index}
                    canRun={launchers.length > 0}
                    resumable={canResume(card.run, agentOpen(card))}
                    ended={endedAgo(card.run)}
                    day={day}
                    focused={focusedAgentId !== null && card.run?.agentId === focusedAgentId}
                    shown={shown?.id === card.id}
                    column={column}
                    index={index}
                    workspaceId={workspaceId}
                    verbs={verbs}
                  />
                ),
              )}
              {dropAt?.column === column && dropAt.index === cards.length && (
                <span className="board-insert" aria-hidden="true" />
              )}
              {adding === column ? (
                <Composer
                  draft={newDraft(workspaceId, column)}
                  title=""
                  body=""
                  isolate={false}
                  offerIsolate
                  submit="Add"
                  onSubmit={(title, body, isolate) => {
                    api.addCard(workspaceId, title, body, column, isolate);
                    // Stays open for the next one: cards are written in runs.
                  }}
                  onRun={
                    launchers.length > 0
                      ? (title, body, isolate, at) =>
                          setMenu({
                            at,
                            items: launchers.map((launcher, index) => ({
                              label: launcher.label,
                              hint: launcher.model ? undefined : "default model",
                              sep: index > 0 && launchers[index - 1]?.cli !== launcher.cli,
                              run: () => {
                                setAdding(null);
                                api.addRunCard(workspaceId, title, body, column, isolate, launcher.id).catch((err: unknown) => {
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
                // At the foot of every column, not only an empty one: the end
                // of a long column is where the next card is looked for, and
                // the header's add is a screen away by then.
                <button className="board-empty" onClick={() => setAdding(column)}>
                  Add a card
                </button>
              )}
            </div>
            <ColumnResizeHandle onResize={(width) => api.resizeColumn(workspaceId, column, width)} onReset={() => api.resizeColumn(workspaceId, column, null)} />
          </section>
        );
      })}

      {menu && <Menu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
      {ask && board.cards.some((c) => c.id === ask.cardId) && (
        <Dialog
          state={{
            kind: "ask",
            title: ask.title,
            hint: ask.hint,
            yes: ask.yes,
            run: ask.run,
            alt: ask.alt,
            choices: ask.choices,
          }}
          onClose={() => setAsk(null)}
        />
      )}
    </div>
  );
}

/**
 * What a card can ask of the board it is on. Its own type, and handed down as
 * one ref rather than as a closure per card, for `CardView`'s reason: see there.
 */
interface CardVerbs {
  robot: (card: Card, at: MenuAt) => void;
  menu: (card: Card, at: MenuAt) => void;
  edit: (cardId: string) => void;
  /** A card dragged over this one, which sits at `index` in `column`. */
  over: (event: React.DragEvent, column: BoardColumn, index: number) => void;
  /** Take the person to a terminal: the run's agent, or the dev server's log. */
  reveal: (agentId: string) => void;
  resume: (card: Card) => void;
  restartDev: (card: Card) => void;
  stopDev: (card: Card) => void;
  dismissNote: (cardId: string) => void;
}

/**
 * When it ended, as the run line says it, for a run that has — or null.
 *
 * Out here and handed in rather than worked out in the line, because the card
 * is memoised: "just now" computed inside it would stay "just now" until
 * something else about the card changed, where handed in it is a prop that
 * changes when the words do, on whatever render of the board is next.
 */
function endedAgo(run: CardRun | null): string | null {
  return run?.endedAt && (run.state === "finished" || run.state === "ended" || run.state === "asleep")
    ? ago(run.endedAt)
    : null;
}

/**
 * One card, drawn again only when something it shows has changed.
 *
 * That is the point of the `memo` and of `sameJson` beside it. The snapshot is
 * replaced whole on every message, so without them each status tick anywhere
 * in the profile — and each focus change, which is a snapshot too — redrew
 * every card on every board on screen to move one dot or one highlight. What
 * stops a card being redrawn is that its props say the same thing as last
 * time, which is why nothing here takes a closure: the board's verbs come as
 * one ref that never changes, read at the moment of a click, so a card that
 * has skipped a dozen renders still acts with the board as it is now — its
 * agents, its launchers, whichever composer is open.
 */
const CardView = memo(function CardView({
  card,
  code,
  agent,
  server,
  devServers,
  mascot,
  error,
  working,
  note,
  insertBefore,
  canRun,
  resumable,
  ended,
  day,
  focused,
  shown,
  column,
  index,
  workspaceId,
  verbs,
}: {
  card: Card;
  code: string;
  agent: AgentSnapshot | undefined;
  /** The terminal the card's dev server runs in, while it has one. */
  server: AgentSnapshot | undefined;
  devServers: DevServer[];
  mascot: MascotConfig;
  error: string | undefined;
  /** What a slow git action on this card is doing right now, if one is. */
  working: string | undefined;
  /** What the last git action came to, until clicked away. */
  note: string | undefined;
  insertBefore: boolean;
  canRun: boolean;
  /** Whether the run's conversation can be picked back up from here. */
  resumable: boolean;
  /** See `endedAgo`. */
  ended: string | null;
  /** Today, which the card's dates are said relative to. */
  day: Day;
  /** Its agent is in the focused pane — see `BoardView`'s `focusedAgentId`. */
  focused: boolean;
  /** It was just asked for by name and is lit for a moment — see `showCardNext`. */
  shown: boolean;
  /** Where the card sits, for a drag over it to say which side it would land. */
  column: BoardColumn;
  index: number;
  /** The board's workspace, which a link to what the card's agent made opens in. */
  workspaceId: string;
  verbs: { readonly current: CardVerbs };
}) {
  const running = runLive(card.run) && agent !== undefined && !agent.exited;
  const below = (event: React.MouseEvent<HTMLElement>): MenuAt => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: box.left, y: box.bottom + 4 };
  };
  const reveal = (agentId: string) => verbs.current.reveal(agentId);
  return (
    <>
      {insertBefore && <span className="board-insert" aria-hidden="true" />}
      <article
        className={[
          "board-card",
          card.run ? `board-card-${card.run.state}` : "",
          focused ? "board-card-on" : "",
          shown ? "board-card-shown" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-card={card.id}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(CARD_MIME, card.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(event) => verbs.current.over(event, column, index)}
        onDoubleClick={() => verbs.current.edit(card.id)}
        /* The same menu the caret opens, where the pointer is — one list for
           both doors, as a workspace row's. The robot's launchers are not in
           it: handing the card to an agent is the robot's one job, and a
           menu that mixed nine model rows into move, edit and delete would
           bury the verbs a right-click comes for. */
        onContextMenu={(event) => {
          event.preventDefault();
          verbs.current.menu(card, { x: event.clientX, y: event.clientY });
        }}
      >
        <div className="board-card-top">
          <span className="board-card-code">{code}</span>
          <span className="board-card-title">{card.title}</span>
          <span className="board-card-actions">
            <button
              className="board-icon-btn board-robot"
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
              onClick={(event) => verbs.current.robot(card, below(event))}
            >
              <Icon name="bot" />
            </button>
            <button
              className="board-icon-btn"
              title="Move, edit or delete"
              aria-label="Card menu"
              aria-haspopup="menu"
              onClick={(event) => verbs.current.menu(card, below(event))}
            >
              <Icon name="caret" />
            </button>
          </span>
        </div>
        {card.body && <CardBody text={card.body} />}
        {card.dates && <CardWhen dates={card.dates} now={day} />}
        {card.worktree ? (
          <TreeLine worktree={card.worktree} />
        ) : (
          card.isolate && (
            <div className="board-tree board-tree-pending" title="Its agent starts in a worktree of its own">
              <Icon name="git" />
              <span className="board-tree-base">worktree on run</span>
            </div>
          )
        )}
        {card.worktree && card.dev && server && (
          <DevLine
            dev={card.dev}
            worktree={card.worktree}
            terminal={server}
            servers={devServers}
            onRestart={() => verbs.current.restartDev(card)}
            onStop={() => verbs.current.stopDev(card)}
            onReveal={reveal}
          />
        )}
        {card.run && (
          <RunLine
            run={card.run}
            agent={agent}
            mascot={mascot}
            ended={ended}
            onReveal={reveal}
            onResume={resumable ? () => verbs.current.resume(card) : undefined}
          />
        )}
        {/* The links its agent's row carries, kept here so they outlive the agent —
            after an idle card's agent is ended, this is where the document still is. */}
        {card.made?.length ? <MadeLinks className="board-made" files={card.made} workspaceId={workspaceId} /> : null}
        {error && <p className="board-card-error">{error}</p>}
        {working && (
          <p className="board-card-busy" role="status">
            <span className="spinner" aria-hidden="true" />
            {working}
          </p>
        )}
        {note && (
          <p className="board-card-note" onClick={() => verbs.current.dismissNote(card.id)} title="Click to dismiss">
            {note}
          </p>
        )}
      </article>
    </>
  );
}, sameJson);

/**
 * The line under a card that has been handed to an agent: whose it is, what it
 * is doing, and the way to it.
 *
 * The dot is the agent's own while the terminal exists, drawn by the same
 * component as the sidebar's — and the words are the run's, because "finished"
 * is a fact about this card that the terminal's `done` only says for as long as
 * nobody has typed into it.
 *
 * A run kururu put to sleep says so, and carries its way back on the line
 * itself: one press, the same conversation, rather than a menu to find it in.
 */
function RunLine({
  run,
  agent,
  mascot,
  ended,
  onReveal,
  onResume,
}: {
  run: CardRun;
  agent: AgentSnapshot | undefined;
  mascot: MascotConfig;
  /** See `endedAgo`. */
  ended: string | null;
  onReveal: (agentId: string) => void;
  onResume: (() => void) | undefined;
}) {
  const asleep = run.state === "asleep";
  return (
    <div className={`board-run board-run-${run.state}`}>
      {agent ? <Status agent={agent} mascot={mascot} /> : <span className="board-run-mark" aria-hidden="true" />}
      <span
        className="board-run-words"
        title={
          asleep
            ? "kururu ended this agent after it sat idle, to save the battery. Its conversation is kept: resuming picks it back up where it was."
            : undefined
        }
      >
        {run.label} · {RUN_WORDS[run.state]}
        {ended ? ` ${ended}` : ""}
      </span>
      {agent && (
        <span className="board-seg">
          <button className="board-seg-btn" onClick={() => onReveal(agent.id)} title="Go to this agent's terminal">
            open
          </button>
        </span>
      )}
      {!agent && asleep && onResume && (
        <span className="board-seg">
          <button className="board-seg-btn" onClick={onResume} title="Wake it: the same conversation, with its context">
            resume
          </button>
        </span>
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
      <Icon name="git" />
      <span className="board-tree-branch">{worktree.branch}</span>
      <span className="board-tree-base">from {worktree.base}</span>
    </div>
  );
}

/**
 * The card's dev server: where it is listening and the way there, with ↻ and ■
 * beside it. The link is the scan's, not the offered port's — see `serverIn` —
 * except on this machine while the scan has not found it yet, where the
 * offered port is the best guess going and a wrong one costs a refused tab.
 * A remote client gets no link until the scan has found it and the proxy is
 * open, for `previewUrl`'s reason.
 */
function DevLine({
  dev,
  worktree,
  terminal,
  servers,
  onRestart,
  onStop,
  onReveal,
}: {
  dev: CardDev;
  worktree: CardWorktree;
  terminal: AgentSnapshot;
  servers: DevServer[];
  onRestart: () => void;
  onStop: () => void;
  onReveal: (agentId: string) => void;
}) {
  const found = serverIn(servers, worktree.path, dev.port);
  const url = terminal.exited
    ? null
    : found
      ? previewUrl(window.location, found)
      : isLoopback(window.location.hostname)
        ? `http://localhost:${dev.port}/`
        : null;
  const words = terminal.exited
    ? `dev server ended${terminal.exitCode != null ? ` (${terminal.exitCode})` : ""}`
    : found
      ? `dev · :${found.port}`
      : `dev · starting on :${dev.port}…`;
  return (
    <div className={`board-run board-dev ${terminal.exited ? "board-dev-ended" : ""}`}>
      <span className="board-run-words" title={worktree.path}>
        {words}
      </span>
      {/* One segmented group rather than two pills and two bare icons: every
          control on the line is about the same terminal, and a row of four
          differently shaped things read as four unrelated ones. */}
      <span className="board-seg">
        {url && (
          <a className="board-seg-btn" href={url} target="_blank" rel="noreferrer noopener" title={`Open ${url}`}>
            open <Icon name="external" />
          </a>
        )}
        <button className="board-seg-btn" onClick={() => onReveal(terminal.id)} title="Go to the dev server's terminal">
          log
        </button>
        <button className="board-seg-btn" onClick={onRestart} title="Restart the dev server" aria-label="Restart the dev server">
          <Icon name="restart" />
        </button>
        <button
          className="board-seg-btn"
          onClick={onStop}
          title="Stop the dev server and close its tab"
          aria-label="Stop the dev server"
        >
          <Icon name="stop" />
        </button>
      </span>
    </div>
  );
}

/** How long ago, in the words the run line uses; the drawer of needs says the same thing the same way. */
export function ago(at: number): string {
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
/**
 * When a card is for, as a line on the card. It says which side of today the
 * dates fall on by its ink alone, so that a column can be scanned for what is
 * happening now without reading a date on it.
 */
export function CardWhen({ dates, now }: { dates: CardDates; now?: Day }) {
  return <span className={`board-card-when board-card-when-${datesTense(dates, now)}`}>{datesLabel(dates, now)}</span>;
}

/**
 * A card's message, clamped to two lines until a "More" opens it in place.
 * The toggle only appears on a card whose text is actually cut off — a
 * `ResizeObserver` on the clamped paragraph is what knows that, since the
 * same text clamps or doesn't depending on the column's width. Clicks on the
 * toggle stop there: the card underneath it is still draggable and still
 * opens its editor on a double-click, so the toggle must not pass either
 * gesture up to it.
 */
export function CardBody({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const body = useRef<HTMLParagraphElement | null>(null);

  useLayoutEffect(() => {
    const node = body.current;
    if (!node || expanded) return;
    const check = () => setClamped(node.scrollHeight - node.clientHeight > 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <div className="board-card-body-wrap">
      <p ref={body} className={`board-card-body ${expanded ? "board-card-body-open" : ""}`}>
        {text}
      </p>
      {(clamped || expanded) && (
        <button
          type="button"
          className="board-card-more"
          draggable={false}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((was) => !was);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {expanded ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

export function Composer({
  draft,
  title: initialTitle,
  body: initialBody,
  isolate: initialIsolate,
  offerIsolate,
  dates: initialDates = null,
  offerDates = false,
  submit,
  onSubmit,
  onRun,
  onCancel,
  keepOpen,
  bodyHint = "Details — the agent is handed the title and all of this",
}: {
  /** Where in `drafts` this composer's text is kept while the board is away. */
  draft: string;
  title: string;
  body: string;
  isolate: boolean;
  /** Whether the worktree box is drawn; see `Card.isolate`. */
  offerIsolate: boolean;
  dates?: CardDates | null;
  /** Whether the date fields are drawn; see `Card.dates`. Without them `onSubmit` is handed what came in. */
  offerDates?: boolean;
  submit: string;
  onSubmit: (title: string, body: string, isolate: boolean, dates: CardDates | null) => void;
  /** Add the card and hand it straight to an agent; the robot beside the submit button. */
  onRun?: (title: string, body: string, isolate: boolean, at: MenuAt) => void;
  onCancel: () => void;
  /** Clear and stay open after saving, for adding several in a row. */
  keepOpen?: boolean;
  /** What the empty body says it is for. The profile's board hands nothing to an agent. */
  bodyHint?: string;
}) {
  const [kept] = useState(() => drafts.get(draft));
  const [title, setTitle] = useState(kept?.title ?? initialTitle);
  const [body, setBody] = useState(kept?.body ?? initialBody);
  // Kept across a run of new cards, like the column: several written in a row
  // are usually several of a kind.
  const [isolate, setIsolate] = useState(kept?.isolate ?? initialIsolate);
  const [start, setStart] = useState(kept?.start ?? initialDates?.start ?? "");
  const [end, setEnd] = useState(kept?.end ?? (initialDates && initialDates.end !== initialDates.start ? initialDates.end : ""));
  useEffect(() => {
    drafts.set(draft, { title, body, isolate, start, end });
  }, [draft, title, body, isolate, start, end]);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);

  /**
   * The two fields as a range. Either alone is one day, and the two the wrong
   * way round are put right rather than refused: the server refuses a range
   * that runs backwards because it cannot know which end was meant, and here
   * both ends are on screen and the person can see what they came to.
   */
  const dates = (): CardDates | null => {
    if (!offerDates) return initialDates;
    const a = start || end;
    const b = end || start;
    if (!a || !b) return null;
    return a <= b ? { start: a, end: b } : { start: b, end: a };
  };

  const save = () => {
    if (!title.trim()) return;
    onSubmit(title, body, isolate, dates());
    if (keepOpen) {
      // The dates go with the text, unlike the worktree box: several cards in
      // a row are often several of a kind, and seldom several for one day.
      setTitle("");
      setBody("");
      setStart("");
      setEnd("");
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
    node.style.height = `${node.scrollHeight + node.offsetHeight - node.clientHeight}px`;
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
      {/* The way out is an X at the corner, where a panel's close is looked
          for, rather than a word in the foot competing with the one that adds. */}
      <div className="board-composer-head">
        <input
          ref={field}
          className="dialog-input"
          placeholder="What needs doing"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => keys(event, true)}
        />
        <button
          type="button"
          className="board-icon-btn"
          title={keepOpen ? "Close" : "Cancel"}
          aria-label={keepOpen ? "Close" : "Cancel"}
          onClick={onCancel}
        >
          <Icon name="close" />
        </button>
      </div>
      <textarea
        ref={grow}
        className="dialog-input board-composer-body"
        placeholder={bodyHint}
        value={body}
        rows={4}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => keys(event, false)}
      />
      {offerDates && (
        <div className="board-composer-dates">
          {/* The browser's own date field, for `.studio-swatch`'s reason: a
              calendar is a control it draws better than this file could, and
              on a phone it is the wheel a thumb already knows. */}
          <input
            type="date"
            className="dialog-input board-date"
            aria-label="On, or from"
            title="The day this is for, or the first of them"
            value={start}
            max={end || undefined}
            onChange={(event) => setStart(event.target.value)}
            onKeyDown={(event) => keys(event, true)}
          />
          {/* The word travels with the field it introduces, so that where the
              two fields wrap it starts the second line and does not end the first. */}
          <span className="board-date-until">
            <span className="board-date-to">to</span>
            <input
              type="date"
              className="dialog-input board-date"
              aria-label="Until"
              title="The last day, for work that takes more than one"
              value={end}
              min={start || undefined}
              onChange={(event) => setEnd(event.target.value)}
              onKeyDown={(event) => keys(event, true)}
            />
          </span>
          {(start || end) && (
            <button
              type="button"
              className="board-icon-btn"
              title="Take the dates off"
              aria-label="Take the dates off"
              onClick={() => {
                setStart("");
                setEnd("");
              }}
            >
              <Icon name="close" />
            </button>
          )}
        </div>
      )}
      <div className="board-composer-foot">
        {offerIsolate && (
          <label
            className={`board-toggle ${isolate ? "board-toggle-on" : ""}`}
            title="Start this card's agent in a git worktree of its own, beside the repository"
          >
            <input type="checkbox" checked={isolate} onChange={(event) => setIsolate(event.target.checked)} />
            <Icon name="git" />
            Worktree
          </label>
        )}
        {/* Add, and add-and-run, as one split button: the robot is the same
            action with an agent on the end, not a third thing beside it. */}
        <span className="board-split board-composer-submit">
          <button type="submit" className="board-btn" disabled={!title.trim()}>
            {submit}
          </button>
          {onRun && (
            <button
              type="button"
              className="board-btn board-split-run"
              title="Add and run on an agent"
              aria-label="Add and run on an agent"
              aria-haspopup="menu"
              disabled={!title.trim()}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                onRun(title, body, isolate, { x: box.left, y: box.bottom + 4 });
              }}
            >
              <Icon name="bot" />
            </button>
          )}
        </span>
      </div>
    </form>
  );
}
