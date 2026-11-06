/**
 * Whether a set of marks a chip names is still on the server, and the address
 * of its pictures.
 *
 * A set is swept after about thirty days (`server/src/marks.ts`), and the
 * message, the card or the draft that named it keeps its lines — each mark's
 * label and comment are on them, so they still read. What changes is the
 * chip: a set that is gone says "cleaned up" rather than offering a picture
 * that would be a 404. Asked once per set per page and remembered, since a
 * set does not come back, and one that is there now is there for a month.
 */

const known = new Map<string, Promise<boolean>>();

/** True once the server says the set is not there; false while it is, or while it cannot be asked. */
export function markSetGone(set: string): Promise<boolean> {
  let asked = known.get(set);
  if (!asked) {
    asked = fetch(`/api/marks/${encodeURIComponent(set)}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ exists?: unknown }>) : { exists: true }))
      .then((body) => body.exists === false)
      .catch(() => {
        // Not known is not gone: ask again next time.
        known.delete(set);
        return false;
      });
    known.set(set, asked);
  }
  return asked;
}

/** A mark's crop, or a set's view when `n` is null, as the server serves it. */
export function markPictureUrl(set: string, n: number | null): string {
  return `/api/marks/${encodeURIComponent(set)}/${n === null ? "view.png" : `mark-${n}.png`}`;
}
