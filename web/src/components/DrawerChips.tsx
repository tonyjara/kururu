/**
 * The two drawers' doors: what needs you, and Kuru.
 *
 * A component of their own since 2026-10-18, because they stopped having one
 * home. They were the right half of the status bar, and the bar under the
 * panes is gone: with both drawers shut they sit in the sidebar's header
 * beside the profile's board — or in the strip along the top of the panes
 * when there is no sidebar — and with one drawer open they move into that
 * drawer's header, where the open one is lit and the other is the way across.
 * One pair on screen at a time, never two copies of the same door, which is
 * why the app decides where they go and passes them down as one element
 * rather than each place drawing its own.
 *
 * A phone keeps them in the bar along the bottom, with the rest of what a
 * thumb reaches for — see `StatusBar.tsx`.
 */
import type { MascotConfig } from "../../../shared/model";
import type { KuruLive } from "../kuru";
import { InboxIcon } from "./NeedsDrawer";
import { Mascot } from "./Status";
import { MicIcon, SpeakerIcon } from "./VoiceIcons";

export interface DrawerChipsProps {
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

export function DrawerChips({ kuru, onKuru, needs, onNeeds }: DrawerChipsProps) {
  return (
    <span className="drawer-chips">
      {/* What needs you: the tray, dim while nothing does; the blocked ink and
          a count while something does, since what it counts is mostly agents
          asking. No words since 2026-10-13 — the tray and its count are what
          the eye comes for, and the title and the label still say what it is,
          to a pointer and to a screen reader. It stays at zero rather than
          vanishing, because chrome that comes and goes reads as a bar that
          lost a button. `mousedown` is prevented on both chips for one reason:
          opening a drawer must not take the focus off a terminal. */}
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
      {/* Kuru's chip. Quiet, it is a dim dot and the word; thinking, the
          mascot hops; speaking, the speaker glyph in the working ink; asking,
          the blocked ink and the word; off, dim and the word. News is text
          inside the chip and never a corner: a red count with the mic for
          messages that did not get through. In flight and all delivered are
          not news and get no mark. */}
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
    </span>
  );
}

/** What the chip says when hovered: how many, where, and which way the click goes. */
function needsTitle(needs: DrawerChipsProps["needs"]): string {
  const what =
    needs.count === 0
      ? "Nothing needs you"
      : `${needs.count} ${needs.count === 1 ? "thing needs" : "things need"} you in ${needs.workspaces} ${needs.workspaces === 1 ? "workspace" : "workspaces"}`;
  return `${what} — ${needs.open ? "close" : "open"} the list (C-a i)`;
}

/** What the chip says when hovered: the state, then whatever is news. */
function kuruTitle(kuru: DrawerChipsProps["kuru"]): string {
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
