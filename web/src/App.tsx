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
 * open and how wide, whether one pane has been zoomed, and what dialog is up.
 *
 * The sidebar's width is the newest of those and the one most obviously the
 * server's if you do not think about it, so: a phone and a desktop watching one
 * server are two windows of two shapes, and a width in the snapshot would be
 * each of them overwriting the other's every time somebody dragged an edge. It
 * lives in `localStorage`, which is per device, which is the scope of the
 * decision. The same reasoning makes the *breakpoint* live here rather than in
 * `styles.css` — see `NARROW`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  activeAgent,
  paneInDirection,
  panes,
  soloPane,
  visibleAgents,
  type Direction,
  type LayoutNode,
} from "../../shared/layout";
import { keymapFrom } from "../../shared/keys";
import { mascotFor } from "../../shared/model";
import { Dialog, type DialogState } from "./components/Dialog";
import { HelpOverlay } from "./components/HelpOverlay";
import { Keybar } from "./components/Keybar";
import { Menu, type MenuAt } from "./components/Menu";
import { resetZoom, zoomBy } from "./zoom";
import { Panes } from "./components/Panes";
import { Reach } from "./components/Reach";
import { Settings, TAB_NAMES as SETTINGS_TABS, type Tab as SettingsTab } from "./components/Settings";
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
import { desktop } from "./desktop";
import { isFileDrag } from "./drop";
import { announce, primeAudio, primeNotifyPermission } from "./notify";
import { tabLabel } from "./labels";
import { applyAppearance } from "./theme";
import { skinFor } from "../../shared/skin";
import * as api from "./session";
import { useKururu } from "./session";
import * as terminals from "./terminals";

/** How far one press of a resize key moves a divider. */
const NUDGE = 0.03;

/**
 * The sidebar's width, and the floor and ceiling a drag is held between.
 *
 * The floor is the interesting number. A sidebar is a list of names and every
 * one of them is already truncated at 224px, so there is a width below which
 * the column still draws but has stopped answering the question it exists to
 * answer — which workspace, which agent — and a divider you can drag to
 * nothing is a way to lose the sidebar that looks like a bug rather than like
 * hiding it. Hiding it is `toggle-sidebar`, and it comes back; a 20px column
 * does not say how.
 */
const SIDEBAR_DEFAULT = 224;
const SIDEBAR_MIN = 168;
const SIDEBAR_MAX = 460;
/** Where a width the user chose is kept. Per browser, on purpose — see below. */
const SIDEBAR_WIDTH_KEY = "kururu.sidebar.width";

/**
 * Whether the touch key toolbar is drawn, on the device that decided.
 *
 * `localStorage` on the sidebar width's reasoning, and rather more obviously so:
 * this is a bar that only exists on a touch screen, and a desktop watching the
 * same server has no opinion about it that is worth sending anywhere. It
 * defaults to *on*, because the device that draws it at all is by definition one
 * whose keyboard is missing the keys on it — somebody who does not want the rows
 * it costs can put it away, and that is a smaller surprise than a phone where
 * escape is unreachable until you find a toggle.
 */
const KEYBAR_KEY = "kururu.keybar";

/**
 * When the window stops being wide enough for a column beside the panes.
 *
 * Stated here in JavaScript and nowhere else, and `styles.css` reads it back off
 * `:root[data-narrow]` rather than writing a media query of its own. A
 * breakpoint in both halves is a number held together by nothing, and the half
 * that drifts is invisible until a phone gets a full-screen sidebar that still
 * thinks it is a column — the same argument `theme.test.ts` makes about a token
 * the CSS asks for that no skin answers, except that here one of the two sides
 * also has to *behave* differently and so has to know.
 */
const NARROW = "(max-width: 720px)";

/**
 * How much of the window an on-screen keyboard has to take before kururu
 * believes it is one.
 *
 * The visual viewport shrinks for things that are not keyboards — a phone
 * browser collapsing its address bar moves it by forty or fifty pixels, and
 * treating that as a keyboard would reflow every pane, and therefore SIGWINCH
 * every agent, every time somebody scrolled. A keyboard is a third of the
 * screen; a hundred and twenty pixels is comfortably above the one and below
 * the other.
 */
