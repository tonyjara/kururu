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
import { keysByAction, type Action } from "../../../shared/keys";
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
import { basename } from "../../../shared/labels";
import { visibleLaunchers, type Launcher, type LaunchSettings } from "../../../shared/launchers";
import type { AgentSnapshot, MascotConfig } from "../../../shared/model";
import { AGENT_MIME, DOC_MIME, PANE_MIME, allowDrop, beginDrag, docId, endDrag, parseDocId, useDragging } from "../drag";
import { keyLabel, PREFIX_LABEL } from "../keys";
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
  /**
   * The keys as they actually are, for the hints in a pane's menu. Handed down
   * rather than read from the defaults here, because they are rebindable and a
   * printed key that is not the key is worse than no key printed at all.
   */
  keymap: Record<string, Action>;
  /** Which agents the new-tab button offers besides a terminal. */
  launch: LaunchSettings;
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
  /** Whether the file tree is showing, for the pane menu's row that toggles it. */
  filesOpen: boolean;
  onToggleFiles: () => void;
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

export function Panes({
  node,
  focusedPaneId,
  agents,
  mascot,
  keymap,
  launch,
  zen,
  solo,
  keyboard,
  filesOpen,
  onToggleFiles,
}: Props) {
  const area = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);
  /**
   * Whose menu is open and where it hangs, or null while none is.
   *
   * The pane is carried beside the point rather than read off the focus,
   * because the button is in a pane's own corner and pressing it is not a
   * gesture about the focused pane — on a tiled window you open the menu of the
   * pane you are pointing at, and every action in it names the pane it came
   * from. One menu for the whole stage rather than one per pane: it is drawn
   * over everything anyway (`.menu-backdrop` is fixed), and two panes with a
   * menu open at once is not a state worth being able to reach.
   */
  const [menu, setMenu] = useState<{ at: MenuAt; paneId: string; of: "pane" | "new" } | null>(null);
  const launchers = visibleLaunchers(launch);
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
  /** Which panes are readers, for a pane in flight to know what it may pour into. */
  const readers = new Set(all.filter((p) => p.reader).map((p) => p.id));

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
              solo={solo ? { index: all.indexOf(pane), count: all.length } : null}
              onMenu={(at) => setMenu({ at, paneId: pane.id, of: "pane" })}
              /* With every agent switched off the menu would be one row, and a
                 menu of one is a step rather than a choice — so the button goes
                 back to opening the terminal straight away. */
              onNew={launchers.length ? (at) => setMenu({ at, paneId: pane.id, of: "new" }) : null}
              keyboard={keyboard}
              agents={agents}
              mascot={mascot}
              readers={readers}
            />
          </div>
        );
      })}

      {!zen && !solo && dividers(node).map((divider) => (
        <DividerBar key={divider.id} divider={divider} area={area} onResizing={setResizing} />
      ))}

      {menu && (
        <Menu
          at={menu.at}
          onClose={() => setMenu(null)}
          items={
            menu.of === "new"
              ? newTabMenu(menu.paneId, launchers, keymap)
              : paneMenu({
                  paneId: menu.paneId,
                  all,
                  agents,
                  keymap,
                  /* Zen and solo are different states and the same fact here: what
                     this says is "a pane made now would be made off screen", and both
                     of them hide every pane but one. */
                  alone: solo || zen,
                  filesOpen,
                  onToggleFiles,
                })
          }
        />
      )}
    </div>
  );
}

