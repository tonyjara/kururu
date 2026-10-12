/**
 * Whether two values off the wire say the same thing, for a component that
 * should not be drawn again when they do.
 *
 * It exists because the snapshot is replaced whole. Every message is a fresh
 * `JSON.parse`, so a card nobody touched arrives as a new object each time a
 * status changes anywhere in the profile, and a check by reference finds every
 * card changed on every message — which is how a focus change used to redraw
 * every card on the board to move one highlight. Comparing what the objects
 * say is the cheap half of that trade: a card is a few dozen fields, and
 * drawing one is a subtree of them.
 *
 * Generic rather than a comparator per type, on purpose. One written field by
 * field is one that a new field on `Card` or `AgentSnapshot` slips past, and
 * the symptom of that is a card that quietly stops updating; this one cannot
 * miss a field. A function compares by reference, so anything that carries a
 * callback is "changed" whenever the callback is new — the safe direction to
 * be wrong in.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}
