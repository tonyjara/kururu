/**
 * Everything in this profile: its workspaces, and every terminal running in it.
 *
 * Two lists rather than a tree, and that is deliberate. The workspaces are the
 * structure. They were numbered, because prefix+1..9 jump to them, and the
 * numbers went once groups came: a number that skips across a folded group and
 * stops at nine was counting something nobody could see, and the column it took
 * was worth more to the names. The key is still in each row's tooltip. The
 * agents span the whole profile, because
 * an agent is the thing you go looking for across a whole session, not inside
 * one layout: "where did the one that finished go" is a question about a
 * profile, not about a split tree.
 *
 * They are grouped by workspace, under headings that fold. They were flat and
 * workspace-tagged first, with the workspace's name leading every row — which
 * answered "where is it" once per row, and by the tenth agent the list was
 * mostly one word printed again and again. A heading says it once, and folding
 * one away is how a profile with a workspace you are not working in today stops
 * spending a third of the column on it. The groups follow the workspace list's
 * order, so the two lists read top to bottom the same way.
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
 *
 * Which is also why a row has one button and not two: the git and database
 * buttons it carried are a menu behind ⋯ now, with the board and LazyGit, and
 * the ⋯ waits for the pointer to be on the row. The ⋯ and the right-click open
 * the same menu (`workspaceItems`) — until 2026-10-18 they were two, split
 * into what is done in a workspace and what is done to one, a line nobody
 * reaching for a verb could see. Buttons read every time you
 * look at the sidebar and pressed a few times a day are the trade the row made
 * once already, with the dev servers.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { panes } from "../../../shared/layout";
import type {
  AgentSnapshot,
  ContextUsage,
  MascotSet,
  Profile,
  Workspace,
} from "../../../shared/model";
import { defaultMascot, mascotFor, workspaceUnits } from "../../../shared/model";
import type { DevServer, GitAction, RepoGit } from "../../../shared/wire";
import type { MachineStatus } from "../../../shared/machines";
import type { NodeStatus } from "../../../shared/nodes";
import { agentItems } from "../agentmenu";
import { AGENT_MIME, GROUP_MIME, WORKSPACE_MIME, allowDrop, beginDrag, endDrag, useDragging } from "../drag";
import type { Action } from "../keys";
import { agentLabel, agentSummary, remoteHost, remoteNote, shortenPath } from "../labels";
import { useLongPress } from "../longpress";
import { asAgent, nodeState } from "../nodes";
import { previewLabel, previewUrl } from "../preview";
import * as api from "../session";
import { useKururu } from "../session";
import { Menu, Popover, type MenuItem } from "./Menu";
import type { DialogState } from "./Dialog";
import { Icon } from "./Icon";
import { MadeLinks } from "./MadeLinks";
import { NameField } from "./NameField";
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
   * The row menu's Databases, there when the workspace's env files name at
   * least one. The sheet that opens is the app's, like the profile's board — it
   * goes over the window, and on a phone the sidebar is put away first.
   */
  onDatabases: (workspaceId: string) => void;
  /**
   * Say when a name is being typed in here, because the prefix has to stand
   * down for it: ctrl+a is select-all in a text field, and an armed prefix would
   * swallow the next letter as a command.
   */
  onEditing: (editing: boolean) => void;
  /**
   * Put a question up — the commit message, for the git rows. The dialog is
   * the app's, for the reason the delete confirmation is: while it is up no key
   * reaches a pty, and that is a promise only the app can keep.
   */
  onPrompt: (state: DialogState) => void;
  /**
   * The sidebar's toggle and the workspace's name, for the strip along the
   * top — see `WorkspaceToggle` in `StatusBar.tsx`. Null on a phone, whose
   * bottom bar has them.
   */
  toggle: ReactNode;
  /** Opens the settings dialog. The corner is the only way in. */
  onSettings: () => void;
  /** Opens the phone dialog — the addresses this server answers at, as QR codes. */
  onReach: () => void;
  /** Opens the profile's own board — see `ProfileBoard`. */
  onBoard: () => void;
  /**
   * The workspaces something is waiting in, by id — `shared/needs.ts`'s
   * answer, worked out once by the app. A row in here wears the same dot an
   * agent's row does when it needs you, so the list of workspaces says it
   * without the list of agents being read.
   */
  needsYou: ReadonlySet<string>;
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
  onDatabases,
  onEditing,
  onPrompt,
  onBoard,
  needsYou,
  toggle,
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
  const { branches, databases, machines } = useKururu();
  const heads = new Map(branches.map((head) => [head.workspaceId, head] as const));
  const dbCount = new Map<string, number>();
  for (const db of databases) dbCount.set(db.workspaceId, (dbCount.get(db.workspaceId) ?? 0) + 1);
  /**
   * Whether any workspace wears a mascot of its own — and so whether every row
   * keeps a column for one. All of them or none, because the point of the column
   * is that the names start in one place: a mascot on four rows of ten, with the
   * other six names starting a sprite further left, would be a ragged edge drawn
   * on purpose. None when nobody has picked, so the feature costs nothing to
   * somebody not using it.
   */
  const mascotted = profile.workspaces.some((w) => ownMascot(mascots, w.mascotId));
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
  /**
   * The workspaces whose group of agents is folded away. Local, on the
   * drawer's argument, and remembered per device on the foot sections' — see
   * `useFolded`.
   */
  const [folded, toggleFolded, foldAgents] = useFolded();
  /**
   * The groups of *workspaces* that are folded, by name. Per device for the
   * same reason the agent groups are, and kept apart from them because a
   * workspace id and a group name are two vocabularies that could collide.
   */
  const [foldedGroups, toggleGroup, foldGroups] = useFolded("kururu.sidebar.groups.folded");
  /** The workspace group whose name is being typed, if any. */
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  /** Where a group heading's menu is open, and which group it is. */
  const [groupMenu, setGroupMenu] = useState<{ group: string; x: number; y: number } | null>(null);
  /** The group heading a dragged terminal would move to, while it is over one. */
  const [overGroup, setOverGroup] = useState<string | null>(null);
  /** The workspace whose name is being typed, if any. */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Where a workspace row's menu is open — off its ⋯ or a right-click, which are one menu — and which row it belongs to. */
  const [menu, setMenu] = useState<{ workspaceId: string; x: number; y: number } | null>(null);
  /** Where an agent row's context menu is open, and which agent it belongs to. */
  const [agentMenu, setAgentMenu] = useState<{ agentId: string; x: number; y: number } | null>(null);
  /**
   * The agent whose name is a field in its row, from Rename in that menu. It
   * claims the keyboard itself (`NameField`), so it is not in the effect below
   * that claims it for the workspace and group fields.
   */
  const [renamingAgent, setRenamingAgent] = useState<string | null>(null);
  // An agent that ended or was dismissed mid-rename takes the rename with it,
  // as a tab does in `Pane`, rather than leaving the field waiting to come back.
  useEffect(() => {
    if (renamingAgent !== null && !agents.some((a) => a.id === renamingAgent)) setRenamingAgent(null);
  }, [renamingAgent, agents]);
  /** The workspace whose git verb is still running — its ⋯ says so, and its git rows take no second one. */
  const [gitBusy, setGitBusy] = useState<string | null>(null);
  /**
   * What the last git verb came to, as the row's second line until it is
   * clicked away or a few seconds pass: what was committed and where it went,
   * or git's reason for not. A line on the row rather than a toast, the way a
   * card says what its merge came to — it is about this workspace, and a
   * message that floated somewhere else would leave you working out which.
   */
  const [gitSaid, setGitSaid] = useState<{ workspaceId: string; text: string; error: boolean } | null>(null);
  useEffect(() => {
    if (!gitSaid || gitSaid.error) return;
    const timer = setTimeout(() => setGitSaid(null), 8000);
    return () => clearTimeout(timer);
  }, [gitSaid]);
  /** Where the mascot picker is open, and whose mascot it is setting. */
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
  /**
   * A long press is a row's right-click on a phone (`longpress.ts`), and the
   * click its lift would deliver is swallowed so `show()` or `goTo()` does not
   * also fire underneath the menu. Agent rows had it first; a workspace row
   * took it on 2026-10-18, when its ⋯ and its right-click became one menu and
   * a phone's way to it should be the same gesture as everywhere else, not
   * only the ⋯.
   */
  const { longPress, swallowed } = useLongPress();

  useEffect(() => {
    onEditing(renaming !== null || renamingGroup !== null);
    // Also on unmount: a sidebar hidden mid-rename must not leave the keyboard
    // switched off with nothing on screen to explain why.
    return () => onEditing(false);
  }, [renaming, renamingGroup, onEditing]);

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
   * The card an agent is running under, if any — so its row's menu can offer
   * "Go to card". Only a workspace's own board ever runs an agent; the
   * profile's board is an inbox nothing has been started from yet, so it is
   * not searched here — see `shared/board.ts`.
   */
  const cardFor = new Map<string, { workspaceId: string; cardId: string }>();
  for (const workspace of profile.workspaces) {
    for (const card of workspace.board?.cards ?? []) {
      if (card.run?.agentId) cardFor.set(card.run.agentId, { workspaceId: workspace.id, cardId: card.id });
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
  const openCards = profile.board.cards.filter((card) => card.column !== "done").length;
  const away = new Set(profile.hiddenAgents);
  const shown = listed.filter((agent) => !away.has(agent.id));
  const hidden = listed.filter((agent) => away.has(agent.id));

  /**
   * The list proper, cut into one group per workspace, in the workspace list's
   * order. A workspace with nothing listed in it draws no heading: an empty
   * group is a row saying there is nothing to say, and the workspace list
   * above already says the workspace exists.
   *
   * Within a group the order is still the profile's `agentOrder`, because this
   * is a filter of `shown` and never a sort of it — so reordering inside a group
   * is the same reorder it always was.
   *
   * A terminal in no workspace at all has no business existing, but a snapshot
   * can arrive a beat before the layout that places it, and a row that vanished
   * for that beat would be the list flickering. So it gets a group of its own,
   * at the end, for as long as it takes.
   */
  const groups = [
    ...profile.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      agents: shown.filter((agent) => where.get(agent.id)?.workspaceId === workspace.id),
    })),
    { id: "", name: "Elsewhere", agents: shown.filter((agent) => !where.has(agent.id)) },
  ].filter((group) => group.agents.length > 0);

  /**
   * Whether the Agents heading's fold-everything button opens rather than
   * folds: only when every group drawn is already shut, so a list with one
   * group left open is still a list it would tidy. It asks of the groups on
   * screen and acts on them alone — folding a workspace with nothing in it
   * would hide the first agent it ever gets, which is the thing `useFolded` is
   * careful not to do.
   */
  const agentsFolded = groups.length > 0 && groups.every((group) => folded.has(group.id));

  /** The row an open menu belongs to. */
  const menuWorkspace = menu ? (profile.workspaces.find((w) => w.id === menu.workspaceId) ?? null) : null;

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

  /** Every group in the profile, in the order the list draws them. */
  const groupNames = [...new Set(profile.workspaces.flatMap((w) => (w.group === null ? [] : [w.group])))];
  /** The Workspaces heading's answer to the same question, asked of the groups of workspaces. */
  const groupsFolded = groupNames.length > 0 && groupNames.every((group) => foldedGroups.has(group));

  /**
   * File a workspace under a group that does not exist yet, and open the new
   * heading's name for typing. The placeholder is unique so it cannot merge
   * into a group already there before anybody has typed a word.
   */
  const newGroup = (workspaceId: string) => {
    let n = groupNames.length + 1;
    while (groupNames.includes(`group ${n}`)) n++;
    api.setWorkspaceGroup(workspaceId, `group ${n}`);
    setRenamingGroup(`group ${n}`);
  };

  /**
   * A group's heading in the workspace list: the fold, a place to drop a
   * workspace into the group, and on right-click the group's own menu.
   *
   * Folding one leaves the workspace you are in standing under it. A fold is a
   * way of not looking at things, and the one workspace you are in is the one
   * thing in the list you are certainly looking at — hiding it would leave the
   * window showing a workspace the sidebar says nothing about.
   */
  const groupHead = (group: string) => {
    const members = profile.workspaces.filter((w) => w.group === group);
    const shut = foldedGroups.has(group);
    const waiting = members.some((w) =>
      agents.some((agent) => agent.unread && where.get(agent.id)?.workspaceId === w.id),
    );
    if (renamingGroup === group) {
      return (
        <li className="ws-group">
          <input
            className="ws-edit"
            defaultValue={group}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") cancelled.current = true;
              if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
            }}
            onBlur={(event) => {
              // An empty name is not a disband: that is a menu row of its own,
              // and a field cleared by accident should not scatter a group.
              const to = event.currentTarget.value.trim();
              if (!cancelled.current && to) {
                // The fold follows the name, which is the only key it has.
                if (shut && !foldedGroups.has(to)) toggleGroup(to);
                api.renameWorkspaceGroup(group, to);
              }
              cancelled.current = false;
              setRenamingGroup(null);
            }}
            spellCheck={false}
            autoComplete="off"
            aria-label="Group name"
          />
        </li>
      );
    }
    return (
      <li className={`ws-group ${overGroup === `group:${group}` ? "ws-over" : ""}`}>
        <button
          className="ws-group-head"
          onClick={() => toggleGroup(group)}
          onDoubleClick={() => setRenamingGroup(group)}
          onContextMenu={(event) => {
            event.preventDefault();
            setGroupMenu({ group, x: event.clientX, y: event.clientY });
          }}
          aria-expanded={!shut}
          title={`${shut ? "Show" : "Fold away"} ${group} \u00b7 double-click to rename`}
          /* The heading is the group's handle, and a click that wobbled into
             a drag is handed back as the fold — `CLICK_SLOP`, as on a row. */
          draggable
          onDragStart={(event) => {
            dragFrom.current = { x: event.clientX, y: event.clientY };
            beginDrag(event, "group", group);
          }}
          onDragEnd={(event) => {
            const from = dragFrom.current;
            dragFrom.current = null;
            endDrag();
            setOverGroup(null);
            if (!from || event.dataTransfer.dropEffect !== "none") return;
            if (Math.hypot(event.clientX - from.x, event.clientY - from.y) <= CLICK_SLOP) toggleGroup(group);
          }}
          /* Two things land here: a workspace, which joins the group, and
             another group, which takes this one's place. */
          onDragOver={(event) => {
            if (dragging?.kind === "group") {
              if (dragging.id === group) return;
            } else if (dragging?.kind === "workspace") {
              if (profile.workspaces.find((w) => w.id === dragging.id)?.group === group) return;
            } else return;
            allowDrop(event);
            setOverGroup(`group:${group}`);
          }}
          onDragLeave={() => setOverGroup((current) => (current === `group:${group}` ? null : current))}
          onDrop={(event) => {
            setOverGroup(null);
            const heading = event.dataTransfer.getData(GROUP_MIME);
            if (heading) {
              event.preventDefault();
              return api.moveWorkspaceGroup(heading, members[0]!.id);
            }
            const moved = event.dataTransfer.getData(WORKSPACE_MIME);
            if (!moved) return;
            event.preventDefault();
            api.setWorkspaceGroup(moved, group);
          }}
        >
          <Icon name="caret" className={shut ? "drawer-caret-shut" : ""} />
          <span className="agent-group-name">{group}</span>
          {/* Folded, the heading says what its rows would have: that something
              in there is waiting for you. */}
          {shut && waiting && <span className="unread" aria-label="waiting for you" />}
          {/* No count of its workspaces since 2026-10-18: open, the rows are
              right under it to be seen, and shut, how many there are was
              never the question — whether one is waiting is, and the dot
              answers that. */}
        </button>
      </li>
    );
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
   * A workspace's board, from its row: there, and the board you have where it
   * is, or a new tab in the pane you were last in — the server decides which,
   * against the layout it holds rather than the one this client last drew.
   * `navigated` for the phone, where the sidebar is a sheet over the thing you
   * just asked to see.
   */
  const openRowBoard = (workspaceId: string) => {
    api.openBoard(undefined, false, workspaceId);
    navigated();
  };

  /**
   * A workspace row's menu, for its ⋯ and its right-click alike: one list,
   * built here and nowhere else, so the two doors cannot drift apart again.
   *
   * The places first — the board, LazyGit, the databases — because a menu
   * opened to go somewhere should not make you read past the furniture; then
   * the main checkout's git under a line saying where it stands, which is
   * what the git button's tooltip said and a menu has no tooltip; then the
   * row as a thing in a list — its name, its mascot, its place, its group —
   * and last, past a line each, a new one beside it and the one verb that
   * cannot be taken back.
   */
  const workspaceItems = (workspace: Workspace, at: { x: number; y: number }): MenuItem[] => {
    const index = profile.workspaces.findIndex((w) => w.id === workspace.id);
    const git = heads.get(workspace.id)?.git ?? null;
    const dbs = dbCount.get(workspace.id) ?? 0;
    const busy = gitBusy === workspace.id;
    const pin = workspace.machine;
    const machine = pin ? machines.find((m) => m.id === pin.machineId) : undefined;
    const items: MenuItem[] = [
      { label: "Open board", run: () => openRowBoard(workspace.id) },
      {
        label: "Open LazyGit",
        /* In the workspace's repository, or on its machine when it is pinned
           to one — the server knows which, and what the folder is. */
        hint: machine ? `on ${machine.name}` : undefined,
        run: () => {
          void api.newTab({ workspaceId: workspace.id, lazygit: true });
          navigated();
        },
      },
    ];
    if (dbs > 0) items.push({ label: "Databases", hint: String(dbs), run: () => onDatabases(workspace.id) });
    if (git) {
      items.push({ label: gitTitle(git).split("\n")[0]!, sep: true, disabled: true, run: () => undefined });
      const verbs = gitItems(git, (root, action, message) => {
        const workspaceId = workspace.id;
        setGitBusy(workspaceId);
        setGitSaid(null);
        api
          .workspaceGit(workspaceId, root, action, message)
          .then(
            (text) => setGitSaid({ workspaceId, text, error: false }),
            (err: unknown) =>
              setGitSaid({ workspaceId, text: err instanceof Error ? err.message : String(err), error: true }),
          )
          .finally(() => setGitBusy((was) => (was === workspaceId ? null : was)));
      }, onPrompt);
      // A verb still running takes no second one, as the button that was
      // disabled for it did; the rows stay listed so the menu keeps its shape.
      items.push(...verbs.map((item) => (busy ? { ...item, disabled: true } : item)));
    }
    items.push(
      { label: "Rename", sep: true, run: () => setRenaming(workspace.id) },
      { label: "Mascot…", run: () => setMascotPicker({ workspaceId: workspace.id, x: at.x, y: at.y }) },
      /* Within its group: a step across the edge would take the neighbour's
         group with it (`moveWorkspace`), and filing is what the rows below
         are for. */
      {
        label: "Move up",
        disabled: profile.workspaces[index - 1]?.group !== workspace.group,
        run: () => api.moveWorkspace(workspace.id, index - 1),
      },
      {
        label: "Move down",
        disabled: profile.workspaces[index + 1]?.group !== workspace.group,
        run: () => api.moveWorkspace(workspace.id, index + 1),
      },
      { label: "New group…", sep: true, run: () => newGroup(workspace.id) },
      ...groupNames
        .filter((name) => name !== workspace.group)
        .map((name) => ({ label: `Move to ${name}`, run: () => api.setWorkspaceGroup(workspace.id, name) })),
      ...(workspace.group !== null
        ? [{ label: "Remove from group", run: () => api.setWorkspaceGroup(workspace.id, null) }]
        : []),
      { label: "New workspace", sep: true, run: () => onRun("new-workspace") },
      {
        label: "Delete",
        sep: true,
        danger: true,
        // The last workspace cannot go: there would be nowhere to be.
        disabled: profile.workspaces.length < 2,
        run: () => onDeleteWorkspace(workspace.id),
      },
    );
    return items;
  };

  /** The agent an open row menu belongs to. */
  const menuAgent = agentMenu ? agents.find((a) => a.id === agentMenu.agentId) ?? null : null;

  /**
   * An agent row's menu, which is its tab's menu with the list's own Hide —
   * see `agentmenu.ts`. The things its corner used to carry as buttons are in
   * it, reachable only by right-click or a long press now, which is what let
   * the corner go back to just the row.
   */
  const rowItems = (agent: AgentSnapshot): MenuItem[] =>
    agentItems(agent, {
      rename: () => setRenamingAgent(agent.id),
      card: cardFor.get(agent.id),
      hidden: away.has(agent.id),
      navigated,
    });

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
          agent.made?.length ? "agent-item-made" : "",
          insert ? (insert.after ? "agent-under" : "agent-over") : "",
        ]
          .filter(Boolean)
          .join(" ")}
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
          // Dropped among another workspace's agents, which now that the list is
          // grouped is a place and not only a position: a row that landed there and
          // stayed in its own workspace would jump straight back to its own group,
          // which is the drop being refused without saying so. So it goes to that
          // workspace first, and the reorder places it within the group after.
          const from = where.get(dragged)?.workspaceId;
          if (at && from && from !== at.workspaceId) api.moveTabToWorkspace(dragged, at.workspaceId);
          const box = event.currentTarget.getBoundingClientRect();
          api.reorderAgent(dragged, insertBefore(event.clientY > box.top + box.height / 2));
        }}
        onContextMenu={(event) => {
          // The field's own menu — paste, spelling — while the name is one.
          if (renamingAgent === agent.id) return;
          event.preventDefault();
          setAgentMenu({ agentId: agent.id, x: event.clientX, y: event.clientY });
        }}
      >
        {renamingAgent === agent.id ? (
          /* The row's top line with the name as a field, and nothing else: not
             the button, since a field inside a button is a click on the row
             every time you place the cursor, and not the activity line, which
             would go on changing under a name being typed. */
          <span className="agent-renaming">
            <Status agent={agent} mascot={mascotFor(mascots, at?.mascotId ?? null)} />
            <NameField
              agentId={agent.id}
              shown={agentLabel(agent)}
              className="agent-edit"
              onEditing={onEditing}
              onDone={() => setRenamingAgent(null)}
            />
          </span>
        ) : (
          <button
            className={`agent-row ${agent.exited ? "agent-row-exited" : ""}`}
            onClick={() => {
              if (swallowed()) return;
              show(agent.id);
            }}
            title={(remoteNote(agent) ? [agentLabel(agent), agentSummary(agent), remoteNote(agent)] : [agentLabel(agent), agentSummary(agent), agent.command, agent.cwd])
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
            {...longPress((at) => setAgentMenu({ agentId: agent.id, ...at }))}
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
              {/* Under a group heading the workspace has already been said, so the program
                  takes its place and its weight. The drawer is not grouped — it is one
                  short list of things put away from anywhere — so its rows still lead with
                  where they live. */}
              {hiddenHere ? (
                <span className="agent-ws">{at ? at.workspace : "—"}</span>
              ) : (
                <span className="agent-title">{agentLabel(agent)}</span>
              )}
              {/* Not "new output" any more, which it was and which lit nine rows in ten:
                  this is the turn that ended, or the question that was asked, while you
                  were not looking at it. The server decides it — see its `unread`. */}
              {/* Where it runs, when that is not here — see `remoteHost`. */}
              {remoteHost(agent) && <span className="remote-mark">{remoteHost(agent)}</span>}
              {agent.unread && <span className="unread" aria-label="waiting for you" />}
              {hiddenHere && <span className="agent-name">{agentLabel(agent)}</span>}
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
                {/* An agent on a machine has no directory here worth naming —
                    its cwd is where the ssh was started — so the machine stands in. */}
                {agentSummary(agent) || (remoteHost(agent) ? `on ${remoteHost(agent)}` : shortenPath(agent.cwd))}
              </span>
              {agent.rss ? <Memory bytes={agent.rss} /> : null}
              {agent.contextUsage && <ContextRing usage={agent.contextUsage} />}
            </span>
          </button>
        )}
        {/* What its last turn ended in, when that was something to read: a line of its
            own under the row rather than a third line inside it, because these are
            buttons and the row is one, and because a row with nothing to read keeps
            the height it always had. Into the agent's workspace, like the row. */}
        {agent.made?.length ? (
          <MadeLinks className="agent-made" files={agent.made} workspaceId={at?.workspaceId ?? null} onOpened={navigated} />
        ) : null}
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
          screen. `app-window` on the root is what says which of the two this is.

          Since 2026-10-18 it is not empty on a desktop: the sidebar's toggle and
          the workspace's name came up from the bar under the panes to stand
          beside the traffic lights, where a window's title would be. So the
          strip is drawn in a browser tab too when it has them — a line that
          holds something is not thirty pixels of nothing — and stays the empty
          drag handle on a phone's full-screen sidebar, which has its close
          button for a way out. The name leads and the toggle stands right
          after it — where the two also stand at the head of the top-left
          pane's strip while the sidebar is away, so folding it moves
          neither. */}
      {toggle ? (
        <div className="sidebar-drag sidebar-top">{toggle}</div>
      ) : (
        <div className="sidebar-drag" aria-hidden="true" />
      )}

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
          <span className="profile-name">{profile.name}</span>
          <Icon name="caret" className="profile-caret" />
        </button>
        {/* The profile's board, beside the name because it is the profile's and
            no workspace's. The count is what is not done yet: the number worth
            glancing at is the pile still waiting to be sent somewhere. */}
        <button
          className="profile-board-btn"
          onClick={onBoard}
          title="This profile's board"
          aria-label={`${profile.name}'s board`}
        >
          <Icon name="board" />
          {openCards > 0 && <span className="profile-board-count">{openCards}</span>}
        </button>
        <span className="sidebar-head-spacer" />
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
          {/* Every group of workspaces folded at once, or opened again once
              they all are. The workspace you are in stays standing under its
              folded group, as it does when one heading is clicked. Drawn only
              while there is a group to fold, on the drawer's argument: a button
              that can do nothing is chrome saying that a feature exists. */}
          {groupNames.length > 0 && (
            <button
              className="mini side-fold-all"
              onClick={() => foldGroups(groupNames, !groupsFolded)}
              title={groupsFolded ? "Show every group of workspaces" : "Fold every group of workspaces away"}
              aria-label={groupsFolded ? "Show all groups" : "Fold all groups"}
            >
              <Icon name={groupsFolded ? "unfold" : "fold"} />
            </button>
          )}
          <button className="mini" onClick={() => onRun("new-workspace")} title="New workspace (C-a C)" aria-label="New workspace">
            <Icon name="add" />
          </button>
        </h2>
        <ul className={`ws-list ${mascotted ? "ws-list-mascots" : ""}`}>
          {profile.workspaces.map((workspace, index) => {
            const head = heads.get(workspace.id);
            const group = workspace.group;
            // The list is kept gathered (`gatherGroups`), so a group starts
            // wherever the row above is not in it.
            const opens = group !== null && profile.workspaces[index - 1]?.group !== group;
            const tucked =
              group !== null && foldedGroups.has(group) && workspace.id !== profile.activeWorkspaceId;
            return (
            <Fragment key={workspace.id}>
            {opens && groupHead(group)}
            {!tucked && (
            <li
              className={`ws-item ${workspace.id === profile.activeWorkspaceId ? "ws-item-on" : ""} ${
                overWorkspace === workspace.id ? "ws-over" : ""
              } ${group !== null ? "ws-item-grouped" : ""}`}
              /* The whole row, both lines of it, and not the name's button.
                 The button was the target for as long as a row *was* the name;
                 splitting the second line out left a strip along the bottom of
                 every row that lit up on hover like the rest of it and did
                 nothing when pressed — the branch, and the gap either side of
                 it, are a third of the height of a row you are aiming at.

                 A click that landed on the ⋯ is not this: it means something
                 else, and a workspace switch riding along behind it would be a
                 side effect nobody asked for. The name's button is the
                 exception rather than being listed, because it *is* this
                 gesture — which also keeps it working from the keyboard, where
                 Enter on the focused button produces exactly this click. */
              onClick={(event) => {
                if (swallowed()) return;
                if ((event.target as HTMLElement).closest("button:not(.ws-row), input")) return;
                goTo(workspace.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ workspaceId: workspace.id, x: event.clientX, y: event.clientY });
              }}
              {...longPress((at) => setMenu({ workspaceId: workspace.id, ...at }))}
              /* Three things can land on a workspace row: a terminal, which moves
                 to that workspace; another workspace, which reorders the list;
                 and a group's heading, which moves the whole group to this
                 row's place. The drag store says which without opening the payload. */
              onDragOver={(event) => {
                // A whole pane is not something a workspace row knows what to do
                // with, so it does not offer to take one.
                if (dragging?.kind !== "agent" && dragging?.kind !== "workspace" && dragging?.kind !== "group") return;
                if (dragging.kind === "workspace" && dragging.id === workspace.id) return;
                if (dragging.kind === "group" && dragging.id === group) return;
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
                const heading = event.dataTransfer.getData(GROUP_MIME);
                if (heading) return api.moveWorkspaceGroup(heading, workspace.id);
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
                    {mascotted && <WorkspaceMascot mascots={mascots} mascotId={workspace.mascotId} />}
                    <span className="ws-name">{workspace.name}</span>
                    {head?.git && <GitMarks git={head.git} />}
                    {/* Something in here needs you — an agent asking, a card
                        in Review, a turn that ended unseen. The dot the agent
                        rows and a folded group's heading already wear, with
                        the same meaning; the drawer behind the status bar's
                        tray says what. */}
                    {needsYou.has(workspace.id) && <span className="unread" aria-label="needs you" />}
                  </button>

                  {/* The row's options, at the end of the name's line, where its
                      git and database buttons were. Drawn only while the pointer
                      is on the row (or the menu is open, or a git verb is still
                      running) — see `.ws-more` for the touch screens that have
                      no pointer to wait for. Outside the row's own button,
                      because a button inside a button is not a thing the
                      platform will give you. */}
                  <button
                    className={[
                      "ws-more",
                      menu?.workspaceId === workspace.id ? "ws-more-open" : "",
                      gitBusy === workspace.id ? "ws-more-busy" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={(event) => {
                      const box = event.currentTarget.getBoundingClientRect();
                      setMenu({ workspaceId: workspace.id, x: box.left, y: box.bottom + 4 });
                    }}
                    title="Options"
                    aria-label={`${workspace.name}: options`}
                    aria-haspopup="menu"
                  >
                    <Icon name="more" />
                  </button>

                  {/* A second line under the name only when there is something
                      to say on it: what the last git verb from the ⋯ came to,
                      until it is clicked away or a few seconds pass, or where a
                      pinned workspace's shells open. The branch was here, every
                      row, every time you looked; it went because everything
                      happens on one branch, and it is still the first line of
                      the ⋯ menu and of the marks' tooltip. In the mono face for
                      the reason a shell prompt uses one, and clipped rather
                      than wrapped, because what git says is git's length. */}
                  {gitSaid?.workspaceId === workspace.id ? (
                    <button
                      className={`ws-note ws-said ${gitSaid.error ? "ws-said-error" : ""}`}
                      onClick={() => setGitSaid(null)}
                      title={`${gitSaid.text}\nClick to dismiss`}
                    >
                      {gitSaid.text}
                    </button>
                  ) : (
                    pinnedTo(workspace, machines)
                  )}
                </>
              )}
            </li>
            )}
            </Fragment>
            );
          })}
        </ul>
      </section>

      <section className="side-section side-agents">
        <h2>
          Agents
          {/* The same, for every workspace's group of agents. */}
          {groups.length > 0 && (
            <button
              className="mini side-fold-all"
              onClick={() => foldAgents(groups.map((group) => group.id), !agentsFolded)}
              title={agentsFolded ? "Show every workspace's agents" : "Fold every workspace's agents away"}
              aria-label={agentsFolded ? "Show all agents" : "Fold all agents"}
            >
              <Icon name={agentsFolded ? "unfold" : "fold"} />
            </button>
          )}
        </h2>
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
          {groups.map((group) => {
            const shut = folded.has(group.id);
            return (
              <li key={group.id || "elsewhere"} className="agent-group">
                {/* The heading is the fold, and also a place to drop a terminal: the
                    same move a workspace row takes, offered here because this is
                    where the terminal is being dragged from and the workspace list
                    may be scrolled out of reach. Clicking it folds and never
                    switches workspace — that is the workspace row's job, and a
                    heading that did both would make folding one you are not in
                    take you there. */}
                <button
                  className={`agent-group-head ${overGroup === group.id ? "ws-over" : ""}`}
                  onClick={() => toggleFolded(group.id)}
                  aria-expanded={!shut}
                  title={shut ? `Show ${group.name}'s agents` : `Fold ${group.name}'s agents away`}
                  onDragOver={(event) => {
                    if (!group.id || dragging?.kind !== "agent") return;
                    if (where.get(dragging.id)?.workspaceId === group.id) return;
                    allowDrop(event);
                    setOverGroup(group.id);
                  }}
                  onDragLeave={(event) => {
                    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                    setOverGroup((current) => (current === group.id ? null : current));
                  }}
                  onDrop={(event) => {
                    setOverGroup(null);
                    const agentId = event.dataTransfer.getData(AGENT_MIME);
                    if (!agentId || !group.id) return;
                    event.preventDefault();
                    event.stopPropagation();
                    api.moveTabToWorkspace(agentId, group.id);
                  }}
                >
                  <Icon name="caret" className={shut ? "drawer-caret-shut" : ""} />
                  <span className="agent-group-name">{group.name}</span>
                  {/* Folded, the heading has to be able to say what the rows would
                      have: that one of them is waiting for you. Open, the row says
                      it itself and a second mark would be the same news twice. */}
                  {shut && group.agents.some((agent) => agent.unread) && (
                    <span className="unread" aria-label="waiting for you" />
                  )}
                  {/* No count of its agents, on the workspace groups' terms:
                      the bottom bar counts the agents running, and a number on
                      every heading was a column of figures nobody read. */}
                </button>
                {!shut && (
                  <ul className="agent-group-list">
                    {group.agents.map((agent, index) => agentRow(agent, group.agents, index, true))}
                  </ul>
                )}
              </li>
            );
          })}
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

      {/* The other kururus, under the agents: what is running on them is the
          same kind of thing as the list above, where the bottom bar's
          machines are gauges. The Claude and Codex allowances, the machines
          and the OpenRouter balance were sections here too and are the
          bottom bar's since 2026-10-18 (`Usage.tsx`, `Machines.tsx`,
          `OpenRouter.tsx`). */}
      <Nodes mascots={mascots} />
      <DevServers />

      {/* The foot: Settings and the phone's QR code, at the bottom left. They
          were down here until 2026-10-12, went up into the header, and came
          back on 2026-10-18 — and this time the foot has no bar beside it to
          meet, because the bar under the panes is gone and the one along the
          bottom runs under this too. The
          QR code is for getting kururu *onto* a phone, so a sidebar that is a
          phone's whole screen does not draw it; a narrow desktop window gets
          it back when widened. */}
      <footer className="sidebar-foot">
        <button className="cog" onClick={onSettings} title="Settings (C-a g)" aria-label="Settings">
          <Icon name="settings" />
        </button>
        {!overlay && (
          <button className="cog" onClick={onReach} title="Open on your phone" aria-label="Open on your phone">
            <Icon name="share" />
          </button>
        )}
      </footer>

      {/* The edge you drag. Last in the tree and absolutely positioned, so it
          sits over the border rather than taking a column of its own — a handle
          that occupied layout would make the sidebar two pixels wider than the
          width it was told to be, and the arithmetic would be wrong in exactly
          the way nobody looks for. */}
      {!overlay && <Resizer onResize={onResize} onReset={onResetWidth} />}

      {menu && menuWorkspace && (
        <Menu at={menu} onClose={() => setMenu(null)} items={workspaceItems(menuWorkspace, menu)} />
      )}

      {groupMenu && (
        <Menu
          at={groupMenu}
          onClose={() => setGroupMenu(null)}
          items={[
            { label: "Rename group", run: () => setRenamingGroup(groupMenu.group) },
            /* One step past whatever is beside it — a loose workspace or a
               whole group, which are the things that move as one. */
            ...[-1, 1].map((step) => {
              const units = workspaceUnits(profile.workspaces);
              const at = units.findIndex((unit) => unit[0]!.group === groupMenu.group);
              const beside = units[at + step]?.[0];
              return {
                label: step < 0 ? "Move group up" : "Move group down",
                disabled: !beside,
                run: () => beside && api.moveWorkspaceGroup(groupMenu.group, beside.id),
              };
            }),
            {
              label: foldedGroups.has(groupMenu.group) ? "Show" : "Fold away",
              run: () => toggleGroup(groupMenu.group),
            },
            /* Disbanding ends nothing — the workspaces go back to being loose —
               so it asks nobody first, unlike deleting one. */
            { label: "Ungroup", sep: true, run: () => api.renameWorkspaceGroup(groupMenu.group, null) },
          ]}
        />
      )}

      {agentMenu && menuAgent && (
        <Menu
          at={agentMenu}
          onClose={() => setAgentMenu(null)}
          items={rowItems(menuAgent)}
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
    </aside>
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
 * The workspace's own mascot, sitting idle between its number and its name.
 *
 * Only for a workspace that picked one. A workspace following the default would
 * put the same frog on every row, and a mark that is on everything distinguishes
 * nothing — what this says is "this one is different", and it can only say that
 * where it is. An id naming a mascot that has since been deleted is found by
 * nothing here and draws nothing, rather than falling back the way `mascotFor`
 * does: the fallback is the default, which is exactly the case left out.
 *
 * The idle clip, because the row is a name and not an agent — nothing in a
 * workspace is "working" — and a sidebar of hopping names would be louder than
 * the agent badges whose hop actually means something. A mascot with no idle
 * clip shows its working one rather than vanishing, since having picked it is
 * the fact being drawn. Motion is the mascot's own setting, and a frozen frame
 * is fine here where it was not on a badge: this is a picture of a choice, not
 * a state the stillness could be mistaken for.
 */
function WorkspaceMascot({ mascots, mascotId }: { mascots: MascotSet; mascotId: string | null }) {
  const mascot = ownMascot(mascots, mascotId);
  /* Empty rather than absent on a row without one: the box is the column, and
     it is what keeps this row's name starting where its neighbours' do. */
  return (
    <span className="status status-idle ws-mascot" aria-hidden>
      {mascot && <Mascot config={mascot} clip={mascot.idle ?? mascot.working} />}
    </span>
  );
}

/** The mascot a workspace picked for itself, or nothing — never the default. */
function ownMascot(mascots: MascotSet, mascotId: string | null): MascotSet["list"][number] | undefined {
  return mascotId === null ? undefined : mascots.list.find((m) => m.id === mascotId);
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

/** "on devbox · ~/code" under a pinned workspace's name, or nothing. */
function pinnedTo(workspace: Workspace, machines: MachineStatus[]): ReactNode {
  const pin = workspace.machine;
  const machine = pin ? machines.find((m) => m.id === pin.machineId) : undefined;
  if (!pin || !machine) return null;
  return (
    <span className="ws-note" title={`New shells here open on ${machine.name} (ssh ${machine.host}), in ${pin.dir}, inside tmux`}>
      on {machine.name} · {pin.dir}
    </span>
  );
}

/**
 * The other kururus — a child on a box that stays on, or the Mac seen from
 * a child — each under a heading of its name, drawn from the summary it last
 * pushed over its link (`shared/nodes.ts`).
 *
 * Read-only, and every row a link: the agents here are another server's, so
 * nothing on this side can type into them, and going to the node is how
 * anything there is done. A node that is away keeps its last summary,
 * greyed, with since when — which, on a child with the Mac's lid shut, is the
 * answer to "is the Mac there".
 *
 * A workspace is a row with its agents' marks, and the dot when something in
 * it needs you, which is the node's own `needsOf` band, not a rule redone
 * here. An agent's mark is the default mascot's: which mascot a workspace
 * wears there is that node's, and not worth a field on the wire.
 */
function Nodes({ mascots }: { mascots: MascotSet }) {
  const { nodes } = useKururu();
  const [open, toggle] = useDisclosure("kururu.sidebar.nodes", true);
  if (!nodes || nodes.nodes.length === 0) return null;
  const away = nodes.nodes.some((node) => node.state !== "up");
  return (
    <section className="side-section side-nodes">
      <h2>
        <SectionToggle open={open} onToggle={toggle} label="Nodes">
          {away && (
            <span className="usage-stale" title="A node is not linked. What it shows is the last it said.">
              ·
            </span>
          )}
        </SectionToggle>
      </h2>
      {open && (
        <ul className="node-list">
          {nodes.nodes.map((node) => (
            <NodeBlock key={node.id} node={node} mascot={mascotFor(mascots, null)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function NodeBlock({ node, mascot }: { node: NodeStatus; mascot: ReturnType<typeof mascotFor> }) {
  const up = node.state === "up";
  const summary = node.summary;
  const go = `Open ${node.name}'s kururu`;
  return (
    <li className={`node-item ${up ? "" : "node-stale"}`}>
      <a className="node-head" href={node.url} target="_blank" rel="noreferrer noopener" title={[go, node.error && !up ? node.error : null].filter(Boolean).join("\n")}>
        <span className="node-name">{node.name}</span>
        {!up && <span className="node-state">{nodeState(node)}</span>}
        {up && summary && summary.needs.count > 0 && <span className="unread" aria-label="needs you" />}
      </a>
      {summary ? (
        <ul className="node-workspaces">
          {summary.workspaces.map((w) => (
            <li key={w.key}>
              <a className="node-ws" href={node.url} target="_blank" rel="noreferrer noopener" title={[w.name, w.folder].filter(Boolean).join("\n")}>
                <span className="node-ws-name">{w.name}</span>
                <span className="node-marks">
                  {w.agents.map((agent) => (
                    <span key={agent.id} className="node-mark" title={[agentLabel(asAgent(agent)), agentSummary(asAgent(agent))].filter(Boolean).join(" · ")}>
                      <Status agent={asAgent(agent)} mascot={mascot} />
                    </span>
                  ))}
                </span>
                {w.band === "needs" && <span className="unread" aria-label="needs you" />}
              </a>
            </li>
          ))}
          {summary.workspaces.length === 0 && <li className="node-empty">No workspaces.</li>}
        </ul>
      ) : (
        <p className="node-empty">{up ? "Waiting for what it is doing…" : "Not heard from since this server started."}</p>
      )}
    </li>
  );
}
/** How long a dev server's stop button keeps asking before it lets the question go. */
const STOP_ASK_MS = 4000;

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
 *
 * Each row can also be stopped, with a square beside the link that asks in
 * place before it does anything. The list is machine-wide, so the server under
 * a thumb may be one an agent in another profile is in the middle of using, and
 * a tap meant for the link that landed a few pixels right should cost nothing.
 * The question takes itself back after a few seconds rather than waiting for a
 * blur, because a tap on a phone does not focus a button and there would be no
 * blur to wait for — an armed button left lying there is the accident it was
 * meant to prevent, a little later.
 */
function DevServers() {
  const { devServers } = useKururu();
  /* Shut by default. The list is the phone's way in and is a thing you go and
     get, not a thing you watch — so the count is what the heading carries, and
     the rows are one press away. */
  const [open, toggle] = useDisclosure("kururu.sidebar.dev", false);
  /** The port whose stop button is asking "sure?". */
  const [asking, setAsking] = useState<number | null>(null);
  const [stopping, setStopping] = useState<readonly number[]>([]);
  /** Why the last stop did not happen, on the row it was for. */
  const [said, setSaid] = useState<{ port: number; text: string } | null>(null);

  useEffect(() => {
    if (asking === null) return;
    const timer = setTimeout(() => setAsking(null), STOP_ASK_MS);
    return () => clearTimeout(timer);
  }, [asking]);

  if (devServers.length === 0) return null;

  const stop = (dev: DevServer) => {
    setAsking(null);
    setSaid(null);
    setStopping((ports) => [...ports, dev.port]);
    api
      .stopDevServer(dev.port, dev.pid)
      .catch((err: unknown) => setSaid({ port: dev.port, text: err instanceof Error ? err.message : String(err) }))
      .finally(() => setStopping((ports) => ports.filter((port) => port !== dev.port)));
  };

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
            const armed = asking === dev.port;
            const busy = stopping.includes(dev.port);
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
                <button
                  className={`dev-stop ${armed ? "dev-stop-ask" : ""} ${busy ? "dev-stop-busy" : ""}`}
                  disabled={busy}
                  onClick={() => (armed ? stop(dev) : setAsking(dev.port))}
                  onBlur={() => setAsking((port) => (port === dev.port ? null : port))}
                  title={busy ? "Stopping…" : armed ? `Stop ${dev.command}` : `Stop this dev server\n${dev.command}`}
                  aria-label={armed ? `Confirm: stop ${previewLabel(dev)}` : `Stop ${previewLabel(dev)}`}
                >
                  {armed ? "Stop?" : <Icon name="stop" />}
                </button>
                {said?.port === dev.port && (
                  <button className="dev-said" onClick={() => setSaid(null)} title="Click to dismiss">
                    {said.text}
                  </button>
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
 * Which workspaces' groups of agents are folded, remembered per device.
 *
 * A set of the folded rather than of the open, so that a workspace made on
 * another client arrives open: a new group you cannot see the agents in is a
 * new agent you do not notice. Ids of workspaces since deleted stay in the set
 * and cost nothing — they name no group, so nothing reads them.
 *
 * The workspace groups use it too, under their own key and by name.
 *
 * The third thing it hands back folds or opens many at once, for the button
 * that does every group. It writes only the ids it is given, never the whole
 * set: the key is per device rather than per profile, so "open everything"
 * meaning "empty the set" would open the groups of profiles you are not in.
 */
function useFolded(
  key = "kururu.sidebar.folded",
): [ReadonlySet<string>, (id: string) => void, (ids: readonly string[], shut: boolean) => void] {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : []);
    } catch {
      return new Set();
    }
  });
  const change = (edit: (next: Set<string>) => void) =>
    setFolded((was) => {
      const next = new Set(was);
      edit(next);
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        // Not remembered; still folded.
      }
      return next;
    });
  const toggle = (id: string) =>
    change((next) => {
      if (!next.delete(id)) next.add(id);
    });
  const setMany = (ids: readonly string[], shut: boolean) =>
    change((next) => {
      for (const id of ids) {
        if (shut) next.add(id);
        else next.delete(id);
      }
    });
  return [folded, toggle, setMany];
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

/**
 * What the main checkout has not finished, at the end of the name's line:
 * files not committed (`±`, the dirty mark shell prompts have long used), and
 * commits not pushed (`↑`) or not pulled (`↓`) — the arrows the ⋯ menu's Push
 * and Pull carry. Nothing at all when there is nothing, so a clean row is just
 * its name.
 *
 * Counts rather than a coloured dot, which is what the git button was: a dot
 * on a row in this list already means an agent is waiting for you, and "how
 * much" is the next question anyway. Always drawn, unlike the ⋯, because it
 * is the one thing on the row worth noticing without going to look. Ahead
 * and behind only count against an upstream; a branch with none says so in
 * the tooltip, not with a mark that would sit on every local-only repository
 * for good. Inside the row's button, so it is part of what a click goes to.
 */
function GitMarks({ git }: { git: RepoGit }) {
  const ahead = git.upstream ? git.ahead : 0;
  const behind = git.upstream ? git.behind : 0;
  if (!git.changes && !ahead && !behind) return null;
  return (
    <span className="ws-marks" title={gitTitle(git)}>
      {git.changes > 0 && <span className="ws-mark-dirty">±{git.changes}</span>}
      {ahead > 0 && <span className="ws-mark-moved">↑{ahead}</span>}
      {behind > 0 && <span className="ws-mark-moved">↓{behind}</span>}
    </span>
  );
}

function gitTitle(git: RepoGit): string {
  const parts = [git.detached ? `detached at ${git.branch}` : git.branch];
  parts.push(git.changes ? `${git.changes} uncommitted` : "nothing to commit");
  if (git.upstream) {
    if (git.ahead) parts.push(`${git.ahead} to push`);
    if (git.behind) parts.push(`${git.behind} to pull`);
  } else if (!git.detached) {
    parts.push("not pushed yet");
  }
  return `${parts.join(" · ")}\n${git.root}`;
}

/**
 * The ⋯ menu's git rows. The three that commit ask for a message first — and
 * only when there is something to commit: a clean tree with commits to merge
 * or push runs straight away, because a prompt for a message that will not be
 * used is a question with no answer. Merge is offered only when there is a
 * main branch that is not the one already out.
 */
function gitItems(
  git: RepoGit | null,
  act: (root: string, action: GitAction, message?: string) => void,
  prompt: (state: DialogState) => void,
): MenuItem[] {
  if (!git) return [{ label: "Not a git repository", disabled: true, run: () => undefined }];
  const run = (action: GitAction, message?: string) => act(git.root, action, message);
  const files = `${git.changes} file${git.changes === 1 ? "" : "s"}`;
  const withMessage = (action: GitAction, title: string, submitLabel: string) => () =>
    prompt({
      kind: "prompt",
      title,
      hint: `${files} on ${git.branch}, in ${git.root}`,
      value: "",
      placeholder: "What this commit does",
      submitLabel,
      onSubmit: (message) => {
        if (message.trim()) run(action, message);
      },
    });
  const detached = git.detached;
  const items: MenuItem[] = [
    {
      label: git.changes ? "Commit…" : "Nothing to commit",
      hint: git.changes ? String(git.changes) : undefined,
      disabled: !git.changes || detached,
      run: withMessage("commit", `Commit to ${git.branch}`, "Commit"),
    },
  ];
  if (git.base) {
    items.push({
      label: git.changes ? `Commit & merge into ${git.base}…` : `Merge into ${git.base}`,
      disabled: detached,
      run: git.changes
        ? withMessage("commit-merge", `Commit, then merge ${git.branch} into ${git.base}`, "Commit & merge")
        : () => run("commit-merge"),
    });
  }
  if (git.changes) {
    items.push({
      label: "Commit & push…",
      disabled: detached,
      run: withMessage("commit-push", `Commit, then push ${git.branch}`, "Commit & push"),
    });
  }
  items.push(
    {
      label: "Pull",
      sep: true,
      hint: git.behind ? `↓${git.behind}` : undefined,
      disabled: detached || !git.upstream,
      run: () => run("pull"),
    },
    {
      label: git.upstream ? "Push" : "Publish branch",
      hint: git.ahead ? `↑${git.ahead}` : undefined,
      disabled: detached,
      run: () => run("push"),
    },
    { label: "Fetch", run: () => run("fetch") },
  );
  return items;
}