/**
 * A pane's menu: where you can go from here, and what this pane can do.
 *
 * This was the phone's switcher, and it is the whole corner now. The split
 * buttons that used to sit in a tiled window's strip are two of the rows below,
 * which costs a click and buys three things: the reader — whose only other door
 * was prefix+M, a key you have to already know — is reachable with a mouse on
 * the desktop and not only on a phone; the corner is one shape on both, so
 * there is one thing to learn and one thing to style; and every pane action can
 * be in here whether or not there is room in a strip for a button, which is the
 * constraint that kept the list short in the first place.
 *
 * It is a list of *places* and then a list of *actions*, in that order, with a
 * rule between them. The places come first because they are what a menu opened
 * by mistake should be safe to read — and they are dropped entirely when this is
 * the only pane, since a one-row list of where you already are is a row that
 * says nothing. Selecting one *focuses* it: there is no second notion of "the
 * pane this window is showing" to keep in step, and there could not usefully be
 * one, since the keybar and every prefix action type into the focused pane.
 *
 * Every action names `paneId` rather than letting the server fall back to the
 * focused pane. Opening the menu does not move the focus — the backdrop
 * swallows the click — so on a tiled window the pane you pointed at and the
 * pane holding the keyboard are routinely not the same one, and a split that
 * landed next to a different pane than the one you opened would be the kind of
 * bug nobody reports because they assume they misclicked.
 *
 * The hints are read out of the live keymap rather than written here, for
 * `HelpOverlay`'s reason: the keys are rebindable, and a menu that prints
 * `C-a |` next to an action somebody has moved is a menu that lies in the one
 * place a person went looking for the truth.
 */
function paneMenu({
  paneId,
  all,
  agents,
  keymap,
  alone,
  filesOpen,
  onToggleFiles,
}: {
  paneId: string;
  all: PaneState[];
  agents: AgentSnapshot[];
  keymap: Record<string, Action>;
  /** The window draws one pane at a time, so anything new opens out of sight. */
  alone: boolean;
  filesOpen: boolean;
  onToggleFiles: () => void;
}): MenuItem[] {
  const bound = keysByAction(keymap);
  const key = (action: Action): string | undefined => {
    const first = bound[action]?.[0];
    return first ? `${PREFIX_LABEL} ${keyLabel(first)}` : undefined;
  };
  const pane = all.find((p) => p.id === paneId);
  const places: MenuItem[] =
    all.length > 1
      ? all.map((p, index) => ({
          label: paneLabel(p, agents),
          hint: `${index + 1}${p.agentIds.length > 1 ? ` · ${p.agentIds.length}` : ""}`,
          mark: p.id === paneId,
          /* Every tab in there, not only the one it would open on: what the dot
             is for is deciding whether a pane is worth going to — and a pane is
             worth going to if anything behind it is waiting for you. */
          unread: p.agentIds.some((id) => agents.find((a) => a.id === id)?.unread),
          run: () => api.focusPane(p.id),
        }))
      : [];
  return [
    ...places,
    {
      label: "Split right",
      hint: key("split-right"),
      sep: places.length > 0,
      run: () => api.splitPane("row", paneId),
    },
    { label: "Split down", hint: key("split-down"), run: () => api.splitPane("col", paneId) },
    /* The tree is the window's rather than this pane's, and it is here anyway:
       this is the corner a mouse goes to for "what else can I open", and the
       tree is where everything else opens from. The status bar has the same
       door; this one is where you already are. */
    {
      label: filesOpen ? "Hide the file tree" : "Show the file tree",
      hint: key("toggle-files"),
      sep: true,
      run: onToggleFiles,
    },
    /* Not on a reader, whose documents come from the tree and open as tabs in
       it: a door onto a picker from inside the pane it would fill is a menu
       padded out to look complete. The keybind there means "follow the editor
       again", which is what the follow button in that strip says in a word. */
    ...(pane?.reader
      ? []
      : [
          {
            label: "Open a document",
            hint: key("open-reader"),
            /* It asks for the focus when there is no room to tile, since a pane
               you cannot see is one that did not open. On a tiled window it
               deliberately does not: the reader arrives beside the terminal you
               were typing into, and taking the keyboard away from that terminal
               to give it to a document is the opposite of what reading one
               beside your work is for. */
            run: () => api.openReader(paneId, undefined, alone),
          },
        ]),
    {
      label: "Close this pane",
      hint: key("close-pane"),
      sep: true,
      danger: true,
      run: () => api.closePane(paneId),
    },
  ];
}

