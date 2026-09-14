/**
 * The mascot sprite, loaded once for the whole window.
 *
 * The server serves a strip at `/api/mascot.png` — the built-in frog, or
 * whatever the user dropped at `~/.config/kururu/mascot.png`; `server/src/mascot.ts`
 * is where that is decided and why. This is the half that has to *draw* it, and
 * the only thing it needs to know is how many frames are in there.
 *
 * Which is not a thing anybody has to be told. A mascot is a horizontal strip of
 * square frames, so the count is the width over the height, and an `Image` that
 * has loaded knows both. That is the whole reason the contract is shaped that
 * way: a sidecar JSON file describing a frame size would be a second thing to
 * keep in step with the first, and the answer was already in the pixels.
 *
 * Loaded once at module level rather than per row, because a sidebar of eight
 * working agents is eight `<img>` elements asking the same question of the same
 * cached response, and every one of them would have to handle the pending case
 * separately. One image, one answer, and the rows read it — the same shape as
 * `session.ts` and for the same reason: there is one of it.
 */
import { useSyncExternalStore } from "react";

export interface Mascot {
  src: string;
  /** Frames in the strip: its width over its height, so at least one. */
  frames: number;
}

/**
 * Null while it is loading, and null forever if it cannot be drawn.
 *
 * The two cases are the same to a caller and deliberately so: both mean "no
 * mascot right now, show the dot". A broken replacement is the interesting one —
 * the server hands over whatever the user put there without second-guessing it,
 * so a file that is not a PNG arrives intact and fails here, which is where the
 * failure is visible and recoverable rather than silently papered over.
 */
let mascot: Mascot | null = null;
const listeners = new Set<() => void>();

const SRC = "/api/mascot.png";

/**
 * Started on import rather than on first render. The sprite is a kilobyte and
 * the request goes out beside the app's own assets, so by the time an agent is
 * working it has long since arrived and no row ever flickers through the dot.
 */
const image = new Image();
image.onload = () => {
  const frames = Math.max(1, Math.round(image.naturalWidth / image.naturalHeight));
  mascot = { src: SRC, frames };
  for (const listener of listeners) listener();
};
image.src = SRC;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMascot(): Mascot | null {
  return useSyncExternalStore(subscribe, () => mascot);
}
