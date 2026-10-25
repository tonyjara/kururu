/**
 * The things that need you, across every workspace, in one list.
 *
 * It exists because going round the workspaces to see which of them were
 * waiting meant going round the workspaces. The profile board tried to be
 * the overview for a version — a bar of every board in the profile, each
 * drawn in the sheet on a click — and what that listed was boards, which
 * is the wrong noun: a workspace with a blocked agent and no board was not
 * in it, one mid-work looked like one waiting, and the sheet is modal, so
 * every step was open, pick, close, deal, reopen. What is wanted is a
 * queue: open one, deal with it, the next. `shared/needs.ts` is the rule
 * for what is in the queue; this is the drawing, and it decides nothing.
 *
 * **A column beside the panes, on Kuru's terms exactly.** You deal with a
 * thing in its terminal while the list of what is left stays beside it, so
 * it is a flex sibling of `.stage`, narrowing it the way the sidebar does,
 * rather than a sheet floated over it — and the terminals are not dimmed for
 * the same reason Kuru's aren't, nor does a click into them close the
 * drawer: it narrows `.stage`, it does not cover it, so a click there is
 * just a click into the layout. Escape and the ✕ close it, as does the tray
 * that opened it, and nothing in it takes the keyboard — a row is pressed
 * without taking focus, so the terminal it reveals is the one the next
 * keystroke goes to. On a narrow window it is a full-screen sheet instead,
 * and there a click outside does close it, as does a pick, since the thing
 * picked is then under it.
 *
 * Three bands. **Needs you** is the queue, one block per workspace with its
 * tag down the side, as the sidebar draws it, and a row per thing; a row
 * goes to the terminal, or to the board for a card with none. After the
 * workspaces comes **Your board**: the cards in the profile board's Needs
 * you column, the to-dos you or Kuru wrote down for you, each wearing which
 * of you it was. Below the workspaces rather than above them, because an
 * agent asking holds a turn up and a to-do waits as long as you let it.
 * **Working**
 * is what is on its way to you, so a busy workspace is never mistaken for
 * a quiet one. **Quiet** is the rest, folded to a line of names — out of
 * the way, and still each a door. Nothing here is dismissed by hand: a
 * row leaves when its state does, which is the only way a list of needs
 * stays honest.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { boardLanes, cardCode, type Card } from "../../../shared/board";
import { cardPlace } from "../../../shared/kuru";
import { allNeeds, type Need, type NeedKind, type ProfileNeeds, type WorkspaceNeeds } from "../../../shared/needs";
import type { NodeStatus, SummaryAgent, SummaryNeed } from "../../../shared/nodes";
import { mascotFor, type AgentSnapshot, type MascotSet, type Profile } from "../../../shared/model";
import { useCardDone } from "../cardDone";
import { referItem } from "../kuru";
import { agentLabel, agentSummary } from "../labels";
import { asAgent } from "../nodes";
import { nodeNeeds, type NodeNeed } from "../../../shared/remote";
import { hueStyle } from "./NodeChip";
import * as api from "../session";
import { ago } from "./Board";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
import { MadeLinks } from "./MadeLinks";
import { Menu, type MenuAt, type MenuItem } from "./Menu";
import { NeedsByMark, profileCardMoves } from "./ProfileBoard";
import { Status } from "./Status";
import { datesLabel } from "../when";

/**
 * Whether the quiet band is open, per device, on the sidebar disclosures'
 * argument: a fold is a thing you do with your eyes, and a phone opening one
 * must not unfold the desktop's.
 */
const QUIET_KEY = "kururu.needs.quiet";

function readQuiet(): boolean {
  try {
    return localStorage.getItem(QUIET_KEY) === "open";
  } catch {
    return false;
  }
}