/**
 * The new-tab button's menu: a terminal, then an agent on a model.
 *
 * The terminal stays first and keeps its key, because it is still what C-a T
 * opens and what a pane with nothing in it opens when clicked — the menu adds
 * choices to the button without changing what the other two doors do. The
 * agents are grouped by CLI with a rule between them, in `LAUNCHERS` order.
 */
function newTabMenu(paneId: string, launchers: Launcher[], keymap: Record<string, Action>): MenuItem[] {
  const first = keysByAction(keymap)["new-tab"]?.[0];
  return [
    {
      label: "Terminal",
      hint: first ? `${PREFIX_LABEL} ${keyLabel(first)}` : undefined,
      run: () => void api.newTab({ paneId }),
    },
    ...launchers.map((launcher, index) => ({
      label: launcher.label,
      hint: launcher.model ? undefined : "default model",
      sep: index === 0 || launchers[index - 1]?.cli !== launcher.cli,
      run: () => void api.newTab({ paneId, launcher: launcher.id }),
    })),
  ];
}

/**
 * What the menu calls a pane.
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
 * in the list, and how long the list is.
 *
 * Null on a window wide enough to tile, rather than a boolean beside two numbers
 * that mean nothing when it is false — the same shape `keybarOpen` argues for in
 * `StatusBar`: "there is no such thing here" and "here it is" should not be
 * possible to confuse. Since the menu moved into every pane's corner, this is
 * only what the button *prints*; where the menu hangs is `onMenu`, which every
 * pane has.
 */
interface SoloAt {
  index: number;
  count: number;
}

