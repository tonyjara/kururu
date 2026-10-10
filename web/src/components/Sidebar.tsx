/**
 * Everything in this profile: its workspaces, and every terminal running in it.
 *
 * Two lists rather than a tree, and that is deliberate. The workspaces are the
 * structure — numbered, because prefix+1..9 jump to them and a number you cannot
 * see is a shortcut you do not use. The agents span the whole profile, because
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
 */
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { panes } from "../../../shared/layout";
import type {
  AgentSnapshot,
  ContextUsage,
  MascotSet,
  Profile,
  Workspace,
  WorkspaceColor,
} from "../../../shared/model";
import { defaultMascot, mascotFor, WORKSPACE_COLORS, workspaceUnits } from "../../../shared/model";
import type { AccountUsage, DevServer, GitAction, RepoGit } from "../../../shared/wire";
import type { WorkspaceDatabase } from "../../../shared/databases";
import { formatBytes as formatSize, machineSeverity, type MachineStatus, type MachineUsed } from "../../../shared/machines";
import {
  balanceOf,
  balanceSeverity,
  formatDollars,
  formatRunway,
  runway,
  type OpenRouterReading,
} from "../../../shared/openrouter";
import type { MissedReply, OutboxEntry } from "../../../shared/voice";
import { colorValue, colorValues } from "../colors";
import { AGENT_MIME, GROUP_MIME, WORKSPACE_MIME, allowDrop, beginDrag, endDrag, useDragging } from "../drag";
import type { Action } from "../keys";
import { agentLabel, agentSummary, shortenPath } from "../labels";
import { previewLabel, previewUrl } from "../preview";
import * as api from "../session";
import { useKururu } from "../session";
import { limitLabel, limitMarks, limitTitle, resetIn, staleTitle } from "../usage";
import { Menu, Popover, type MenuItem } from "./Menu";
import type { DialogState } from "./Dialog";
import { Icon } from "./Icon";
import { MicIcon, SpeakerIcon } from "./VoiceIcons";
import { useOutgoing, useVoiceUi, voiceIsRemote, type Outgoing } from "../voice";
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
   * The database button on a row: the workspace's env files name at least one,
   * and the sheet that opens is the app's, like the profile's board — it goes
   * over the window, and on a phone the sidebar is put away first.
   */
  onDatabases: (workspaceId: string) => void;
  /**
   * Say when a name is being typed in here, because the prefix has to stand
   * down for it: ctrl+a is select-all in a text field, and an armed prefix would
   * swallow the next letter as a command.
   */
  onEditing: (editing: boolean) => void;
  /**
   * Put a question up — the commit message, for the git button. The dialog is
   * the app's, for the reason the delete confirmation is: while it is up no key
   * reaches a pty, and that is a promise only the app can keep.
   */
  onPrompt: (state: DialogState) => void;
  /** Opens the settings dialog. The corner is the only way in. */
  onSettings: () => void;
  /** Opens the phone dialog — the addresses this server answers at, as QR codes. */
  onReach: () => void;
  /** Opens the profile's own board — see `ProfileBoard`. */
  onBoard: () => void;
  /** Starts or goes to the profile's harness — see `shared/harness.ts`. */
  onHarness: () => void;
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
  onHarness,
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
  const { branches, databases, machines, missed, outbox } = useKururu();
  const heads = new Map(branches.map((head) => [head.workspaceId, head] as const));
  /** Kuru's replies in this profile that nobody played to their end — the harness button's badge. See `Voice.review`. */
  const missedHere = missed.filter((reply) => reply.profileId === profile.id);
  /** Your messages to Kuru in this profile, newest first: the server's, and the ones this page has not got to it yet. See `outbox.ts`. */
  const outgoing = useOutgoing();
  const talk = useVoiceUi();
  const saidHere = mineIn(profile.id, outbox, outgoing);
  const failedHere = saidHere.filter((m) => m.state === "failed").length;
  const movingHere = saidHere.some((m) => m.state !== "delivered" && m.state !== "failed");
  /** Where the lists behind those badges are open, and which was asked for — it goes first. */
  const [missedAt, setMissedAt] = useState<{ x: number; y: number; first: "mine" | "missed" } | null>(null);
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
  /** Where a context menu is open, and which row it belongs to. */
  const [menu, setMenu] = useState<{ workspaceId: string; x: number; y: number } | null>(null);
  /** Where a git button's menu is open, and whose checkout it acts on. */
  const [gitMenu, setGitMenu] = useState<{ workspaceId: string; x: number; y: number } | null>(null);
  /** The workspace whose git verb is still running — its button says so, and takes no second one. */
  const [gitBusy, setGitBusy] = useState<string | null>(null);
  /**
   * What the last git verb came to, in place of the branch line until it is
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
  const harnessId = profile.harness?.agentId;
  const harnessLive = harnessId !== undefined && harnessId !== null && agents.some((agent) => agent.id === harnessId && !agent.exited);
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
   * Which colour each workspace is wearing, so an agent row can rule a line in
   * the colour of the workspace it lives in without walking the tree again.
   */
  const tint = new Map(profile.workspaces.map((w) => [w.id, colorValue(w.color)] as const));

  /**
   * Whether the Agents heading's fold-everything button opens rather than
   * folds: only when every group drawn is already shut, so a list with one
   * group left open is still a list it would tidy. It asks of the groups on
   * screen and acts on them alone — folding a workspace with nothing in it
   * would hide the first agent it ever gets, which is the thing `useFolded` is
   * careful not to do.
   */
  const agentsFolded = groups.length > 0 && groups.every((group) => folded.has(group.id));

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
          <span className="agent-group-n">{members.length}</span>
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
          <span className={`agent-top ${hiddenHere ? "" : "agent-top-grouped"}`}>
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
        {/* The profile's harness, beside its board for the same reason: it is
            the profile's, over every workspace. One button whatever its state —
            start, resume or go to — because the user means one thing by it.
            Lit while it runs, so a glance says whether there is anybody home. */}
        <span className="profile-harness">
          <button
            className={`profile-board-btn profile-harness-btn${harnessLive ? " profile-harness-live" : ""}`}
            onClick={onHarness}
            title={harnessLive ? "Go to this profile's harness (C-a H)" : "Start this profile's harness (C-a H)"}
            aria-label={`${profile.name}'s harness`}
            aria-pressed={harnessLive}
          >
            <Icon name="bot" />
          </button>
          {/* What Kuru said that nobody heard to the end: cut off, dismissed,
              or said with no window listening. A button of its own on the
              harness button's corner rather than a count inside it, because
              the harness button goes to the harness and this goes to what
              it said — two places, two targets. */}
          {missedHere.length > 0 && (
            <button
              className="profile-missed"
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                setMissedAt({ x: box.left, y: box.bottom + 4, first: "missed" });
              }}
              title={`${missedHere.length} ${missedHere.length === 1 ? "reply" : "replies"} from Kuru you did not hear`}
              aria-label={`${missedHere.length} missed ${missedHere.length === 1 ? "reply" : "replies"}`}
            >
              {missedHere.length}
            </button>
          )}
          {/* Your messages to Kuru, on the other corner: the other way round
              from the badge above it, and drawn so. A count only when some
              did not get through, since that is the one you act on; a dot
              while one is on its way, and a quiet one once they all arrived,
              so the list is always a click away to see that one did. */}
          {saidHere.length > 0 && (
            <button
              className={`profile-said${failedHere ? " profile-said-failed" : movingHere ? " profile-said-moving" : ""}`}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                setMissedAt({ x: box.left, y: box.bottom + 4, first: "mine" });
              }}
              title={saidTitle(saidHere)}
              aria-label={`Your messages to Kuru: ${saidTitle(saidHere)}`}
            >
              {failedHere > 0 ? failedHere : ""}
            </button>
          )}
        </span>
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

                 A click that landed on the git button is not this: it means
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
                    <span className="ws-index">{index < 9 ? index + 1 : "\u00b7"}</span>
                    {mascotted && <WorkspaceMascot mascots={mascots} mascotId={workspace.mascotId} />}
                    <span className="ws-name">{workspace.name}</span>
                  </button>

                  {/* The main checkout's git, as a control, at the end of the
                      name's line — where the colour swatch was, which lives on
                      in the row's menu and in the rail down its left edge.
                      Its colour is the answer to "is there anything to commit",
                      asked of the main checkout and never of a card's worktree:
                      those are the board's to commit and merge, and a button
                      that changed colour whenever focus crossed into one would
                      be saying something about the wrong checkout.

                      Only in a repository, since there is nothing for it to do
                      anywhere else. Outside the row's own button, because a
                      button inside a button is not a thing the platform will
                      give you. */}
                  {(head?.git || dbCount.get(workspace.id)) && (
                    <span className="ws-tools">
                      {/* The workspace's databases, to the left of git: drawn
                          only when its env files name one, and the sheet it
                          opens is the app's. The count is how many places,
                          not how many files — two files pointing at one
                          database are one database. */}
                      {(dbCount.get(workspace.id) ?? 0) > 0 && (
                        <button
                          className="ws-db"
                          onClick={() => onDatabases(workspace.id)}
                          title={dbTitle(databases.filter((db) => db.workspaceId === workspace.id))}
                          aria-label={`Databases: ${dbCount.get(workspace.id)}`}
                        >
                          <Icon name="database" />
                        </button>
                      )}
                      {head?.git && (
                        <button
                          className={`ws-git ${gitTone(head.git)} ${gitBusy === workspace.id ? "ws-git-busy" : ""}`}
                          disabled={gitBusy === workspace.id}
                          onClick={(event) => {
                            const box = event.currentTarget.getBoundingClientRect();
                            setGitMenu({ workspaceId: workspace.id, x: box.left, y: box.bottom + 4 });
                          }}
                          title={gitTitle(head.git)}
                          aria-label={`Git: ${gitTitle(head.git)}`}
                        >
                          <Icon name="git" />
                        </button>
                      )}
                    </span>
                  )}

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
                  {gitSaid?.workspaceId === workspace.id ? (
                    <button
                      className={`ws-branch ws-said ${gitSaid.error ? "ws-said-error" : ""}`}
                      onClick={() => setGitSaid(null)}
                      title={`${gitSaid.text}\nClick to dismiss`}
                    >
                      {gitSaid.text}
                    </button>
                  ) : head ? (
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
                  ) : (
                    /* A workspace pinned to a machine has no branch here — its
                       shells are on the machine, and nothing reads that disk —
                       so the line says where they are instead. A branch wins
                       when there is one: an agent started here, in a repository,
                       is the more specific fact. */
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
            const bar = tint.get(group.id);
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
                  style={bar ? ({ "--tag": bar } as CSSProperties) : undefined}
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
                  <span className="agent-group-n">{group.agents.length}</span>
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

      <Usage />
      <OpenRouter />
      <Machines />
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
            /* Within its group: a step across the edge would take the
               neighbour's group with it (`moveWorkspace`), and filing is what
               the rows below are for. */
            {
              label: "Move up",
              disabled: profile.workspaces[menuAt - 1]?.group !== menuWorkspace.group,
              run: () => api.moveWorkspace(menuWorkspace.id, menuAt - 1),
            },
            {
              label: "Move down",
              disabled: profile.workspaces[menuAt + 1]?.group !== menuWorkspace.group,
              run: () => api.moveWorkspace(menuWorkspace.id, menuAt + 1),
            },
            { label: "New group…", sep: true, run: () => newGroup(menuWorkspace.id) },
            ...groupNames
              .filter((name) => name !== menuWorkspace.group)
              .map((name) => ({
                label: `Move to ${name}`,
                run: () => api.setWorkspaceGroup(menuWorkspace.id, name),
              })),
            ...(menuWorkspace.group !== null
              ? [{ label: "Remove from group", run: () => api.setWorkspaceGroup(menuWorkspace.id, null) }]
              : []),
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

      {missedAt && (missedHere.length > 0 || saidHere.length > 0) && (
        <VoiceLists
          at={missedAt}
          first={missedAt.first}
          mine={saidHere}
          recording={talk.phase === "listening" && !voiceIsRemote()}
          replies={missedHere}
          onPlay={() => {
            api.playMissed(profile.id);
            setMissedAt(null);
          }}
          onClear={() => {
            api.clearMissed(profile.id);
            setMissedAt(null);
          }}
          onClose={() => setMissedAt(null)}
        />
      )}
      {gitMenu && (
        <Menu
          at={gitMenu}
          onClose={() => setGitMenu(null)}
          items={gitItems(heads.get(gitMenu.workspaceId)?.git ?? null, (root, action, message) => {
            const workspaceId = gitMenu.workspaceId;
            setGitBusy(workspaceId);
            setGitSaid(null);
            api
              .workspaceGit(workspaceId, root, action, message)
              .then(
                (text) => setGitSaid({ workspaceId, text, error: false }),
                (err: unknown) =>
                  setGitSaid({ workspaceId, text: err instanceof Error ? err.message : String(err), error: true }),
              )
              .finally(() => setGitBusy((busy) => (busy === workspaceId ? null : busy)));
          }, onPrompt)}
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
 * One of your messages as the list draws it: the outbox's, or a clip this
 * page holds that the server has not taken yet (`saving`).
 */
type Mine = Omit<OutboxEntry, "state"> & { state: OutboxEntry["state"] | "saving" };

/** A profile's messages, newest first, the server's record winning over this page's for a clip both know. */
function mineIn(profileId: string, outbox: readonly OutboxEntry[], outgoing: readonly Outgoing[]): Mine[] {
  const known = new Set(outbox.map((e) => e.id));
  const pending: Mine[] = outgoing
    .filter((c) => c.profileId === profileId && !known.has(c.id))
    .map((c) => ({
      id: c.id,
      profileId: c.profileId,
      at: c.at,
      ms: c.ms,
      state: "saving",
      text: null,
      lang: null,
      typedAt: null,
      note: c.error ? `Not with the server yet (${c.error}). Kept on this device and sent again until it is.` : null,
    }));
  return [...outbox.filter((e) => e.profileId === profileId), ...pending].sort((a, b) => b.at - a.at);
}

/** What the corner button says when hovered: how many arrived, how many are on their way, how many did not. */
function saidTitle(mine: readonly Mine[]): string {
  const count = (state: (m: Mine) => boolean) => mine.filter(state).length;
  const parts = [
    [count((m) => m.state === "failed"), "did not get through"],
    [count((m) => m.state !== "delivered" && m.state !== "failed"), "on the way"],
    [count((m) => m.state === "delivered"), "delivered"],
  ] as const;
  return parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`).join(", ");
}

const MINE_LABEL: Record<Mine["state"], string> = {
  saving: "Saving",
  transcribing: "Transcribing",
  queued: "Queued",
  delivered: "Delivered",
  failed: "Failed",
};

/**
 * The two lists behind the harness button: what you said to Kuru, and what
 * Kuru said that you did not hear. One box, because they are the two halves
 * of one conversation and the question that opens either is "did that get
 * through?" — but two sections, each headed by which way the words went and
 * drawn with who said them, a microphone or a speaker, because the one thing
 * that must not happen is a reply read as a message of yours or the other way
 * round. Whichever badge was clicked goes first.
 *
 * **Your messages**, newest first, each with what became of it: recording,
 * saving (not with the server yet, kept on this device), transcribing,
 * queued (waiting for Kuru, or typed and waiting for it to take it),
 * delivered, failed. A failed one can be sent again — heard again if it has
 * no words, handed to Kuru again if it has — or discarded with its audio.
 *
 * **Kuru's replies you missed**, oldest first, to read or hear again. "Play"
 * says them in order, each starting "Earlier", and each leaves the list once
 * it is heard to its end — the same thing asking Kuru "what did I miss?"
 * does through its `play_missed` tool. "Clear" is having read them. Opening
 * the list is not, since a glance is not reading.
 */
function VoiceLists({
  at,
  first,
  mine,
  recording,
  replies,
  onPlay,
  onClear,
  onClose,
}: {
  at: { x: number; y: number };
  first: "mine" | "missed";
  mine: readonly Mine[];
  recording: boolean;
  replies: readonly MissedReply[];
  onPlay: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const said = (mine.length > 0 || recording) && (
    <section className="voice-list voice-list-mine" aria-label="Your messages to Kuru">
      <h3 className="voice-list-head">
        <MicIcon />
        <span>Your messages to Kuru</span>
      </h3>
      <ol className="missed-list">
        {recording && (
          <li className="missed-item said-item">
            <span className="said-meta">
              <span className="said-state said-state-recording">Recording</span>
            </span>
          </li>
        )}
        {mine.map((m) => (
          <li key={m.id} className="missed-item said-item">
            <span className="said-meta">
              <span className={`said-state said-state-${m.state}`}>{MINE_LABEL[m.state]}</span>
              <time className="missed-at" dateTime={new Date(m.at).toISOString()}>
                {saidAt(m.at)} · {clipLength(m.ms)}
              </time>
            </span>
            {m.text ? <span className="missed-text">{m.text}</span> : <span className="said-pending">Not in words yet — the audio is kept.</span>}
            {m.note && m.state !== "delivered" && <span className="said-note">{m.note}</span>}
            {m.state === "failed" && (
              <span className="said-actions">
                <button className="menu-item" onClick={() => api.resendVoice(m.id)}>
                  <span className="menu-label">{m.text ? "Resend" : "Listen again"}</span>
                </button>
                <button className="menu-item" onClick={() => api.discardVoice(m.id)}>
                  <span className="menu-label">Discard</span>
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
  const missed = replies.length > 0 && (
    <section className="voice-list voice-list-missed" aria-label="Kuru's replies you did not hear">
      <h3 className="voice-list-head">
        <SpeakerIcon />
        <span>Kuru's replies you didn't hear</span>
      </h3>
      <ol className="missed-list">
        {replies.map((reply) => (
          <li key={reply.id} className="missed-item">
            <time className="missed-at" dateTime={new Date(reply.at).toISOString()}>
              {saidAt(reply.at)}
            </time>
            <span className="missed-text">{reply.text}</span>
          </li>
        ))}
      </ol>
      <div className="missed-actions">
        <button className="menu-item" onClick={onPlay}>
          <Icon name="play" />
          <span className="menu-label">Play {replies.length === 1 ? "it" : `all ${replies.length}`}</span>
        </button>
        <button className="menu-item" onClick={onClear}>
          <span className="menu-label">Clear</span>
        </button>
      </div>
    </section>
  );
  // Scrolling the list is scrolling, not a hint to close — unlike the
  // right-click menu's backdrop, which closes on a scroll because the row it
  // points at may have just moved under it.
  return (
    <Popover at={at} onClose={onClose} className="menu missed" role="dialog" closeOnScroll={false}>
      {first === "mine" ? said : missed}
      {first === "mine" ? missed : said}
    </Popover>
  );
}

/** How long a clip runs, as a clock: 0:07, 4:32. */
function clipLength(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The time a reply was said: the clock today, and the day before that. */
function saidAt(at: number): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return when.toDateString() === new Date().toDateString() ? time : `${when.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
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
export function ColorPicker({
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
      {/* Shut, every limit as a ring on one line, the machine row's shape. It used
          to be the session's bar alone, on the argument that the weeks move by
          a percent an afternoon; but a ring is small enough that the weeks cost
          nothing to keep in view, and the week is the one that ends an
          afternoon outright when it runs out. The reset countdowns go to the
          tooltips — open is where they are read. */}
      {open ? (
        <ul className="usage-list">
          {account.limits.map((limit) => (
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
      ) : (
        <ul className="usage-list">
          <UsageRings account={account} />
        </ul>
      )}
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
 * The shut usage row: whose allowance on the left, a ring per limit on the
 * right. Named "Claude" rather than left blank because the heading already says
 * "Usage", and what the row has to add is which account it is — the email is
 * the name's tooltip, as the host is a machine name's.
 */
function UsageRings({ account }: { account: AccountUsage }) {
  const marks = limitMarks(account.limits);
  return (
    <li className="gauge-item">
      <span className="gauge-name" title={account.email ?? undefined}>
        Claude
      </span>
      <span className="gauge-rings">
        {account.limits.map((limit, i) => {
          const reset = limit.resetsAt ? resetIn(limit.resetsAt) : "";
          return (
            <GaugeRing
              key={`${limit.kind}:${limit.scope ?? ""}`}
              label={limitLabel(limit)}
              mark={marks[i] ?? ""}
              percent={limit.percent}
              severity={limit.severity}
              title={`${limitLabel(limit)}${reset ? ` — ${reset}` : ""}\n${limitTitle(limit)}`}
            />
          );
        })}
      </span>
    </li>
  );
}

/**
 * The OpenRouter account: what is left, and how fast it is going.
 *
 * Words rather than a bar, which is the departure from the two sections either
 * side of it, and it is because a balance has no whole to be a share of.
 * `credits` is every dollar ever bought, so spent-over-bought is a bar that
 * creeps toward full for the life of the account and says nothing about this
 * week. A balance in dollars, coloured by how many days it lasts at the pace it
 * is going, says the thing — `balanceSeverity` has those days.
 *
 * Shut, the balance and today's spend on one line, which is the glance. Open,
 * the week and the month under it, the pace in words, and which key is asking.
 *
 * Draws nothing until a key has been given in Settings, like the machines section.
 */
function OpenRouter() {
  const { openrouter } = useKururu();
  const [open, toggle] = useDisclosure("kururu.sidebar.openrouter", false);
  if (!openrouter) return null;
  const { reading, stale, error } = openrouter;

  return (
    <section className="side-section side-openrouter">
      <h2>
        <SectionToggle open={open} onToggle={toggle} label="OpenRouter">
          {error && (
            <span className="usage-stale" title={reading ? `${error}\nThe balance is the last one read.` : error}>
              ·
            </span>
          )}
        </SectionToggle>
      </h2>
      <ul className="usage-list">
        {reading ? (
          <OpenRouterBalance reading={reading} stale={stale} open={open} />
        ) : (
          <li className="usage-item">
            <span className="usage-head">
              <span className="usage-name">Balance</span>
              <span className="usage-used">{error ? "unreachable" : "…"}</span>
            </span>
            {error && <span className="usage-reset">{error}</span>}
          </li>
        )}
      </ul>
      {open && (
        <p className="usage-account" title="The management key reading this account">
          {openrouter.hint}
        </p>
      )}
    </section>
  );
}

function OpenRouterBalance({ reading, stale, open }: { reading: OpenRouterReading; stale: boolean; open: boolean }) {
  const pace = runway(reading);
  const title = [
    `${formatDollars(reading.used)} spent of ${formatDollars(reading.credits)} bought`,
    pace && `${formatRunway(pace.days)} left at ${formatDollars(pace.perDay)} a day — this ${pace.basis}'s pace`,
  ]
    .filter(Boolean)
    .join("\n");
  const spend = reading.spend;

  return (
    <>
      <li className={`usage-item ${stale ? "or-stale" : ""}`}>
        <span className="usage-head" title={title}>
          <span className="or-balance" data-severity={balanceSeverity(reading)}>
            {formatDollars(balanceOf(reading))} left
          </span>
          {!open && spend && <span className="usage-used">{formatDollars(spend.day)} today</span>}
        </span>
        {open && pace && (
          <span className="usage-reset">
            {formatRunway(pace.days)} at this {pace.basis}'s pace
          </span>
        )}
      </li>
      {open &&
        spend &&
        (
          [
            ["Today", spend.day],
            ["This week", spend.week],
            ["This month", spend.month],
          ] as const
        ).map(([label, amount]) => (
          <li key={label} className={`usage-item ${stale ? "or-stale" : ""}`}>
            <span className="usage-head">
              <span className="usage-name">{label}</span>
              <span className="usage-used">{formatDollars(amount)}</span>
            </span>
          </li>
        ))}
    </>
  );
}

/**
 * The machines somebody asked to watch — a VPS, a PC on the tailnet — a bar
 * each for CPU, memory and disk, and a button that opens a shell on one.
 *
 * Under the usage bars and drawn with their parts, because it is the same kind
 * of glance — a thing you notice on the way past rather than go and read — and
 * two gauges that look alike should mean alike: a fill is what is *spent*.
 *
 * Shut, one line per machine with the three percentages, which is enough to see
 * that nothing is on fire. Open, the bars.
 *
 * The shell button is on every row, reachable or not, and most of all when
 * not: a row that says ssh could not get in is fixed by answering ssh once in
 * a terminal — a host key, a passphrase, Tailscale's browser check — and the
 * button is that terminal, already pointed at the host.
 *
 * Draws nothing until one has been added in Settings, like the dev servers: an
 * empty section on every window for a feature most people never use is noise.
 * The disclosure keeps the key it had as the VPS section, so a section somebody
 * shut stays shut across the rename.
 */
/** "on omarchy1 · ~/code" under a pinned workspace's name, or nothing. */
function pinnedTo(workspace: Workspace, machines: MachineStatus[]): ReactNode {
  const pin = workspace.machine;
  const machine = pin ? machines.find((m) => m.id === pin.machineId) : undefined;
  if (!pin || !machine) return null;
  return (
    <span className="ws-branch" title={`New shells here open on ${machine.name} (ssh ${machine.host}), in ${pin.dir}, inside tmux`}>
      on {machine.name} · {pin.dir}
    </span>
  );
}

function Machines() {
  const { machines } = useKururu();
  const [open, toggle] = useDisclosure("kururu.sidebar.vps", true);
  if (machines.length === 0) return null;
  const failing = machines.some((machine) => machine.error);

  return (
    <section className="side-section side-machines">
      <h2>
        <SectionToggle open={open} onToggle={toggle} label="Machines">
          {failing && (
            <span className="usage-stale" title="A machine could not be reached. Its numbers are the last ones read.">
              ·
            </span>
          )}
        </SectionToggle>
      </h2>
      <ul className="machine-list">
        {machines.map((machine) => (
          <MachineRow key={machine.id} server={machine} open={open} />
        ))}
      </ul>
    </section>
  );
}

function MachineRow({ server, open }: { server: MachineStatus; open: boolean }) {
  const reading = server.reading;
  const title = [server.host, server.error && `Last attempt: ${server.error}`].filter(Boolean).join("\n");
  const name = server.panel ? (
    <a className="machine-name" href={server.panel} target="_blank" rel="noreferrer noopener" title={`${title}\n→ ${server.panel}`}>
      {server.name}
    </a>
  ) : (
    <span className="machine-name" title={title}>
      {server.name}
    </span>
  );
  const shell = (
    <button
      className="mini"
      onClick={() => void api.openMachineShell(server.id)}
      title={`Open a shell on ${server.name} in a new tab\nssh -t ${server.host}`}
      aria-label={`Shell on ${server.name}`}
    >
      <Icon name="terminal" />
    </button>
  );

  if (!reading) {
    return (
      <li className="machine-item">
        <span className="usage-head">
          {name}
          <span className="usage-used">
            {server.error ? "unreachable" : "…"}
            {shell}
          </span>
        </span>
        {server.error && <span className="machine-error">{server.error}</span>}
      </li>
    );
  }

  const cpu = reading.cpu;
  const mem = share(reading.mem);
  const disk = share(reading.disk);
  const memFigure = reading.mem && `${formatSize(reading.mem.used)} / ${formatSize(reading.mem.total)}`;
  const diskFigure = reading.disk && `${formatSize(reading.disk.used)} / ${formatSize(reading.disk.total)}`;

  /* Shut, a ring each on the name's own line — the same three figures and the
     same colours as the bars, in one row's height rather than four. */
  if (!open) {
    return (
      <li className={`machine-item gauge-item ${server.stale ? "machine-stale" : ""}`}>
        {name}
        <span className="gauge-rings">
          {cpu !== null && <MachineRing label="CPU" percent={cpu} figure={`${Math.round(cpu)}%`} />}
          {mem !== null && <MachineRing label="RAM" percent={mem} figure={memFigure ?? ""} />}
          {disk !== null && <MachineRing label="Disk" percent={disk} figure={diskFigure ?? ""} />}
          {shell}
        </span>
      </li>
    );
  }

  return (
    <li className={`machine-item ${server.stale ? "machine-stale" : ""}`}>
      <span className="usage-head">
        {name}
        {shell}
      </span>
      {cpu !== null && <MachineMeter label="CPU" percent={cpu} figure={`${Math.round(cpu)}%`} />}
      {mem !== null && memFigure && <MachineMeter label="RAM" percent={mem} figure={memFigure} />}
      {disk !== null && diskFigure && <MachineMeter label="Disk" percent={disk} figure={diskFigure} />}
      {server.error && <span className="machine-error">{server.error}</span>}
    </li>
  );
}

function MachineRing({ label, percent, figure }: { label: string; percent: number; figure: string }) {
  const rounded = Math.round(percent);
  return (
    <GaugeRing
      label={label}
      mark={label[0] ?? ""}
      percent={percent}
      severity={machineSeverity(percent)}
      title={`${label} ${rounded}% used${figure && figure !== `${rounded}%` ? ` — ${figure}` : ""}`}
    />
  );
}

/**
 * One figure as a ring, the context ring's shape: the shut form of a bar, for a
 * machine row and the usage row alike. The mark is a letter beside it rather than a
 * word, because three words and three rings do not fit beside a name in a
 * sidebar; the tooltip carries the whole sentence.
 */
function GaugeRing({
  label,
  mark,
  percent,
  severity,
  title,
}: {
  label: string;
  mark: string;
  percent: number;
  severity: string;
  title: string;
}) {
  const circumference = 2 * Math.PI * 5;
  const rounded = Math.round(percent);
  return (
    <span
      className="gauge-ring"
      role="meter"
      aria-label={`${label} used`}
      aria-valuenow={rounded}
      aria-valuemin={0}
      aria-valuemax={100}
      title={title}
    >
      <svg className="ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" data-severity={severity}>
        <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
        <circle
          cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2"
          strokeDasharray={`${(percent / 100) * circumference} ${circumference}`}
          transform="rotate(-90 7 7)"
          strokeLinecap="round"
        />
      </svg>
      <span className="gauge-ring-label">{mark}</span>
      <span className="gauge-ring-pct">{rounded}%</span>
    </span>
  );
}

function MachineMeter({ label, percent, figure }: { label: string; percent: number; figure: string }) {
  return (
    <div className="machine-meter">
      <span className="usage-head">
        <span className="usage-name">{label}</span>
        <span className="usage-used">{figure}</span>
      </span>
      <span
        className="usage-bar"
        role="meter"
        aria-label={`${label} used`}
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        title={`${Math.round(percent)}% used`}
      >
        <span className="usage-fill" data-severity={machineSeverity(percent)} style={{ width: `${percent}%` }} />
      </span>
    </div>
  );
}

/** Used as a percentage of total, or null when there is no total to be a share of. */
function share(part: MachineUsed | null): number | null {
  if (!part || part.total <= 0) return null;
  return Math.min(100, (part.used / part.total) * 100);
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
 * The git button's colour: something to commit, something to push or pull,
 * or nothing. Uncommitted wins over the rest because it is the one a merge
 * or a push would leave behind.
 */
/** The tooltip on the database button: one line per place, file first. */
function dbTitle(dbs: WorkspaceDatabase[]): string {
  return dbs.map((db) => `${db.files.join(", ")} → ${db.host}/${db.database}`).join("\n");
}

function gitTone(git: RepoGit): string {
  if (git.changes) return "ws-git-dirty";
  if (git.ahead || git.behind) return "ws-git-moved";
  return "";
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
 * The git button's menu. The three that commit ask for a message first — and
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
