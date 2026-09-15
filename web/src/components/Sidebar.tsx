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
 * A workspace row also answers the two gestures every list of named things
 * answers: double-click renames it in place, and right-click opens the menu of
 * what else can be done to it. Both are second doors onto the prefix keymap
 * rather than a second implementation — the rename sends the same message
 * prefix+W does — and they exist because a keymap is worth nothing until it has
 * been learnt, and a row has no room to print five buttons.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { panes } from "../../../shared/layout";
import type {
  AgentSnapshot,
  ContextUsage,
  MascotSet,
  Profile,
  ProfileSummary,
  WorkspaceColor,
} from "../../../shared/model";
import { defaultMascot, mascotFor, WORKSPACE_COLORS } from "../../../shared/model";
import { colorValue, colorValues } from "../colors";
import { AGENT_MIME, WORKSPACE_MIME, allowDrop, beginDrag, endDrag, useDragging } from "../drag";
import type { Action } from "../keys";
import { agentLabel, agentSummary, shortenPath } from "../labels";
import * as api from "../session";
import { Menu, Popover } from "./Menu";
import { Mascot, Status } from "./Status";

interface Props {
  profile: Profile;
  /**
   * Every profile, which this list needs for one thing only: a workspace can
   * borrow another profile's accounts, and a pointer draws nothing without the
   * name on the other end of it. The summaries are already in the snapshot for
   * the switcher, so this costs a prop rather than a request.
   */
  profiles: ProfileSummary[];
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
}