const KEYBOARD_MIN = 120;

/**
 * Where Settings was, across the one reload kururu does to itself.
 *
 * Picking a theme reloads the window (see the effect below), and a reload takes
 * the dialog with it because whether Settings is open is `useState` and nothing
 * more — deliberately, since it is this window's business and not the server's.
 * That is right in every case but this one: browsing themes is a compare, and a
 * picker that closes on every pick makes the second comparison cost four
 * clicks.
 *
 * `sessionStorage`, not `localStorage`, and the difference is the whole design:
 * it is scoped to this tab and this run of it, so a window opened fresh
 * tomorrow does not come up holding a dialog somebody closed by reloading
 * months ago. Read once and cleared, so a hand-typed ⌘R after the fact is a
 * plain reload and not a second reopening.
 */
const SETTINGS_KEY = "kururu.settings.resume";

function keepSettings(tab: SettingsTab | null): void {
  if (!tab) return;
  try {
    sessionStorage.setItem(SETTINGS_KEY, tab);
  } catch {
    // Storage that refuses is a dialog that closes. The theme still lands.
  }
}

/**
 * Trusted no further than a string: this is storage a person can edit, and the
 * value ends up choosing a page. An unknown one opens nothing, which is the
 * same answer as never having written it.
 */
function resumeSettings(): SettingsTab | null {
  let saved: string | null = null;
  try {
    saved = sessionStorage.getItem(SETTINGS_KEY);
    sessionStorage.removeItem(SETTINGS_KEY);
  } catch {
    return null;
  }
  return saved && (SETTINGS_TABS as readonly string[]).includes(saved) ? (saved as SettingsTab) : null;
}

