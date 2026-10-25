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
 *
 * **A group folds, and the queue sorts.** Ten cards under one workspace
 * are a wall the rest of the queue is behind, so every group — a
 * workspace's, Your board, another node's — has a caret by its name that
 * folds it to that one line and its count, and the groups and the cards in
 * them can be put in the order they will be taken: dragged with a mouse, or
 * moved from the menu a right-click or a held touch opens, which is the
 * phone's way. Folded is not dismissed — the tray still counts what is in
 * there, and Next still goes to it. What is kept and why, and what does not
 * move, is `needsorder.ts`; this draws it.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { boardLanes, cardCode, NEEDS_COLUMN, type Card } from "../../../shared/board";
import { cardPlace } from "../../../shared/kuru";
import { allNeeds, type Need, type NeedKind, type ProfileNeeds, type WorkspaceNeeds } from "../../../shared/needs";
import type { NodeStatus, SummaryAgent, SummaryNeed } from "../../../shared/nodes";
import { mascotFor, type AgentSnapshot, type MascotSet, type Profile } from "../../../shared/model";
import { useCardDone } from "../cardDone";
import { referItem } from "../kuru";
import { agentLabel, agentSummary } from "../labels";
import { asAgent } from "../nodes";
import { nodeNeeds, qualify, type NodeNeed } from "../../../shared/remote";
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
import {
  arrange,
  BOARD_GROUP,
  dropIndex,
  moveTo,
  movesFrom,
  setOrder,
  toggleShut,
  useNeedsView,
  withCards,
  withGroups,
} from "../needsorder";

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
  const [cardMenu, setCardMenu] = useState<{ at: MenuAt; workspaceKey: string; card: Card } | null>(null);
  /** A Needs you card's row menu: its own card menu's moves, and the door to it. */
  const [boardMenu, setBoardMenu] = useState<{ at: MenuAt; card: Card } | null>(null);
  /** A group's menu, off its name: the fold, and where the group goes. */
  const [groupMenu, setGroupMenu] = useState<{ at: MenuAt; key: string } | null>(null);
  const { order, shut } = useNeedsView(profile.key);

  const waiting = needs.workspaces.filter((w) => w.band === "needs");
  const working = needs.workspaces.filter((w) => w.band === "working");
  const quiet = needs.workspaces.filter((w) => w.band === "quiet");
  /* The waiting workspaces come already in the person's order, so that Next
     walks what is drawn (`arrangedNeeds`, in `App`); this places Your board
     among them, which is no workspace and so not in that walk. */
  type Group = { key: string; w: WorkspaceNeeds | null };
  const groups = arrange<Group>(
    [...waiting.map((w) => ({ key: w.workspace.key, w })), ...(needs.cards.length ? [{ key: BOARD_GROUP, w: null }] : [])],
    (group) => group.key,
    order.groups,
  );
  const groupKeys = groups.map((group) => group.key);
  /** The key a group is folded by, which has to be unique past this profile — see `needsorder.ts`'s `SHUT_KEY`. */
  const shutKey = (key: string) => (key === BOARD_GROUP ? `board:${profile.key}` : key);
  const moveGroup = (key: string, index: number) =>
    setOrder(profile.key, withGroups(order, profile, groupKeys, moveTo(groupKeys, key, index)));
  /** A workspace group's cards, as drawn: what its moves count, since its agent rows stay put. */
  const cardKeys = (w: WorkspaceNeeds) => w.needs.flatMap((need) => (need.card ? [need.card.id] : []));
  const moveWorkspaceCard = (w: WorkspaceNeeds, cardId: string, index: number) => {
    const drawn = cardKeys(w);
    setOrder(profile.key, withCards(order, profile, w.workspace.key, drawn, moveTo(drawn, cardId, index)));
  };
  /* Your board's cards are its column's, so a move is the board's own, by the
     index `moveCard` counts — the column's cards with this one taken out,
     which is what `moveTo` counts too. */
  const moveBoardCard = (cardId: string, index: number) => api.moveProfileCard(profile.id, cardId, NEEDS_COLUMN, index);

  /* A drop is a move to an index, and one that lands where the thing already
     is sends nothing — on Your board that would be a write to the database
     for no change. Rows are keyed `c<card>` and `a<agent>`, as React keys
     them, and only the `c`s count, since the agent rows stay put. */
  const sort = useSort(root, (what, over) => {
    if (what.kind === "group") {
      const index = dropIndex(groupKeys, what.key, over.key, over.after);
      if (index !== groupKeys.indexOf(what.key)) moveGroup(what.key, index);
      return;
    }
    const board = what.group === BOARD_GROUP;
    const w = board ? null : waiting.find((one) => one.workspace.key === what.group);
    const rows = board ? needs.cards.map((card) => `c${card.id}`) : w?.needs.map(needKey);
    if (!rows) return;
    const isCard = (key: string) => key.startsWith("c");
    const index = dropIndex(rows, what.key, over.key, over.after, isCard);
    if (index === rows.filter(isCard).indexOf(what.key)) return;
    const cardId = what.key.slice(1);
    if (w) moveWorkspaceCard(w, cardId, index);
    else moveBoardCard(cardId, index);
  });

  const boardMenuItems = (card: Card): MenuItem[] => {
    const [first, ...rest] = profileCardMoves(profile, card);
    return [
      { label: "Open on the board", run: () => onProfileCard(card.id) },
      ...placeMoves(
        needs.cards.map((c) => c.id),
        card.id,
        (index) => moveBoardCard(card.id, index),
      ),
      ...(first ? [{ ...first, sep: true }, ...rest] : []),
      referItem({ code: cardCode(profile.name, card.number), title: card.title, place: cardPlace(null, api.nodeNameOf), cardId: card.id }),
    ];
  };
  const groupMenuItems = (key: string): MenuItem[] => {
    const group = groups.find((one) => one.key === key);
    if (!group) return [];
    return [
      { label: shut.has(shutKey(key)) ? "Show" : "Fold away", run: () => toggleShut(shutKey(key)) },
      ...placeMoves(groupKeys, key, (index) => moveGroup(key, index), "group"),
      ...(order.groups.length ? [{ label: "Sort groups as the sidebar does", sep: true, run: () => setOrder(profile.key, { ...order, groups: [] }) }] : []),
      ...(group.w && order.cards[key]?.length
        ? [
            {
              label: "Sort its cards as the board does",
              sep: !order.groups.length,
              run: () => {
                const { [key]: _dropped, ...cards } = order.cards;
                setOrder(profile.key, { ...order, cards });
              },
            },
          ]
        : []),
    ];
  };
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
  const cardMenuItems = (workspaceKey: string, card: Card): MenuItem[] => {
    const w = waiting.find((one) => one.workspace.key === workspaceKey);
    if (!w) return [];
    const { id: workspaceId, name: workspaceName } = w.workspace;
    return [
      { label: "Move to Done", run: () => moveToDone(workspaceId, card) },
      ...placeMoves(cardKeys(w), card.id, (index) => moveWorkspaceCard(w, card.id, index)),
      // Opening Kuru's drawer closes this one: the two share the slot.
      referItem({ code: cardCode(workspaceName, card.number), title: card.title, place: cardPlace(workspaceId, api.nodeNameOf), cardId: card.id }),
    ];
  };

  /* A node that is away is left out, not drawn stale: its last summary may
     list a question already answered, and this is a queue to act on. */
  const elsewhere = nodes.filter((node) => node.state === "up" && (node.summary?.needs.count ?? 0) > 0);
  const mascot = (w: WorkspaceNeeds) => mascotFor(mascots, w.workspace.mascotId);

  return (
    <aside
      className={`kuru-drawer needs-drawer ${sheet ? "kuru-sheet" : ""} ${sort.active ? "needs-sorting" : ""}`}
      ref={root}
      role="dialog"
      aria-label="Needs you"
    >
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
        {groups.map(({ key, w }) => {
          const folded = shut.has(shutKey(key));
          const name = w ? w.workspace.name : "Your board";
          const count = w ? w.needs.length : needs.cards.length;
          return (
            <li
              key={key}
              className={`needs-ws ${w ? "" : "needs-ws-board"} ${sort.classOf("group", key)}`}
              data-sort-group={key}
            >
              <GroupHead
                name={name}
                folded={folded}
                onFold={() => toggleShut(shutKey(key))}
                onMenu={(x, y) => setGroupMenu({ at: { x, y }, key })}
                onSortStart={sort.begin({ kind: "group", key })}
                onGo={() => (w ? onWorkspace(w.workspace.id) : onProfileCard(null))}
                title={w ? `Go to ${name}` : "Open the profile's board"}
              >
                <span className="needs-ws-name">{name}</span>
                <span className="needs-ws-n">{count}</span>
                {w && w.working.length > 0 && (
                  <span className="needs-ws-also">
                    · {w.working.length} working
                  </span>
                )}
              </GroupHead>
              {!folded && w && (
                <ul className="needs-rows">
                  {w.needs.map((need) => (
                    <NeedRow
                      key={needKey(need)}
                      need={need}
                      workspaceName={w.workspace.name}
                      mascot={mascot(w)}
                      group={key}
                      sortClass={sort.classOf("row", needKey(need))}
                      onSortStart={need.card ? sort.begin({ kind: "row", group: key, key: needKey(need) }) : undefined}
                      onGo={onGo}
                      onBoard={onBoard}
                      onOpened={sheet ? onClose : undefined}
                      onMenu={need.card ? (x, y) => setCardMenu({ at: { x, y }, workspaceKey: key, card: need.card! }) : undefined}
                    />
                  ))}
                </ul>
              )}
              {!folded && !w && (
                <ul className="needs-rows">
                  {needs.cards.map((card) => (
                    <BoardRow
                      key={card.id}
                      card={card}
                      code={cardCode(profile.name, card.number)}
                      group={key}
                      sortClass={sort.classOf("row", `c${card.id}`)}
                      onSortStart={sort.begin({ kind: "row", group: key, key: `c${card.id}` })}
                      onOpen={() => onProfileCard(card.id)}
                      onDone={hasDone ? () => api.moveProfileCard(profile.id, card.id, "done") : undefined}
                      onMenu={(x, y) => setBoardMenu({ at: { x, y }, card })}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}

        {elsewhere.map((node) => (
          <NodeBand
            key={node.id}
            node={node}
            mascot={mascotFor(mascots, null)}
            shut={shut}
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
      {cardMenu && <Menu at={cardMenu.at} items={cardMenuItems(cardMenu.workspaceKey, cardMenu.card)} onClose={() => setCardMenu(null)} />}
      {boardMenu && <Menu at={boardMenu.at} items={boardMenuItems(boardMenu.card)} onClose={() => setBoardMenu(null)} />}
      {groupMenu && <Menu at={groupMenu.at} items={groupMenuItems(groupMenu.key)} onClose={() => setGroupMenu(null)} />}
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

/** A row's key in its group, as React keys it: `c` and the card, or `a` and the agent for a row with no card. */
function needKey(need: Need): string {
  return need.card ? `c${need.card.id}` : `a${need.agent!.id}`;
}

/** What a mouse is carrying: a group by its key, or a card's row by its key, within its group. */
type Sorting = { kind: "group"; key: string } | { kind: "row"; group: string; key: string };
/** Where it would land: before or after this group or row. */
type SortOver = { key: string; after: boolean };

/** How far a held mouse goes before the press is a drag. Under it the press is still the click it began as. */
const SORT_SLOP = 5;

/**
 * Sorting by dragging, with pointer events rather than the platform's drag
 * and drop — which is the decision to defend, since the sidebar and the
 * boards use the platform's. Two things it does are wrong here. A
 * `draggable` element only starts a drag when its `mousedown` goes
 * through, and every press in this drawer cancels its `mousedown`, because
 * that is what keeps the keyboard on the terminal a row reveals; and once
 * a drag has started no click is dispatched at all, so a press that wobbled
 * three pixels does nothing (`Sidebar.tsx`'s `CLICK_SLOP` is the patch for
 * that). Done by hand, the press stays a press until the mouse has really
 * gone somewhere, and only a mouse: a finger's press here is a scroll or,
 * held, the row's menu, which is where a phone moves things.
 *
 * The target is read off the document under the pointer — `data-sort-group`
 * on a group, `data-sort-row` and `data-sort-in` on a row — so a row only
 * lands among its own group's, and a release outside the drawer is a drag
 * put back.
 */
function useSort(root: React.RefObject<HTMLElement | null>, onDrop: (what: Sorting, over: SortOver) => void) {
  const [sorting, setSorting] = useState<Sorting | null>(null);
  const [over, setOver] = useState<SortOver | null>(null);
  const drop = useRef(onDrop);
  drop.current = onDrop;
  /** The listeners of a press in progress, taken off if the drawer goes mid-drag. */
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  /** Under the pointer: a target, null for nowhere to land, undefined for keep the last one — a gap between rows. */
  const targetAt = (what: Sorting, x: number, y: number): SortOver | null | undefined => {
    const el = document.elementFromPoint(x, y);
    if (!el || !root.current?.contains(el)) return null;
    const half = (box: Element, key: string): SortOver | null => {
      if (key === what.key) return null;
      const rect = box.getBoundingClientRect();
      return { key, after: y > rect.top + rect.height / 2 };
    };
    if (what.kind === "group") {
      const group = el.closest<HTMLElement>("[data-sort-group]");
      return group?.dataset.sortGroup === undefined ? undefined : half(group, group.dataset.sortGroup);
    }
    const row = el.closest<HTMLElement>("[data-sort-row]");
    if (row?.dataset.sortRow !== undefined && row.dataset.sortIn === what.group) return half(row, row.dataset.sortRow);
    return el.closest<HTMLElement>("[data-sort-group]")?.dataset.sortGroup === what.group ? undefined : null;
  };

  const begin = (what: Sorting) => (event: React.PointerEvent) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    stop.current?.();
    const from = { x: event.clientX, y: event.clientY };
    let started = false;
    let target: SortOver | null = null;
    const move = (e: PointerEvent) => {
      if (!started) {
        if (Math.hypot(e.clientX - from.x, e.clientY - from.y) < SORT_SLOP) return;
        started = true;
        setSorting(what);
      }
      const next = targetAt(what, e.clientX, e.clientY);
      if (next === undefined) return;
      target = next;
      setOver((was) => (was?.key === next?.key && was?.after === next?.after ? was : next));
    };
    const finish = (commit: boolean) => {
      stop.current?.();
      if (!started) return;
      setSorting(null);
      setOver(null);
      swallowClick();
      if (commit && target) drop.current(what, target);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    stop.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      stop.current = null;
    };
  };

  /** The class a group or row wears while something is carried: faded if it is the thing, a line where it would land. */
  const classOf = (kind: Sorting["kind"], key: string): string => {
    if (!sorting || sorting.kind !== kind) return "";
    if (sorting.key === key) return "needs-sorting-this";
    if (over?.key === key) return over.after ? "needs-drop-after" : "needs-drop-before";
    return "";
  };
  return { begin, classOf, active: sorting !== null };
}

/**
 * The click a release delivers to whatever it was over, which after a drag
 * is not a press of that thing. Taken once, in the capture phase, and let go
 * of on the next turn if none came — a release over nothing clickable
 * delivers none.
 */
function swallowClick(): void {
  const swallow = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

/**
 * The moves a menu offers for a thing's place in its list, which is how a
 * phone sorts: a finger's press is a scroll or a menu, never a drag. The two
 * ends as well as a step, because ten rows is nine steps. Nothing when there
 * is nothing to put it beside; a move that would go nowhere is drawn and
 * disabled, as the sidebar's group menu draws them.
 */
function placeMoves(keys: readonly string[], key: string, move: (index: number) => void, noun?: string): MenuItem[] {
  if (keys.length < 2) return [];
  const moves = movesFrom(keys.indexOf(key), keys.length);
  const what = noun ? `Move ${noun}` : "Move";
  const step = (label: string, index: number | undefined, sep = false): MenuItem => ({
    label: `${what} ${label}`,
    sep,
    disabled: index === undefined,
    run: () => {
      if (index !== undefined) move(index);
    },
  });
  return [step("up", moves.up, true), step("down", moves.down), step("to the top", moves.top), step("to the bottom", moves.bottom)];
}

/**
 * A group's name line: the caret that folds it, then the name, which goes to
 * the workspace — or, for another node's from before, links to its page.
 * Folded, the line is all there is of the group, and its count pill still
 * says how many are in there. The rest of the line is the group's handle: a
 * mouse drags it, and a right-click or a held touch opens its menu.
 */
function GroupHead({
  name,
  folded,
  title,
  onFold,
  onGo,
  href,
  onMenu,
  onSortStart,
  children,
}: {
  name: string;
  folded: boolean;
  title: string;
  onFold: () => void;
  onGo?: () => void;
  /** Instead of `onGo`: a link, for another node's workspace this window cannot open. */
  href?: string;
  onMenu?: (x: number, y: number) => void;
  onSortStart?: (event: React.PointerEvent) => void;
  children: ReactNode;
}) {
  const { handlers, swallow } = useRowMenu(onMenu);
  return (
    <div className="needs-ws-top" {...handlers}>
      <button
        className="needs-ws-fold"
        onClick={() => {
          if (swallow()) return;
          onFold();
        }}
        onMouseDown={(event) => event.preventDefault()}
        aria-expanded={!folded}
        aria-label={folded ? `Show ${name}` : `Fold ${name} away`}
        title={folded ? `Show ${name}` : `Fold ${name} away`}
      >
        <Icon name="caret" className={folded ? "drawer-caret-shut" : ""} />
      </button>
      {href ? (
        <a className="needs-ws-head" href={href} target="_blank" rel="noreferrer noopener" title={title}>
          {children}
        </a>
      ) : (
        <button
          className="needs-ws-head"
          onClick={() => {
            if (swallow()) return;
            onGo?.();
          }}
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={onSortStart}
          title={onSortStart ? `${title} · drag to move the group` : title}
        >
          {children}
        </button>
      )}
    </div>
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
 * menu the sidebar's agent rows do (`Sidebar.tsx`, KUR-99), and its first
 * row, "Move to Done", asks it here too, through `useCardDone`; the moves
 * under it are its place in the group. A card's row is dragged by its
 * door; an agent's with no card is not, and keeps the rule's place
 * (`needsorder.ts`), though a card may be dropped beside it.
 */
function NeedRow({
  need,
  workspaceName,
  mascot,
  group,
  sortClass,
  onSortStart,
  onGo,
  onBoard,
  onOpened,
  onMenu,
}: {
  need: Need;
  workspaceName: string;
  mascot: ReturnType<typeof mascotFor>;
  /** The group it is drawn in, which is the only one it may be dropped in. */
  group: string;
  sortClass: string;
  /** Pick the row up, for a card's; undefined for an agent's, which stays where the rule put it. */
  onSortStart: ((event: React.PointerEvent) => void) | undefined;
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
    <li
      className={`needs-row needs-row-${need.kind} ${made.length ? "needs-row-made" : ""} ${sortClass}`}
      data-sort-row={needKey(need)}
      data-sort-in={group}
      {...handlers}
    >
      <button
        className="needs-go"
        onClick={() => {
          if (swallow()) return;
          onGo(need);
        }}
        onMouseDown={(event) => event.preventDefault()}
        onPointerDown={onSortStart}
        title={`${agent ? "Go to its terminal" : "This card, on its board"}${onSortStart ? " · drag to move it" : ""}`}
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
 * or a held touch, as a workspace card's row has. Dragging one, or moving
 * it from that menu, moves it in the board's Needs you column, which is
 * the order these are drawn in.
 */
function BoardRow({
  card,
  code,
  group,
  sortClass,
  onSortStart,
  onOpen,
  onDone,
  onMenu,
}: {
  card: Card;
  code: string;
  group: string;
  sortClass: string;
  onSortStart: (event: React.PointerEvent) => void;
  onOpen: () => void;
  onDone: (() => void) | undefined;
  onMenu: (x: number, y: number) => void;
}) {
  const { handlers, swallow } = useRowMenu(onMenu);
  const first = card.body.split("\n").find((line) => line.trim())?.trim() ?? "";
  const why = [card.dates ? datesLabel(card.dates) : "", first].filter(Boolean).join(" · ") || "on your board";
  return (
    <li
      className={`needs-row needs-row-yours needs-row-by-${card.needsBy ?? "none"} ${sortClass}`}
      data-sort-row={`c${card.id}`}
      data-sort-in={group}
      {...handlers}
    >
      <button
        className="needs-go"
        onClick={() => {
          if (swallow()) return;
          onOpen();
        }}
        onMouseDown={(event) => event.preventDefault()}
        onPointerDown={onSortStart}
        title="This card, on the profile's board · drag to move it"
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
 *
 * Each workspace folds as this node's do, by its qualified id. It does not
 * sort: its order and its cards' are the node's summary's, and a row with
 * no menu has nowhere for a phone's moves to live.
 */
function NodeBand({
  node,
  mascot,
  shut,
  onGo,
  onWorkspace,
}: {
  node: NodeStatus;
  mascot: ReturnType<typeof mascotFor>;
  /** The folded groups' keys — `needsorder.ts`'s set, read once by the drawer. */
  shut: ReadonlySet<string>;
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
          const fold = qualify(node.id, w.key);
          const folded = shut.has(fold);
          return (
            <li key={w.key} className="needs-ws">
              <GroupHead
                name={w.name}
                folded={folded}
                onFold={() => toggleShut(fold)}
                {...(here ? { onGo: () => onWorkspace(node.id, w.key) } : { href: node.url })}
                title={here ? `Go to ${w.name}, on ${node.name}` : old}
              >
                <span className="needs-ws-name">{w.name}</span>
                <span className="needs-ws-n">{w.needs.length}</span>
              </GroupHead>
              {!folded && <ul className="needs-rows">
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
              </ul>}
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
