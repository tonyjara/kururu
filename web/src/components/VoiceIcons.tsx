/**
 * Who is speaking, as a picture: a microphone for you, a speaker for Kuru.
 *
 * Drawn here rather than taken from the skin's icon set on `SidebarIcon`'s
 * reasoning — pictures of physical objects that mean the same thing in any
 * chrome — and kept together because they are used as a pair. The Kuru
 * drawer is one timeline of your messages and Kuru's replies, and which way
 * the words went is the one thing about each line that must not be misread;
 * the status bar's chip wears the same two over its two counts.
 */

export function MicIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
    </svg>
  );
}

export function SpeakerIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H2v6h4l5 4V5Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
    </svg>
  );
}

/**
 * The speaker struck through, for replies that are not read aloud: the same
 * cone as `SpeakerIcon` with a cross where the waves were, so the two read as
 * one switch in its two positions rather than two different things.
 */
export function SpeakerOffIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H2v6h4l5 4V5Z" />
      <path d="m16 9 6 6M22 9l-6 6" />
    </svg>
  );
}

/**
 * A paper plane, for a message that came from a channel — Telegram's own
 * mark is a plane, and a plane says "sent from elsewhere" in any chrome
 * without borrowing anybody's logo.
 */
export function PlaneIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.5 3.5 2.5 10.8l6.8 2.6 2.6 7 3.4-4.6 4.7 3.6 1.5-15.9Z" />
      <path d="m9.3 13.4 12.2-9.9" />
    </svg>
  );
}

/**
 * A pencil, for the screen pen — the pill's and the Kuru drawer's, beside the
 * microphone, so the two ways of saying something to Kuru sit together.
 */
export function PenIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      <path d="m14.5 5.5 3 3" />
    </svg>
  );
}

/** An arrow turning back, for the pen's Undo in the pill. */
export function UndoIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

/** A camera, for the pen's Snap in the pill: the display under the pointer, as a mark with no ink. */
export function SnapIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}
