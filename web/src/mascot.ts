/**
 * The sprite sheet behind the mascot: where to ask for one, and how big it is.
 *
 * Both halves of the window need the same two answers. A sidebar row needs the
 * sheet's dimensions to work out the background it is drawing a 16px window
 * onto; Settings needs them to draw the grid you pick cells out of. Neither
 * needs anything else about the picture, and neither should be the one that
 * knows how to spell the URL.
 *
 * Cached by URL at module level, so eight working agents and a settings dialog
 * cost one request and one decode between them. The browser would have cached
 * the response anyway — what this saves is eight `onload` handlers all arriving
 * at the same number, and eight rows rendering a frame late while they wait.
 *
 * A sheet that fails to load resolves to null rather than throwing, and null is
 * what a caller draws the dot for. That is the whole error path: the server
 * hands over a user's own file without inspecting it, so a file that is not a
 * PNG fails here, which is where it is visible and recoverable.
 */
import { useEffect, useState } from "react";

export interface SheetSize {
  width: number;
  height: number;
}

/** Where a sheet comes from. `custom` is the user's own file; the server knows. */
export function sheetUrl(sheet: string): string {
  return `/api/mascot.png?sheet=${encodeURIComponent(sheet)}`;
}

const sizes = new Map<string, SheetSize | null>();
const loading = new Map<string, Promise<SheetSize | null>>();

function load(src: string): Promise<SheetSize | null> {
  const already = loading.get(src);
  if (already) return already;
  const pending = new Promise<SheetSize | null>((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(null);
    image.src = src;
  }).then((size) => {
    sizes.set(src, size);
    return size;
  });
  loading.set(src, pending);
  return pending;
}

/**
 * The sheet's size, once it is known — null while it loads, and null for good if
 * it cannot be drawn.
 *
 * Seeded from the cache rather than from nothing, so a row that mounts after the
 * sheet has already loaded draws the mascot on its first frame instead of
 * flashing the dot at every reconnect.
 */
export function useSheet(src: string): SheetSize | null {
  const [size, setSize] = useState<SheetSize | null>(() => sizes.get(src) ?? null);
  useEffect(() => {
    let live = true;
    setSize(sizes.get(src) ?? null);
    void load(src).then((loaded) => {
      if (live) setSize(loaded);
    });
    return () => {
      live = false;
    };
  }, [src]);
  return size;
}