export function App() {
  const { snapshot, connected } = useKururu();

  /**
   * Whether the window is narrow enough that the sidebar stops being a column
   * and becomes a screen. Read from `matchMedia` rather than from a resize
   * listener because the browser already knows the answer and will say when it
   * changes; a listener on every resize event would recompute it sixty times a
   * second while a divider is being dragged.
   */
  const narrow = useNarrow();
  /**
   * Open, and how wide.
   *
   * Both are this window's, not the server's, and the width especially: a phone
   * and a desktop looking at one server want two different sidebars, so a width
   * in the snapshot would be one of them constantly overwriting the other — the
   * same argument `zen` and `sidebarOpen` already make. It goes to
   * `localStorage`, which is per browser and per device, which is exactly the
   * scope of the decision. A read that throws (a private window, blocked site
   * data) is not an error worth reporting; it is a window that opens at the
   * default width.
   */
  const [sidebarOpen, setSidebarOpen] = useState(() => !matchesNarrow());
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  /** Zen: the focused pane takes the window. A view state, never the server's. */
  const [zen, setZen] = useState(false);
  /**
   * The touch toolbar, and whether this device has any use for one.
   *
   * Two things rather than one because they answer different questions and only
   * one of them is a preference: `touch` is a fact about the hardware and
   * `keybarOpen` is what somebody chose about it, so a mouse never draws the bar
   * however the flag is set, and a phone that put it away keeps it away.
   */
  const touch = useCoarsePointer();
  const [keybarOpen, setKeybarOpen] = useState(storedKeybar);
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
  const [settings, setSettings] = useState<SettingsTab | null>(resumeSettings);
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
  /**
   * The installed styles are in the key as well, because the *same* appearance
   * means a different window once one is installed or removed: the ids in
   * `appearance` do not move when a theme arrives under one of them, and without
   * this the palette that was just downloaded would sit there unapplied until
   * something else changed. Their versions rather than the whole library, on the
   * reasoning above — a palette stringified several times a second is the cost
   * this key exists to avoid.
   */
  const styles = snapshot?.styles;
  const appearanceKey = appearance
    ? JSON.stringify(appearance) + (styles?.installed.map((s) => `${s.kind}/${s.id}@${s.version}`).join() ?? "")
    : null;
  useEffect(() => {
    if (!appearance) return;
    /**
     * A palette the emulators cannot be talked out of — see
     * `applyTerminalAppearance`, which explains why a colour is settled inside
     * the wasm and why nothing short of new terminals moves one. Reloading is
     * the only lever, and this is the layer that should pull it: the dialog
     * somebody picked the theme in is this component's state and nobody else's.
     *
     * Safe to do the instant it is reported, because the appearance arrives on
     * a *snapshot*. The server has already written it down, so the window that
     * comes back reads the new theme as the one it was always on — which is
     * also why this cannot loop: the reload lands on a first application, and a
     * first application is never a change.
     */
    if (applyAppearance(appearance, styles)) {
      keepSettings(settings);
      location.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appearanceKey]);

  /**
   * Tell the stylesheet which shape the window is in.
   *
   * An attribute on the root rather than a `@media` rule of its own, so the
   * breakpoint is stated once — see `NARROW` above. It is the same trick
   * `theme.ts` and `skin.ts` use for a different reason: the cascade is the
   * cheapest way to tell several hundred rules something, and it costs no
   * render at all.
   */
  useEffect(() => {
    document.documentElement.toggleAttribute("data-narrow", narrow);
  }, [narrow]);

  // Remembered per device, for the reason the sidebar's width is. Storage that
  // refuses to answer is a bar that comes back next time, not an error.
  useEffect(() => {
    try {
      localStorage.setItem(KEYBAR_KEY, keybarOpen ? "1" : "0");
    } catch {
      // A private window keeps the default. Nothing here is worth a dialog.
    }
  }, [keybarOpen]);

  /** Give the window back to the keyboard when one is up. See `useKeyboardInset`. */
  useKeyboardInset();

  /**
   * Crossing the breakpoint decides for you, once.
   *
   * Going narrow closes the sidebar, because a sidebar that is a full-screen
   * overlay is not something to leave standing over the panes; coming back wide
   * opens it, because a column beside them is the ordinary state of the window.
   * Only on the *crossing* — a deliberate `toggle-sidebar` either side of it
   * survives until the window changes shape again, which is the difference
   * between the layout having an opinion and the layout overruling you.
   */
  useEffect(() => {
    setSidebarOpen(!narrow);
  }, [narrow]);

  /** Remember the width for the next time this browser opens kururu. */
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {
      // No storage is a window that opens at the default width, not a failure.
    }
  }, [sidebarWidth]);

  /**
   * A width proposed by the drag handle, held between the floor and the ceiling.
   *
   * The clamp is here rather than in the handle because the handle's job is to
   * report where the pointer is and this is the file that knows what a sidebar
   * is for. Note what this costs downstream and why nothing has to be done
   * about it: a narrower sidebar is a wider stage, so every pane's box moves,
   * and a moved box is a new proposed grid and therefore a SIGWINCH into every
   * agent on screen. That is correct — it is what dragging the edge of the
   * window means — and it arrives through the `ResizeObserver` in
   * `terminals.ts` with the same 60ms settle a dragged divider gets, so a drag
   * is one resize at the end of it rather than one per frame.
   */
  const resizeSidebar = useCallback((px: number) => {
    setSidebarWidth(Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px))));
  }, []);

  /**
   * Tell the server what is on screen: the active tab of every pane, and only of
   * the workspace you are in. A workspace you are not looking at is not costing
   * anything — which is the point of having several.
   *
   * A narrow window draws one pane (see `Panes`), so it says one terminal — and
   * that is load bearing rather than tidiness. *Visible* is what gives a client
   * a vote on the size of a pty, the policy is the smallest vote over everybody
   * who can see it, and a phone claiming to see four panes would hold all four
   * down to a quarter of a phone screen on the desktop watching the same agents.
   * The rest stay warm and keep being fed: the pool says so separately, which is
   * the whole reason `watch` carries two sets.
   */
  const visible = useMemo(() => {
    if (!workspace) return [];
    if (!narrow) return visibleAgents(workspace.layout);
    const shown = activeAgent(soloPane(workspace.layout, workspace.focusedPaneId));
    return shown ? [shown] : [];
  }, [workspace, narrow]);
  useEffect(() => {
    api.watch(visible);
  }, [visible]);

  /**
   * Make the noise and draw the card when the server says somebody is wanted.
   *
   * Registered once, and the settings are read through a ref rather than
   * captured, for the reason the appearance effect is keyed on a string: a
   * snapshot arrives several times a second and is a new object every time, so
   * a dependency on it would tear this subscription down and rebuild it at that
   * rate forever. Nothing is lost by reading late — a notification is answered
   * with whatever the settings are at the moment it arrives, which is the only
   * sensible reading of them.
   *
   * No policy here. Everything that decides *whether* is in `shared/notify.ts`
   * and has already run on the server; a message that got this far passed.
   */
  const notifySettings = snapshot?.notify;
  const notifyRef = useRef(notifySettings);
  notifyRef.current = notifySettings;
  useEffect(() => {
    // The browser will not let a page make a noise until it has been touched,
    // and there is no way to ask whether it has — so be there when it happens.
    primeAudio();
    // And ask for the cards on that same first touch, so somebody opening kururu
    // for the first time is asked rather than finding out months later that the
    // notifications they never saw were a permission nobody had requested. The
    // gesture matters: Safari ignores an ask without one, and a prompt raised
    // while the window is still drawing gets dismissed — which is `denied`, and
    // a page cannot take that back.
    primeNotifyPermission();
    return api.onNotify((card) => {
      const settings = notifyRef.current;
      if (settings) announce(card, settings);
    });
  }, []);

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
   * The database button. Asked about in both directions, which is not the usual
   * rule — kururu confirms destruction and nothing else — and the exception is
   * earned by what these two cost.
   *
   * Stopping is the obvious one: a local Supabase is holding somebody's
   * afternoon of seeded data behind an app that is probably mid-request, and it
   * is one tap away from a button that is also on the row. Starting is the less
   * obvious one and is why this is not "confirm the dangerous half": it is a
   * minute of Docker, and a minute of Docker begun by accident on a laptop is a
   * minute of fans and a tab you did not open. So both, and the dialog names
   * which one it is — the server is told `on` explicitly for the same reason.
   */
  const confirmSupabase = useCallback(
    (workspaceId: string, on: boolean) => {
      const workspace = profile?.workspaces.find((w) => w.id === workspaceId);
      if (!workspace) return;
      setDialog({
        kind: "confirm",
        title: on ? `Start the database in \u201c${workspace.name}\u201d?` : `Stop the database in \u201c${workspace.name}\u201d?`,
        hint: on
          ? "It runs in a terminal in that workspace, and takes about a minute."
          : "Anything talking to it stops being able to. Your data stays where it is.",
        confirmLabel: on ? "Start" : "Stop",
        onConfirm: () => api.supabasePower(workspaceId, on),
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
         * landed on is the useful one. It was a pick dialog; then renaming and
         * deleting moved into Settings and the picking went with them. That
         * overcorrected. *Switching* never stopped being navigation: it is the
         * thing you do ten times an afternoon, and routing it through a modal
         * with a "Switch to" button on every row put three clicks and a dialog
         * in front of a move between two rooms.
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
    [workspace, profile, agents, promptNewProfile, confirmDeleteWorkspace],
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

      /**
       * A key aimed at a text field belongs to the field, prefix included:
       * ctrl+a in a box you are typing in means select-all everywhere else on
       * this machine, and a filter you cannot get to the start of is a filter
       * that behaves like nothing else on screen. `editing` says the same thing
       * for the fields the chrome knows about by name — the sidebar's rename,
       * Settings' capture box — and this is the general form of it, for a field
       * inside a pane, which no flag up here could know about.
       *
       * An `<input>` and nothing else, which is not laziness: ghostty-web parks
       * a 1x1 `<textarea>` under every terminal to catch keystrokes and IME, and
       * it is *focused* whenever you are typing into a pty. Excluding textareas
       * as a class would therefore exclude the prefix from every terminal in the
       * window — the exact keyboard this handler exists to provide.
       *
       * Escape is the exception and goes on through, because it is the way out
       * of the thing the field is *in* — Settings, a dialog — as often as it is
       * the way out of the field, and those below decide between the two. The
       * field still sees it: this listener captures, and letting an event past
       * without taking it is what leaves it to arrive at its target.
       */
      if (event.target instanceof HTMLInputElement && keyName(event) !== "escape") return;

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
          return;
        }
        /**
         * A reader is the one pane with nothing under it that keys belong to, so
         * the three a document viewer has used since documents had viewers are
         * free to mean what they mean everywhere else. No prefix, because there
         * is no pty here to get out of the way of — the prefix exists to settle
         * a fight over the keyboard and in this pane there is nobody to fight.
         *
         * Modifiers are deliberately let through instead: ⌘+ and ⌘0 are
         * Electron's and zoom the *window*, which is a different and equally
         * reasonable thing to want, and taking them here would make the two
         * indistinguishable from the outside.
         */
        if (readerFocused(workspace) && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const key = keyName(event);
          if (key === "+" || key === "=") {
            take();
            return zoomBy(1);
          }
          if (key === "-" || key === "_") {
            take();
            return zoomBy(-1);
          }
          if (key === "0") {
            take();
            return resetZoom();
          }
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
    /* The width is a custom property rather than an inline width on the aside,
       because two rules need it: the sidebar itself, and — while it is an
       overlay — nothing at all. Putting it on the root lets the stylesheet
       decide which of those applies, which is the whole point of stating the
       breakpoint once. `app-window` says this is Electron rather than a browser
       tab, and exists for exactly one thing: the traffic lights, which float
       over this corner and are not there on a phone. */
    <div
      className={`app ${zen ? "app-zen" : ""} ${desktop() ? "app-window" : ""}`}
      style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
    >
      {sidebarOpen && !zen && (
        <Sidebar
          profile={profile}
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
          onSupabase={confirmSupabase}
          onEditing={setEditing}
          onSettings={() => setSettings("appearance")}
          onReach={() => setReach(true)}
          /* Whether it is a column or a screen, and how to get rid of it. The
             sidebar draws a close button only in the second case — in the first
             the panes beside it are already the way out. */
          overlay={narrow}
          onClose={() => setSidebarOpen(false)}
          onResize={resizeSidebar}
          onResetWidth={() => setSidebarWidth(SIDEBAR_DEFAULT)}
        />
      )}
      {/* A full-screen sidebar sits over the panes, so it needs something
          behind it to swallow the taps that miss. Escape is deliberately *not*
          a way out of it: escape belongs to whatever is running in the pty —
          it is how you leave insert mode — and a chrome that took it would be
          a chrome that broke vim to save a keystroke. */}
      {sidebarOpen && !zen && narrow && (
        <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      )}

      <div className="stage">
        {/* Somewhere to drag the window by when the sidebar is not there to be
            it. The traffic lights float over the top-left corner whether or not
            anything is drawn under them, so a hidden sidebar used to leave them
            sitting on a terminal with nothing to grab the window by at all —
            which mattered little while hiding it was a keyboard gesture and
            matters rather more now that a narrow window starts that way. */}
        {!sidebarOpen && !zen && <div className="stage-drag" aria-hidden="true" />}
        <main className="panes">
          <Panes
            node={workspace.layout}
            focusedPaneId={workspace.focusedPaneId}
            agents={agents}
            mascot={mascot}
            /* For the key hints in a pane's menu — the same merged map the help
               overlay prints, so the two never disagree about where a split is. */
            keymap={keymap}
            zen={zen}
            /* One pane at a time once there is no room to tile — the same
               number that turns the sidebar into a screen, for the same
               reason, which is why it is this flag and not a second
               breakpoint. */
            solo={narrow}
            keyboard={paneKeyboard}
          />
        </main>
        {/* Between the panes and the status bar, which puts it directly above
            the on-screen keyboard — `.app` is already shortened by `--keyboard`,
            so the bar rides up with the bottom edge and needs to know nothing
            about any of it. Not below the status bar, thumb reach
            notwithstanding: the bar is a keyboard, the keyboard belongs against
            the keys it extends, and the status bar is the window's bottom edge
            and the one thing that owns the home indicator's inset.

            Hidden in zen for the same reason the status bar is. Zen means the
            pane takes the window, and a toolbar is chrome — and unlike the
            sidebar toggle there is nothing here that cannot be reached another
            way, since zen is itself something you left by pressing a key. */}
        {touch && keybarOpen && !zen && (
          <Keybar agentId={focusedAgentOf(workspace)} keyboard={paneKeyboard} />
        )}
        <StatusBar
          profile={profile}
          workspace={workspace}
          connected={connected}
          prefixArmed={prefixArmed}
          resizeMode={resizeMode}
          /* The pointer's door onto `toggle-sidebar`. It has always had a key,
             and a key is no use at all in the one state that needs this most:
             the sidebar hidden on a phone, where there is no keyboard to press
             it with and nothing on screen saying the list is still there. */
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => run("toggle-sidebar")}
          /* Null on a mouse, which is how the bar draws no toggle at all rather
             than a disabled one: a control for a thing that cannot exist here is
             worse than no control. */
          keybarOpen={touch ? keybarOpen : null}
          onToggleKeybar={() => setKeybarOpen((open) => !open)}
          /* The jump between panes, drawn only where the panes are not all on
             screen at once — on a wide window the one you would jump to is
             already in front of you, and a click on it is the jump. Null rather
             than a count on the rest, so the bar can tell "there is nothing to
             jump to" from "there is nothing to jump *from*". */
          panes={narrow ? panes(workspace.layout).length : null}
          onLastPane={() => api.lastPane()}
          onHelp={() => setHelp(true)}
        />
      </div>

      {help && <HelpOverlay keymap={keymap} onClose={() => setHelp(false)} />}
      {settings && (
        <Settings
          appearance={snapshot.appearance}
          styles={snapshot.styles}
          mascots={snapshot.mascots}
          notify={snapshot.notify}
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
      {skinFor(snapshot.appearance.skinId, snapshot.styles.skins).tokens.overlay !== "none" && (
        <div className="overlay" aria-hidden="true" />
      )}
    </div>
  );
}

/**
 * Is the window narrow enough that the sidebar should be a screen?
 *
 * `matchMedia` rather than a `resize` listener: the browser is already
 * evaluating this query for the stylesheet and will say when the answer flips,
 * so subscribing to the answer costs one event per crossing instead of one per
 * frame of a window drag.
 */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(matchesNarrow);
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const onChange = () => setNarrow(query.matches);
    query.addEventListener("change", onChange);
    // And once now, in case the window changed between the initial state being
    // computed and this effect running.
    onChange();
    return () => query.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/**
 * Is this a device somebody touches?
 *
 * The same question `terminals.ts` asks before it takes the focus, through the
 * same query string, and asked here as a subscription rather than a call
 * because this one decides what is *rendered* — a tablet that has just had a
 * keyboard folded onto it should lose the toolbar without a reload, and only a
 * listener can do that. `matchMedia` rather than a resize listener on
 * `useNarrow`'s reasoning: the browser already knows and will say.
 */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(terminals.fingerPointer);
  useEffect(() => {
    const query = window.matchMedia(terminals.COARSE_POINTER);
    const onChange = () => setCoarse(query.matches);
    query.addEventListener("change", onChange);
    onChange();
    return () => query.removeEventListener("change", onChange);
  }, []);
  return coarse;
}

/** Whether this device last left the touch toolbar up. Defaults to up. */
function storedKeybar(): boolean {
  try {
    return localStorage.getItem(KEYBAR_KEY) !== "0";
  } catch {
    return true;
  }
}

/**
 * Keep the window above the on-screen keyboard.
 *
 * A phone keyboard does not resize the page: it is drawn *over* it, and the
 * layout viewport carries on believing it has the whole screen. So the bottom
 * third of the terminal — which is exactly where an agent draws the box you are
 * typing into — sits underneath it, and you type into something you cannot see.
 * The one thing that knows otherwise is the **visual** viewport, so that is what
 * this watches, on both `resize` and `scroll` because a phone answers a keyboard
 * with some of each.
 *
 * What comes out is a length on the root element and nothing else — no React
 * state — for the reason `applyTheme` is an effect and not a context: the answer
 * is consumed by one CSS rule, and re-rendering the window to tell it a number
 * the cascade can carry is paying a render for nothing.
 *
 * **The terminal then genuinely reflows, and that is the feature rather than a
 * side effect.** The pane is shorter, so it proposes fewer rows, so the pty is
 * resized and the agent redraws its input box at the new bottom — which is the
 * whole point, and it is why this shortens the window rather than sliding it
 * upwards. Sliding would have left the rows where they were and pushed the top
 * of the screen out of sight, so the thing you are typing into would be visible
 * and everything it was replying to would not.
 *
 * Two consequences worth knowing. The proposal goes through the same 60ms
 * settle a dragged divider does, so a keyboard costs one SIGWINCH on the way up
 * and one on the way down rather than one per frame of the animation. And the
 * size policy is `smallest` over every client that can see the terminal, so
 * while you are typing on a phone the desktop watching the same agent is drawn
 * at the phone's row count too. That is the policy working rather than a bug —
 * the phone really can only see that many rows — but it is visible, and it is
 * the reason this file says so out loud.
 */
function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    // Every browser kururu runs in has this; the guard is for the one that does
    // not, where the answer is simply that there is no keyboard to make room for.
    if (!viewport) return;

    const apply = () => {
      /**
       * `offsetTop` is in here because a phone does not only shrink the visual
       * viewport, it also slides it — iOS scrolls the focused field into view,
       * and without this the slide reads as the keyboard having grown by however
       * far it scrolled.
       */
      const inset = window.innerHeight - viewport.height - viewport.offsetTop;
      const keyboard = inset > KEYBOARD_MIN ? Math.round(inset) : 0;
      document.documentElement.style.setProperty("--keyboard", `${keyboard}px`);
    };

    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      document.documentElement.style.removeProperty("--keyboard");
    };
  }, []);
}

