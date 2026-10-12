/**
 * The word after an agent reloaded the window: who asked, and why.
 *
 * A reload nobody pressed for is a window that blinked, and the one thing
 * worse than a surprise is one with no explanation. So the page that comes
 * back says it, in the corner above the status bar, for long enough to read
 * and no longer — and a click takes it down sooner. In a corner rather than
 * where the voice pill sits, since the pill may well be next: a reply that
 * waited for the reload plays right after it.
 *
 * `role="status"`, read out once, never focused: it is news, not a question,
 * and a notice that took the focus would put the next keystroke in the wrong
 * place — the one thing the reload itself was careful not to do.
 */
import { useEffect } from "react";
import { dismissReloadNotice, useReloadNotice } from "../reload";

/** Long enough to read two lines and see who they were from. */
const SHOWN_MS = 10_000;

export function ReloadNotice() {
  const asks = useReloadNotice();

  useEffect(() => {
    if (!asks) return;
    const timer = setTimeout(dismissReloadNotice, SHOWN_MS);
    return () => clearTimeout(timer);
  }, [asks]);

  if (!asks || asks.length === 0) return null;
  return (
    <div
      className="reload-notice"
      role="status"
      aria-live="polite"
      title="Dismiss"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={dismissReloadNotice}
    >
      {asks.map((ask) => (
        <p key={ask.id} className="reload-notice-line">
          Reloaded for <span className="reload-notice-by">{ask.by}</span>
          <span className="reload-notice-why">: {ask.why}</span>
        </p>
      ))}
    </div>
  );
}
