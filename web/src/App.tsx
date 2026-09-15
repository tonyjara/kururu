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
import { keymapFrom } from "../../shared/keys";
import { mascotFor } from "../../shared/model";
import { Dialog, type DialogState } from "./components/Dialog";
import { HelpOverlay } from "./components/HelpOverlay";
import { Menu, type MenuAt } from "./components/Menu";
import { Panes } from "./components/Panes";
import { Reach } from "./components/Reach";
import { Settings, type Tab as SettingsTab } from "./components/Settings";
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
import { tabLabel } from "./labels";
import { applyAppearance } from "./theme";
import { skinFor } from "../../shared/skin";
import * as api from "./session";
import { useKururu } from "./session";
import * as terminals from "./terminals";

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
   * Settings: which page of it is open, or null for closed. A view state like the
   * help overlay rather than anything the server knows about — what it *edits* is
   * the server's, but whether it is open is this window's, and a phone should not
   * be dragged into a picker because the desktop opened one.
   *
   * A tab rather than a flag because there are now two doors into it that want
   * different pages: the cog opens where somebody browsing would want to start,
   * and the profile name opens the page about profiles. Only the opening — where
   * the dialog goes next is its own business.
   */
  const [settings, setSettings] = useState<SettingsTab | null>(null);
  /**
   * The profile menu, and the button it hangs under.
   *
   * View state like Settings and the help overlay: which profile you are *in* is
   * the server's, whether a menu about it is open is this window's. The ref is
   * how the keyboard gets the same menu as the click — `switch-profile` measures
   * the button rather than guessing a corner, so the menu comes up in the same
   * place either way and the sidebar keeps sole responsibility for where its own
   * button is.
   */
  const [profileMenu, setProfileMenu] = useState<MenuAt | null>(null);
  const profileButton = useRef<HTMLButtonElement>(null);
  /**
   * The phone dialog: which addresses this server answers at, as QR codes. A
   * view state for the same reason Settings is — and more so, since it is about
   * how *this* window was reached, and the phone that scanned the code has no
   * use at all for a dialog telling it its own address.
   */
  const [reach, setReach] = useState(false);
  /**
   * Something in the chrome is taking typing — renaming a workspace in the
   * sidebar. Modal over the keyboard for the same reason a dialog is: ctrl+a is
   * select-all in a text field, and an armed prefix would eat the next letter.
   */
  const [editing, setEditing] = useState(false);

  /**
   * Whether the panes still hold the keyboard.
   *
   * Everything in here that takes typing takes it *from a terminal*, and the
   * browser does not give it back: a dialog answered, a name committed in the
   * sidebar, Settings closed — each of them leaves the focused element removed
   * from the document and the focus itself on `<body>`, where every keystroke
   * goes nowhere at all. The pane still looked focused, and the next thing
   * typed was simply lost, which is why it read as the terminal having died
   * rather than as a focus that had.
   *
   * So it is stated rather than repaired afterwards. The emulator is told
   * whether the keyboard is the panes' to have, and the effect that already
   * exists in `Terminal.tsx` — focus follows the focused pane — hands it back
   * the moment nothing in the chrome wants it. Which pane is *focused* is
   * untouched by any of this: it is still where the next keystroke belongs,
   * and it still draws that way.
   *
   * `resizeMode` is deliberately not in the list. It takes every key in the
   * capture phase before an emulator could see one, so the keyboard can stay
   * exactly where it is and the terminal needs no second handover when hjkl
   * stops moving a divider.
   */
  const paneKeyboard = !(dialog || editing || settings || help || reach || profileMenu);

  const profile = snapshot?.profile ?? null;
  const workspace = useMemo(
    () => profile?.workspaces.find((w) => w.id === profile.activeWorkspaceId) ?? null,
    [profile],
  );
  const agents = useMemo(() => snapshot?.agents ?? [], [snapshot]);
  /**
   * The keys this window is using: ghosttown's table as the user has amended it.
   * Derived from the snapshot rather than held, like everything else the server
   * owns — which is what makes a rebinding reach a second window and survive a
   * reload.
   */
  const keymap = useMemo(() => keymapFrom(snapshot?.keys ?? {}), [snapshot?.keys]);
  /**
   * The badge the panes draw. Everything in them is in the workspace you are
   * looking at, so it resolves once here — the sidebar cannot do that, because
   * its list spans every workspace in the profile and resolves per row.
   */
  const mascot = useMemo(
    () => (snapshot && workspace ? mascotFor(snapshot.mascots, workspace.mascotId) : null),
    [snapshot, workspace],
  );

  /**
   * Wear whatever the server says. The chrome's tokens go onto the root element
   * and the palette goes to every pooled emulator, neither of which is anything
   * React draws — which is the point of doing it in an effect rather than in the
   * tree. A theme is a property of the document, and threading forty colours
   * through a context so that components could re-render to learn them would be
   * paying a render of the whole window for something the cascade does for free.
   *
   * Keyed on the appearance *serialized*, and that is not laziness. A snapshot
   * goes out on every status tick and arrives as JSON, so the object is a new
   * one several times a second however little has changed — keying on it would
   * ask every pooled emulator whether its font had moved twice a second, for the
   * lifetime of the window. Five fields stringified is the cheapest thing that
   * is actually stable.
   */
  const appearance = snapshot?.appearance;
  const appearanceKey = appearance ? JSON.stringify(appearance) : null;
  useEffect(() => {
    if (appearance) applyAppearance(appearance);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appearanceKey]);

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
   * And let go of the emulators of terminals that no longer exist.
   *
   * An emulator is pooled for the life of its terminal now rather than the life
   * of the pane drawing it, so something has to say when that life ends — and
   * the only thing that ever does is the snapshot, by omission. A killed
   * terminal, a closed tab and a deleted workspace all arrive here the same way:
   * as an id that has stopped being listed. Done from the snapshot rather than
   * from the verbs that caused it, because any of them can have been sent by the
   * window next door.
   */
  useEffect(() => {
    if (!snapshot) return;
    terminals.retain(new Set(agents.map((agent) => agent.id)));
  }, [snapshot, agents]);

  /**
   * Making a profile without going and looking at the list of them, which is
   * what prefix+S is for. Settings has a box of its own for the same job — a
   * page that is already a form does not want a modal on top of it to collect
   * one word — so this is the quick door rather than the only one.
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
        case "open-reader":
          return api.openReader();
        case "toggle-sidebar":
          return setSidebarOpen((open) => !open);
        case "settings":
          return setSettings("appearance");
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
              // `tabLabel`, not a fourth spelling of it: a finder that calls a
              // terminal something the tab strip does not is a finder you
              // cannot search with.
              label: tabLabel(agent),
              hint: agent.cwd,
            })),
            onPick: (id) => {
              const pane = workspace ? panes(workspace.layout).find((p) => p.agentIds.includes(id)) : null;
              if (!pane) return;
              api.focusPane(pane.id);
              api.selectTab(pane.id, pane.agentIds.indexOf(id));
            },
          });
        /**
         * The profile menu, under the sidebar's profile name.
         *
         * This has been all three things a switcher can be, and the split it
         * landed on is the useful one. It was a pick dialog; then a profile grew
         * an identity, which is a form, and a dialog that picks beside a page
         * that edits is two places that disagree about what a profile is — so it
         * all moved into Settings. That overcorrected. *Switching* never stopped
         * being navigation: it is the thing you do ten times an afternoon, and
         * routing it through a modal with a "Switch to" button on every row put
         * three clicks and a dialog in front of a move between two rooms.
         *
         * So: the menu is the switcher, Settings is the editor, and the menu's
         * last item is the door between them. Each is the shape of its own job,
         * and neither duplicates the other — Settings no longer switches at all.
         */
        case "switch-profile": {
          const at = profileButton.current?.getBoundingClientRect();
          // Below the button's left edge, or the corner if the sidebar is hidden
          // and there is no button to measure. Both are somewhere sensible; the
          // first is somewhere it was asked for.
          return setProfileMenu(at ? { x: at.left, y: at.bottom + 2 } : { x: 8, y: 34 });
        }
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
      // being typed in the sidebar — or in Settings, or a key being captured
      // there — is the same case at a smaller scale, and `editing` is how the
      // chrome says so.
      if (dialog || editing) return;

      /**
       * A menu is modal in the same small way. It closes itself on escape, on a
       * click, on a scroll and on a resize (`Popover`), so all this has to do is
       * keep the rest of the keyboard out from under it — a key that armed the
       * prefix or switched workspace behind an open menu would leave it pointing
       * at a window that had moved on.
       */
      if (profileMenu) return;

      /**
       * Settings is modal over the keyboard for the same reason a dialog is —
       * it is full of fields, and ctrl+a in one of them is select-all. Escape is
       * taken because the scrim and the Done button are pointer gestures and a
       * keyboard needs a way out too.
       */
      if (settings) {
        if (keyName(event) === "escape") {
          take();
          setSettings(null);
        }
        return;
      }

      // The phone dialog has nothing to type in, but it is still modal — a key
      // that reached a pty from behind a scrim would be typed somewhere the
      // user cannot see. Escape is the way out the pointer already has twice.
      if (reach) {
        if (keyName(event) === "escape") {
          take();
          setReach(false);
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

      const action = actionFor(event, keymap);
      if (action) return run(action);

      const digit = workspaceDigit(event);
      if (digit !== null) api.workspaceByIndex(digit);
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [prefixArmed, resizeMode, dialog, editing, help, settings, reach, profileMenu, workspace, keymap, run, arm, disarm]);

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

  if (!snapshot || !profile || !workspace || !mascot) {
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
          /* For the one row that says it opens as somebody else: a workspace
             borrowing another profile's accounts stores a pointer, and only the
             list of profiles has the name on the other end of it. */
          profiles={snapshot.profiles}
          profileRef={profileButton}
          agents={agents}
          connected={connected}
          mascots={snapshot.mascots}
          /* The terminal the keyboard is pointed at. The sidebar marks it,
             because a list of six agents does not otherwise say which of them
             the next keystroke belongs to. */
          focusedAgentId={focusedAgentOf(workspace)}
          onRun={run}
          onDeleteWorkspace={confirmDeleteWorkspace}
          onEditing={setEditing}
          onSettings={() => setSettings("appearance")}
          onReach={() => setReach(true)}
        />
      )}

      <div className="stage">
        <main className="panes">
          <Panes
            node={workspace.layout}
            focusedPaneId={workspace.focusedPaneId}
            agents={agents}
            mascot={mascot}
            zen={zen}
            keyboard={paneKeyboard}
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

      {help && <HelpOverlay keymap={keymap} onClose={() => setHelp(false)} />}
      {settings && (
        <Settings
          appearance={snapshot.appearance}
          mascots={snapshot.mascots}
          keys={snapshot.keys}
          profiles={snapshot.profiles}
          activeProfileId={profile.id}
          initialTab={settings}
          onClose={() => setSettings(null)}
          onEditing={setEditing}
        />
      )}
      {profileMenu && snapshot && (
        <Menu
          at={profileMenu}
          onClose={() => setProfileMenu(null)}
          items={[
            ...snapshot.profiles.map((p) => ({
              label: p.name,
              mark: p.id === profile.id,
              // What you would be leaving running, which is the one thing worth
              // knowing about a profile you are not in. Blank rather than "0
              // live" for the empty ones: a column of zeroes is noise.
              hint: p.agents ? `${p.agents} live` : "",
              run: () => api.switchProfile(p.id),
            })),
            { label: "New profile…", sep: true, run: promptNewProfile },
            { label: "Profile settings…", run: () => setSettings("profiles") },
          ]}
        />
      )}
      {reach && <Reach onClose={() => setReach(false)} />}
      {dialog && <Dialog state={dialog} onClose={() => setDialog(null)} />}
      {/* The skin's effect layer — scanlines, a grain — over everything
          including the terminal canvases, which is the only place it can go and
          be visible. Rendered only when there is one to draw rather than always
          and transparently: a fixed, full-window element is a real element even
          at zero opacity, and the surest way for it to never be the thing that
          swallowed a drag is for it not to exist. It reads the skin rather than
          a CSS token because that is the one question CSS cannot answer about
          itself — whether `--overlay` is `none`. */}
      {skinFor(snapshot.appearance.skinId).tokens.overlay !== "none" && (
        <div className="overlay" aria-hidden="true" />
      )}
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