function Pane({
  pane,
  focused,
  solo,
  onMenu,
  onNew,
  keyboard,
  agents,
  mascot,
  readers,
}: {
  pane: PaneState;
  focused: boolean;
  solo: SoloAt | null;
  onMenu: (at: MenuAt) => void;
  /** Open the new-tab menu here, or null to open a terminal without asking. */
  onNew: ((at: MenuAt) => void) | null;
  keyboard: boolean;
  agents: AgentSnapshot[];
  mascot: MascotConfig;
  readers: Set<string>;
}) {
  const showing = activeAgent(pane);
  const dragging = useDragging();
  /** Where in this strip a dropped tab would land, while one is over it. */
  const [dropAt, setDropAt] = useState<number | null>(null);
  /**
   * A tab of the kind this strip holds: terminals into a terminal pane,
   * documents into a reader. Either kind can still go on any pane's *edge*,
   * which makes a new pane of its own kind — see `DropZones`.
   */
  const takesTabs = pane.reader ? dragging?.kind === "doc" : dragging?.kind === "agent";
  /** Another pane is in flight, and it is not this one. */
  const takesPane = dragging?.kind === "pane" && dragging.id !== pane.id;
  /** ...and it is the same kind of pane, so dropping it on this strip can pour it in. */
  const mergesPane = takesPane && readers.has(dragging.id) === Boolean(pane.reader);
  /** Something that can land on this pane's body: any tab on an edge, any pane. */
  const takesZones = takesPane || dragging?.kind === "agent" || dragging?.kind === "doc";
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
    if (agentId && !pane.reader) {
      event.preventDefault();
      event.stopPropagation();
      return api.moveTab(agentId, pane.id, index ?? undefined);
    }
    const doc = parseDocId(event.dataTransfer.getData(DOC_MIME));
    if (doc && pane.reader) {
      event.preventDefault();
      event.stopPropagation();
      return api.moveDoc(doc.paneId, doc.index, pane.id, index ?? undefined);
    }
    // A whole pane dropped on a strip pours its tabs in and disappears. It is
    // the way back from a split — without it a window divides but never rejoins.
    const paneId = event.dataTransfer.getData(PANE_MIME);
    if (paneId && paneId !== pane.id && mergesPane) {
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
        onDragOver={(event) => (takesTabs || mergesPane) && allowDrop(event)}
        onDragLeave={() => setDropAt(null)}
        onDrop={dropOnStrip}
      >
        {pane.reader ? (
          <ReaderStrip
            pane={pane}
            dropAt={dropAt}
            onOver={overTab}
            onDrop={dropOnStrip}
            onDragEnd={() => setDropAt(null)}
          />
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
                {agent.unread && <span className="unread" aria-label="waiting for you" />}
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
            onClick={(event) => {
              if (!onNew) return void api.newTab({ paneId: pane.id });
              const box = event.currentTarget.getBoundingClientRect();
              onNew({ x: box.left, y: box.bottom + 4 });
            }}
            title={onNew ? "New tab here: a terminal or an agent" : "New terminal here (C-a T)"}
            aria-label="New tab"
            aria-haspopup={onNew ? "menu" : undefined}
          >
            <Icon name="add" />
          </button>
        )}

        <span className="tab-spacer" />
        {/* The pane's own controls, as one block, because the block is what
            stays put: the strip scrolls sideways once the tabs outgrow it, and
            these used to scroll away with them. On a phone that is the menu
            gone — two tabs is enough to lose it — and the menu is the only way
            to the other panes there. It is pinned in the stylesheet rather than
            here; what this grouping does is give it something to pin.

            Two buttons, the same two at every width: the menu, and the one
            thing that should never be behind a menu. There were four here for a
            while — two splits, the switcher and close — and a corner that holds
            every control a pane will ever grow is a corner that runs out of
            room; `paneMenu` is the list that does not. */}
        <span className="tab-actions">
          <PaneMenuButton solo={solo} onOpen={onMenu} />
          <button
            className="pane-btn"
            onClick={() => api.closePane(pane.id)}
            title="Close this pane and everything in it (C-a x)"
            aria-label="Close pane"
          >
            <Icon name="close" />
          </button>
        </span>
      </header>

      <div className="pane-body">
        {pane.reader ? (
          <ReaderView paneId={pane.id} reader={pane.reader} />
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
        {takesZones && <DropZones paneId={pane.id} reader={Boolean(pane.reader)} />}
      </div>
    </section>
  );
}

/**
 * The corner button, and everything a pane can do behind it.
 *
 * The count — `2/3` — is printed only where the other panes are off screen,
 * which is the whole of what it was ever for: a button that only opened a menu
 * would leave a phone with nothing on screen saying the other panes exist at
 * all, and "there is more of this window somewhere" is most of the work it does.
 * On a tiled window they are right there in their own boxes, so the number would
 * be a label for something the eye has already counted, and the corner spends
 * the width on the terminal instead.
 *
 * The `panes` glyph for both, and not a hamburger or an ellipsis: what is behind
 * it is *this pane and its neighbours*, which is a subject rather than a
 * category, and the set already has a drawing that means exactly that. A skin
 * that restyles `panes` restyles the corner on both platforms at once — one
 * icon, one meaning, and nothing new for a future skin to answer for.
 *
 * The menu is anchored to the button's *left* edge and allowed to run off the
 * side, because `Popover` already clamps it back inside the window — which at
 * this width right-aligns it under a button that is itself against the right
 * edge. Naming the corner here instead would be a second thing to keep in step
 * with the first.
 */
function PaneMenuButton({ solo, onOpen }: { solo: SoloAt | null; onOpen: (at: MenuAt) => void }) {
  return (
    <button
      className={`pane-btn ${solo ? "pane-switch" : ""}`}
      title="This pane: split it, open a document, go to another"
      aria-label={solo ? `Pane ${solo.index + 1} of ${solo.count}. Pane menu` : "Pane menu"}
      aria-haspopup="menu"
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        onOpen({ x: box.left, y: box.bottom + 4 });
      }}
    >
      <Icon name="panes" />
      {solo && (
        <span className="pane-switch-count">
          {solo.index + 1}/{solo.count}
        </span>
      )}
    </button>
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
function DropZones({ paneId, reader }: { paneId: string; reader: boolean }) {
  const dragging = useDragging();
  const [over, setOver] = useState<string | null>(null);
  /**
   * The middle means "into this pane", and a tab only goes into a pane of its
   * own kind. Over the other kind there is no middle to light up at all —
   * the edges still take it, as a new pane of the kind it is.
   */
  const center =
    dragging?.kind === "pane" || (dragging?.kind === "doc" ? reader : dragging?.kind === "agent" ? !reader : false);

  const act = (name: string) => (event: React.DragEvent) => {
    const doc = parseDocId(event.dataTransfer.getData(DOC_MIME));
    if (doc) {
      if (name === "center") return reader && api.moveDoc(doc.paneId, doc.index, paneId);
      const [dir, before] = EDGES[name]!;
      return api.splitWithDoc(doc.paneId, doc.index, paneId, dir, before);
    }
    const agentId = event.dataTransfer.getData(AGENT_MIME);
    if (agentId) {
      // A terminal into a reader's middle would be a terminal in a reader.
      if (name === "center") return !reader && api.moveTab(agentId, paneId);
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
      {center && <div {...zone("center")} />}
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
 * A reader's strip: its documents as tabs, and whether it is still listening.
 *
 * A tab's name comes from the path rather than from the document's own first
 * heading, which the server does send. A strip should say which file you are
 * looking at — two notes both titled "Notes" are a strip that has stopped
 * telling you anything.
 *
 * The tabs behave as a terminal pane's do, because a tab that looks like one
 * and cannot be picked up is a tab that lies about what it is: drag one along
 * the strip to reorder it, onto another reader to move it there, or onto any
 * pane's edge to give it a reader of its own. The drop handling is the pane's
 * (`Pane`), shared with terminal tabs; this only says where each tab is.
 *
 * The one control is the editor toggle, on a reader that has an editor to
 * follow. The file tree is not a reader's to open, so its door is in the pane
 * menu and the status bar rather than on every reader's strip.
 */
function ReaderStrip({
  pane,
  dropAt,
  onOver,
  onDrop,
  onDragEnd,
}: {
  pane: PaneState;
  dropAt: number | null;
  onOver: (event: React.DragEvent, index: number) => void;
  onDrop: (event: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const reader = pane.reader;
  if (!reader) return null;
  const following = reader.follow !== null;
  return (
    <>
      {reader.docs.map((doc, index) => {
        const on = doc.root === reader.root && doc.path === reader.path;
        return (
          <Fragment key={`${doc.root}/${doc.path}`}>
            {dropAt === index && <span className="tab-insert" aria-hidden="true" />}
            <button
              className={`tab tab-doc ${on ? "tab-on" : ""}`}
              onClick={() => !on && api.selectDoc(pane.id, index)}
              title={`${doc.root}/${doc.path}`}
              draggable
              onDragStart={(event) => beginDrag(event, "doc", docId(pane.id, index))}
              onDragEnd={() => {
                endDrag();
                onDragEnd();
              }}
              onDragOver={(event) => onOver(event, index)}
              onDrop={onDrop}
            >
              <span className="tab-label">{basename(doc.path)}</span>
              <span
                className="tab-close"
                role="button"
                tabIndex={-1}
                aria-label="Close tab"
                title="Close this document"
                onClick={(event) => {
                  event.stopPropagation();
                  api.closeDoc(pane.id, index);
                }}
              >
                <Icon name="close" />
              </span>
            </button>
          </Fragment>
        );
      })}
      {dropAt === reader.docs.length && <span className="tab-insert" aria-hidden="true" />}
      {reader.docs.length === 0 && (
        <span className="tab tab-on tab-reader" title="Waiting for the editor to open a markdown file">
          <span className="tab-label">{following ? "waiting for the editor" : "reader"}</span>
        </span>
      )}
      {/* Only for a reader that has an editor to go back to. One opened from the
          tree never had one, and a follow button with nobody to follow was the
          button that did nothing when you clicked it. */}
      {reader.editor && (
        <button
          className={`pane-btn ${following ? "pane-btn-on" : ""}`}
          onClick={() => api.pinReader(pane.id, !following)}
          aria-pressed={following}
          title={
            following
              ? "Following the editor: this pane shows whatever markdown its nvim opens. Click to stay on this file."
              : "Staying on this file. Click to follow the editor again."
          }
          aria-label={following ? "Stop following the editor" : "Follow the editor"}
        >
          <Icon name="follow" />
        </button>
      )}
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