function matchesNarrow(): boolean {
  return typeof window !== "undefined" && window.matchMedia(NARROW).matches;
}

/**
 * The width this browser was last left at, or the default.
 *
 * Clamped on the way in as well as on the way out, because what comes back is a
 * string somebody could have edited and a sidebar restored to four pixels is
 * one with no way to get hold of its own drag handle.
 */
function storedSidebarWidth(): number {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) {
      return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, saved)));
    }
  } catch {
    // Storage that refuses to answer is a default width, not an error.
  }
  return SIDEBAR_DEFAULT;
}

/** The terminal the focused pane is showing, if any. */
/**
 * Whether the keyboard is pointed at a reader rather than at a terminal.
 *
 * Asked of the *pane* and not of the agent, because "no agent" is also what an
 * empty pane looks like and an empty pane is a button waiting to open a shell —
 * claiming its keys for a zoom would be claiming them from the terminal that is
 * one press away.
 */
function readerFocused(
  workspace: { layout: LayoutNode; focusedPaneId: string } | null,
): boolean {
  if (!workspace) return false;
  const pane = panes(workspace.layout).find((p) => p.id === workspace.focusedPaneId);
  return Boolean(pane?.reader);
}

function focusedAgentOf(
  workspace: { layout: LayoutNode; focusedPaneId: string } | null,
): string | null {
  if (!workspace) return null;
  const pane = panes(workspace.layout).find((p) => p.id === workspace.focusedPaneId);
  return pane ? activeAgent(pane) : null;
}
