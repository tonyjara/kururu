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
 * goes to the terminal, or to the board for a card with none. **Working**
 * is what is on its way to you, so a busy workspace is never mistaken for
 * a quiet one. **Quiet** is the rest, folded to a line of names — out of
 * the way, and still each a door. Nothing here is dismissed by hand: a
 * row leaves when its state does, which is the only way a list of needs
 * stays honest.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cardCode, type Card } from "../../../shared/board";
import type { Need, ProfileNeeds, WorkspaceNeeds } from "../../../shared/needs";
import { mascotFor, type AgentSnapshot, type MascotSet } from "../../../shared/model";
import { useCardDone } from "../cardDone";
import { agentLabel, agentSummary } from "../labels";
import * as api from "../session";
import { ago } from "./Board";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
import { MadeLinks } from "./MadeLinks";
import { Menu, type MenuAt, type MenuItem } from "./Menu";
import { Status } from "./Status";

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
  mascots,
  agents,
  sheet,
  onClose,
  onResize,
  onResetWidth,
  onGo,
  onNext,
  onWorkspace,
  onBoard,
  chips,
}: {
  needs: ProfileNeeds;
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
  /** The next thing that needs you, from wherever the keyboard is. */
  onNext: () => void;
  /** Go to a workspace, from its name. */
  onWorkspace: (workspaceId: string) => void;
  /** This card, on its board, in its workspace. */
  onBoard: (workspaceId: string, cardId: string) => void;
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
  const [cardMenu, setCardMenu] = useState<{ at: MenuAt; workspaceId: string; card: Card } | null>(null);
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
  const cardMenuItems = (workspaceId: string, card: Card): MenuItem[] => [
    { label: "Move to Done", run: () => moveToDone(workspaceId, card) },
  ];

  const waiting = needs.workspaces.filter((w) => w.band === "needs");
  const working = needs.workspaces.filter((w) => w.band === "working");
  const quiet = needs.workspaces.filter((w) => w.band === "quiet");
  const state =
    needs.count === 0
      ? "nothing needs you"
      : `${needs.count} in ${needs.inWorkspaces} ${needs.inWorkspaces === 1 ? "workspace" : "workspaces"}`;
  const mascot = (w: WorkspaceNeeds) => mascotFor(mascots, w.workspace.mascotId);

  return (
    <aside className={`kuru-drawer needs-drawer ${sheet ? "kuru-sheet" : ""}`} ref={root} role="dialog" aria-label="Needs you">
      {/* The chips where the tray and the title were — the lit tray is this
          drawer's name, as Kuru's chip is Kuru's — and the count in words
          after them, which the chip has no room to say. */}
      <header className="kuru-head">
        {chips}
        <span className={`kuru-head-state ${needs.count ? "needs-head-some" : ""}`} role="status">
          {state}
        </span>
        <span className="kuru-head-spacer" />
        <button
          className="kuru-head-btn"
          onClick={onNext}
          onMouseDown={(event) => event.preventDefault()}
          disabled={needs.count === 0}
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
        {waiting.length === 0 && (
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
                      ? (x, y) => setCardMenu({ at: { x, y }, workspaceId: need.workspaceId, card: need.card! })
                      : undefined
                  }
                />
              ))}
            </ul>
          </li>
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
        <Menu at={cardMenu.at} items={cardMenuItems(cardMenu.workspaceId, cardMenu.card)} onClose={() => setCardMenu(null)} />
      )}
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
  /*
   * The row's own menu, open on a right-click or a touch held still —
   * `Sidebar.tsx`'s agent row trick, copied rather than imported: a dozen
   * lines of gesture code are cheaper duplicated here than factored out from
   * under a row with no other reason to know the sidebar exists. `pressed`
   * swallows the click the lift would otherwise deliver, so opening the menu
   * does not also run `onGo`.
   */
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const pressed = useRef(false);
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  return (
    <li
      className={`needs-row needs-row-${need.kind} ${made.length ? "needs-row-made" : ""}`}
      onContextMenu={
        onMenu
          ? (event: React.MouseEvent) => {
              event.preventDefault();
              onMenu(event.clientX, event.clientY);
            }
          : undefined
      }
      onPointerDown={
        onMenu
          ? (event: React.PointerEvent) => {
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
            }
          : undefined
      }
      onPointerMove={
        onMenu
          ? (event: React.PointerEvent) => {
              const at = press.current;
              if (at && Math.hypot(event.clientX - at.x, event.clientY - at.y) > 10) cancelPress();
            }
          : undefined
      }
      onPointerUp={onMenu ? cancelPress : undefined}
      onPointerCancel={onMenu ? cancelPress : undefined}
    >
      <button
        className="needs-go"
        onClick={() => {
          if (pressed.current) {
            pressed.current = false;
            return;
          }
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
