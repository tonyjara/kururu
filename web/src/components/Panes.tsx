/**
 * The tiled half of the window: the server's layout, drawn.
 *
 * It decides nothing. The tree arrives in the snapshot; this positions it.
 *
 * **Panes are a flat, keyed list of absolutely-positioned boxes, not nested flex
 * boxes.** They were nested once, which read better and was wrong: React
 * reconciles children by position, so restructuring the tree — which is what
 * every rearrangement does — moved a pane to a different place in the element
 * tree and React rebuilt it. The terminal inside was thrown away and built
 * again empty, and since the *set* of visible terminals had not changed, nothing
 * asked the server for the history to refill it. Dragging a pane aside made its
 * agent vanish until the program next happened to repaint itself.
 *
 * Flat and keyed by pane id, a rearrangement is a change of four CSS
 * percentages. React moves the existing DOM node, the emulator inside it never
 * learns that anything happened, and the scrollback and scroll position survive.
 * The geometry comes from `rects()` and `dividers()` in shared/layout.ts, which
 * are pure and tested; nothing here computes a coordinate.
 *
 * Dragging is handled here because what a drop means is about geometry: a strip
 * says *where in this order*, and a pane body says *which part of this space*.
 * The zones that answer are drawn only while something is actually in flight —
 * an invisible grid of drop targets over a terminal you are trying to click
 * would be its own bug.
 *
 * Two things can be picked up, and the strip is where both begin. Grab a tab and
 * the tab moves; grab the strip itself — the bit beside the tabs, which is the
 * pane's title bar — and the *whole pane* moves, contents and all. They share a
 * handle because they are the same idea at two scales, and `dragstart` bubbling
 * from the tab to the strip is the one trap: see the guard in `onDragStart`.
 *
 * **Only the active tab of a pane is mounted, and mounting is now cheap.** What
 * a pane draws is a box that a pooled emulator is moved into (`terminals.ts`),
 * so a hidden tab is not an emulator thrown away — it is one that keeps being
 * fed off screen and comes back with its screen, its scrollback and its scroll
 * position intact. This used to be a rebuild, justified by a WebGL context
 * budget that a 2D canvas does not have and by a backlog that existed to paper
 * over the rebuild in the first place. Neither a tab switch nor a layout change
 * rebuilds anything now.
 */
import { Fragment, useCallback, useRef, useState } from "react";
import {
  activeAgent,
  dividers,
  panes,
  rects,
  soloPane,
  type Divider,
  type LayoutNode,
  type PaneState,
  type Rect,
} from "../../../shared/layout";
import type { AgentSnapshot, MascotConfig } from "../../../shared/model";
import { AGENT_MIME, PANE_MIME, allowDrop, beginDrag, endDrag, useDragging } from "../drag";
import { shortenPath, tabLabel } from "../labels";
import * as api from "../session";
import { ReaderView } from "./Reader";
import { Icon } from "./Icon";
import { Menu, type MenuAt, type MenuItem } from "./Menu";
import { Status } from "./Status";
import { TerminalView } from "./Terminal";

interface Props {
  node: LayoutNode;
  focusedPaneId: string;
  agents: AgentSnapshot[];
  /** What the working badge animates; drawn here, owned by the server. */
  mascot: MascotConfig;
  /** Zen: the focused pane takes the window and the rest are held out of sight. */
  zen: boolean;
  /**
   * Solo: the window is too narrow to tile, so it draws one pane and a way to
   * reach the others. See the comment on `shown` below for what separates this
   * from zen, which looks like the same thing and is not.
   */
  solo: boolean;
  /**
   * Whether the panes are the ones holding the keyboard.
   *
   * False while something in the chrome has it — a dialog, a name being typed
   * in the sidebar, Settings. It is passed down rather than inferred here
   * because only `App.tsx` knows what is open, and it reaches the *emulator*
   * rather than the pane: the focused pane goes on looking focused while a
   * dialog is up, because it still is — it is where the next keystroke will go
   * once the dialog is answered.
   */
  keyboard: boolean;
}

