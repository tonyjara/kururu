/**
 * Everything in this profile: its workspaces, and every terminal running in it.
 *
 * Two lists rather than a tree, and that is deliberate. The workspaces are the
 * structure — numbered, because prefix+1..9 jump to them and a number you cannot
 * see is a shortcut you do not use. The agents are flat and workspace-tagged,
 * because an agent is the thing you go looking for across a whole session, not
 * inside one layout: "where did the one that finished go" is a question about a
 * profile, not about a split tree.
 *
 * Clicking an agent shows it — the pane it is in, the tab it is on, focused. It
 * never rearranges anything to do so. *Dragging* one does: onto a pane it moves
 * there, onto a workspace row it moves to that workspace. Which makes this list
 * the way to get at a terminal that is somewhere you are not currently looking,
 * without having to go there first.
 *
 * Dropping one on another *row* is the third of those and the only one that
 * moves nothing: it rearranges the list itself. Spawn order never moves under
 * you, which is what makes it a good default and a poor arrangement — the two
 * agents you are alternating between this afternoon started an hour apart, and
 * the layout cannot put them next to each other because it answers where a
 * terminal is drawn, not where it is listed. The order is the profile's (see
 * `Profile.agentOrder`), so a phone and a desktop hold the same one.
 *
 * A workspace row also answers the two gestures every list of named things
 * answers: double-click renames it in place, and right-click opens the menu of
 * what else can be done to it. Both are second doors onto the prefix keymap
 * rather than a second implementation — the rename sends the same message
 * prefix+W does — and they exist because a keymap is worth nothing until it has
 * been learnt, and a row has no room to print five buttons.
 */
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { panes } from "../../../shared/layout";
import type {
  AgentSnapshot,
  ContextUsage,
  MascotSet,
  Profile,
  WorkspaceColor,
} from "../../../shared/model";
import { defaultMascot, mascotFor, WORKSPACE_COLORS } from "../../../shared/model";
import { colorValue, colorValues } from "../colors";
import { AGENT_MIME, WORKSPACE_MIME, allowDrop, beginDrag, endDrag, useDragging } from "../drag";
import type { Action } from "../keys";
import { agentLabel, agentSummary, shortenPath } from "../labels";
import { previewLabel, previewUrl } from "../preview";
import * as api from "../session";
import { useKururu } from "../session";
import { limitLabel, limitTitle, resetIn, staleTitle } from "../usage";
import { Menu, Popover } from "./Menu";
import { Icon } from "./Icon";
import { Mascot, Status } from "./Status";

/**
 * How far the pointer may travel between `dragstart` and `dragend` for the
 * gesture to still count as a click, in pixels.
 *
 * It exists because of one thing the platform does and will not be talked out
 * of: a `draggable` element starts a drag after about three pixels of movement
 * with the button down, and **once a drag has started no `click` is dispatched
 * at all**. A workspace row is draggable, because dragging one reorders the
 * list — so a press that wobbled, which on a trackpad is most of them, silently
 * did nothing whatsoever. It is not even a drag that went somewhere: a row
 * dropped on itself is refused as a target (see the `dragover` below), so the
 * whole gesture ends in `dragend` with nothing done and nothing said.
 *
 * So the drag that went nowhere is read back as what it was. Comfortably larger
 * than the platform's own threshold, because the failure it is catching is a
 * hand that did not mean to move at all, and well under the distance to the
 * next row — which is the only gesture on the other side of it.
 */
const CLICK_SLOP = 12;

interface Props {
  profile: Profile;
  agents: AgentSnapshot[];
  connected: boolean;
  /** What the working badge animates; drawn here, owned by the server. */
  mascots: MascotSet;
  /**
   * The terminal the keyboard is pointed at, or null when the focused pane is
   * empty. Marked rather than merely listed: a sidebar of six agents otherwise
   * says nothing about which of them the next keystroke belongs to, and that is
   * the single most useful fact on the row.
   */
  focusedAgentId: string | null;
  /** The same table the keyboard runs, so a button and its shortcut cannot differ. */
  onRun: (action: Action) => void;
  /**
   * The profile button, handed up so the app can hang a menu off it.
   *
   * The menu is the app's — `switch-profile` opens it, and that action has a key
   * as well as this button — but *where* it goes is a fact about a button only
   * this file draws. A ref is the whole of what has to cross: the click still
   * goes through `onRun` like every other control in here, so there is one door
   * and two ways of knocking on it.
   */
  profileRef: RefObject<HTMLButtonElement | null>;
  /**
   * Deleting a workspace ends every terminal in it, so the confirmation belongs
   * to the app rather than to this list — it is the same dialog prefix+X puts up.
   */
  onDeleteWorkspace: (workspaceId: string) => void;
  /**
   * Say when a name is being typed in here, because the prefix has to stand
   * down for it: ctrl+a is select-all in a text field, and an armed prefix would
   * swallow the next letter as a command.
   */
  onEditing: (editing: boolean) => void;
  /** Opens the settings dialog. The corner is the only way in. */
  onSettings: () => void;
  /** Opens the phone dialog — the addresses this server answers at, as QR codes. */
  onReach: () => void;
  /**
   * Whether this is a column beside the panes or a screen in front of them.
   *
   * The second is what a narrow window gets, and it changes two things about how
   * the list behaves rather than only how it looks — which is why it is a prop
   * and not left entirely to the stylesheet. It draws a way out, because there
   * is no longer a pane next to it to click on; and picking something in it puts
   * it away, because on a phone the whole point of picking is to go and *look*
   * at the thing, and a list still covering it would mean two gestures for one
   * intention.
   */
  overlay: boolean;
  /** Put the sidebar away. Only ever drawn while `overlay`. */
  onClose: () => void;
  /** A width the drag handle is proposing, in pixels. The app clamps it. */
  onResize: (px: number) => void;
  /** Double-clicking the handle: back to the width it shipped at. */
  onResetWidth: () => void;
}

