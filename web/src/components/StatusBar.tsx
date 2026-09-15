/**
 * One line along the bottom: where you are, and whether the mux is listening.
 *
 * The PREFIX badge is the load-bearing part. A prefix is a mode, and an unlabelled
 * mode is the thing that makes people distrust modal interfaces — you press the
 * chord, something else takes your attention, and three seconds later you cannot
 * tell whether the next key will split a pane or go into your shell. So the bar
 * says, and it stops saying when the prefix times out.
 */
import type { Profile, Workspace } from "../../../shared/model";
import { PREFIX_LABEL } from "../keys";

interface Props {
  profile: Profile;
  workspace: Workspace;
  connected: boolean;
  prefixArmed: boolean;
  resizeMode: boolean;
  /** Whether the sidebar is up, so the toggle can say which way it goes. */
  sidebarOpen: boolean;
  /** `toggle-sidebar`, for a pointer. See below for why the bar is where it is. */
  onToggleSidebar: () => void;
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
  onHelp: () => void;
}

export function StatusBar({
  profile,
  workspace,
  connected,
  prefixArmed,
  resizeMode,
  sidebarOpen,
  onToggleSidebar,
  keybarOpen,
  onToggleKeybar,
  panes,
  onLastPane,
  onHelp,
}: Props) {
  const index = profile.workspaces.findIndex((w) => w.id === workspace.id);
  return (
    <footer className="statusbar">
      {/* The pointer's door onto `toggle-sidebar`, which until now had only a
          key — and a key is no use in the one state that needs this most: the
          sidebar hidden on a phone, where there is no keyboard to press it with
          and nothing on screen to say the list is still there.

          In the status bar rather than floating over the panes, for two
          reasons. It is chrome, and the panes are not a place to put chrome — a
          button over a terminal is a button you hit while clicking into it. And
          on a phone the bottom edge is the half of the screen a thumb reaches,
          which is where a navigation toggle wants to be however firmly the
          desktop habit says "top left". */}
      <button
        className="sb-bars"
        onClick={onToggleSidebar}
        title={sidebarOpen ? "Hide the sidebar (C-a b)" : "Show the sidebar (C-a b)"}
        aria-label={sidebarOpen ? "Hide the sidebar" : "Show the sidebar"}
        aria-expanded={sidebarOpen}
      >
        <BarsIcon />
      </button>
      <span className="sb-profile">{profile.name}</span>
      <span className="sb-sep">/</span>
      <span className="sb-workspace">
        {index >= 0 && index < 9 ? `${index + 1} ` : ""}
        {workspace.name}
      </span>

      {prefixArmed && <span className="sb-badge sb-prefix">PREFIX</span>}
      {resizeMode && <span className="sb-badge sb-resize">RESIZE hjkl · esc</span>}
      {!connected && <span className="sb-badge sb-off">reconnecting…</span>}

      <span className="sb-spacer" />
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
      <button className="sb-help" onClick={onHelp} title="Keys">
        {PREFIX_LABEL} ?
      </button>
    </footer>
  );
}

/**
 * Three lines, which is what every application on every platform has agreed
 * means "the list of things". Drawn rather than taken from the skin's icon set
 * for the reason the cog and the QR code in the sidebar are: the set names the
 * glyphs a *skin* is expected to restyle, and a fourth entry in it would be a
 * fourth thing every future skin has to answer for to gain nothing — this one
 * is the same three lines in any chrome.
 */
function BarsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
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
 * set on `BarsIcon`'s reasoning.
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
 * `BarsIcon`'s reasoning: the set names the glyphs a skin is expected to
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
