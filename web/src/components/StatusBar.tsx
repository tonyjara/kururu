/**
 * One line along the bottom of the window, the whole width of it: how many
 * agents are at work, and whether the mux is listening.
 *
 * It is the second bar to hold this name. The first ran under the panes only,
 * and carried the sidebar's toggle, the workspace's name, the two drawers'
 * chips and the file tree's folder; on 2026-10-18 the user had it taken away
 * and this put in its place. The toggle and the name went up beside the
 * traffic lights (`WorkspaceToggle`, below, drawn by the sidebar and by the
 * strip over the panes when there is no sidebar), the chips went to the
 * top-right pane's strip (`DrawerChips.tsx`), and the folder went altogether —
 * the tree is `C-a e` and a line in every pane's menu.
 *
 * **Everything on it stands at the right**, and whatever is added later goes
 * there too, so the bar reads as one cluster against the edge the drawers open
 * from rather than a row of odd bits spread across the window. The exception
 * is the left end's gauges — the Claude and Codex allowances (`Usage.tsx`)
 * and the machines (`Machines.tsx`), down from the sidebar on 2026-10-18:
 * things of a different kind, whose detail opens upwards over the panes
 * rather than the drawers.
 *
 * What it holds is the count of agents that are running, across every profile,
 * by the rule `/api/health` and `bun run status` count by (`countsAsAgent`), so
 * the three never disagree about a number. The PREFIX badge stayed too, and is
 * the reason this bar is not empty while nothing is at work. A prefix is a
 * mode, and an unlabelled mode is the thing that makes people distrust modal
 * interfaces — you press the chord, something else takes your attention, and
 * three seconds later you cannot tell whether the next key will split a pane
 * or go into your shell. So the bar says, and it stops saying when the prefix
 * times out. Resize mode and a dropped connection are the same kind of thing
 * and sit beside it.
 *
 * A phone is the exception, and keeps what it had. Its sidebar is a screen
 * rather than a column, so there is no header to put a toggle or a chip in
 * while the panes are up, and the bottom edge is the half of the screen a
 * thumb reaches. So on a narrow window the bar opens with the toggle and the
 * workspace at the left, and the right holds the count, the jump to the other
 * pane, the key bar's toggle and the two chips — the thumb's only doors onto
 * things a keyboard does for free.
 */
import type { ReactNode } from "react";
import { countsAsAgent, type AgentSnapshot } from "../../../shared/model";
import { MachinesChip } from "./Machines";
import { UsageChips } from "./Usage";

interface Props {
  agents: readonly AgentSnapshot[];
  connected: boolean;
  prefixArmed: boolean;
  resizeMode: boolean;
  /**
   * The sidebar's toggle and the workspace's name, when this bar is where they
   * go — a narrow window, whose sidebar is a screen. Null on a desktop, where
   * they are at the top. See `WorkspaceToggle`.
   */
  toggle: ReactNode;
  /**
   * Whether the touch key toolbar is up, or null on a device that cannot have
   * one. Null rather than a second boolean beside it, so that "there is no such
   * thing here" and "it is currently hidden" cannot be confused for each other
   * by whoever reads this next — which is the same shape `mascotId` argues for.
   */
  keybarOpen: boolean | null;
  onToggleKeybar: () => void;
  /**
   * How many panes this workspace has, or null on a window wide enough to draw
   * them all at once.
   *
   * Null rather than a boolean beside a count, on `keybarOpen`'s reasoning: "the
   * window shows every pane already" and "the window shows one of two" are
   * different things and should not be one field apart. It is a count rather
   * than a flag because the button has three states and the third is the count
   * — nothing to jump to when there is only one pane, and a disabled control
   * says that better than a missing one, which would read as a bar that had
   * lost a button.
   */
  panes: number | null;
  onLastPane: () => void;
  /** The two drawers' chips, on a phone; null where they are at the top. */
  chips: ReactNode;
  /** Settings → Machines, from the foot of the machines chip's popover. */
  onMachinesSettings: () => void;
}

