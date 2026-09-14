/**
 * The window: what is running down the left, tiled terminals filling the rest,
 * and a prefix in front of every key that is not meant for a pty.
 *
 * Two things moved out of here since the last rewrite, and both moved to the
 * server. The arrangement is no longer React state — this file *draws* a layout
 * rather than holding one, so a reload costs a repaint and a second client sees
 * the same window. And the hierarchy grew the two levels ghosttown has: a
 * profile is a list of workspaces, a workspace is one split tree, a pane holds
 * tabs.
 *
 * What is left in here is exactly what a client should own: which keys mean what
 * (`keys.ts`), what is visible and therefore worth watching, and the handful of
 * view states the server has no business knowing about — whether the sidebar is
 * open, whether one pane has been zoomed, and what dialog is up.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  activeAgent,
  paneInDirection,
  panes,
  visibleAgents,
  type Direction,
  type LayoutNode,
} from "../../shared/layout";
import { Dialog, type DialogState } from "./components/Dialog";
import { HelpOverlay } from "./components/HelpOverlay";
import { Panes } from "./components/Panes";
import { Settings } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import {
  actionFor,
  isModifier,
  isPrefix,
  keyName,
  workspaceDigit,
  PREFIX_BYTE,
  PREFIX_TIMEOUT_MS,
  type Action,
} from "./keys";
import { isFileDrag } from "./drop";
import * as api from "./session";
import { useKururu } from "./session";

/** How far one press of a resize key moves a divider. */
const NUDGE = 0.03;

