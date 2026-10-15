/**
 * Who is speaking, as a picture: a microphone for you, a speaker for Kuru.
 *
 * Drawn here rather than taken from the skin's icon set on `BarsIcon`'s
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