export function StatusBar({
  agents,
  connected,
  prefixArmed,
  resizeMode,
  toggle,
  keybarOpen,
  onToggleKeybar,
  panes,
  onLastPane,
  chips,
  onMachinesSettings,
}: Props) {
  const running = agents.filter(countsAsAgent);
  const working = running.filter((agent) => agent.status === "working").length;
  return (
    <footer className="statusbar">
      {toggle}
      {/* The left end on a desktop: the allowances — whose they are and a
          ring a window — and the machines, a glyph in the colour of the
          worst load and how many are connected. Each opens its detail on a
          hover or a tap. See `Usage.tsx` and `Machines.tsx`. */}
      <UsageChips />
      <MachinesChip onSettings={onMachinesSettings} />
      <span className="sb-spacer" />

      {prefixArmed && <span className="sb-badge sb-prefix">PREFIX</span>}
      {resizeMode && <span className="sb-badge sb-resize">RESIZE hjkl · esc</span>}
      {!connected && <span className="sb-badge sb-off">reconnecting…</span>}

      {/* The count, the bar's one standing fact. Running is the number and
          working is the news: an agent at a prompt is still holding its
          context and its tokens, so it counts, and the working ones are said
          beside it — in their ink — only when there are any, since "0
          working" is a word for nothing. */}
      <span
        className={`sb-agents ${working > 0 ? "sb-agents-working" : running.length === 0 ? "sb-agents-none" : ""}`}
        title={`${running.length} ${running.length === 1 ? "agent is" : "agents are"} running, across every profile${working > 0 ? ` — ${working} working` : ""}`}
      >
        <span className="sb-agents-dot" aria-hidden="true" />
        <span className="sb-agents-n">{running.length}</span>
        <span className="sb-agents-word">{running.length === 1 ? "agent" : "agents"}</span>
        {working > 0 && <span className="sb-agents-busy">· {working} working</span>}
      </span>

      {/* The other pane, in one press.
          A narrow window draws one pane at a time, and somebody watching two
          agents crosses between them every few seconds — which is a move worth a
          button rather than a menu, the same argument the profile switcher lost
          when it was a dialog. It sits beside the keyboard toggle because both
          are about the half of the window a thumb is holding, and it goes
          *before* it: this one moves you, and the one next to it changes what is
          under your thumb once you are there.

          Disabled rather than hidden at one pane, so the bar keeps its shape
          the moment you split — and the title says which of the two reasons it
          is dim. */}
      {panes !== null && (
        <button
          className="sb-panes"
          onClick={onLastPane}
          disabled={panes < 2}
          title={panes < 2 ? "The only pane in this workspace" : "The other pane"}
          aria-label="Go to the other pane"
        >
          <SwapIcon />
        </button>
      )}
      {/* The toolbar's only way back, so it lives somewhere that is never
          covered by it. It is drawn only where there is a toolbar to talk
          about — on a desktop the keys it offers are all on the keyboard
          already, and a toggle for a bar that would never appear is a control
          that teaches somebody the wrong thing about the window. */}
      {keybarOpen !== null && (
        <button
          className={`sb-keys ${keybarOpen ? "sb-keys-on" : ""}`}
          onClick={onToggleKeybar}
          title={keybarOpen ? "Hide the key bar" : "Show the key bar"}
          aria-label={keybarOpen ? "Hide the key bar" : "Show the key bar"}
          aria-pressed={keybarOpen}
        >
          <KeysIcon />
        </button>
      )}
      {chips}
    </footer>
  );
}

/**
 * The sidebar's toggle and the workspace's name, which go together wherever
 * they are drawn: the button that opens or puts away the sidebar, and the name
 * of the workspace the panes belong to.
 *
 * They were the left end of the bar under the panes, and on 2026-10-18 they
 * went up into the strip the traffic lights stand in — the sidebar's top line
 * while there is a sidebar, the top of the panes while there is not — and the
 * name sits where a window's title would. On a phone they are still the
 * bottom bar's left end, where a thumb is.
 *
 * `toggleLast` is the sidebar's top line: the name leads and the toggle stands
 * at the far end, on the edge the sidebar folds towards. With the sidebar away
 * the toggle comes first, just after the traffic lights, which is where a Mac
 * app keeps the button that brings its sidebar back.
 *
 * The name is heavier than it was. With the bar it was one quiet label among
 * several; up here it is the window's title, and it is read as one.
 */
export function WorkspaceToggle({
  name,
  sidebarOpen,
  toggleLast,
  onToggle,
}: {
  name: string;
  sidebarOpen: boolean;
  toggleLast: boolean;
  onToggle: () => void;
}) {
  const button = (
    <button
      className="sb-bars"
      onClick={onToggle}
      title={sidebarOpen ? "Hide the sidebar (C-a b)" : "Show the sidebar (C-a b)"}
      aria-label={sidebarOpen ? "Hide the sidebar" : "Show the sidebar"}
      aria-expanded={sidebarOpen}
    >
      <SidebarIcon />
    </button>
  );
  return (
    <span className={`ws-toggle ${toggleLast ? "ws-toggle-last" : ""}`}>
      {!toggleLast && button}
      <span className="sb-workspace">{name}</span>
      {toggleLast && button}
    </span>
  );
}

/**
 * A window with its left column ruled off: the sidebar, which is the thing
 * this button opens and closes. It was three lines until 2026-10-18, and three
 * lines say "a list of things" — a menu — where this says which part of the
 * window moves. Drawn rather than taken from the skin's icon set for the
 * reason the cog and the QR code in the sidebar are: the set names the glyphs
 * a *skin* is expected to restyle, and a new entry in it would be one more
 * thing every future skin has to answer for to gain nothing — this is the
 * same drawing in any chrome.
 */
function SidebarIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}

/**
 * Two arrows swapping places: there and back, which is what the button does.
 *
 * Not a picture of two panes, though that was the first drawing. A pane is what
 * you are *in*, so a diagram of one says "panes" and leaves you to guess the
 * verb — and the verb is the whole button, since the switcher in the pane's own
 * corner is already the noun. Drawn here rather than taken from the skin's icon
 * set on `SidebarIcon`'s reasoning.
 */
function SwapIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9h13M13 5l4 4-4 4" />
      <path d="M20 15H7M11 11l-4 4 4 4" />
    </svg>
  );
}

/**
 * A keyboard, drawn here rather than taken from the skin's icon set on
 * `SidebarIcon`'s reasoning: the set names the glyphs a skin is expected to
 * restyle, and this is a picture of a physical object that means the same thing
 * in any chrome.
 */
function KeysIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
    </svg>
  );
}