export function Sidebar({
  profile,
  agents,
  connected,
  mascots,
  focusedAgentId,
  onRun,
  profileRef,
  onDeleteWorkspace,
  onEditing,
  onSettings,
  onReach,
  overlay,
  onClose,
  onResize,
  onResetWidth,
}: Props) {
  const dragging = useDragging();
  /**
   * What each workspace has checked out.
   *
   * Read from the store here rather than threaded down as a prop, on the same
   * call `DevServers` below makes: this is a fact about the machine that only
   * the sidebar draws, and passing it through the app would mean two components
   * knowing about it so that one of them could forget.
   */
  const { branches } = useKururu();
  const heads = new Map(branches.map((head) => [head.workspaceId, head] as const));
  /** The workspace row a drop would land on, while something is over it. */
  const [overWorkspace, setOverWorkspace] = useState<string | null>(null);
  /**
   * Where a dragged terminal would land in the agent list: the row it is over,
   * and which side of that row's midpoint the pointer is on.
   *
   * A line between two rows rather than a highlight on one, for the reason the
   * tab strip draws one: a glow on a row says "into this", and a reorder does
   * not go *into* anything. Held as state because `dataTransfer` cannot be read
   * on `dragover` — see `web/src/drag.ts` — so what is drawn on the way and what
   * happens on the drop are worked out twice, from the geometry both times.
   */
  const [overAgent, setOverAgent] = useState<{ id: string; after: boolean } | null>(null);
  /**
   * Whether the drawer of put-away agents is open.
   *
   * The one piece of the list that is *not* the server's, and deliberately: a
   * disclosure is a thing you do with your eyes for as long as you are looking,
   * not an arrangement two clients have to agree about. A phone opening the
   * drawer to find something and leaving it open would otherwise be a phone
   * that reached over and undid the tidying on the desktop.
   */
  const [drawer, setDrawer] = useState(false);
  /** The workspace whose name is being typed, if any. */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Where a context menu is open, and which row it belongs to. */
  const [menu, setMenu] = useState<{ workspaceId: string; x: number; y: number } | null>(null);
  /** Where the colour picker is open, and whose colour it is setting. */
  const [picker, setPicker] = useState<{ workspaceId: string; x: number; y: number } | null>(null);
  /** The same, for the mascot. Two states rather than one with a mode in it,
      because only one of them can be open and neither cares about the other. */
  const [mascotPicker, setMascotPicker] = useState<{ workspaceId: string; x: number; y: number } | null>(
    null,
  );
  /**
   * Escape cancels a rename by blurring the field, which is also how enter and
   * clicking away commit one — so the commit lives in `blur` and this is what
   * tells it which of the three just happened.
   */
  const cancelled = useRef(false);
  /**
   * Where a workspace drag started, so `dragend` can tell a reorder from a
   * click the platform turned into a drag. See `CLICK_SLOP`.
   */
  const dragFrom = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    onEditing(renaming !== null);
    // Also on unmount: a sidebar hidden mid-rename must not leave the keyboard
    // switched off with nothing on screen to explain why.
    return () => onEditing(false);
  }, [renaming, onEditing]);

  /** Where each agent lives, so a row can say which workspace to look in. */
  const where = new Map<
    string,
    { workspaceId: string; workspace: string; paneId: string; index: number; mascotId: string | null }
  >();
  for (const workspace of profile.workspaces) {
    for (const pane of panes(workspace.layout)) {
      pane.agentIds.forEach((agentId, index) => {
        where.set(agentId, {
          workspaceId: workspace.id,
          workspace: workspace.name,
          paneId: pane.id,
          index,
          // Carried here rather than looked up at the row, because the row
          // already has this entry and a second search per agent per render to
          // find a workspace we have just walked past would be silly.
          mascotId: workspace.mascotId,
        });
      });
    }
  }

  /**
   * Agents, and only agents. The list is headed "Agents" and a terminal you
   * opened to run `ls` in is not one — with six of those in a profile the
   * shells are most of the list and none of them is what you came looking for.
   *
   * The test is "has an agent ever been seen in here", not "is one running right
   * now", and the difference is the whole reason `lastAgent` exists. Detection
   * is a poll of the process table, so the live answer blinks off between one
   * thing and the next; filtering on it alone would drop rows and put them back
   * while you were reading them. It also keeps an *exited* agent listed, which is
   * not a nicety — its screen is the only record of what it said, and the ✕ on
   * its row is the only way to dismiss it.
   *
   * Nothing becomes unreachable: every terminal is still in its tab strip, and
   * prefix+a still finds all of them by name.
   */
  const listed = agents.filter((agent) => agent.agent || agent.lastAgent);

  /**
   * And of those, the ones the list is currently showing.
   *
   * Put away is not closed and not killed: the pty is running, its tab is where
   * it was, prefix+a still finds it, and a notification it earns is still
   * delivered. What it is out of is this list — which is the one thing in kururu
   * that spans a whole profile, and therefore the one thing that gets long
   * enough to want a drawer.
   *
   * Filtered here against what is actually running rather than pruned when a
   * terminal ends, on `orderAgents`' bargain: an id naming nothing costs one
   * `has` per row, and tidying it away would cost a write per snapshot.
   */
  const away = new Set(profile.hiddenAgents);
  const shown = listed.filter((agent) => !away.has(agent.id));
  const hidden = listed.filter((agent) => away.has(agent.id));

  /**
   * Which colour each workspace is wearing, so an agent row can rule a line in
   * the colour of the workspace it lives in without walking the tree again.
   */
  const tint = new Map(profile.workspaces.map((w) => [w.id, colorValue(w.color)] as const));

  /** The row an open menu belongs to, and where it sits in the list. */
  const menuAt = menu ? profile.workspaces.findIndex((w) => w.id === menu.workspaceId) : -1;
  const menuWorkspace = menuAt === -1 ? null : profile.workspaces[menuAt]!;

  /**
   * A gesture in here has gone and changed what the panes are showing.
   *
   * Which matters only while this is an overlay: the list is then covering the
   * thing it just took you to, and leaving it up would make "show me that
   * agent" a two-tap job with the second tap being housekeeping. As a column it
   * does nothing at all — putting the sidebar away every time you switched
   * workspace on a desktop would be the app tidying up after you.
   */
  const navigated = () => {
    if (overlay) onClose();
  };

  /**
   * Go to a workspace, from whichever of the two gestures it was.
   *
   * Two, because a row is clicked and a row is also dragged, and the platform
   * decides which of those happened on a threshold no design can see — see
   * `CLICK_SLOP`.
   */
  const goTo = (workspaceId: string) => {
    api.switchWorkspace(workspaceId);
    navigated();
  };

  const show = (agentId: string) => {
    const at = where.get(agentId);
    if (!at) return;
    if (at.workspaceId !== profile.activeWorkspaceId) api.switchWorkspace(at.workspaceId);
    api.focusPane(at.paneId);
    api.selectTab(at.paneId, at.index);
    navigated();
  };

  /**
   * One row of the agent list, drawn the same whichever of the two lists it is
   * in: the list proper, and the drawer of the ones put away. One function
   * rather than two, because a row in the drawer is the same row — the same
   * status mark, the same activity line, the same drag onto a pane — and a
   * second copy would be the copy that stopped saying what the first one says.
   *
   * What differs is `reorderable`, which is also what says which list this is.
   * The drawer is a drawer and not an arrangement, so it takes no drop of its
   * own: dragging a row *out* of it still moves that terminal, because that is
   * a gesture about a pane and not about a list.
   */
  const agentRow = (
    agent: AgentSnapshot,
    list: AgentSnapshot[],
    index: number,
    reorderable: boolean,
  ) => {
    const hiddenHere = !reorderable;
    const at = where.get(agent.id);
    const focused = agent.id === focusedAgentId;
    const bar = at ? tint.get(at.workspaceId) : null;
    /* Which row a drop here would put the dragged one above. The row below this one when
       the pointer is past the midpoint, and nothing at all at the bottom of the list —
       which is the end of it. The list is agents only, so "the next row" is the next one
       somebody can see; a shell sitting between the two in spawn order is not something
       this list has ever drawn. */
    const insertBefore = (after: boolean): string | null =>
      after ? (list[index + 1]?.id ?? null) : agent.id;
    const insert = overAgent?.id === agent.id ? overAgent : null;
    return (
      <li
        key={agent.id}
        className={[
          "agent-item",
          focused ? "agent-item-on" : "",
          insert ? (insert.after ? "agent-under" : "agent-over") : "",
        ]
          .filter(Boolean)
          .join(" ")}
        /* The rule down the left is the workspace's colour. It is a variable rather than
           a border set here so the untagged case still reserves the two pixels: rows that
           shift sideways when a colour is assigned would make the list jump under the
           cursor. */
        style={bar ? ({ "--tag": bar } as React.CSSProperties) : undefined}
        /* Only a terminal, and never the one in flight: a row dropped on itself is a drag
           somebody changed their mind about, and it should read as nothing happening
           rather than as a refusal. A pane or a workspace dropped here means nothing, so
           the row does not light up for one. */
        onDragOver={(event) => {
          if (!reorderable || dragging?.kind !== "agent" || dragging.id === agent.id) return;
          allowDrop(event);
          const box = event.currentTarget.getBoundingClientRect();
          const after = event.clientY > box.top + box.height / 2;
          setOverAgent((current) =>
            current?.id === agent.id && current.after === after
              ? current
              : { id: agent.id, after },
          );
        }}
        onDragLeave={(event) => {
          // `dragleave` fires when the pointer crosses onto a *child* of this row as well
          // as when it leaves it, and the row is a button with spans in it — so an
          // unguarded handler blinks the line off every time the pointer moves within the
          // row it is aimed at, until the next `dragover` puts it back.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setOverAgent((current) => (current?.id === agent.id ? null : current));
        }}
        onDrop={(event) => {
          if (!reorderable) return;
          const dragged = event.dataTransfer.getData(AGENT_MIME);
          setOverAgent(null);
          if (!dragged || dragged === agent.id) return;
          event.preventDefault();
          // The sidebar is inside a window that swallows stray file drops, and a pane
          // underneath would otherwise be offered a drop the list has already dealt with.
          event.stopPropagation();
          const box = event.currentTarget.getBoundingClientRect();
          api.reorderAgent(dragged, insertBefore(event.clientY > box.top + box.height / 2));
        }}
      >
        <button
          className={`agent-row ${agent.exited ? "agent-row-exited" : ""}`}
          onClick={() => show(agent.id)}
          title={[agentLabel(agent), agentSummary(agent), agent.command, agent.cwd]
            .filter(Boolean)
            .join("\n")}
          draggable
          onDragStart={(event) => beginDrag(event, "agent", agent.id)}
          /* `dragend` fires wherever the drag finished, including nowhere, which is why
             the line is cleared here as well as on the drop. */
          onDragEnd={() => {
            setOverAgent(null);
            endDrag();
          }}
        >
          {/* Where it lives and what it is. The two things you need to find it again, and
              nothing that changes while you read.

              Where first, because that is what you are scanning for: the list spans a
              whole profile and holds several terminals running the same program, so
              "claude" is the word that tells you least about which row this is. The
              program is still worth saying — the list runs more than one of them — so it
              goes where the workspace used to be, at the end of the line and dimmer, as
              the thing you read once you have found the row rather than the thing you
              find it by. */}
          <span className="agent-top">
            {/* The agent's own workspace, not the one you are looking at: this list spans
                the whole profile, so two rows of it can legitimately be wearing different
                mascots. */}
            <Status agent={agent} mascot={mascotFor(mascots, at?.mascotId ?? null)} />
            <span className="agent-ws">{at ? at.workspace : "—"}</span>
            {/* Not "new output" any more, which it was and which lit nine rows in ten:
                this is the turn that ended, or the question that was asked, while you
                were not looking at it. The server decides it — see its `unread`. */}
            {agent.unread && <span className="unread" aria-label="waiting for you" />}
            <span className="agent-name">{agentLabel(agent)}</span>
          </span>
          {/* What it is doing, what it is costing, and how much room it has left to do it
              in. All three change constantly, which is why they are on their own line:
              a row whose top half is stable is a row you can find something in without
              re-reading it.

              The cwd stands in only when nothing has said anything at all — no hook has
              reported and the program has not named its own window. An unreported agent
              would otherwise have a blank line under it saying nothing, and where it is
              working is the next most useful thing we know for certain. */}
          <span className="agent-bottom">
            <span className="agent-activity">
              {agentSummary(agent) || shortenPath(agent.cwd)}
            </span>
            {agent.rss ? <Memory bytes={agent.rss} /> : null}
            {agent.contextUsage && <ContextRing usage={agent.contextUsage} />}
          </span>
        </button>
        {/* The two things you can do to a row without going and looking at it, in the
            corner, in the order of what they cost. Putting one away is a decision about
            this list; the ✕ beside it ends a process. They are one flex box rather than
            two absolutely-placed corners, so that adding the first did not mean knowing
            how wide the second is under every skin. */}
        <span className="agent-tools">
          <button
            className="agent-tool agent-away"
            onClick={() => api.hideAgent(agent.id, !hiddenHere)}
            title={
              hiddenHere
                ? "Put back in the list"
                : "Hide this row — the agent keeps running"
            }
            aria-label={hiddenHere ? "Show" : "Hide"}
          >
            <Icon name="hide" />
          </button>
          <button
            className="agent-tool agent-kill"
            onClick={() => api.closeTab(agent.id)}
            title={agent.exited ? "Remove this tab" : "End this agent and close its tab"}
            aria-label={agent.exited ? "Dismiss" : "Kill"}
          >
            <Icon name="close" />
          </button>
        </span>
      </li>
    );
  };

  return (
    <aside className={`sidebar ${overlay ? "sidebar-overlay" : ""}`}>
      {/* The strip the traffic lights sit in.
          The window is `titleBarStyle: "hiddenInset"`, so macOS floats its close,
          minimise and zoom buttons over this corner and gives us no title bar to
          drag the window by. This is both answers at once: it is the drag handle,
          and it is the space the buttons are standing in.

          It used to be the profile row itself, with 78px of left padding to get
          out of their way — which put the profile name in the gap beside three
          system buttons, in a row it did not fill, wearing an indent that
          belonged to something else. So the strip is now empty and the profile
          name has a line of its own underneath it, where it can start at the same
          left edge every other row in the sidebar starts at.

          Empty, and therefore drawn only in the Electron window: in a browser tab
          — which is what the phone loads — there is nothing floating over this
          corner and the strip would be thirty pixels of nothing at the top of the
          screen. `app-window` on the root is what says which of the two this is. */}
      <div className="sidebar-drag" aria-hidden="true" />

      <header className="sidebar-head">
        <span
          className={`dot ${connected ? "dot-on" : "dot-off"}`}
          title={connected ? "connected" : "reconnecting…"}
        />
        {/* The name is where you change profile, and it says so: a menu hangs off
            it with every profile in it, because switching is navigation and
            navigation wants to be one click from wherever you already are.
            Editing one is a different job and lives in Settings, which the last
            item in that menu goes to. See `switch-profile` in App.tsx. */}
        <button
          ref={profileRef}
          className="profile-btn"
          onClick={() => onRun("switch-profile")}
          title="Profiles (C-a s)"
        >
          {profile.name}
          <Icon name="caret" className="profile-caret" />
        </button>
        {/* The way out of a full-screen sidebar. Drawn only when it is one: as a
            column, the panes next to it are already the way out, and a close
            button beside a thing with a keyboard shortcut and a status-bar
            toggle would be a third door onto a two-door room. */}
        {overlay && (
          <button className="sidebar-close" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" />
          </button>
        )}
      </header>

      <section className="side-section">
        <h2>
          Workspaces
          <button className="mini" onClick={() => onRun("new-workspace")} title="New workspace (C-a C)" aria-label="New workspace">
            <Icon name="add" />
          </button>
        </h2>
        <ul className="ws-list">
          {profile.workspaces.map((workspace, index) => {
            const head = heads.get(workspace.id);
            return (
            <li
              key={workspace.id}
              className={`ws-item ${workspace.id === profile.activeWorkspaceId ? "ws-item-on" : ""} ${
                overWorkspace === workspace.id ? "ws-over" : ""
              }`}
              /* The rail down the left edge, in this workspace's colour — the
                 same `--tag` every agent living in here wears, so the sidebar
                 says which agents belong to which workspace by lining them up
                 rather than by making anybody read two lists. */
              style={
                colorValue(workspace.color)
                  ? ({ "--tag": colorValue(workspace.color)! } as CSSProperties)
                  : undefined
              }
              /* The whole row, both lines of it, and not the name's button.
                 The button was the target for as long as a row *was* the name;
                 splitting the second line out left a strip along the bottom of
                 every row that lit up on hover like the rest of it and did
                 nothing when pressed — the branch, and the gap either side of
                 it, are a third of the height of a row you are aiming at.

                 A click that landed on the swatch is not this: it means
                 something else, and a workspace switch riding along behind it
                 would be a side effect nobody asked for. The name's button is the
                 exception rather than being listed, because it *is* this
                 gesture — which also keeps it working from the keyboard, where
                 Enter on the focused button produces exactly this click. */
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("button:not(.ws-row), input")) return;
                goTo(workspace.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ workspaceId: workspace.id, x: event.clientX, y: event.clientY });
              }}
              /* Two things can land on a workspace row: a terminal, which moves
                 to that workspace, and another workspace, which reorders the
                 list. The drag store says which without opening the payload. */
              onDragOver={(event) => {
                // A whole pane is not something a workspace row knows what to do
                // with, so it does not offer to take one.
                if (dragging?.kind !== "agent" && dragging?.kind !== "workspace") return;
                if (dragging.kind === "workspace" && dragging.id === workspace.id) return;
                allowDrop(event);
                setOverWorkspace(workspace.id);
              }}
              onDragLeave={() =>
                setOverWorkspace((current) => (current === workspace.id ? null : current))
              }
              onDrop={(event) => {
                event.preventDefault();
                setOverWorkspace(null);
                const agentId = event.dataTransfer.getData(AGENT_MIME);
                if (agentId) return api.moveTabToWorkspace(agentId, workspace.id);
                const moved = event.dataTransfer.getData(WORKSPACE_MIME);
                if (moved) api.moveWorkspace(moved, index);
              }}
            >
              {renaming === workspace.id ? (
                <input
                  className="ws-edit"
                  defaultValue={workspace.name}
                  autoFocus
                  onFocus={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {
                    // The app listens on window in the capture phase, so this
                    // stops nothing it does; it is here for anything between.
                    event.stopPropagation();
                    if (event.key === "Escape") cancelled.current = true;
                    if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
                  }}
                  onBlur={(event) => {
                    // Blur is the exit every path goes through, so the commit
                    // lives here and escape's only job is to say it was not one.
                    // An empty name is refused by the server and hands the
                    // workspace back the name it had.
                    if (!cancelled.current) api.renameWorkspace(workspace.id, event.currentTarget.value);
                    cancelled.current = false;
                    setRenaming(null);
                  }}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Workspace name"
                />
              ) : (
                <>
                  <button
                    className={`ws-row ${workspace.id === profile.activeWorkspaceId ? "ws-row-on" : ""}`}
                    onDoubleClick={() => setRenaming(workspace.id)}
                    title={index < 9 ? `C-a ${index + 1} \u00b7 double-click to rename` : "Double-click to rename"}
                    draggable
                    onDragStart={(event) => {
                      dragFrom.current = { x: event.clientX, y: event.clientY };
                      beginDrag(event, "workspace", workspace.id);
                    }}
                    /* A drag that ended where it began was a click the platform
                       took off us, so it is handed back — see `CLICK_SLOP`.
                       Only when the drag did nothing: `dropEffect` is "move"
                       when a row accepted it, and switching to a workspace
                       somebody had just finished dragging somewhere else would
                       be answering a gesture with a different one. */
                    onDragEnd={(event) => {
                      const from = dragFrom.current;
                      dragFrom.current = null;
                      endDrag();
                      setOverWorkspace(null);
                      if (!from || event.dataTransfer.dropEffect !== "none") return;
                      const moved = Math.hypot(event.clientX - from.x, event.clientY - from.y);
                      if (moved <= CLICK_SLOP) goTo(workspace.id);
                    }}
                  >
                    <span className="ws-index">{index < 9 ? index + 1 : "\u00b7"}</span>
                    <span className="ws-name">{workspace.name}</span>
                  </button>

                  {/* The colour, as a control, at the end of the name's line.
                      What the colour *is* is said by the rail down the left of
                      the row — the same two pixels every agent in this
                      workspace wears, which is the thing that makes the
                      connection. This is the way to change it, and it is drawn
                      even when untagged, as an empty ring, because a control
                      that only appears once it has been used is one nobody
                      finds.

                      Outside the row's own button rather than inside it: a
                      button inside a button is not a thing the platform will
                      give you. */}
                  <button
                    className={`ws-swatch ${workspace.color ? "" : "ws-swatch-off"}`}
                    style={
                      colorValue(workspace.color)
                        ? { background: colorValue(workspace.color)! }
                        : undefined
                    }
                    onClick={(event) => {
                      const box = event.currentTarget.getBoundingClientRect();
                      setPicker({ workspaceId: workspace.id, x: box.left, y: box.bottom + 4 });
                    }}
                    title={workspace.color ? `Colour: ${workspace.color}` : "Set a colour"}
                    aria-label={workspace.color ? `Colour: ${workspace.color}` : "Set a colour"}
                  />

                  {/* What is checked out where this workspace works, on a line
                      of its own under the name — and only when there is one, so
                      a workspace outside a repository is a single line rather
                      than a name with a blank under it.

                      Text rather than a button, because there is nothing
                      useful to do to it from here — switching branch under a
                      running agent is a thing to do in the terminal, where you
                      can see what it says. In the mono face for the reason a
                      shell prompt uses one: it makes a word that could be
                      anything read as a ref. It clips rather than wrapping,
                      because branch names are somebody else's length. */}
                  {head && (
                    <span
                      className={`ws-branch ${head.detached ? "ws-branch-off" : ""}`}
                      title={
                        head.detached
                          ? `Detached at ${head.branch}\n${head.root}`
                          : `Branch: ${head.branch}\n${head.root}`
                      }
                    >
                      {head.branch}
                    </span>
                  )}
                </>
              )}
            </li>
            );
          })}
        </ul>
      </section>

      <section className="side-section side-agents">
        <h2>Agents</h2>
        <ul className="agent-list">
          {shown.length === 0 && (
            <li className="muted sidebar-empty">
              {!connected
                ? "Reconnecting…"
                : /* An empty list with a full drawer is the one case that must
                     not say "nothing running": everything is running, and the
                     line under this one is where it went. */
                  hidden.length > 0
                  ? "All of them are put away."
                  : agents.length > 0
                    ? "No agents yet — run one in a terminal."
                    : "Nothing running."}
            </li>
          )}
          {shown.map((agent, index) => agentRow(agent, shown, index, true))}
        </ul>

        {/* The drawer. Drawn only when there is something in it, because a
            permanent "Hidden (0)" would be a row of chrome saying that a
            feature exists — and the way this one is found is by having used
            the button on a row, which is the only place it can be used from.

            The count is on the closed drawer for the reason a folder shows
            one: what is put away is still yours, and a drawer that said only
            "Hidden" would need opening to answer how much. The unread mark is
            there for the sharper version of the same thing — an agent that has
            said something since you put it away is the one case where the
            drawer has to be able to get your attention while shut. */}
        {hidden.length > 0 && (
          <div className="agent-drawer">
            <button
              className="agent-drawer-head"
              onClick={() => setDrawer((open) => !open)}
              aria-expanded={drawer}
              title={drawer ? "Close the drawer" : "Show the agents you have put away"}
            >
              <Icon name="caret" className={drawer ? "" : "drawer-caret-shut"} />
              <span>Hidden</span>
              <span className="agent-drawer-n">{hidden.length}</span>
              {hidden.some((agent) => agent.unread) && (
                <span className="unread" aria-label="new output" />
              )}
            </button>
            {drawer && (
              <ul className="agent-list agent-list-drawer">
                {hidden.map((agent, index) => agentRow(agent, hidden, index, false))}
              </ul>
            )}
          </div>
        )}
      </section>

      <Usage />
      <DevServers />

      {/* A new terminal used to be a button down here and is not one any more:
          the tab strip's `+` is in the place you are already looking when you
          want another tab, and C-a T and ⌘T are how it actually gets opened.
          What the corner is for instead is the thing with no other door. */}
      <div className="sidebar-foot">
        <button className="cog" onClick={onSettings} title="Settings" aria-label="Settings">
          <Icon name="settings" />
        </button>
        {/* Beside the cog rather than in it: getting kururu onto a phone is a
            thing you do at the start of a session, not a preference you set —
            and it is the one gesture in the app with no keyboard door, because
            the answer to it is a picture you have to be looking at. */}
        <button
          className="cog"
          onClick={onReach}
          title="Open on your phone"
          aria-label="Open on your phone"
        >
          <Icon name="share" />
        </button>
      </div>

      {/* The edge you drag. Last in the tree and absolutely positioned, so it
          sits over the border rather than taking a column of its own — a handle
          that occupied layout would make the sidebar two pixels wider than the
          width it was told to be, and the arithmetic would be wrong in exactly
          the way nobody looks for. */}
      {!overlay && <Resizer onResize={onResize} onReset={onResetWidth} />}

      {menu && menuWorkspace && (
        <Menu
          at={menu}
          onClose={() => setMenu(null)}
          items={[
            /* First, because it is the one row here that goes somewhere: it
               switches to this workspace and shows its board, making one if it
               has never had one. `navigated` for the phone, where the sidebar
               is a sheet over the thing you just asked to see. */
            {
              label: "Open the board",
              run: () => {
                api.openBoard(undefined, false, menuWorkspace.id);
                navigated();
              },
            },
            { label: "Rename", sep: true, run: () => setRenaming(menuWorkspace.id) },
            {
              label: "Colour…",
              run: () => setPicker({ workspaceId: menuWorkspace.id, x: menu.x, y: menu.y }),
            },
            {
              label: "Mascot…",
              run: () => setMascotPicker({ workspaceId: menuWorkspace.id, x: menu.x, y: menu.y }),
            },
            {
              label: "Move up",
              disabled: menuAt === 0,
              run: () => api.moveWorkspace(menuWorkspace.id, menuAt - 1),
            },
            {
              label: "Move down",
              disabled: menuAt === profile.workspaces.length - 1,
              run: () => api.moveWorkspace(menuWorkspace.id, menuAt + 1),
            },
            { label: "New workspace", sep: true, run: () => onRun("new-workspace") },
            {
              label: "Delete",
              sep: true,
              danger: true,
              // The last workspace cannot go: there would be nowhere to be.
              disabled: profile.workspaces.length < 2,
              run: () => onDeleteWorkspace(menuWorkspace.id),
            },
          ]}
        />
      )}

      {mascotPicker && (
        <MascotPicker
          at={mascotPicker}
          mascots={mascots}
          current={
            profile.workspaces.find((w) => w.id === mascotPicker.workspaceId)?.mascotId ?? null
          }
          onPick={(mascotId) => {
            api.setWorkspaceMascot(mascotPicker.workspaceId, mascotId);
            setMascotPicker(null);
          }}
          onClose={() => setMascotPicker(null)}
        />
      )}

      {picker && (
        <ColorPicker
          at={picker}
          current={profile.workspaces.find((w) => w.id === picker.workspaceId)?.color ?? null}
          onPick={(color) => {
            api.setWorkspaceColor(picker.workspaceId, color);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </aside>
  );
}

/**
 * Fourteen swatches and a way back out of them.
 *
 * A grid rather than a list of colour names, because nobody picks "coral" — they
 * pick the one that is not the one the workspace above is wearing, and that is a
 * comparison you make by looking. The colour currently set is ringed rather than
 * ticked for the same reason: a tick would have to sit on top of the colour it
 * is describing.
 *
 * "None" is a swatch too, not a separate control. Clearing a tag is the same
 * kind of decision as changing it, and burying the undo of a thing one row lower
 * than the thing is how people end up with a palette they cannot get out of.
 */
function ColorPicker({
  at,
  current,
  onPick,
  onClose,
}: {
  at: { x: number; y: number };
  current: WorkspaceColor | null;
  onPick: (color: WorkspaceColor | null) => void;
  onClose: () => void;
}) {
  return (
    <Popover at={at} onClose={onClose} className="picker" role="listbox">
      <div className="picker-grid">
        {WORKSPACE_COLORS.map((color) => (
          <button
            key={color}
            role="option"
            aria-selected={current === color}
            className={`chip ${current === color ? "chip-on" : ""}`}
            style={{ background: colorValues()[color] }}
            title={color}
            aria-label={color}
            onClick={() => onPick(color)}
          />
        ))}
      </div>
      <button
        role="option"
        aria-selected={current === null}
        className={`picker-none ${current === null ? "picker-none-on" : ""}`}
        onClick={() => onPick(null)}
      >
        No colour
      </button>
    </Popover>
  );
}

/**
 * The sidebar's right-hand edge, as something you can take hold of.
 *
 * Deliberately the same shape as `DividerBar` in `Panes.tsx` — pointer capture
 * on the way down, a position read off the event on the way move, nothing
 * listening on `window` — because they are the same gesture and a second way of
 * writing it is a second set of bugs about pointers leaving the element
 * mid-drag. Capture is what makes the drag survive the pointer crossing into a
 * terminal, which it does immediately and every time.
 *
 * What it reports is a width, not a delta, and the difference matters when the
 * pointer runs past the clamp: a delta would keep accumulating off the end and
 * the sidebar would sit at its minimum for two hundred pixels of dragging back
 * before it moved. A width measured from the sidebar's own left edge has no
 * memory to get out of step.
 *
 * Double-click puts it back to the width it shipped at, which is the only
 * gesture that can — there is nothing else in the window that names a number,
 * and a sidebar dragged somewhere silly otherwise has to be dragged back by eye.
 */
function Resizer({ onResize, onReset }: { onResize: (px: number) => void; onReset: () => void }) {
  const onPointerDown = (event: React.PointerEvent) => {
    // The default here is a text selection that runs the length of the sidebar
    // and stays highlighted after the drop.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const box = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!box) return;
    onResize(event.clientX - box.left);
  };

  const release = (event: React.PointerEvent) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      className="sidebar-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={release}
      onDoubleClick={onReset}
    />
  );
}

/**
 * Which mascot this workspace's agents wear.
 *
 * Each one is drawn animating rather than named, for the same reason the colour
 * picker is swatches: you are choosing between pictures, and "Michi" means
 * nothing until you have seen it hop. The working clip is the one shown, since
 * that is the state you are actually looking for in a sidebar.
 *
 * "Default" is an option in the list rather than a way of dismissing it, the way
 * "No colour" is — following the default is a choice with consequences, namely
 * that changing the default later changes this workspace too, and a control that
 * only said how to *stop* following would hide that.
 */
function MascotPicker({
  at,
  mascots,
  current,
  onPick,
  onClose,
}: {
  at: { x: number; y: number };
  mascots: MascotSet;
  current: string | null;
  onPick: (mascotId: string | null) => void;
  onClose: () => void;
}) {
  const fallback = defaultMascot(mascots);
  return (
    <Popover at={at} onClose={onClose} className="picker picker-mascots" role="listbox">
      <button
        role="option"
        aria-selected={current === null}
        className={`mascot-option ${current === null ? "mascot-option-on" : ""}`}
        onClick={() => onPick(null)}
      >
        <span className="status status-working mascot-chip" role="img" aria-hidden>
          <Mascot config={fallback} clip={fallback.working} />
        </span>
        <span className="mascot-name">Default</span>
        <span className="set-note">{fallback.name}</span>
      </button>
      {mascots.list.map((one) => (
        <button
          key={one.id}
          role="option"
          aria-selected={current === one.id}
          className={`mascot-option ${current === one.id ? "mascot-option-on" : ""}`}
          onClick={() => onPick(one.id)}
        >
          <span className="status status-working mascot-chip" role="img" aria-hidden>
            <Mascot config={one} clip={one.working} />
          </span>
          <span className="mascot-name">{one.name}</span>
        </button>
      ))}
    </Popover>
  );
}

/**
 * What the terminal is holding, next to what it has left to think with.
 *
 * The two numbers are a pair and that is why they sit together: one says how
 * much of this agent's turn is left, the other says what having it open is
 * costing, and the row where you decide which of five agents to end is the row
 * that has to answer both. It is drawn quieter than the context ring because it
 * is the one you go looking for rather than the one you watch — nothing about
 * 400 MB is news until the machine starts swapping.
 *
 * Two figures and no more, because that is all the server sends: it rounds
 * before it decides whether the number changed, so a third digit here would be
 * one that never moved. See `server/src/memory.ts`, which is also where the
 * tooltip's caveat comes from — this counts what is resident, and the kernel
 * compressing a process out of sight makes it *smaller* here.
 */
function Memory({ bytes }: { bytes: number }) {
  return (
    <span
      className="mem"
      title={`${formatBytes(bytes)} resident — this terminal and everything running under it`}
    >
      {formatBytes(bytes)}
    </span>
  );
}

/** `409993216` → `391 MB`. Gigabytes once megabytes stop being readable. */
function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/**
 * How full the window is: a ring, and the number beside it.
 *
 * The ring alone was the trend, which is the part you read at a glance and the
 * part that matters most of the time — but "how much is left" is a question with
 * an actual answer, and asking somebody to estimate it off an arc is asking them
 * to squint. Ghosttown prints the number for the same reason, in the same
 * direction: the percentage *used*, so it climbs towards the thing you are
 * watching for rather than counting down to it.
 *
 * The tooltip says both numbers outright, because a percentage of a window
 * whose size you cannot see is only half of the answer — 95% of 200k and 19% of
 * 1M are the same conversation, and only one of them is a problem.
 */
function ContextRing({ usage }: { usage: ContextUsage }) {
  const percent = Math.min(100, Math.round((usage.used / usage.window) * 100));
  const circumference = 2 * Math.PI * 5;
  return (
    <span
      className="ctx"
      title={`${percent}% of context used — ${format(usage.used)} of ${format(usage.window)} tokens`}
    >
      <svg className="ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
        <circle
          cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2"
          strokeDasharray={`${(percent / 100) * circumference} ${circumference}`}
          transform="rotate(-90 7 7)"
          strokeLinecap="round"
        />
      </svg>
      <span className="ctx-pct">{percent}%</span>
    </span>
  );
}

/** `189377` → `189k`. A token count is a magnitude, never an exact figure. */
function format(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/**
 * How much of this profile's Claude allowance is gone, as a bar per limit.
 *
 * It fills rather than drains, which is the one decision in here worth arguing
 * because it went the other way first. Every other measure in this window
 * climbs — the context ring on an agent row, and the figure `/usage` prints in
 * the terminal directly above this bar — and the two are read one after the
 * other. A reader who has just parsed a ring at 80% as "nearly out" should not
 * have to invert the next gauge to learn it means the same thing, and the
 * half-second that inversion takes is the whole of the glance this section is
 * for.
 *
 * The case for draining was that "how much have I got left before it stops" is
 * the question somebody actually asks, which is true and is why the figure
 * beside the bar and the tooltip on it both still answer it in words. Words can
 * carry the question; the shape carries the comparison.
 *
 * The colour is the *account's* severity, not a threshold kururu picked. Three
 * bands invented here would be three bands that disagree with the warning Claude
 * Code prints in the terminal directly above this bar.
 */
function Usage() {
  const { usage } = useKururu();
  /**
   * A tick, only so the countdowns move. The numbers themselves arrive on their
   * own push once a minute; what goes stale between pushes is the *sentence*
   * next to them — "resets in 2h 14m" is wrong thirty seconds later, and a
   * reader who catches it disagreeing with the clock stops trusting the bar.
   * Local to this component so the agent list does not re-render for it.
   */
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const [open, toggle] = useDisclosure("kururu.sidebar.usage", false);

  const account = usage;
  // Nothing known, or no login on this machine. Both draw nothing: a machine
  // with no readable Claude login is not in an error state, it is one with
  // nothing to say, and a row explaining that would be noise on every window.
  if (!account || account.signedOut || account.limits.length === 0) return null;

  /**
   * Shut, the one bar that moves while you watch: the session's. The weekly
   * limits move by a percent an afternoon and are worth a look now and then,
   * not a third of the sidebar's foot all day. An account that reports no
   * session limit shows whichever it reports first rather than nothing, on
   * `limitLabel`'s argument — the limit nobody expected is the one about to
   * bite.
   */
  const shown = open
    ? account.limits
    : [account.limits.find((limit) => limit.kind === "session") ?? account.limits[0]!];

  return (
    <section className="side-section side-usage">
      <h2>
        <SectionToggle open={open} onToggle={toggle} label="Usage">
          {/* The staleness mark, which is the whole of the offline handling.
              The bars keep their last numbers — see `AccountUsage.stale` for
              why blanking them is worse — and this is the one thing that says
              those numbers are not from now. */}
          {account.stale && <span className="usage-stale" title={staleTitle(account.at)}>·</span>}
        </SectionToggle>
      </h2>
      <ul className="usage-list">
        {shown.map((limit) => (
          <li key={`${limit.kind}:${limit.scope ?? ""}`} className="usage-item">
            <span className="usage-head">
              <span className="usage-name">{limitLabel(limit)}</span>
              {/* "97%" alone is read as 97% *left* about as often as not, and
                  the two readings are three percent apart at one end of the bar
                  and ninety-four at the other. The word is four characters and
                  removes the question. */}
              <span className="usage-used">{Math.round(limit.percent)}% used</span>
            </span>
            <span
              className="usage-bar"
              role="meter"
              aria-label={`${limitLabel(limit)} used`}
              aria-valuenow={Math.round(limit.percent)}
              aria-valuemin={0}
              aria-valuemax={100}
              title={limitTitle(limit)}
            >
              <span
                className="usage-fill"
                data-severity={limit.severity}
                style={{ width: `${limit.percent}%` }}
              />
            </span>
            {limit.resetsAt && <span className="usage-reset">{resetIn(limit.resetsAt)}</span>}
          </li>
        ))}
      </ul>
      {/* Whose allowance this is. With more than one Claude login on the
          machine the bars are for whichever was signed into last — or, with
          logins kept per profile, for the profile on screen — and two
          accounts' percentages are otherwise indistinguishable. */}
      {open && account.email && (
        <p className="usage-account" title={account.email}>
          {account.email}
        </p>
      )}
    </section>
  );
}

/**
 * The dev servers running on this machine, each one a link you can open.
 *
 * This exists because of the phone. On the desktop a dev server is already
 * reachable — you type localhost and the port, and you knew the port — but over
 * the tailnet neither half of that is true: the phone's own localhost is the
 * phone, and the port that matters is the proxy's rather than the one the dev
 * server is listening on. So the address is worked out in `preview.ts` from the
 * host this window itself arrived on, and what is drawn is the answer rather
 * than the ingredients.
 *
 * It is a real anchor and not a button with an onClick, which is the whole
 * design of the row. A link can be long-pressed for the share sheet, opened in
 * a background tab, copied, and — the one that changes how this feels to use —
 * added to a home screen, after which the dev server is an icon on the phone
 * and kururu is not in the loop at all. None of that is available to a handler
 * that computes a URL and navigates, and mobile Safari additionally blocks
 * `window.open` once a round trip has separated it from the tap. `server/src/
 * index.ts` opens every proxy on the scan for exactly this reason: an href has
 * to be right before anybody touches it.
 *
 * The list is machine-wide rather than this workspace's, which is the scan's
 * shape and is the right one here — a server you started by hand in another
 * terminal is one you still want to reach from your phone, and kururu cannot
 * currently attribute a listening port to a workspace anyway.
 *
 * Its own subscription rather than a prop from `App`: this is the only thing in
 * the window that draws dev servers, and threading a list through two
 * components to be used in one of them is how a prop list stops describing what
 * a component is for.
 */
function DevServers() {
  const { devServers } = useKururu();
  /* Shut by default. The list is the phone's way in and is a thing you go and
     get, not a thing you watch — so the count is what the heading carries, and
     the rows are one press away. */
  const [open, toggle] = useDisclosure("kururu.sidebar.dev", false);
  if (devServers.length === 0) return null;

  return (
    <section className="side-section side-dev">
      <h2>
        <SectionToggle open={open} onToggle={toggle} label="Dev servers">
          <span className="side-toggle-n">{devServers.length}</span>
        </SectionToggle>
      </h2>
      {open && (
        <ul className="dev-list">
          {devServers.map((dev) => {
            const url = previewUrl(window.location, dev);
            return (
              <li key={dev.port} className="dev-item">
                {url ? (
                  <a
                    className="dev-row"
                    href={url}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={[previewLabel(dev), dev.command, dev.cwd, `→ ${url}`]
                      .filter(Boolean)
                      .join("\n")}
                  >
                    <span className="dev-name">{previewLabel(dev)}</span>
                    <span className="dev-port">:{dev.port}</span>
                    <Icon name="external" />
                  </a>
                ) : (
                  /* No proxy yet — the scan has found the server but this client
                     is not on the machine, so there is no address that would
                     work. Drawn as a row anyway, because "it is running and not
                     reachable from here yet" is worth more than a gap, and the
                     next scan is a second away. */
                  <span className="dev-row dev-row-off" title={`${dev.command}\nNo preview yet`}>
                    <span className="dev-name">{previewLabel(dev)}</span>
                    <span className="dev-port">:{dev.port}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Whether one of the sidebar's foot sections is open, remembered per device.
 *
 * Local rather than the server's, on the drawer's argument above: a disclosure
 * is a thing you do with your eyes, and a phone opening the dev servers to tap
 * one must not reach over and open them on the desktop. Remembered at all
 * because the sidebar is unmounted every time a phone puts it away, and a
 * section that shut itself each time would have to be opened each time.
 *
 * Storage can throw — a private window, blocked site data — and when it does
 * the section simply starts at its default.
 */
function useDisclosure(key: string, initial: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? initial : saved === "1";
    } catch {
      return initial;
    }
  });
  const toggle = () =>
    setOpen((was) => {
      try {
        localStorage.setItem(key, was ? "0" : "1");
      } catch {
        // Not remembered; still toggled.
      }
      return !was;
    });
  return [open, toggle];
}

/**
 * A section heading that is also its disclosure. The whole heading is the
 * target, and the caret is the drawer's — rotated shut rather than swapped —
 * so the two ways the sidebar folds something away look like one.
 */
function SectionToggle({
  open,
  onToggle,
  label,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <button className="side-toggle" onClick={onToggle} aria-expanded={open}>
      <Icon name="caret" className={open ? "" : "drawer-caret-shut"} />
      <span>{label}</span>
      {children}
    </button>
  );
}
