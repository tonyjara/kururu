/**
 * One line along the bottom: where you are, whether the mux is listening, and
 * what is waiting for you.
 *
 * The PREFIX badge is the load-bearing part. A prefix is a mode, and an unlabelled
 * mode is the thing that makes people distrust modal interfaces — you press the
 * chord, something else takes your attention, and three seconds later you cannot
 * tell whether the next key will split a pane or go into your shell. So the bar
 * says, and it stops saying when the prefix times out.
 *
 * Everything else on it earns its place by one of two tests, and the bar has
 * two halves because there are two tests. The left half is *where you are and
 * the two columns beside you*: the sidebar's toggle at the edge the sidebar
 * opens on, the workspace's name, and the mode badges. The right half is *what
 * is coming to you*: the two drawers' chips — what needs you, and Kuru — and
 * then the file tree's toggle at the edge the tree opens on, mirroring the
 * bars. A phone gets two more between the halves, the jump to the other pane
 * and the key bar's toggle, because on a phone those are the thumb's only
 * doors onto things a keyboard does for free.
 *
 * What is *not* here is as deliberate. The profile's name was, and went on
 * 2026-10-12: it is the sidebar's header, and a name shown twice is a name
 * you check twice. Settings and the phone's QR code were in the sidebar's
 * foot, which sat on this bar's left end as three icon buttons from two
 * components — they are in that header now, beside the name they belong to.
 * The `C-a ?` hint went too: the keys are a page in Settings and a key away,
 * and a hint for a chord that is barely used was the bar's loudest text. The
 * talk key's button is in the Kuru drawer's composer, which is the one place
 * a message to Kuru is already being written; a microphone on the bar beside
 * Kuru's chip was two controls for one conversation.
 */
import type { MascotConfig, Workspace } from "../../../shared/model";
import type { KuruLive } from "../kuru";
import { InboxIcon } from "./NeedsDrawer";
import { Mascot } from "./Status";
import { MicIcon, SpeakerIcon } from "./VoiceIcons";

interface Props {
  workspace: Workspace;
  connected: boolean;
  prefixArmed: boolean;
  resizeMode: boolean;
  /** Whether the sidebar is up, so the toggle can say which way it goes. */
  sidebarOpen: boolean;
  /** `toggle-sidebar`, for a pointer. See below for why the bar is where it is. */
  onToggleSidebar: () => void;
  /** The file tree, and its toggle: the sidebar's pair, for the other side. */
  filesOpen: boolean;
  onToggleFiles: () => void;
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
  /**
   * Kuru, as the second of the two chips: what it is doing, the one count that
   * is news, and whether its drawer is up. The mascot is the one that hops
   * while it thinks. The count of replies nobody heard was here too, and went
   * on 2026-10-12 — the drawer marks each unheard reply where it sits, and
   * asking Kuru what you missed plays them, which is all the count ever led to.
   */
  kuru: { live: KuruLive; undelivered: number; open: boolean; mascot: MascotConfig };
  onKuru: () => void;
  /**
   * What needs you across the workspaces, in two numbers, and whether its
   * drawer is up — the first of the two chips. See `NeedsDrawer.tsx`.
   */
  needs: { count: number; workspaces: number; open: boolean };
  onNeeds: () => void;
}

