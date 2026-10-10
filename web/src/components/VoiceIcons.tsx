/**
 * Who is speaking, as a picture: a microphone for you, a speaker for Kuru.
 *
 * Drawn here rather than taken from the skin's icon set on `BarsIcon`'s
 * reasoning — pictures of physical objects that mean the same thing in any
 * chrome — and kept together because they are used as a pair. The list
 * behind the harness button holds two lists that look alike, your messages
 * on their way to Kuru and Kuru's replies you did not hear, and which way the
 * words went is the one thing about each that must not be misread.
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
