/**
 * The document list, reduced to the three decisions it actually makes.
 *
 * The picker itself is a fetch and a list of buttons; what is worth keeping out
 * of it — and worth testing — is how a path becomes two pieces of text, what a
 * typed query matches, and how long ago a file was written. All three are the
 * kind of thing that looks obvious until a phone is showing forty rows of it.
 */

/** What `/api/docs` answers with, per file. */
export interface Doc {
  path: string;
  mtime: number;
}

/** A path split where the eye splits it: the name, and where it lives. */
export interface DocRow extends Doc {
  name: string;
  dir: string;
}

export function rows(docs: Doc[]): DocRow[] {
  return docs.map((doc) => {
    const cut = doc.path.lastIndexOf("/");
    return {
      ...doc,
      name: cut === -1 ? doc.path : doc.path.slice(cut + 1),
      dir: cut === -1 ? "" : doc.path.slice(0, cut),
    };
  });
}

/**
 * Filter by every word typed, anywhere in the path.
 *
 * Every word rather than the whole string, because the two things somebody
 * knows about a document are its name and roughly where it is, and they arrive
 * in the order they are thought of — "plan docs" should find `docs/PLAN.md` and
 * a substring match on the pair never would. The path and not just the name,
 * for the same reason: a directory is half of what identifies a README.
 */
export function matching(all: DocRow[], query: string): DocRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return all;
  return all.filter((row) => {
    const path = row.path.toLowerCase();
    return words.every((word) => path.includes(word));
  });
}

/**
 * How long ago, in the fewest characters that still say it.
 *
 * The list is ordered by this, so the column's job is to show where the recent
 * ones stop rather than to be a timestamp — "2h" against "3d" is the whole
 * message. Deliberately coarse and deliberately not a date: a date needs a
 * locale and a width, and neither earns its place in a 40px column on a phone.
 */
export function ago(mtime: number, now: number): string {
  const seconds = Math.max(0, (now - mtime) / 1000);
  if (seconds < 90) return "now";
  const minutes = seconds / 60;
  // Floored, not rounded, all the way down: "1h" the moment it has been an hour
  // reads correctly, where a rounded "1h" at 31 minutes is the column lying in
  // the one direction that matters — it is sorted by this.
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)}d`;
  const weeks = days / 7;
  if (weeks < 52) return `${Math.floor(weeks)}w`;
  return `${Math.floor(days / 365)}y`;
}