export function Sidebar({
  profile,
  profiles,
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
}: Props) {
  const dragging = useDragging();
  /** The workspace row a drop would land on, while something is over it. */
  const [overWorkspace, setOverWorkspace] = useState<string | null>(null);
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
  /** And for the profile a workspace borrows its accounts from. */
  const [identityMenu, setIdentityMenu] = useState<{
    workspaceId: string;
    x: number;
    y: number;
  } | null>(null);
  /**
   * Escape cancels a rename by blurring the field, which is also how enter and
   * clicking away commit one — so the commit lives in `blur` and this is what
   * tells it which of the three just happened.
   */
  const cancelled = useRef(false);

  /**
   * The profile each workspace's terminals open as, for the ones not opening as
   * the profile they live in. Absent is by far the common case and draws
   * nothing: a badge on every row would say only "these are your accounts",
   * which is what the profile name at the top of the sidebar already says.
   *
   * A pointer at a profile that has gone is absent too, because that is what the
   * server does with it — see `identityForWorkspace`. The sidebar agrees rather
   * than reporting it; a row is not where you would want to find that out.
   *
   * A map built once rather than a lookup per row, for the reason `mascotId` is
   * carried on `where` above: the answer is a search through every profile, and
   * the badge, its tooltip and the menu item all ask for it.
   */
  const borrowed = new Map<string, ProfileSummary>();
  for (const workspace of profile.workspaces) {
    const id = workspace.identityProfileId;
    if (!id || id === profile.id) continue;
    const lender = profiles.find((p) => p.id === id);
    if (lender) borrowed.set(workspace.id, lender);
  }

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
   * Which workspaces have something serving right now — the difference between
   * the row's ↻ and its ▸.
   *
   * Derived here rather than sent as a field of its own. The snapshot already
   * says which terminals hold a dev server and the map above already says which
   * workspace each terminal is in; a second field stating the conclusion is a
   * second field that can disagree with the two it was drawn from.
   */
  const serving = new Set<string>();
  for (const agent of agents) {
    const at = agent.dev ? where.get(agent.id) : undefined;
    if (at) serving.add(at.workspaceId);
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
   * Which colour each workspace is wearing, so an agent row can rule a line in
   * the colour of the workspace it lives in without walking the tree again.
   */
  const tint = new Map(profile.workspaces.map((w) => [w.id, colorValue(w.color)] as const));

  /** The row an open menu belongs to, and where it sits in the list. */
  const menuAt = menu ? profile.workspaces.findIndex((w) => w.id === menu.workspaceId) : -1;
  const menuWorkspace = menuAt === -1 ? null : profile.workspaces[menuAt]!;

  const show = (agentId: string) => {
    const at = where.get(agentId);
    if (!at) return;
    if (at.workspaceId !== profile.activeWorkspaceId) api.switchWorkspace(at.workspaceId);
    api.focusPane(at.paneId);
    api.selectTab(at.paneId, at.index);
  };

  return (
    <aside className="sidebar">
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
          <span className="profile-caret" aria-hidden>
            ▾
          </span>
        </button>
      </header>

      <section className="side-section">
        <h2>
          Workspaces
          <button className="mini" onClick={() => onRun("new-workspace")} title="New workspace (C-a C)">
            +
          </button>
        </h2>
        <ul className="ws-list">
          {profile.workspaces.map((workspace, index) => (
            <li
              key={workspace.id}
              className={overWorkspace === workspace.id ? "ws-over" : ""}
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
                <button
                  className={`ws-row ${workspace.id === profile.activeWorkspaceId ? "ws-row-on" : ""}`}
                  onClick={() => api.switchWorkspace(workspace.id)}
                  onDoubleClick={() => setRenaming(workspace.id)}
                  title={index < 9 ? `C-a ${index + 1} · double-click to rename` : "Double-click to rename"}
                  draggable
                  onDragStart={(event) => beginDrag(event, "workspace", workspace.id)}
                  onDragEnd={() => {
                    endDrag();
                    setOverWorkspace(null);
                  }}
                >
                  <span className="ws-index">{index < 9 ? index + 1 : "·"}</span>
                  <span className="ws-name">{workspace.name}</span>
                  {/* Whose accounts the next terminal in here opens as, when it
                      is not this profile's. Drawn inside the row rather than
                      beside it because it is a fact *about* the workspace and
                      not a control — the thing that changes it is the menu, and
                      a second clickable target on a row this size would be one
                      you hit by accident on a phone. */}
                  {borrowed.has(workspace.id) && (
                    <span
                      className="ws-identity"
                      title={`Opens terminals as ${borrowed.get(workspace.id)!.name}`}
                    >
                      {borrowed.get(workspace.id)!.name}
                    </span>
                  )}
                </button>
              )}
              {/* The dev server, if this workspace has ever had one. Outside the
                  row's button for the same reason the swatch is — a button
                  inside a button is not a thing the platform will give you, and
                  pressing this one must not also switch workspace. */}
              {renaming !== workspace.id && (workspace.dev || serving.has(workspace.id)) && (
                <button
                  className="ws-run"
                  onClick={() => api.runDev(workspace.id)}
                  /* The command is not printed on the row — it is the same `npm
                     run dev` in most workspaces and it cost the name half its
                     width — so the tooltip is where it goes. Either condition
                     draws the button, because the two arrive a moment apart: a
                     server is noticed before the directory it is running in has
                     been read, and a button that appeared a second after the ↻
                     it belongs to would read as arriving late. */
                  title={
                    serving.has(workspace.id)
                      ? `Restart ${workspace.dev?.command ?? "the dev server"}`
                      : `Run ${workspace.dev?.command ?? "the dev server"}`
                  }
                  aria-label={`${serving.has(workspace.id) ? "Restart" : "Run"} the dev server`}
                >
                  {serving.has(workspace.id) ? "↻" : "▸"}
                </button>
              )}
              {/* Under the number, and outside the row's own button rather than
                  inside it: a button within a button is not a thing the platform
                  will give you, and this one has to be clickable on its own —
                  hitting it must open the picker, not switch workspace. Drawn
                  even when untagged, as an empty outline, because a control that
                  only appears once it has been used is one nobody finds. */}
              {renaming !== workspace.id && (
                <button
                  className={`ws-swatch ${workspace.color ? "" : "ws-swatch-off"}`}
                  style={colorValue(workspace.color) ? { background: colorValue(workspace.color)! } : undefined}
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    setPicker({ workspaceId: workspace.id, x: box.left, y: box.bottom + 4 });
                  }}
                  title={workspace.color ? `Colour: ${workspace.color}` : "Set a colour"}
                  aria-label={workspace.color ? `Colour: ${workspace.color}` : "Set a colour"}
                />
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="side-section side-agents">
        <h2>Agents</h2>
        <ul className="agent-list">
          {listed.length === 0 && (
            <li className="muted sidebar-empty">
              {!connected
                ? "Reconnecting…"
                : agents.length > 0
                  ? "No agents yet — run one in a terminal."
                  : "Nothing running."}
            </li>
          )}
          {listed.map((agent) => {
            const at = where.get(agent.id);
            const focused = agent.id === focusedAgentId;
            const bar = at ? tint.get(at.workspaceId) : null;
            return (
              <li
                key={agent.id}
                className={`agent-item ${focused ? "agent-item-on" : ""}`}
                /* The rule down the left is the workspace's colour. It is a
                   variable rather than a border set here so the untagged case
                   still reserves the two pixels: rows that shift sideways when a
                   colour is assigned would make the list jump under the cursor. */
                style={bar ? ({ "--tag": bar } as React.CSSProperties) : undefined}
              >
                <button
                  className={`agent-row ${agent.exited ? "agent-row-exited" : ""}`}
                  onClick={() => show(agent.id)}
                  title={[agentLabel(agent), agentSummary(agent), agent.command, agent.cwd]
                    .filter(Boolean)
                    .join("\n")}
                  draggable
                  onDragStart={(event) => beginDrag(event, "agent", agent.id)}
                  onDragEnd={endDrag}
                >
                  {/* What it is and where it lives. The two things you need to
                      find it again, and nothing that changes while you read. */}
                  <span className="agent-top">
                    {/* The agent's own workspace, not the one you are looking
                        at: this list spans the whole profile, so two rows of it
                        can legitimately be wearing different mascots. */}
                    <Status agent={agent} mascot={mascotFor(mascots, at?.mascotId ?? null)} />
                    <span className="agent-name">{agentLabel(agent)}</span>
                    {agent.unread && <span className="unread" aria-label="new output" />}
                    <span className="agent-ws">{at ? at.workspace : "—"}</span>
                  </span>
                  {/* What it is doing, what it is costing, and how much room
                      it has left to do it in. All three change constantly, which
                      is why they are on their own line: a row whose top half is
                      stable is a row you can find something in without
                      re-reading it.

                      The cwd stands in only when nothing has said anything at
                      all — no hook has reported and the program has not named
                      its own window. An unreported agent would otherwise have a
                      blank line under it saying nothing, and where it is working
                      is the next most useful thing we know for certain. */}
                  <span className="agent-bottom">
                    <span className="agent-activity">
                      {agentSummary(agent) || shortenPath(agent.cwd)}
                    </span>
                    {agent.rss ? <Memory bytes={agent.rss} /> : null}
                    {agent.contextUsage && <ContextRing usage={agent.contextUsage} />}
                  </span>
                </button>
                <button
                  className="agent-kill"
                  onClick={() => api.closeTab(agent.id)}
                  title={agent.exited ? "Remove this tab" : "End this agent and close its tab"}
                  aria-label={agent.exited ? "Dismiss" : "Kill"}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {/* A new terminal used to be a button down here and is not one any more:
          the tab strip's `+` is in the place you are already looking when you
          want another tab, and C-a T and ⌘T are how it actually gets opened.
          What the corner is for instead is the thing with no other door. */}
      <div className="sidebar-foot">
        <button className="cog" onClick={onSettings} title="Settings" aria-label="Settings">
          <CogIcon />
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
          <QrIcon />
        </button>
      </div>

      {menu && menuWorkspace && (
        <Menu
          at={menu}
          onClose={() => setMenu(null)}
          items={[
            { label: "Rename", run: () => setRenaming(menuWorkspace.id) },
            {
              label: "Colour…",
              run: () => setPicker({ workspaceId: menuWorkspace.id, x: menu.x, y: menu.y }),
            },
            {
              label: "Mascot…",
              run: () => setMascotPicker({ workspaceId: menuWorkspace.id, x: menu.x, y: menu.y }),
            },
            {
              // The accounts, named by the profile that holds them. It says who
              // it is currently opening as rather than only offering to change
              // it, because the badge on the row is deliberately absent for the
              // ordinary case and this is then the only place that answers it.
              label: `Accounts: ${borrowed.get(menuWorkspace.id)?.name ?? profile.name}…`,
              run: () => setIdentityMenu({ workspaceId: menuWorkspace.id, x: menu.x, y: menu.y }),
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

      {/* Whose accounts this workspace's terminals open as: a list of profiles,
          with the one it is using marked. A list rather than a form, because
          what is being picked is one of the identities Settings already holds —
          three paths have one home and this points at it, so an account
          re-pointed there follows every workspace borrowing it.

          Nothing that is already running moves: the environment reaches a pty
          at spawn and at no other time, which is the same thing the profile's
          own identity says about itself and the reason neither needs an "are
          you sure". The next terminal in here is the one that changes. */}
      {identityMenu && (
        <Menu
          at={identityMenu}
          onClose={() => setIdentityMenu(null)}
          items={profiles.map((p) => ({
            label: p.id === profile.id ? `${p.name} (this profile)` : p.name,
            // Null for the profile the workspace lives in, rather than its id:
            // "I have not chosen" and "I chose the one I am in" are different
            // states, and only the first follows the workspace anywhere.
            mark: p.id === (borrowed.get(identityMenu.workspaceId)?.id ?? profile.id),
            run: () =>
              api.setWorkspaceIdentity(
                identityMenu.workspaceId,
                p.id === profile.id ? null : p.id,
              ),
          }))}
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
 * Eight swatches and a way back out of them.
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
 * A cog, drawn rather than imported: it is the only icon in the whole app, and a
 * dependency for one of them would be a dependency for one of them.
 */
function CogIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/**
 * A QR code, drawn as one — three finders and a scatter of modules.
 *
 * Not a phone, which is the other obvious glyph for this and the wrong one: a
 * phone icon says "there is a mobile app", and there is not. There is a code to
 * scan, and the icon is a small picture of the thing the button produces.
 */
function QrIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="15" y="3" width="6" height="6" rx="1" />
      <rect x="3" y="15" width="6" height="6" rx="1" />
      <path d="M15 15h2M19 15h2M15 19h2M19 19h2M17 17h2" />
    </svg>
  );
}