/** A normalized rect as the four percentages CSS wants. */
function place(rect: Rect): React.CSSProperties {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.w * 100}%`,
    height: `${rect.h * 100}%`,
  };
}

const FULL: React.CSSProperties = { left: 0, top: 0, width: "100%", height: "100%" };

export function Panes({ node, focusedPaneId, agents, mascot, zen, solo, keyboard }: Props) {
  const area = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);
  /** Where the pane switcher hangs, or null while it is shut. */
  const [switcher, setSwitcher] = useState<MenuAt | null>(null);
  const boxes = rects(node);
  const all = panes(node);

  /**
   * Solo: the one pane a phone draws, and the others left out of the document.
   *
   * It is not zen with a narrower window, and the difference is the whole
   * reason this is a second state rather than `zen ||= narrow`. Zen hides the
   * other panes *where they are*, boxes and all, so their ptys keep the size
   * they were drawing at and coming back out of it costs no reflow. Here their
   * boxes are fractions of a 390px screen — twenty columns, thirty at best —
   * and a laid-out box is one the `ResizeObserver` in `terminals.ts` measures
   * and proposes. Since the policy is the *smallest* proposal over every client
   * that can see a terminal, a phone that kept them laid out would hold every
   * pane on the desktop next door down to a phone-sized grid, and the SIGWINCH
   * would make each agent redraw itself into it.
   *
   * So they are not drawn at all. A detached pooled emulator reports no width,
   * so `terminals.ts` refuses the measurement and proposes nothing, and
   * `App.tsx` drops them from the *visible* half of `watch` — which is what
   * withdraws the vote — while the pool keeps them warm and being fed. Nothing
   * is rebuilt by any of it: an emulator outlives the pane that was showing it,
   * the same way it already outlives a tab switch or a workspace change.
   */
  const shown = solo ? soloPane(node, focusedPaneId) : null;

  return (
    /* A pane slides to a new position, but not while you are dragging its
       divider — there it has to track the pointer exactly, and an easing curve
       reads as lag. */
    <div className={`stagearea ${resizing ? "stagearea-resizing" : ""}`} ref={area}>
      {(shown ? [shown] : all).map((pane) => {
        const focused = pane.id === focusedPaneId;
        const rect = boxes.get(pane.id);
        /**
         * In zen the focused pane takes the window and the others are hidden
         * *where they are* rather than unmounted or resized to nothing — their
         * ptys keep the size they were drawing at, so leaving zen costs no
         * reflow and no program is ever told it has zero columns.
         */
        const box = place(rect ?? { x: 0, y: 0, w: 1, h: 1 });
        const style = shown
          ? FULL
          : zen
            ? focused
              ? FULL
              : { ...box, visibility: "hidden" as const }
            : box;
        return (
          <div className="pane-box" key={pane.id} style={style}>
            <Pane
              pane={pane}
              /* Always true in solo, since the pane drawn is the focused one by
                 construction — and it still has to be passed rather than assumed,
                 because this is also what gives the emulator its cursor: an
                 unfocused one draws none at all (see `setFocused`). The ring it
                 costs is a ring round the only pane on screen, which says nothing
                 and is cheaper than a second meaning for the flag. */
              focused={focused}
              solo={solo ? { index: all.indexOf(pane), count: all.length, open: setSwitcher } : null}
              keyboard={keyboard}
              agents={agents}
              mascot={mascot}
            />
          </div>
        );
      })}

      {!zen && !solo && dividers(node).map((divider) => (
        <DividerBar key={divider.id} divider={divider} area={area} onResizing={setResizing} />
      ))}

      {/* The switcher. A list of places rather than a list of actions, which is
          what `mark` is for — and the way back to a pane whose only other door,
          on a window this narrow, is a keybind on a keyboard that is not there.
          Selecting one *focuses* it: there is no second notion of "the pane this
          phone is showing" to keep in step, and there could not usefully be one,
          since the keybar and every prefix action type into the focused pane and
          a phone showing a pane it was not typing into would be the worse bug. */}
      {switcher && (
        <Menu
          at={switcher}
          onClose={() => setSwitcher(null)}
          items={[
            ...all.map((pane, index): MenuItem => ({
              label: paneLabel(pane, agents),
              hint: `${index + 1}${pane.agentIds.length > 1 ? ` · ${pane.agentIds.length}` : ""}`,
              mark: pane.id === shown?.id,
              /* Every tab in there, not only the one it would open on: what the
                 dot is for is deciding whether a pane is worth going to. */
              unread: pane.agentIds.some((id) => agents.find((a) => a.id === id)?.unread),
              run: () => api.focusPane(pane.id),
            })),
            /* Making one, since the corner this button took over is where that
               used to live. It belongs in the same menu rather than beside it:
               a split is how the list above grows, and on a window that shows
               one pane at a time the two are the same subject. */
            { label: "Split right", sep: true, run: () => api.splitPane("row", shown?.id) },
            { label: "Split down", run: () => api.splitPane("col", shown?.id) },
            /* The reader's only other door is prefix+M, which is a keyboard this
               window does not have — and on a phone it is the whole reason for
               reading anything here at all. It asks for the focus as well, since
               a pane you cannot see is one that did not open. */
            { label: "Open a document", run: () => api.openReader(shown?.id, undefined, true) },
          ]}
        />
      )}
    </div>
  );
}

/**
 * What the switcher calls a pane.
 *
 * The tab that is showing, by the name the strip would give it, because a list
 * of panes people recognise is a list of the things they were last looking at —
 * and a fourth spelling of a terminal's name is a switcher that disagrees with
 * the strip you are reading it next to. A pane with nothing in it says so
 * rather than being left blank: an unlabelled row reads as a row that failed to
 * load.
 */
function paneLabel(pane: PaneState, agents: AgentSnapshot[]): string {
  if (pane.reader) {
    return pane.reader.path ? (pane.reader.path.split("/").pop() ?? "reader") : "reader";
  }
  const id = activeAgent(pane);
  const agent = id ? agents.find((a) => a.id === id) : null;
  return agent ? tabLabel(agent) : "empty";
}

/**
 * One split's boundary, as something you can grab.
 *
 * The ratio is read against the split's *own* rectangle rather than the window,
 * which is the whole reason `dividers()` hands one over: a divider two levels
 * down covers a fraction of the screen, and measuring the pointer against the
 * screen would move it by the wrong amount.
 */
function DividerBar({
  divider,
  area,
  onResizing,
}: {
  divider: Divider;
  area: React.RefObject<HTMLDivElement | null>;
  onResizing: (resizing: boolean) => void;
}) {
  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      onResizing(true);
    },
    [onResizing],
  );

  const onPointerUp = useCallback(() => onResizing(false), [onResizing]);

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const box = area.current?.getBoundingClientRect();
      if (!box) return;
      const ratio =
        divider.dir === "row"
          ? ((event.clientX - box.left) / box.width - divider.within.x) / divider.within.w
          : ((event.clientY - box.top) / box.height - divider.within.y) / divider.within.h;
      api.setRatio(divider.id, ratio);
    },
    [divider, area],
  );

  const style: React.CSSProperties =
    divider.dir === "row"
      ? {
          left: `${divider.at * 100}%`,
          top: `${divider.within.y * 100}%`,
          height: `${divider.within.h * 100}%`,
        }
      : {
          top: `${divider.at * 100}%`,
          left: `${divider.within.x * 100}%`,
          width: `${divider.within.w * 100}%`,
        };

  return (
    <div
      className={`dividerbar dividerbar-${divider.dir}`}
      style={style}
      role="separator"
      aria-orientation={divider.dir === "row" ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}

/**
 * What a pane in a solo window needs to know about the others: where it stands
 * in the list, how long the list is, and where to hang the menu that shows it.
 *
 * Null on a window wide enough to tile, rather than a boolean beside two numbers
 * that mean nothing when it is false — the same shape `keybarOpen` argues for in
 * `StatusBar`: "there is no such thing here" and "here it is" should not be
 * possible to confuse.
 */
interface SoloAt {
  index: number;
  count: number;
  open: (at: MenuAt) => void;
}

function Pane({
  pane,
  focused,
  solo,
  keyboard,
  agents,
  mascot,
}: {
  pane: PaneState;
  focused: boolean;
  solo: SoloAt | null;
  keyboard: boolean;
  agents: AgentSnapshot[];
  mascot: MascotConfig;
}) {
  const showing = activeAgent(pane);
  const dragging = useDragging();
  /** Where in this strip a dropped tab would land, while one is over it. */
  const [dropAt, setDropAt] = useState<number | null>(null);
  /**
   * The reader's picker is open over its document. Local to the pane and not in
   * the layout, because it is a question somebody is in the middle of asking
   * rather than a fact about the arrangement — the answer is what the server
   * gets told, and a second window has no business having its picker opened from
   * here. It is the same line `Settings` draws about which tab it has open.
   */
  const [picking, setPicking] = useState(false);

  const takesTabs = dragging?.kind === "agent" && !pane.reader;
  /** Another pane is in flight, and it is not this one. */
  const takesPane = dragging?.kind === "pane" && dragging.id !== pane.id;
  /** This pane is the one being dragged; show it as picked up. */
  const lifted = dragging?.kind === "pane" && dragging.id === pane.id;

  const overTab = (event: React.DragEvent, index: number) => {
    if (!takesTabs) return;
    allowDrop(event);
    // Past the midpoint means after this tab — the same rule every tab strip
    // uses, and the reason the insertion line lands where the eye expects.
    const box = event.currentTarget.getBoundingClientRect();
    setDropAt(event.clientX > box.left + box.width / 2 ? index + 1 : index);
  };

  const dropOnStrip = (event: React.DragEvent) => {
    const index = dropAt;
    setDropAt(null);
    const agentId = event.dataTransfer.getData(AGENT_MIME);
    if (agentId) {
      event.preventDefault();
      event.stopPropagation();
      return api.moveTab(agentId, pane.id, index ?? undefined);
    }
    // A whole pane dropped on a strip pours its tabs in and disappears. It is
    // the way back from a split — without it a window divides but never rejoins.
    const paneId = event.dataTransfer.getData(PANE_MIME);
    if (paneId && paneId !== pane.id) {
      event.preventDefault();
      event.stopPropagation();
      api.mergePanes(paneId, pane.id);
    }
  };

  return (
    <section
      className={`pane ${focused ? "pane-on" : ""} ${lifted ? "pane-lifted" : ""}`}
      // Pointer-down rather than click: focus should land before the terminal
      // starts a selection drag, not after it.
      onPointerDown={() => api.focusPane(pane.id)}
    >
      <header
        className={`tabstrip ${lifted ? "tabstrip-lifted" : ""}`}
        /* The pane's own drag handle — but `dragstart` bubbles up from every
           tab in here, so only claim the drag when the strip itself is what was
           grabbed. Without this, picking up a tab would put the pane in flight. */
        draggable
        onDragStart={(event) => {
          if (event.target !== event.currentTarget) return;
          beginDrag(event, "pane", pane.id);
        }}
        onDragEnd={() => {
          endDrag();
          setDropAt(null);
        }}
        onDragOver={(event) => (takesTabs || takesPane) && allowDrop(event)}
        onDragLeave={() => setDropAt(null)}
        onDrop={dropOnStrip}
      >
        {pane.reader ? (
          <ReaderStrip pane={pane} picking={picking} onPick={() => setPicking((open) => !open)} />
        ) : null}
        {!pane.reader &&
          pane.agentIds.map((agentId, index) => {
          const agent = agents.find((a) => a.id === agentId);
          if (!agent) return null;
          return (
            <Fragment key={agentId}>
              {dropAt === index && <span className="tab-insert" aria-hidden="true" />}
              <button
                className={`tab ${index === pane.activeIdx ? "tab-on" : ""} ${agent.exited ? "tab-exited" : ""}`}
                onClick={() => api.selectTab(pane.id, index)}
                /* The label leads, because a tab is 180px wide and a summary an
                   agent wrote is usually longer than that — the tooltip is the
                   only place the whole sentence fits. */
                title={[tabLabel(agent), agent.command, agent.cwd].join("\n")}
                draggable
                onDragStart={(event) => beginDrag(event, "agent", agentId)}
                onDragEnd={() => {
                  endDrag();
                  setDropAt(null);
                }}
                onDragOver={(event) => overTab(event, index)}
                onDrop={dropOnStrip}
              >
                <Status agent={agent} mascot={mascot} />
                <span className="tab-label">{tabLabel(agent)}</span>
                {agent.unread && <span className="unread" aria-label="new output" />}
                <span
                  className="tab-close"
                  role="button"
                  tabIndex={-1}
                  aria-label="Close tab"
                  title="Close this tab — it ends the terminal"
                  onClick={(event) => {
                    event.stopPropagation();
                    api.closeTab(agentId);
                  }}
                >
                  <Icon name="close" />
                </span>
              </button>
            </Fragment>
          );
          })}
        {!pane.reader && dropAt === pane.agentIds.length && <span className="tab-insert" aria-hidden="true" />}

        {!pane.reader && (
          <button
            className="tab tab-new"
            onClick={() => void api.newTab({ paneId: pane.id })}
            title="New terminal here (C-a T)"
            aria-label="New tab"
          >
            +
          </button>
        )}

        <span className="tab-spacer" />
        {/* The pane's own controls, as one block, because the block is what
            stays put: the strip scrolls sideways once the tabs outgrow it, and
            these used to scroll away with them. On a phone that is the switcher
            gone — two tabs is enough to lose it — and the switcher is the only
            way to the other panes there. It is pinned in the stylesheet rather
            than here; what this grouping does is give it something to pin. */}
        <span className="tab-actions">
          {/* Splitting is a two-handed gesture for a window with room to split
              into, so on a phone the corner is spent on the one control that is
              *only* reachable here — the other panes. The keys still do it, and
              a split made on the desktop is a row in the switcher on the phone. */}
          {!solo && (
            <>
              <button className="pane-btn" onClick={() => api.splitPane("row", pane.id)} title="Split right (C-a |)">
                ⊟
              </button>
              <button className="pane-btn" onClick={() => api.splitPane("col", pane.id)} title="Split down (C-a -)">
                ⊞
              </button>
            </>
          )}
          {solo && <PaneSwitch solo={solo} />}
          <button
            className="pane-btn"
            onClick={() => api.closePane(pane.id)}
            title="Close this pane and everything in it (C-a x)"
          >
            <Icon name="close" />
          </button>
        </span>
      </header>

      <div className="pane-body">
        {pane.reader ? (
          <ReaderView
            paneId={pane.id}
            reader={pane.reader}
            picking={picking}
            onPicked={() => setPicking(false)}
          />
        ) : showing ? (
          /* Deliberately unkeyed. A key here would rebuild this on every tab
             switch, which is what it used to be for — and the emulator it would
             have rebuilt is pooled now and outlives the pane, so the only thing
             a key could still throw away is the empty box it lives in. The
             agent id is a dependency of the effect that borrows, which is where
             a tab switch belongs: one `removeChild`, one `appendChild`. */
          <TerminalView agentId={showing} focused={focused} keyboard={keyboard} />
        ) : (
          <EmptyPane pane={pane} />
        )}
        {(takesTabs || takesPane) && <DropZones paneId={pane.id} />}
      </div>
    </section>
  );
}

/**
 * The corner button a narrow window gets instead of the split controls.
 *
 * It says which pane this is and how many there are — `2/3` — because a button
 * that only opened a menu would leave a phone with nothing on screen saying the
 * other panes exist at all, and "there is more of this window somewhere" is most
 * of what it is for. The glyph is drawn here rather than taken from the skin's
 * icon set, on `StatusBar`'s reasoning: the set names the glyphs a skin is
 * expected to restyle, and a fourth entry every future skin has to answer for
 * would buy nothing — two rectangles mean two panes in any chrome.
 *
 * The menu is anchored to the button's *left* edge and allowed to run off the
 * side, because `Popover` already clamps it back inside the window — which at
 * this width right-aligns it under a button that is itself against the right
 * edge. Naming the corner here instead would be a second thing to keep in step
 * with the first.
 */
function PaneSwitch({ solo }: { solo: SoloAt }) {
  return (
    <button
      className="pane-btn pane-switch"
      title="The other panes in this workspace"
      aria-label={`Pane ${solo.index + 1} of ${solo.count}. Switch panes`}
      aria-haspopup="menu"
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        solo.open({ x: box.left, y: box.bottom + 4 });
      }}
    >
      <PanesIcon />
      <span className="pane-switch-count">
        {solo.index + 1}/{solo.count}
      </span>
    </button>
  );
}

/** Two boxes side by side: the window this one is a slice of. */
function PanesIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="7.5" height="16" rx="1.5" />
      <rect x="13.5" y="4" width="7.5" height="16" rx="1.5" />
    </svg>
  );
}

/**
 * The five places something can be dropped on a pane: four edges and the middle.
 *
 * What they mean depends on what is in flight, and the two readings are the same
 * idea at two scales. A *tab* on an edge divides the pane and goes in the new
 * half; a tab in the middle joins the pane. A *pane* on an edge moves to that
 * side of this one; a pane in the middle swaps places with it — which is the
 * short way to say "these two, the other way round", and the reason it is not
 * simply a move onto the opposite edge.
 *
 * Five absolutely-positioned regions rather than arithmetic on the pointer,
 * because the regions are also what gets highlighted — working out the zone and
 * then drawing it separately is two chances to disagree about where the boundary
 * is. They exist only while a drag does, so nothing is ever laid over a terminal
 * you are trying to use.
 */
function DropZones({ paneId }: { paneId: string }) {
  const dragging = useDragging();
  const [over, setOver] = useState<string | null>(null);

  const act = (name: string) => (event: React.DragEvent) => {
    const agentId = event.dataTransfer.getData(AGENT_MIME);
    if (agentId) {
      if (name === "center") return api.moveTab(agentId, paneId);
      const [dir, before] = EDGES[name]!;
      return api.splitWith(agentId, paneId, dir, before);
    }
    const from = event.dataTransfer.getData(PANE_MIME);
    if (!from || from === paneId) return;
    if (name === "center") return api.swapPanes(from, paneId);
    const [dir, before] = EDGES[name]!;
    api.movePane(from, paneId, dir, before);
  };

  const zone = (name: string) => ({
    className: `dz dz-${name} ${over === name ? "dz-on" : ""}`,
    onDragOver: (event: React.DragEvent) => {
      allowDrop(event);
      setOver(name);
    },
    onDragLeave: () => setOver((current) => (current === name ? null : current)),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setOver(null);
      act(name)(event);
    },
  });

  return (
    <div className={`dropzones dropzones-${dragging?.kind ?? "none"}`}>
      <div {...zone("left")} />
      <div {...zone("right")} />
      <div {...zone("top")} />
      <div {...zone("bottom")} />
      <div {...zone("center")} />
    </div>
  );
}

/** Which way an edge divides, and which side of the split the new thing takes. */
const EDGES: Record<string, ["row" | "col", boolean]> = {
  left: ["row", true],
  right: ["row", false],
  top: ["col", true],
  bottom: ["col", false],
};

/**
 * A reader's strip: what it is showing, and whether it is still listening.
 *
 * The name comes from the path the pane already has rather than from the
 * document's own first heading, which the server does send. A strip should say
 * which file you are looking at — two notes both titled "Notes" are a strip that
 * has stopped telling you anything.
 *
 * Two controls, and they are the two ways a reader can be pointed at something.
 * The toggle is the editor: following is the point of the pane, so that is the
 * default and pinning is the exception — the moment you want to keep reading one
 * file while the editor moves on. The name is the other way, for the window that
 * has no editor to follow, and picking a file there pins it by doing so.
 */
function ReaderStrip({
  pane,
  picking,
  onPick,
}: {
  pane: PaneState;
  picking: boolean;
  onPick: () => void;
}) {
  const reader = pane.reader;
  if (!reader) return null;
  const name = reader.path ? (reader.path.split("/").pop() ?? reader.path) : "reader";
  const following = reader.follow !== null;
  return (
    <>
      {/* The name is the way back to the list, which is why it is a button and
          not the label it used to be. A picker reachable only from an empty
          reader would be a picker you could use once — and the file you are
          reading is the obvious place to ask for a different one. */}
      <button
        className={`tab tab-on tab-reader ${picking ? "tab-picking" : ""}`}
        onClick={onPick}
        aria-expanded={picking}
        title={reader.path ? `${reader.root}/${reader.path}\nClick to open another document` : "waiting for the editor"}
      >
        {name}
        <span className="tab-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      <button
        className="pane-btn"
        onClick={() => api.pinReader(pane.id, !following)}
        title={following ? "Following the editor — click to pin this file" : "Pinned — click to follow the editor"}
      >
        {following ? "⇄" : "⊙"}
      </button>
    </>
  );
}

/**
 * A pane with no tabs, which is now a leftover rather than a starting point.
 *
 * Making a pane opens a terminal in it — the server does that for a split, a new
 * workspace, a new profile and a first launch — so the only ways to arrive here
 * are closing a pane's last tab yourself and a layout restored from disk, which
 * comes back without its processes on purpose. That leaves nothing to choose
 * between, and a button offering the one thing that can happen is a step that
 * decides nothing. So the pane *is* the button: click anywhere in it.
 */
function EmptyPane({ pane }: { pane: PaneState }) {
  return (
    <button
      className="pane-empty"
      onClick={() => void api.newTab({ paneId: pane.id })}
      title="Open a terminal here (C-a T)"
    >
      <span className="pane-empty-hint">
        terminal{pane.cwd ? ` in ${shortenPath(pane.cwd)}` : ""}
      </span>
      <span className="pane-empty-keys">
        <kbd>C-a</kbd> <kbd>T</kbd>
      </span>
    </button>
  );
}