export function App() {
  const { snapshot, connected } = useKururu();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  /** Zen: the focused pane takes the window. A view state, never the server's. */
  const [zen, setZen] = useState(false);
  const [prefixArmed, setPrefixArmed] = useState(false);
  const [resizeMode, setResizeMode] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [help, setHelp] = useState(false);
  /**
   * Settings. A view state like the help overlay rather than anything the server
   * knows about — what it *edits* is the server's, but whether it is open is
   * this window's, and a phone should not be dragged into a picker because the
   * desktop opened one.
   */
  const [settings, setSettings] = useState(false);
  /**
   * Something in the chrome is taking typing — renaming a workspace in the
   * sidebar. Modal over the keyboard for the same reason a dialog is: ctrl+a is
   * select-all in a text field, and an armed prefix would eat the next letter.
   */
  const [editing, setEditing] = useState(false);

  const profile = snapshot?.profile ?? null;
  const workspace = useMemo(
    () => profile?.workspaces.find((w) => w.id === profile.activeWorkspaceId) ?? null,
    [profile],
  );
  const agents = useMemo(() => snapshot?.agents ?? [], [snapshot]);

  /**
   * Tell the server what is on screen: the active tab of every pane, and only of
   * the workspace you are in. A workspace you are not looking at is not costing
   * anything — which is the point of having several.
   */
  const visible = useMemo(() => (workspace ? visibleAgents(workspace.layout) : []), [workspace]);
  useEffect(() => {
    api.watch(visible);
  }, [visible]);

  /**
   * The one prompt two doors lead to: the keybind, and the + at the bottom of
   * the switcher. Naming it here rather than writing it twice is the same
   * reason the action table exists at all.
   */
  const promptNewProfile = useCallback(() => {
    setDialog({
      kind: "prompt",
      title: "New profile",
      hint: "A session of its own. What you are in now keeps running.",
      value: "",
      onSubmit: (name) => name.trim() && api.newProfile(name),
    });
  }, []);

  /**
   * Deleting a workspace ends every terminal in it, so it is asked about — in
   * one place, because prefix+X and the sidebar's menu must not disagree about
   * what is being destroyed or how many turns it costs.
   */
  const confirmDeleteWorkspace = useCallback(
    (workspaceId: string) => {
      if (!profile || profile.workspaces.length < 2) return;
      const doomed = profile.workspaces.find((w) => w.id === workspaceId);
      if (!doomed) return;
      const inside = panes(doomed.layout).reduce((n, p) => n + p.agentIds.length, 0);
      setDialog({
        kind: "confirm",
        title: `Delete “${doomed.name}”?`,
        hint:
          inside === 0
            ? "It is empty."
            : `${inside} terminal${inside === 1 ? "" : "s"} in it will be ended.`,
        confirmLabel: "Delete",
        onConfirm: () => api.deleteWorkspace(doomed.id),
      });
    },
    [profile],
  );

  /**
   * Everything the keyboard can do, by name. Kept in one table so the keymap,
   * the help overlay and the buttons in the chrome cannot drift apart — a button
   * and its shortcut running different code is how they end up behaving
   * differently.
   */
  const run = useCallback(
    (action: Action) => {
      const focusedAgent = focusedAgentOf(workspace);

      switch (action) {
        case "split-right":
          return api.splitPane("row");
        case "split-down":
          return api.splitPane("col");
        // Every terminal is the same thing now — the server opens a shell and
        // you run your agent in it — so there is one verb rather than two.
        case "new-tab":
          return void api.newTab();
        case "next-tab":
          return api.cycleTab(1);
        case "prev-tab":
          return api.cycleTab(-1);
        case "close-tab":
          return api.closeTab();
        case "close-pane":
          return api.closePane();
        case "rename-tab": {
          if (!focusedAgent) return;
          const agent = agents.find((a) => a.id === focusedAgent);
          return setDialog({
            kind: "prompt",
            title: "Rename tab",
            hint: "Empty hands the name back to whatever it would be called.",
            value: agent?.titleOverride ?? "",
            onSubmit: (name) => api.renameTab(focusedAgent, name),
          });
        }
        case "focus-left":
        case "focus-right":
        case "focus-up":
        case "focus-down": {
          const dir = action.slice("focus-".length) as Direction;
          // Nothing to the left of the leftmost pane means the sidebar, the way
          // it does in ghosttown — the chrome is part of the layout to a keyboard.
          if (dir === "left" && workspace && !paneInDirection(workspace.layout, workspace.focusedPaneId, "left")) {
            setSidebarOpen(true);
            return;
          }
          return api.focusDirection(dir);
        }
        case "toggle-sidebar":
          return setSidebarOpen((open) => !open);
        case "zen-mode":
          return setZen((on) => !on);
        case "resize-mode":
          return setResizeMode(true);
        case "new-workspace":
          return api.newWorkspace();
        case "next-workspace":
          return api.stepWorkspace(1);
        case "prev-workspace":
          return api.stepWorkspace(-1);
        case "last-workspace":
          return api.lastWorkspace();
        case "rename-workspace":
          if (!workspace) return;
          return setDialog({
            kind: "prompt",
            title: "Rename workspace",
            value: workspace.name,
            onSubmit: (name) => api.renameWorkspace(workspace.id, name),
          });
        case "delete-workspace":
          if (workspace) confirmDeleteWorkspace(workspace.id);
          return;
        case "find-workspace":
          if (!profile) return;
          return setDialog({
            kind: "pick",
            title: "Workspaces",
            items: profile.workspaces.map((w, i) => ({
              id: w.id,
              label: w.name,
              hint: `${i + 1}`,
            })),
            onPick: (id) => api.switchWorkspace(id),
          });
        case "find-agent":
          return setDialog({
            kind: "pick",
            title: "Agents",
            items: agents.map((agent) => ({
              id: agent.id,
              label: agent.titleOverride ?? agent.agent ?? agent.command,
              hint: agent.cwd,
            })),
            onPick: (id) => {
              const pane = workspace ? panes(workspace.layout).find((p) => p.agentIds.includes(id)) : null;
              if (!pane) return;
              api.focusPane(pane.id);
              api.selectTab(pane.id, pane.agentIds.indexOf(id));
            },
          });
        case "switch-profile":
          if (!snapshot) return;
          return setDialog({
            kind: "pick",
            title: "Profiles",
            hint: "The one you leave keeps running.",
            items: snapshot.profiles.map((p) => ({
              id: p.id,
              label: p.name,
              hint: `${p.workspaces} ws · ${p.agents} live`,
            })),
            onPick: (id) => api.switchProfile(id),
            onCreate: { label: "New profile", run: promptNewProfile },
            onDelete: (id) => {
              if (snapshot.profiles.length < 2) return;
              const doomed = snapshot.profiles.find((p) => p.id === id);
              setDialog({
                kind: "confirm",
                title: `Delete profile “${doomed?.name ?? id}”?`,
                hint: `${doomed?.agents ?? 0} live terminal(s) in it will be ended.`,
                confirmLabel: "Delete",
                onConfirm: () => api.deleteProfile(id),
              });
            },
            onRename: (id) => {
              const current = snapshot.profiles.find((p) => p.id === id);
              setDialog({
                kind: "prompt",
                title: "Rename profile",
                value: current?.name ?? "",
                onSubmit: (name) => api.renameProfile(id, name),
              });
            },
          });
        case "new-profile":
          return promptNewProfile();
        case "reload":
          return location.reload();
        /**
         * Ghosttown's prefix+B, and the one place kururu's is *cheaper* than
         * its own: there it means a fresh daemon and everything in the panes
         * dies. Here the ptys are in a process this does not touch, so it costs
         * a reconnect. The socket comes back on its own.
         */
        case "restart-server":
          return api.restartServer();
        case "help":
          return setHelp((on) => !on);
      }
    },
    [workspace, profile, agents, snapshot, promptNewProfile, confirmDeleteWorkspace],
  );

  // -------------------------------------------------------------------------
  // The prefix
  // -------------------------------------------------------------------------

  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarm = useCallback(() => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = null;
    setPrefixArmed(false);
  }, []);
  const arm = useCallback(() => {
    setPrefixArmed(true);
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = setTimeout(() => setPrefixArmed(false), PREFIX_TIMEOUT_MS);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const take = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      /**
       * A modifier on its own is the first half of a chord, never a command, so
       * it is let through before anything else looks at it — including the armed
       * prefix, which is spent on whatever the next keydown is. Shift raises its
       * own keydown before the letter does, so without this the prefix was gone
       * by the time the letter arrived and every shifted binding (T, D, C, W, X,
       * |, %, ?) did nothing at all.
       */
      if (isModifier(event)) return;

      // A dialog is modal over everything, including the prefix: while one is
      // open every key is text or an answer, and the component owns them. A name
      // being typed in the sidebar is the same case at a smaller scale.
      if (dialog || editing || settings) return;

      /**
       * Settings is modal over the keyboard for the same reason a dialog is —
       * it is full of fields, and ctrl+a in one of them is select-all. Escape is
       * taken because the scrim and the Done button are pointer gestures and a
       * keyboard needs a way out too.
       */
      if (settings) {
        if (keyName(event) === "escape") {
          take();
          setSettings(false);
        }
        return;
      }

      if (help) {
        if (isPrefix(event) || keyName(event) === "escape" || keyName(event) === "?") {
          take();
          setHelp(false);
        }
        return;
      }

      /**
       * Resize mode is modal over the ptys but not over the prefix: hjkl push
       * the divider until esc or enter, and the prefix arms out of it, the way
       * ghosttown's arrange mode does.
       */
      if (resizeMode) {
        take();
        const key = keyName(event);
        if (key === "escape" || key === "enter") return setResizeMode(false);
        if (isPrefix(event)) {
          setResizeMode(false);
          return arm();
        }
        const dirs: Record<string, Direction> = {
          h: "left", left: "left",
          l: "right", right: "right",
          k: "up", up: "up",
          j: "down", down: "down",
        };
        const dir = dirs[key];
        if (dir) api.nudge(dir, NUDGE);
        return;
      }

      if (!prefixArmed) {
        if (isPrefix(event)) {
          take();
          arm();
        }
        // Everything else belongs to the pty, and xterm is downstream of here.
        return;
      }

      take();
      disarm();

      // The prefix twice sends it through, which is what keeps ctrl+a usable
      // inside readline.
      if (isPrefix(event)) {
        const focused = focusedAgentOf(workspace);
        if (focused) api.input(focused, PREFIX_BYTE);
        return;
      }

      const action = actionFor(event);
      if (action) return run(action);

      const digit = workspaceDigit(event);
      if (digit !== null) api.workspaceByIndex(digit);
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [prefixArmed, resizeMode, dialog, editing, help, settings, workspace, run, arm, disarm]);

  /**
   * A file dropped anywhere that is not a terminal does nothing.
   *
   * This is a guard, not a feature. A web page's default answer to a dropped
   * file is to navigate to it, and this page is the whole application — so a
   * screenshot missing the pane by ten pixels would replace kururu with a
   * picture of a screenshot, and take every terminal on screen with it. The
   * agents would survive, being processes on the other end; the window would
   * not.
   *
   * Bubble phase on purpose, so `Terminal.tsx` gets the drop first and this only
   * ever sees the ones that missed. And only for file drags: kururu's own tab
   * and pane drags carry custom MIME types and must keep reaching their own drop
   * zones untouched.
   */
  useEffect(() => {
    const swallow = (event: DragEvent) => {
      if (isFileDrag(event.dataTransfer)) event.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  /**
   * The ⌘ shortcuts, kept from before the prefix existed. A second door: ⌘W and
   * ⌘R stay Electron's, which is why closing a pane is ⇧⌘W.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey) return;
      const key = event.key.toLowerCase();
      const take = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (key === "d") {
        take();
        run(event.shiftKey ? "split-down" : "split-right");
      } else if (key === "t" && !event.shiftKey) {
        take();
        run("new-tab");
      } else if (key === "w" && event.shiftKey) {
        take();
        run("close-pane");
      } else if (key === "[" || key === "]") {
        take();
        api.stepPane(key === "]" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [run]);

  // -------------------------------------------------------------------------

  if (!snapshot || !profile || !workspace) {
    return (
      <div className="app app-booting">
        <p className="muted">{connected ? "Starting…" : "Connecting to the kururu server…"}</p>
      </div>
    );
  }

  return (
    <div className={`app ${zen ? "app-zen" : ""}`}>
      {sidebarOpen && !zen && (
        <Sidebar
          profile={profile}
          agents={agents}
          connected={connected}
          mascot={snapshot.mascot}
          /* The terminal the keyboard is pointed at. The sidebar marks it,
             because a list of six agents does not otherwise say which of them
             the next keystroke belongs to. */
          focusedAgentId={focusedAgentOf(workspace)}
          onRun={run}
          onDeleteWorkspace={confirmDeleteWorkspace}
          onEditing={setEditing}
          onSettings={() => setSettings(true)}
        />
      )}

      <div className="stage">
        <main className="panes">
          <Panes
            node={workspace.layout}
            focusedPaneId={workspace.focusedPaneId}
            agents={agents}
            mascot={snapshot.mascot}
            zen={zen}
          />
        </main>
        <StatusBar
          profile={profile}
          workspace={workspace}
          connected={connected}
          prefixArmed={prefixArmed}
          resizeMode={resizeMode}
          onHelp={() => setHelp(true)}
        />
      </div>

      {help && <HelpOverlay onClose={() => setHelp(false)} />}
      {settings && <Settings mascot={snapshot.mascot} onClose={() => setSettings(false)} />}
      {dialog && <Dialog state={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** The terminal the focused pane is showing, if any. */
function focusedAgentOf(
  workspace: { layout: LayoutNode; focusedPaneId: string } | null,
): string | null {
  if (!workspace) return null;
  const pane = panes(workspace.layout).find((p) => p.id === workspace.focusedPaneId);
  return pane ? activeAgent(pane) : null;
}
