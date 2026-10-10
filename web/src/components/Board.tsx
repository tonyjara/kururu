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
 * It is drawn in two places: a workspace's own pane, and the profile's board,
 * which shows any workspace's board over the window without going there. The
 * second is the same component with one thing added, `onReveal`, because
 * everything a card does works on a workspace that is not on screen — only a
 * terminal it opens is somewhere the sheet is in front of.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import type { Launcher } from "../../../shared/launchers";
import type { AgentSnapshot, MascotConfig } from "../../../shared/model";
import type { MergeBlock, MergeResolution, WorktreeStatus } from "../../../shared/projects";
import type { DevServer } from "../../../shared/wire";
import { isLoopback, previewUrl, serverIn } from "../preview";
import * as api from "../session";
import { datesLabel, datesTense } from "../when";
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
  onReveal,
}: {
  workspaceId: string;
  workspaceName: string;
  board: Board;
  agents: AgentSnapshot[];
  mascot: MascotConfig;
  launchers: Launcher[];
  /**
   * Said after the board has taken somebody to a terminal, by a board drawn
   * over the window — the profile's — so that it can get out of the way of
   * what it just showed. A board in a pane has nothing in front of it.
   */
  onReveal?: () => void;
}) {
  /** The column a new card is being written in, or null. One composer at a time. */
  const [adding, setAddingState] = useState<BoardColumn | null>(() => openComposers.get(workspaceId)?.adding ?? null);
  const [editing, setEditingState] = useState<string | null>(() => openComposers.get(workspaceId)?.editing ?? null);
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
   * A merge waiting for its second click. On the card rather than in the menu,
   * because the menu closes on the click that asks, and because the card is
   * where the consequence — worktree gone, agent ended, column changed — is
   * going to show.
   */
  const [ask, setAsk] = useState<Ask | null>(null);
  /**
   * Cards with a slow git action in flight, and what it is doing. A merge is a
   * commit, a rebase, a worktree removal and an ended agent, and takes seconds
   * in which the card would otherwise sit there looking like nothing happened.
   */
  const [working, setWorking] = useState<Record<string, string>>({});
  const whileWorking = <T,>(cardId: string, text: string, job: Promise<T>) => {
    setWorking((all) => ({ ...all, [cardId]: text }));
    const done = () => setWorking(({ [cardId]: _, ...rest }) => rest);
    job.then(done, done);
    return job;
  };

  const said = (cardId: string, text: string) => {
    setErrors(({ [cardId]: _, ...rest }) => rest);
    setNotes((all) => ({ ...all, [cardId]: text }));
  };
  const failed = (cardId: string) => (err: unknown) => {
    setNotes(({ [cardId]: _, ...rest }) => rest);
    setErrors((all) => ({ ...all, [cardId]: err instanceof Error ? err.message : String(err) }));
  };
  const { devServers } = api.useKururu();
  const reveal = (agentId: string) => {
    api.revealAgent(agentId);
    onReveal?.();
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

  /** Whether the card's dev server still has a tab, whether or not its process is still up. */
  const devOpen = (card: Card) => {
    const agentId = card.dev?.agentId;
    return agentId != null && agents.some((a) => a.id === agentId);
  };
  const restartDev = (card: Card) => {
    setErrors(({ [card.id]: _, ...rest }) => rest);
    api.restartCardDev(workspaceId, card.id).catch(failed(card.id));
  };
  const stopDev = (card: Card) => {
    setErrors(({ [card.id]: _, ...rest }) => rest);
    api.stopCardDev(workspaceId, card.id).catch(failed(card.id));
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
  const merge = (card: Card, tree: CardWorktree, commitFirst: boolean, resolve?: MergeResolution) =>
    whileWorking(
      card.id,
      commitFirst ? "Committing and merging…" : "Merging…",
      (commitFirst ? api.commitCard(workspaceId, card.id) : Promise.resolve(null)).then(() =>
        api.mergeCard(workspaceId, card.id, resolve),
      ),
    )
      .then((reply) => {
        if ("blocked" in reply) {
          askAboutBlock(card, tree, reply.blocked);
          return;
        }
        const merged = `Merged ${reply.commits} ${reply.commits === 1 ? "commit" : "commits"} into ${tree.base}; worktree removed`;
        if (reply.note) failed(card.id)(new Error(`${merged} — but ${reply.note}`));
        else said(card.id, merged);
      })
      .catch(failed(card.id));

  /**
   * The merge that stopped before it started, because the checkout `base` is
   * on has uncommitted work in the files this branch changes. Git would have
   * refused the fast-forward over it; the server saw that coming and ended
   * nothing. The card says what is in the way and, when a dry run says the
   * two sets of changes fit, offers the two ways through with what each one
   * does — commit the work on the base first and rebase the card over it, or
   * git's own autostash around the fast-forward. A dry run that conflicted
   * gets neither, because both would land in the same conflict, one of them
   * in a worse place: that one is the person's to resolve by hand. An
   * untracked file the branch would create is the same kind of stop, since
   * autostash leaves untracked files where they are and a commit would only
   * turn the collision into an add/add conflict.
   */
  const askAboutBlock = (card: Card, tree: CardWorktree, block: MergeBlock) => {
    const list = (paths: string[]) => paths.slice(0, 4).join(", ") + (paths.length > 4 ? ` and ${paths.length - 4} more` : "");
    const parts: string[] = [];
    if (block.files.length) {
      parts.push(
        `${block.base} has uncommitted changes in ${list(block.files)}, which this branch also changes, and git will not fast-forward over them.`,
      );
    }
    if (block.untracked.length) {
      parts.push(
        `${block.base} has untracked ${list(block.untracked)}, which this branch creates. Move or remove ${
          block.untracked.length === 1 ? "it" : "them"
        } and merge again.`,
      );
    }
    const offer = !block.untracked.length && block.clean !== false;
    if (!block.untracked.length) {
      parts.push(
        block.clean === true
          ? "In a dry run the two fit together, so either of these gets through:"
          : block.clean === false
            ? `In a dry run they conflict, so neither committing nor stashing them would get past this. Resolve it on ${block.base} by hand, then merge again.`
            : "Whether the two fit together could not be checked; if they do not, the step that finds out stops and says so.",
      );
    }
    setAsk({
      cardId: card.id,
      text: parts.join(" "),
      choices: offer
        ? [
            {
              label: `Commit ${block.base}, then merge`,
              outcome:
                `Everything uncommitted on ${block.base} is committed as “wip: before merging ${card.title}”, the card is rebased onto ` +
                `that, and ${block.base} fast-forwards. A rebase that conflicts is aborted and the worktree stays.`,
              run: () => merge(card, tree, false, "commit"),
            },
            {
              label: "Stash, merge, restore",
              outcome:
                `git merge --autostash: the changes are set aside, ${block.base} fast-forwards, and they are put back uncommitted. ` +
                "If they do not apply, they stay in git stash and the card says so.",
              run: () => merge(card, tree, false, "stash"),
            },
          ]
        : [],
    });
  };

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
          `The worktree is removed${running ? ", its agent is ended" : ""}${devOpen(card) ? ", its dev server stopped" : ""} and branch ${tree.branch} deleted.`,
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
        // In a pane the server focuses the new terminal itself. Over the
        // window it may be in a workspace that is not on screen, and a
        // terminal asked for and not shown is one that seems not to have come.
        run: () =>
          api
            .openWorktree(workspaceId, card.id)
            .then((agentId) => onReveal && reveal(agentId))
            .catch(failed(card.id)),
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
                    onRestartDev={() => restartDev(card)}
                    onStopDev={() => stopDev(card)}
                    onReveal={reveal}
                    mascot={mascot}
                    error={errors[card.id]}
                    working={working[card.id]}
                    note={notes[card.id]}
                    onNoteClick={() => setNotes(({ [card.id]: _, ...rest }) => rest)}
                    ask={ask?.cardId === card.id ? ask : null}
                    onAsk={(run) => {
                      setAsk(null);
                      run?.();
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
          </section>
        );
      })}

      {menu && <Menu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/**
 * A question a card is asking in place: what it says, and what yes and the
 * other way out do. A question with `choices` instead of a `yes` is one
 * whose answers each need a sentence — they are drawn as rows, each with
 * what it does under its button, and Cancel is the only plain button left.
 */
interface Ask {
  cardId: string;
  text: string;
  yes?: string;
  run?: () => void;
  alt?: { label: string; run: () => void };
  choices?: { label: string; outcome: string; run: () => void }[];
}

function CardView({
  card,
  code,
  agent,
  server,
  devServers,
  onRestartDev,
  onStopDev,
  onReveal,
  mascot,
  error,
  working,
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
  code: string;
  agent: AgentSnapshot | undefined;
  /** The terminal the card's dev server runs in, while it has one. */
  server: AgentSnapshot | undefined;
  devServers: DevServer[];
  onRestartDev: () => void;
  onStopDev: () => void;
  /** Take the person to a terminal: the run's agent, or the dev server's log. */
  onReveal: (agentId: string) => void;
  mascot: MascotConfig;
  error: string | undefined;
  /** What a slow git action on this card is doing right now, if one is. */
  working: string | undefined;
  /** What the last git action came to, until clicked away. */
  note: string | undefined;
  onNoteClick: () => void;
  /** A merge waiting for its second click, or null. */
  ask: Ask | null;
  /** The answer's action, or null for the way out. */
  onAsk: (run: (() => void) | null) => void;
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
              onClick={(event) => onRobot(below(event))}
            >
              <Icon name="bot" />
            </button>
            <button
              className="board-icon-btn"
              title="Move, edit or delete"
              aria-label="Card menu"
              aria-haspopup="menu"
              onClick={(event) => onMenu(below(event))}
            >
              <Icon name="caret" />
            </button>
          </span>
        </div>
        {card.body && <p className="board-card-body">{card.body}</p>}
        {card.dates && <CardWhen dates={card.dates} />}
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
            onRestart={onRestartDev}
            onStop={onStopDev}
            onReveal={onReveal}
          />
        )}
        {card.run && <RunLine run={card.run} agent={agent} mascot={mascot} onReveal={onReveal} />}
        {error && <p className="board-card-error">{error}</p>}
        {working && (
          <p className="board-card-busy" role="status">
            <span className="spinner" aria-hidden="true" />
            {working}
          </p>
        )}
        {note && (
          <p className="board-card-note" onClick={onNoteClick} title="Click to dismiss">
            {note}
          </p>
        )}
        {ask && (
          <div className="board-card-ask" role="alertdialog" aria-label="Confirm">
            <p className="board-card-ask-text">{ask.text}</p>
            {ask.choices?.map((choice) => (
              <div key={choice.label} className="board-card-ask-choice">
                <button className="board-btn" onClick={() => onAsk(choice.run)}>
                  {choice.label}
                </button>
                <p className="board-card-ask-outcome">{choice.outcome}</p>
              </div>
            ))}
            <div className="board-card-ask-actions">
              <button className="board-btn board-btn-quiet" onClick={() => onAsk(null)}>
                Cancel
              </button>
              {ask.alt && (
                <button className="board-btn board-btn-quiet" onClick={() => onAsk(ask.alt?.run ?? null)}>
                  {ask.alt.label}
                </button>
              )}
              {ask.yes && (
                <button className="board-btn" onClick={() => onAsk(ask.run ?? null)}>
                  {ask.yes}
                </button>
              )}
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
function RunLine({
  run,
  agent,
  mascot,
  onReveal,
}: {
  run: CardRun;
  agent: AgentSnapshot | undefined;
  mascot: MascotConfig;
  onReveal: (agentId: string) => void;
}) {
  return (
    <div className={`board-run board-run-${run.state}`}>
      {agent ? <Status agent={agent} mascot={mascot} /> : <span className="board-run-mark" aria-hidden="true" />}
      <span className="board-run-words">
        {run.label} · {RUN_WORDS[run.state]}
        {run.endedAt && (run.state === "finished" || run.state === "ended") ? ` ${ago(run.endedAt)}` : ""}
      </span>
      {agent && (
        <span className="board-seg">
          <button className="board-seg-btn" onClick={() => onReveal(agent.id)} title="Go to this agent's terminal">
            open
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
/**
 * When a card is for, as a line on the card. It says which side of today the
 * dates fall on by its ink alone, so that a column can be scanned for what is
 * happening now without reading a date on it.
 */
export function CardWhen({ dates }: { dates: CardDates }) {
  return <span className={`board-card-when board-card-when-${datesTense(dates)}`}>{datesLabel(dates)}</span>;
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
