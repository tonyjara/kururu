/**
 * The fold that heads a thing: a minus on one that is open, a plus on one
 * folded to its bar. Kuru's chat folds its lines with it, and a window of
 * our own — a popped-out note, a popped-out column — folds itself with the
 * same glyph at the same end.
 *
 * The windows' fold was a chevron pair beside the close, at the bar's right
 * end, and a fold one icon from the × is a close waiting to happen (the
 * owner, 2026-11-25, on a popped-out column: "the collapse button is too
 * close to the x, it should be on the left side … like how we have in the
 * kuru chat"). So it is the chat's glyph and the chat's place, and the right
 * end keeps only what ends the window.
 */

/** Drawn here rather than in the icon set, as the drawer's own glyphs are: a sign, not a picture of a thing. */
export function FoldIcon({ folded }: { folded: boolean }) {
  return (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d={folded ? "M5 12h14M12 5v14" : "M5 12h14"} />
    </svg>
  );
}

/**
 * A window's fold, first in its bar. It is always drawn, in the bar's quiet
 * ink, where the bar's other buttons stand back while the window does not
 * have the keys: a folded window is only its bar, and the plus is the one
 * way it says it opens.
 */
export function HeadFold({ folded, onFold }: { folded: boolean; onFold: () => void }) {
  return (
    <button
      type="button"
      className="head-fold"
      title={folded ? "Unfold" : "Fold to the title bar"}
      aria-label={folded ? "Unfold" : "Fold"}
      aria-expanded={!folded}
      onClick={onFold}
    >
      <FoldIcon folded={folded} />
    </button>
  );
}
