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
import { useEffect, useRef, useState } from "react";
import { panes } from "../../../shared/layout";
import type { AgentSnapshot, ContextUsage, Profile, WorkspaceColor } from "../../../shared/model";
import { WORKSPACE_COLORS } from "../../../shared/model";
import { COLOR_VALUES, colorValue } from "../colors";
import { AGENT_MIME, WORKSPACE_MIME, allowDrop, beginDrag, endDrag, useDragging } from "../drag";
import type { Action } from "../keys";
import { agentLabel, shortenPath } from "../labels";
import * as api from "../session";
import { Menu, Popover } from "./Menu";
import { Status } from "./Status";

interface Props {
  profile: Profile;
  agents: AgentSnapshot[];
  connected: boolean;
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
}

export function Sidebar({
  profile,
  agents,
  connected,
  focusedAgentId,
  onRun,
  onDeleteWorkspace,
  onEditing,
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
  /**
   * Escape cancels a rename by blurring the field, which is also how enter and
   * clicking away commit one — so the commit lives in `blur` and this is what
   * tells it which of the three just happened.
   */
  const cancelled = useRef(false);

  useEffect(() => {
    onEditing(renaming !== null);
    // Also on unmount: a sidebar hidden mid-rename must not leave the keyboard
    // switched off with nothing on screen to explain why.
    return () => onEditing(false);
  }, [renaming, onEditing]);

  /** Where each agent lives, so a row can say which workspace to look in. */
  const where = new Map<string, { workspaceId: string; workspace: string; paneId: string; index: number }>();
  for (const workspace of profile.workspaces) {
    for (const pane of panes(workspace.layout)) {
      pane.agentIds.forEach((agentId, index) => {
        where.set(agentId, {
          workspaceId: workspace.id,
          workspace: workspace.name,
          paneId: pane.id,
          index,
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
        <button className="profile-btn" onClick={() => onRun("switch-profile")} title="Switch profile (C-a s)">
          {profile.name}
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
                  <span className="ws-count">{countTerminals(workspace)}</span>
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
                  title={[agent.activity, agent.command, agent.cwd].filter(Boolean).join("\n")}
                  draggable
                  onDragStart={(event) => beginDrag(event, "agent", agent.id)}
                  onDragEnd={endDrag}
                >
                  {/* What it is and where it lives. The two things you need to
                      find it again, and nothing that changes while you read. */}
                  <span className="agent-top">
                    <Status agent={agent} />
                    <span className="agent-name">{agentLabel(agent)}</span>
                    {agent.unread && <span className="unread" aria-label="new output" />}
                    <span className="agent-ws">{at ? at.workspace : "—"}</span>
                  </span>
                  {/* What it is doing, and how much room it has left to do it
                      in. Both change constantly, which is why they are on their
                      own line: a row whose top half is stable is a row you can
                      find something in without re-reading it.

                      The cwd stands in until the agent has reported — an
                      unreported agent would otherwise have a blank line under it
                      saying nothing, and where it is working is the next most
                      useful thing we know for certain. */}
                  <span className="agent-bottom">
                    <span className="agent-activity">
                      {agent.activity || shortenPath(agent.cwd)}
                    </span>
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

      <div className="sidebar-foot">
        <div className="sidebar-start">
          {/* One button, because there is one thing to open. Starting an agent
              used to be its own button; it is a terminal with `claude` typed
              into it, and the tab says so either way. */}
          <button className="button" onClick={() => onRun("new-tab")} disabled={!connected}>
            New terminal
          </button>
        </div>
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
            style={{ background: COLOR_VALUES[color] }}
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

function countTerminals(workspace: Profile["workspaces"][number]): number {
  return panes(workspace.layout).reduce((n, pane) => n + pane.agentIds.length, 0);
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