export function StatusBar({
  workspace,
  connected,
  prefixArmed,
  resizeMode,
  sidebarOpen,
  onToggleSidebar,
  filesOpen,
  onToggleFiles,
  keybarOpen,
  onToggleKeybar,
  panes,
  onLastPane,
  kuru,
  onKuru,
  needs,
  onNeeds,
}: Props) {
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
      {/* The workspace, and only the workspace. With the sidebar up its row is
          lit and this is a second copy; with the sidebar away — which is how a
          phone spends most of its time — it is the one thing on screen that
          says which of the workspaces the panes belong to, and that is the
          state the bar is laid out for. The `1 ` that used to lead it was the
          `C-a 1` hint, and is gone with the rest of the key hints. */}
      <span className="sb-workspace">{workspace.name}</span>

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
      {/* The two drawers' chips: a mark, then whatever is news, and Kuru's
          name between them on a desktop. What needs you said its words too
          from 2026-10-12, on the argument that a tray with no word is an
          inbox and the inbox is the other drawer; on 2026-10-13 they went on
          every device, as they already had on a phone. The tray and its count
          are what the eye comes for, and the words were the widest thing on
          the right of the bar — the title and the label still say what it is,
          to a pointer and to a screen reader.

          What needs you: the tray, dim while nothing does; the blocked ink and
          a count while something does, since what it counts is mostly agents
          asking. It stays at zero rather than vanishing, because chrome that
          comes and goes reads as a bar that lost a button. `mousedown` is
          prevented on both chips for one reason: opening a drawer must not
          take the focus off a terminal. See `NeedsDrawer.tsx`. */}
      <button
        className={`sb-needs ${needs.count > 0 ? "sb-needs-some" : ""} ${needs.open ? "sb-needs-on" : ""}`}
        onClick={onNeeds}
        onMouseDown={(event) => event.preventDefault()}
        title={needsTitle(needs)}
        aria-label={needsTitle(needs)}
        aria-expanded={needs.open}
      >
        <InboxIcon />
        {needs.count > 0 && <span className="sb-needs-n">{needs.count}</span>}
      </button>
      {/* Kuru's chip: the one door onto its drawer. Quiet, it is a dim dot and
          the word; thinking, the mascot hops; speaking, the speaker glyph in
          the working ink; asking, the blocked ink and the word; off, dim and
          the word. News is text inside the chip and never a corner: a red
          count with the mic for messages that did not get through. In flight
          and all delivered are not news and get no mark. */}
      <button
        className={`sb-kuru sb-kuru-${kuru.live} ${kuru.open ? "sb-kuru-on" : ""}`}
        onClick={onKuru}
        onMouseDown={(event) => event.preventDefault()}
        title={kuruTitle(kuru)}
        aria-label={kuruTitle(kuru)}
        aria-expanded={kuru.open}
      >
        <span className="sb-kuru-mark" aria-hidden="true">
          {kuru.live === "thinking" ? (
            <span className="status status-working">
              <Mascot config={kuru.mascot} clip={kuru.mascot.working} />
            </span>
          ) : kuru.live === "speaking" ? (
            <SpeakerIcon />
          ) : (
            <span className="sb-kuru-dot" />
          )}
        </span>
        <span className="sb-kuru-name">Kuru</span>
        {(kuru.live === "asking" || kuru.live === "off") && <span className="sb-kuru-word">{kuru.live}</span>}
        {kuru.undelivered > 0 && (
          <span className="sb-kuru-news sb-kuru-failed">
            <MicIcon />
            {kuru.undelivered}
          </span>
        )}
      </button>
      {/* The tree's door, on the side the tree opens on — the bars at the far
          left open the column on the left, and this is the same gesture
          mirrored, the last thing on the bar on every device. */}
      <button
        className={`sb-files ${filesOpen ? "sb-files-on" : ""}`}
        onClick={onToggleFiles}
        title={filesOpen ? "Hide the files (C-a e)" : "Show the files (C-a e)"}
        aria-label={filesOpen ? "Hide the files" : "Show the files"}
        aria-expanded={filesOpen}
      >
        <FilesIcon />
      </button>
    </footer>
  );
}

/** What the chip says when hovered: how many, where, and which way the click goes. */
function needsTitle(needs: Props["needs"]): string {
  const what =
    needs.count === 0
      ? "Nothing needs you"
      : `${needs.count} ${needs.count === 1 ? "thing needs" : "things need"} you in ${needs.workspaces} ${needs.workspaces === 1 ? "workspace" : "workspaces"}`;
  return `${what} — ${needs.open ? "close" : "open"} the list (C-a i)`;
}

/** What the chip says when hovered: the state, then whatever is news. */
function kuruTitle(kuru: Props["kuru"]): string {
  const state =
    kuru.live === "off"
      ? "Kuru is not running"
      : kuru.live === "thinking"
        ? "Kuru is thinking"
        : kuru.live === "asking"
          ? "Kuru is asking something in its terminal"
          : kuru.live === "speaking"
            ? "Kuru is speaking"
            : "Kuru";
  const news =
    kuru.undelivered > 0 ? ` · ${kuru.undelivered} ${kuru.undelivered === 1 ? "message" : "messages"} did not get through` : "";
  return `${state}${news} — ${kuru.open ? "close" : "open"} the conversation (C-a a)`;
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

/**
 * A folder, drawn here rather than taken from the skin's icon set on
 * `BarsIcon`'s reasoning — it is the partner of the bars at the other end of the
 * bar, and means the same thing in any chrome.
 */
function FilesIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}
