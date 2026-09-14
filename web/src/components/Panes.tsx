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
 * **Only the active tab of a pane is mounted.** A hidden tab is not watched, so
 * its emulator would be frozen on stale output and reset by a backlog the moment
 * it came back — and every live terminal holds a WebGL context, of which a page
 * gets about sixteen. A tab switch is a rebuild and the backlog makes it
 * correct; a *layout* change is not a rebuild at all.
 */
import { Fragment, useCallback, useRef, useState } from "react";
import {
  activeAgent,
  dividers,
  panes,
  rects,
  type Divider,
  type LayoutNode,
  type PaneState,
  type Rect,
} from "../../../shared/layout";
import type { AgentSnapshot } from "../../../shared/model";
import { AGENT_MIME, PANE_MIME, allowDrop, beginDrag, endDrag, useDragging } from "../drag";
import { agentLabel, shortenPath } from "../labels";
import * as api from "../session";
import { Status } from "./Status";
import { TerminalView } from "./Terminal";

interface Props {
  node: LayoutNode;
  focusedPaneId: string;
  agents: AgentSnapshot[];
  /** Zen: the focused pane takes the window and the rest are held out of sight. */
  zen: boolean;
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

export function Panes({ node, focusedPaneId, agents, zen }: Props) {
  const area = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);
  const boxes = rects(node);

  return (
    /* A pane slides to a new position, but not while you are dragging its
       divider — there it has to track the pointer exactly, and an easing curve
       reads as lag. */
    <div className={`stagearea ${resizing ? "stagearea-resizing" : ""}`} ref={area}>
      {panes(node).map((pane) => {
        const focused = pane.id === focusedPaneId;
        const rect = boxes.get(pane.id);
        /**
         * In zen the focused pane takes the window and the others are hidden
         * *where they are* rather than unmounted or resized to nothing — their
         * ptys keep the size they were drawing at, so leaving zen costs no
         * reflow and no program is ever told it has zero columns.
         */
        const style =
          zen && !focused
            ? { ...place(rect ?? { x: 0, y: 0, w: 1, h: 1 }), visibility: "hidden" as const }
            : zen
              ? FULL
              : place(rect ?? { x: 0, y: 0, w: 1, h: 1 });
        return (
          <div className="pane-box" key={pane.id} style={style}>
            <Pane pane={pane} focused={focused} agents={agents} />
          </div>
        );
      })}

      {!zen && dividers(node).map((divider) => (
        <DividerBar key={divider.id} divider={divider} area={area} onResizing={setResizing} />
      ))}
    </div>
  );
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

function Pane({ pane, focused, agents }: { pane: PaneState; focused: boolean; agents: AgentSnapshot[] }) {
  const showing = activeAgent(pane);
  const dragging = useDragging();
  /** Where in this strip a dropped tab would land, while one is over it. */
  const [dropAt, setDropAt] = useState<number | null>(null);

  const takesTabs = dragging?.kind === "agent";
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
        {pane.agentIds.map((agentId, index) => {
          const agent = agents.find((a) => a.id === agentId);
          if (!agent) return null;
          return (
            <Fragment key={agentId}>
              {dropAt === index && <span className="tab-insert" aria-hidden="true" />}
              <button
                className={`tab ${index === pane.activeIdx ? "tab-on" : ""} ${agent.exited ? "tab-exited" : ""}`}
                onClick={() => api.selectTab(pane.id, index)}
                title={`${agent.command}\n${agent.cwd}`}
                draggable
                onDragStart={(event) => beginDrag(event, "agent", agentId)}
                onDragEnd={() => {
                  endDrag();
                  setDropAt(null);
                }}
                onDragOver={(event) => overTab(event, index)}
                onDrop={dropOnStrip}
              >
                <Status agent={agent} />
                <span className="tab-label">{agentLabel(agent)}</span>
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
                  ✕
                </span>
              </button>
            </Fragment>
          );
        })}
        {dropAt === pane.agentIds.length && <span className="tab-insert" aria-hidden="true" />}

        <button
          className="tab tab-new"
          onClick={() => void api.newTab({ paneId: pane.id })}
          title="New terminal here (C-a T)"
          aria-label="New tab"
        >
          +
        </button>

        <span className="tab-spacer" />
        <button className="pane-btn" onClick={() => api.splitPane("row", pane.id)} title="Split right (C-a |)">
          ⊟
        </button>
        <button className="pane-btn" onClick={() => api.splitPane("col", pane.id)} title="Split down (C-a -)">
          ⊞
        </button>
        <button
          className="pane-btn"
          onClick={() => api.closePane(pane.id)}
          title="Close this pane and everything in it (C-a x)"
        >
          ✕
        </button>
      </header>

      <div className="pane-body">
        {showing ? (
          /* Keyed on the terminal, so switching tabs builds a fresh emulator and
             the server's backlog fills it; keyed on nothing else, so the layout
             moving around cannot disturb it. */
          <TerminalView key={showing} agentId={showing} focused={focused} />
        ) : (
          <EmptyPane pane={pane} />
        )}
        {(takesTabs || takesPane) && <DropZones paneId={pane.id} />}
      </div>
    </section>
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
