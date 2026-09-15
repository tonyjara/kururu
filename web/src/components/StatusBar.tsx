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