export function NeedsDrawer({
  needs,
  profile,
  nodes,
  mascots,
  agents,
  sheet,
  onClose,
  onResize,
  onResetWidth,
  onGo,
  onGoNode,
  onNext,
  onWorkspace,
  onBoard,
  onProfileCard,
  chips,
}: {
  needs: ProfileNeeds;
  /** The profile whose board `needs.cards` are on: its name for their codes, its columns and workspaces for their menu. */
  profile: Profile;
  /**
   * The other nodes, each with the summary it last pushed. A linked one with
   * something waiting gets a band of its own under this node's queue, each
   * row a door to the thing in this window — see `NodeBand`.
   */
  nodes: NodeStatus[];
  mascots: MascotSet;
  /** Every agent in the profile — the same check the board makes before Done asks its question, for the row's own menu. */
  agents: AgentSnapshot[];
  /** A full-screen sheet on a narrow window, rather than a panel beside the panes. */
  sheet: boolean;
  onClose: () => void;
  /** A width proposed by the drawer's own grip — desktop only, see `Grip` below. */
  onResize: (px: number) => void;
  onResetWidth: () => void;
  /** Take me to this need: its terminal, or its board. */
  onGo: (need: Need) => void;
  /** The same for another node's need, in this window. */
  onGoNode: (need: NodeNeed) => void;
  /** The next thing that needs you, from wherever the keyboard is. */
  onNext: () => void;
  /** Go to a workspace, from its name. */
  onWorkspace: (workspaceId: string) => void;
  /** This card, on its board, in its workspace. */
  onBoard: (workspaceId: string, cardId: string) => void;
  /** The profile's own board — the sheet, opened over everything — with this card lit on it, or none. */
  onProfileCard: (cardId: string | null) => void;
  /**
   * The two drawers' chips, which lead this header while the drawer is open —
   * this one's lit, and Kuru's the way across. See `DrawerChips.tsx`.
   */
  chips: ReactNode;
}) {
  /**
   * On a phone the drawer is a sheet over the whole screen, so a click
   * outside only reaches something drawn above it — the tray, a menu, a
   * dialog — and still means "go there instead". On a desktop it narrows
   * `.stage` rather than covering it, so a click outside is just a click
   * into the layout (a terminal, a card) and must not close the drawer; only
   * its own close button, the tray, or the keyboard does. Capture phase, so
   * a terminal's own handler taking the press cannot keep the drawer up.
   * `KuruDrawer.tsx`'s, to the line, so the two behave alike.
   */
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!sheet) return;
    const away = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (root.current?.contains(target) || target.closest(".sb-needs, .scrim, .menu-backdrop, .menu")) return;
      onClose();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [sheet, onClose]);
  const [quietOpen, setQuietOpen] = useState(readQuiet);
  const toggleQuiet = () => {
    const next = !quietOpen;
    setQuietOpen(next);
    try {
      localStorage.setItem(QUIET_KEY, next ? "open" : "shut");
    } catch {
      // Not remembered; still opened.
    }
  };
  /**
   * A card's row menu — right-click, or a touch held still — see `NeedRow`.
   * Separate from the inline "Done" button beside it, which only ever shows
   * for a `Need.plainDone` row and skips the question because there is none.
   */
  const [cardMenu, setCardMenu] = useState<{ at: MenuAt; workspaceId: string; workspaceName: string; card: Card } | null>(null);
  /** A Needs you card's row menu: its own card menu's moves, and the door to it. */
  const [boardMenu, setBoardMenu] = useState<{ at: MenuAt; card: Card } | null>(null);
  const boardMenuItems = (card: Card): MenuItem[] => [
    { label: "Open on the board", run: () => onProfileCard(card.id) },
    ...profileCardMoves(profile, card),
    referItem({ code: cardCode(profile.name, card.number), title: card.title, place: cardPlace(null, api.nodeNameOf), cardId: card.id }),
  ];
  /* Done is a plain move on the profile's board, which runs nothing — so the
     row may offer it outright, on a board whose Done is still there. */
  const hasDone = boardLanes(profile.board).some((lane) => lane.id === "done");
  const agentOpen = (card: Card) => {
    const agentId = card.run?.agentId;
    return agentId != null && agents.some((a) => a.id === agentId && !a.exited);
  };
  const devOpen = (card: Card) => {
    const agentId = card.dev?.agentId;
    return agentId != null && agents.some((a) => a.id === agentId);
  };
  const { ask, setAsk, moveToDone } = useCardDone(agentOpen, devOpen, {
    error: (_cardId, err) => window.alert(err instanceof Error ? err.message : String(err)),
  });
  const cardMenuItems = (workspaceId: string, workspaceName: string, card: Card): MenuItem[] => [
    { label: "Move to Done", run: () => moveToDone(workspaceId, card) },
    // Opening Kuru's drawer closes this one: the two share the slot.
    referItem({ code: cardCode(workspaceName, card.number), title: card.title, place: cardPlace(workspaceId, api.nodeNameOf), cardId: card.id }),
  ];

  const waiting = needs.workspaces.filter((w) => w.band === "needs");
  const working = needs.workspaces.filter((w) => w.band === "working");
  const quiet = needs.workspaces.filter((w) => w.band === "quiet");
  /* A node that is away is left out, not drawn stale: its last summary may
     list a question already answered, and this is a queue to act on. */
  const elsewhere = nodes.filter((node) => node.state === "up" && (node.summary?.needs.count ?? 0) > 0);
  const mascot = (w: WorkspaceNeeds) => mascotFor(mascots, w.workspace.mascotId);

  return (
    <aside className={`kuru-drawer needs-drawer ${sheet ? "kuru-sheet" : ""}`} ref={root} role="dialog" aria-label="Needs you">
      {/* The chips where the tray and the title were — the lit tray is this
          drawer's name, as Kuru's chip is Kuru's. The count in words after
          them went on 2026-10-18: the chip already counts, and the list under
          it says the rest. */}
      <header className="kuru-head">
        {chips}
        <span className="kuru-head-spacer" />
        <button
          className="kuru-head-btn"
          onClick={onNext}
          onMouseDown={(event) => event.preventDefault()}
          disabled={allNeeds(needs).length === 0 && nodeNeeds(nodes).length === 0}
          title="Go to the next thing that needs you (C-a o)"
        >
          Next
          <Icon name="caret" className="needs-next-caret" />
        </button>
        <button className="sidebar-close kuru-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="close" />
        </button>
      </header>

      <ol className="kuru-list needs-list">
        {waiting.length === 0 && needs.cards.length === 0 && elsewhere.length === 0 && (
          <li className="needs-none" role="status">
            Nothing is waiting on you.
          </li>
        )}
        {waiting.map((w) => (
          <li key={w.workspace.id} className="needs-ws">
            <button
              className="needs-ws-head"
              onClick={() => onWorkspace(w.workspace.id)}
              onMouseDown={(event) => event.preventDefault()}
              title={`Go to ${w.workspace.name}`}
            >
              <span className="needs-ws-name">{w.workspace.name}</span>
              <span className="needs-ws-n">{w.needs.length}</span>
              {w.working.length > 0 && (
                <span className="needs-ws-also">
                  · {w.working.length} working
                </span>
              )}
            </button>
            <ul className="needs-rows">
              {w.needs.map((need) => (
                <NeedRow
                  key={need.card ? `c${need.card.id}` : `a${need.agent!.id}`}
                  need={need}
                  workspaceName={w.workspace.name}
                  mascot={mascot(w)}
                  onGo={onGo}
                  onBoard={onBoard}
                  onOpened={sheet ? onClose : undefined}
                  onMenu={
                    need.card
                      ? (x, y) => setCardMenu({ at: { x, y }, workspaceId: need.workspaceId, workspaceName: w.workspace.name, card: need.card! })
                      : undefined
                  }
                />
              ))}
            </ul>
          </li>
        ))}

        {needs.cards.length > 0 && (
          <li className="needs-ws needs-ws-board">
            <button
              className="needs-ws-head"
              onClick={() => onProfileCard(null)}
              onMouseDown={(event) => event.preventDefault()}
              title="Open the profile's board"
            >
              <span className="needs-ws-name">Your board</span>
              <span className="needs-ws-n">{needs.cards.length}</span>
            </button>
            <ul className="needs-rows">
              {needs.cards.map((card) => (
                <BoardRow
                  key={card.id}
                  card={card}
                  code={cardCode(profile.name, card.number)}
                  onOpen={() => onProfileCard(card.id)}
                  onDone={hasDone ? () => api.moveProfileCard(profile.id, card.id, "done") : undefined}
                  onMenu={(x, y) => setBoardMenu({ at: { x, y }, card })}
                />
              ))}
            </ul>
          </li>
        )}

        {elsewhere.map((node) => (
          <NodeBand
            key={node.id}
            node={node}
            mascot={mascotFor(mascots, null)}
            onGo={onGoNode}
            onWorkspace={(nodeId, workspaceKey) => {
              api.showNodeWorkspace(nodeId, workspaceKey);
              if (sheet) onClose();
            }}
          />
        ))}

        {working.length > 0 && (
          <>
            <li className="needs-band">Working</li>
            {working.map((w) => (
              <li key={w.workspace.id} className="needs-ws needs-ws-working">
                <button
                  className="needs-ws-head"
                  onClick={() => onWorkspace(w.workspace.id)}
                  onMouseDown={(event) => event.preventDefault()}
                  title={`Go to ${w.workspace.name}`}
                >
                  <span className="needs-ws-name">{w.workspace.name}</span>
                </button>
                <ul className="needs-rows">
                  {w.working.map((agent) => (
                    <WorkingRow key={agent.id} agent={agent} mascot={mascot(w)} />
                  ))}
                </ul>
              </li>
            ))}
          </>
        )}

        {quiet.length > 0 && (
          <li className="needs-quiet">
            <button
              className="needs-band needs-quiet-head"
              onClick={toggleQuiet}
              onMouseDown={(event) => event.preventDefault()}
              aria-expanded={quietOpen}
              title={quietOpen ? "Fold the quiet workspaces away" : "Show the quiet workspaces"}
            >
              <Icon name="caret" className={quietOpen ? "" : "drawer-caret-shut"} />
              <span>Quiet</span>
              <span className="needs-ws-n">{quiet.length}</span>
            </button>
            {quietOpen && (
              <ul className="needs-chips">
                {quiet.map((w) => (
                  <li key={w.workspace.id}>
                    <button
                      className="needs-chip"
                      onClick={() => onWorkspace(w.workspace.id)}
                      onMouseDown={(event) => event.preventDefault()}
                      title={`Go to ${w.workspace.name}`}
                    >
                      {w.workspace.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        )}
      </ol>

      {/* The edge you drag, `KuruDrawer.tsx`'s to the line, so the two behave
          alike — see its `Grip` for the argument. */}
      {!sheet && <Grip onResize={onResize} onReset={onResetWidth} />}
      {cardMenu && (
        <Menu at={cardMenu.at} items={cardMenuItems(cardMenu.workspaceId, cardMenu.workspaceName, cardMenu.card)} onClose={() => setCardMenu(null)} />
      )}
      {boardMenu && <Menu at={boardMenu.at} items={boardMenuItems(boardMenu.card)} onClose={() => setBoardMenu(null)} />}
      {ask && (
        <Dialog
          state={{ kind: "ask", title: ask.title, hint: ask.hint, yes: ask.yes, run: ask.run, alt: ask.alt, choices: ask.choices }}
          onClose={() => setAsk(null)}
        />
      )}
    </aside>
  );
}

/** `KuruDrawer.tsx`'s `Grip`, copied rather than imported: the two drawers are
 * siblings, not a shared chrome component, and a one-line gesture is cheaper
 * duplicated than it is factored out from under a component that does not
 * otherwise know the other exists. */
function Grip({ onResize, onReset }: { onResize: (px: number) => void; onReset: () => void }) {
  const onPointerDown = (event: React.PointerEvent) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const box = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!box) return;
    onResize(box.right - event.clientX);
  };
  const release = (event: React.PointerEvent) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  return (
    <div
      className="kuru-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the drawer"
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={release}
      onDoubleClick={onReset}
    />
  );
}

/** How long a touch must hold still to open a row's menu — `Sidebar.tsx`'s own agent row, to the number. */
const LONG_PRESS_MS = 500;

/*
 * A row's own menu, open on a right-click or a touch held still —
 * `Sidebar.tsx`'s agent row trick, copied rather than imported: a dozen
 * lines of gesture code are cheaper duplicated here than factored out from
 * under a row with no other reason to know the sidebar exists. Shared by
 * the two kinds of row here that have a menu. `swallow` is asked by the
 * row's button first: a long press opened the menu, and the click its lift
 * delivers must not also go to the thing.
 */
function useRowMenu(onMenu: ((x: number, y: number) => void) | undefined) {
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const pressed = useRef(false);
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  const handlers = onMenu
    ? {
        onContextMenu: (event: React.MouseEvent) => {
          event.preventDefault();
          onMenu(event.clientX, event.clientY);
        },
        onPointerDown: (event: React.PointerEvent) => {
          if (event.pointerType !== "touch") return;
          cancelPress();
          const { clientX: x, clientY: y } = event;
          press.current = {
            x,
            y,
            timer: window.setTimeout(() => {
              press.current = null;
              pressed.current = true;
              onMenu(x, y);
            }, LONG_PRESS_MS),
          };
        },
        onPointerMove: (event: React.PointerEvent) => {
          const at = press.current;
          if (at && Math.hypot(event.clientX - at.x, event.clientY - at.y) > 10) cancelPress();
        },
        onPointerUp: cancelPress,
        onPointerCancel: cancelPress,
      }
    : {};
  const swallow = () => {
    if (!pressed.current) return false;
    pressed.current = false;
    return true;
  };
  return { handlers, swallow };
}

/**
 * One thing that needs you: the agent's own mark when it has a terminal,
 * what it is, and one line of why. The row goes to the terminal, or for a
 * card with none to its board; a card's row also carries the board as a
 * button, so the card is one press from here even when the row's press is
 * the terminal. **Done** is drawn only where the move is nothing but a move
 * — see `Need.plainDone` — because every other move to Done is a question
 * asked in a dialog of its own, about a merge or an agent. That question is
 * not the board's alone: a card's row carries the same right-click/long-press
 * menu the sidebar's agent rows do (`Sidebar.tsx`, KUR-99), and its one row
 * so far, "Move to Done", asks it here too, through `useCardDone`.
 */
function NeedRow({
  need,
  workspaceName,
  mascot,
  onGo,
  onBoard,
  onOpened,
  onMenu,
}: {
  need: Need;
  workspaceName: string;
  mascot: ReturnType<typeof mascotFor>;
  onGo: (need: Need) => void;
  onBoard: (workspaceId: string, cardId: string) => void;
  /** A link was opened: on a phone the sheet is over the file, so it goes. */
  onOpened: (() => void) | undefined;
  /** Open the row's menu at this point; undefined for a need with no card — see `Need.card`. */
  onMenu: ((x: number, y: number) => void) | undefined;
}) {
  const { agent, card } = need;
  const title = card ? `${cardCode(workspaceName, card.number)} ${card.title}` : agentLabel(agent!);
  /* What its turn ended in, which is usually the reason to come here at all: a card in
     Review is a document to read before it is a card to move. The agent's own list while
     it has a terminal, being the fresher of the two; the card's once it has gone. */
  const made = agent?.made?.length ? agent.made : (card?.made ?? []);
  const { handlers, swallow } = useRowMenu(onMenu);
  return (
    <li className={`needs-row needs-row-${need.kind} ${made.length ? "needs-row-made" : ""}`} {...handlers}>
      <button
        className="needs-go"
        onClick={() => {
          if (swallow()) return;
          onGo(need);
        }}
        onMouseDown={(event) => event.preventDefault()}
        title={agent ? "Go to its terminal" : "This card, on its board"}
      >
        {agent ? <Status agent={agent} mascot={mascot} /> : <span className="needs-mark" aria-hidden="true" />}
        <span className="needs-what">
          <span className="needs-title">{title}</span>
          <span className="needs-why">{why(need)}</span>
        </span>
      </button>
      {card && need.plainDone && (
        <button
          className="kuru-head-btn needs-done"
          onClick={() => api.moveCard(need.workspaceId, card.id, "done")}
          onMouseDown={(event) => event.preventDefault()}
          title="Move the card to Done"
        >
          Done
        </button>
      )}
      {card && agent && (
        <button
          className="kuru-head-btn"
          onClick={() => onBoard(need.workspaceId, card.id)}
          onMouseDown={(event) => event.preventDefault()}
          title="This card, on its board"
        >
          board
        </button>
      )}
      {made.length > 0 && <MadeLinks className="needs-made" files={made} workspaceId={need.workspaceId} onOpened={onOpened} />}
    </li>
  );
}

/**
 * One card of the profile board's Needs you: who put it there where an
 * agent's mark would be — the thing to tell these rows apart by — then its
 * code and title, and under them its dates and the first line of what it
 * says. The row opens the card on the board; **Done** is drawn whenever the
 * board has a Done, since nothing on this board runs and the move asks no
 * question; the rest of the card's menu is the row's own, on a right-click
 * or a held touch, as a workspace card's row has.
 */
function BoardRow({
  card,
  code,
  onOpen,
  onDone,
  onMenu,
}: {
  card: Card;
  code: string;
  onOpen: () => void;
  onDone: (() => void) | undefined;
  onMenu: (x: number, y: number) => void;
}) {
  const { handlers, swallow } = useRowMenu(onMenu);
  const first = card.body.split("\n").find((line) => line.trim())?.trim() ?? "";
  const why = [card.dates ? datesLabel(card.dates) : "", first].filter(Boolean).join(" · ") || "on your board";
  return (
    <li className={`needs-row needs-row-yours needs-row-by-${card.needsBy ?? "none"}`} {...handlers}>
      <button
        className="needs-go"
        onClick={() => {
          if (swallow()) return;
          onOpen();
        }}
        onMouseDown={(event) => event.preventDefault()}
        title="This card, on the profile's board"
      >
        {card.needsBy ? <NeedsByMark by={card.needsBy} /> : <span className="needs-mark" aria-hidden="true" />}
        <span className="needs-what">
          <span className="needs-title">{`${code} ${card.title}`}</span>
          <span className="needs-why">{why}</span>
        </span>
      </button>
      {onDone && (
        <button
          className="kuru-head-btn needs-done"
          onClick={onDone}
          onMouseDown={(event) => event.preventDefault()}
          title="Move the card to Done"
        >
          Done
        </button>
      )}
    </li>
  );
}

/** The one line under a row: why it is here, in the words the board and the sidebar use for the same facts. */
function why(need: Need): string {
  const { agent, card } = need;
  const summary = agent ? agentSummary(agent) : null;
  switch (need.kind) {
    case "asking":
      return summary ?? "asking something in its terminal";
    case "review": {
      const run = card?.run;
      const when = run?.endedAt ? ` · finished ${ago(run.endedAt)}` : "";
      return `in Review${run?.state === "asleep" ? " · asleep" : ""}${when}`;
    }
    case "unseen":
      return summary ? `finished while you were away · ${summary}` : "finished while you were away";
    case "stalled": {
      const at = card?.run?.endedAt;
      return `in progress, and its agent ended${at ? ` ${ago(at)}` : ""}`;
    }
  }
}

/** How long a node's "not Done, because…" stays on its row. */
const SAID_MS = 8000;

/**
 * Another node's queue, under its name in its hue: its workspaces that need
 * you, each a block like this node's own. For a node this window can open
 * (`NodeSummary.watchable`), every row is a door into *this* window, as a
 * local row is: an agent's goes to its terminal — `reveal-agent` with the
 * qualified id, which puts the node's workspace on screen and its pane in
 * front — a card with no terminal to the card on the node's board here, and
 * the workspace's head to the workspace. A node from before keeps rows that
 * link to its own page, saying what updating it would give. Either way the
 * row says why it is there in the words `why` uses for the same kinds.
 *
 * A card's row carries **Done** where the node said the move is a plain one
 * (`SummaryNeed.plainDone`), and only that: the press asks the node, which
 * asks its own rule again and moves the card or says why not — a worktree
 * grown or a terminal opened since its summary — and the sentence takes the
 * row's second line for a few seconds. Every other move to Done is a
 * question its board asks, there, and there is no row menu for it here.
 */
function NodeBand({
  node,
  mascot,
  onGo,
  onWorkspace,
}: {
  node: NodeStatus;
  mascot: ReturnType<typeof mascotFor>;
  onGo: (need: NodeNeed) => void;
  onWorkspace: (nodeId: string, workspaceKey: string) => void;
}) {
  const summary = node.summary!;
  const here = !!summary.watchable;
  const old = node.parent ? `Open ${node.name}'s kururu` : `Open ${node.name}'s kururu. Update it (kururu child update) to open its workspaces in this window.`;
  /** The node's answer to a Done, by card, while it is the latest word on that row. */
  const [said, setSaid] = useState<{ cardId: string; text: string } | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  useEffect(() => {
    if (!said) return;
    const timer = setTimeout(() => setSaid(null), SAID_MS);
    return () => clearTimeout(timer);
  }, [said]);
  const done = (workspaceKey: string, cardId: string) => {
    setAsking(cardId);
    setSaid(null);
    api.nodeCardDone(node.id, workspaceKey, cardId).then(
      () => setAsking(null),
      (err: unknown) => {
        setAsking(null);
        setSaid({ cardId, text: err instanceof Error ? err.message : String(err) });
      },
    );
  };
  return (
    <>
      <li className="needs-band" style={hueStyle(node.id)}>
        <span className="node-chip-dot" aria-hidden="true" />
        {node.name}
      </li>
      {summary.workspaces
        .filter((w) => w.band === "needs")
        .map((w) => {
          const agents = new Map<string, SummaryAgent>(w.agents.map((agent) => [agent.id, agent]));
          const head = (
            <>
              <span className="needs-ws-name">{w.name}</span>
              <span className="needs-ws-n">{w.needs.length}</span>
            </>
          );
          return (
            <li key={w.key} className="needs-ws">
              {here ? (
                <button
                  className="needs-ws-head"
                  onClick={() => onWorkspace(node.id, w.key)}
                  onMouseDown={(event) => event.preventDefault()}
                  title={`Go to ${w.name}, on ${node.name}`}
                >
                  {head}
                </button>
              ) : (
                <a className="needs-ws-head" href={node.url} target="_blank" rel="noreferrer noopener" title={old}>
                  {head}
                </a>
              )}
              <ul className="needs-rows">
                {w.needs.map((need) => {
                  const agent = need.agentId ? agents.get(need.agentId) : undefined;
                  const what = (
                    <>
                      {agent ? <Status agent={asAgent(agent)} mascot={mascot} /> : <span className="needs-mark" aria-hidden="true" />}
                      <span className="needs-what">
                        <span className="needs-title">{need.title}</span>
                        <span className="needs-why">{said && said.cardId === need.cardId ? said.text : nodeWhy(need, agent)}</span>
                      </span>
                    </>
                  );
                  return (
                    <li key={need.cardId ? `c${need.cardId}` : `a${need.agentId ?? need.title}`} className={`needs-row needs-row-${need.kind}`}>
                      {here ? (
                        <button
                          className="needs-go"
                          onClick={() => onGo({ node: node.id, workspaceKey: w.key, need })}
                          onMouseDown={(event) => event.preventDefault()}
                          title={need.agentId ? `Go to its terminal, on ${node.name}` : `This card, on its board on ${node.name}`}
                        >
                          {what}
                        </button>
                      ) : (
                        <a className="needs-go" href={node.url} target="_blank" rel="noreferrer noopener" title={old}>
                          {what}
                        </a>
                      )}
                      {need.cardId && need.plainDone && node.state === "up" && (
                        <button
                          className="kuru-head-btn needs-done"
                          disabled={asking === need.cardId}
                          onClick={() => done(w.key, need.cardId!)}
                          onMouseDown={(event) => event.preventDefault()}
                          title={`Move the card to Done on ${node.name}`}
                        >
                          Done
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
    </>
  );
}

/** `why`, for a need another node summarised: the kind, and the agent's own words when it has said any. */
function nodeWhy(need: SummaryNeed, agent: SummaryAgent | undefined): string {
  const summary = agent ? agentSummary(asAgent(agent)) : null;
  const words: Record<NeedKind, string> = {
    asking: summary ?? "asking something in its terminal",
    review: "in Review",
    unseen: summary ? `finished while you were away · ${summary}` : "finished while you were away",
    stalled: "in progress, and its agent ended",
  };
  return words[need.kind];
}

/** An agent mid-turn, under its workspace in the Working band: its mark, its name, what it says it is doing. */
function WorkingRow({ agent, mascot }: { agent: AgentSnapshot; mascot: ReturnType<typeof mascotFor> }) {
  return (
    <li className="needs-row needs-row-working">
      <button
        className="needs-go"
        onClick={() => api.revealAgent(agent.id)}
        onMouseDown={(event) => event.preventDefault()}
        title="Go to its terminal"
      >
        <Status agent={agent} mascot={mascot} />
        <span className="needs-what">
          <span className="needs-title">{agentLabel(agent)}</span>
          {agentSummary(agent) && <span className="needs-why">{agentSummary(agent)}</span>}
        </span>
      </button>
    </li>
  );
}

/**
 * An inbox tray, drawn here rather than taken from the skin's icon set on
 * the status bar's `SidebarIcon` reasoning: a fourth entry in that set is a
 * cell every future skin has to ship, and a tray means the same thing in
 * any chrome. Exported for the chip, so the two are one drawing.
 */
export function InboxIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}
