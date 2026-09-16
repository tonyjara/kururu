/**
 * Is there a newer kururu than this one?
 *
 * The answer lives on GitHub — the latest release of `tonyjara/kururu`, whose
 * body is the section `/release` stamped into `CHANGELOG.md` — and it is asked
 * for here rather than in the browser, for the three reasons `styles.ts` gives
 * at length and one more that is this file's own. A phone on the tailnet has no
 * business reaching GitHub; only the server can act on the answer; CORS would
 * otherwise be a question. And the version being compared is the *server's*,
 * which the browser does not know and should not have to be told twice.
 *
 * It is deliberately a check and never an install. What installing means depends
 * on how kururu got onto the machine — Electron's updater for a DMG, `brew
 * upgrade` for the tap, `git pull` for a checkout — and only the thing that did
 * the installing can know which. So this answers *what is out there* and hands
 * the acting to whoever asked, which in the desktop's case is the main process
 * and nowhere else: a page served over HTTP must not be able to swap the
 * application it is being served by, the same line `preload.js` draws at `file:`.
 *
 * Cached, because the button is a thing people press twice. Unauthenticated
 * GitHub allows sixty requests an hour from an address and a window with three
 * settings dialogs open in it should not be spending them; the cache is skipped
 * only when somebody explicitly asked again.
 */
import type { UpdateCheck } from "../../shared/wire";
import { IS_RELEASE_BUILD, VERSION } from "./version";

/** Overridable so this can be pointed at a fixture rather than at the internet. */
const API =
  process.env.KURURU_UPDATE_URL ||
  `https://api.github.com/repos/${process.env.KURURU_UPDATE_REPO || "tonyjara/kururu"}/releases/latest`;

const FETCH_TIMEOUT = 8000;
const CACHE_MS = 30 * 60 * 1000;

/**
 * One version as semver sees it: three numbers and whatever was after the dash.
 * Anything unparseable comes back null, and a comparison involving a null is
 * declined rather than guessed — an update prompt is a thing people act on, and
 * "I could not read either number" must not read as "you are up to date".
 */
interface Parsed {
  parts: [number, number, number];
  pre: string[];
}

export function parseVersion(raw: string): Parsed | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(raw.trim());
  if (!match) return null;
  const [, major, minor, patch, pre] = match;
  return {
    parts: [Number(major), Number(minor), Number(patch)],
    pre: pre ? pre.split(".") : [],
  };
}

/**
 * Is `candidate` newer than `current`?
 *
 * Semver's own rules, including the one people forget: a prerelease is *older*
 * than the release it leads to, so `0.2.0-beta.1` must not offer itself to
 * somebody already on `0.2.0`. Identifiers compare numerically when both are
 * numbers and as strings otherwise, and a longer prerelease wins a tie — which
 * is what makes `beta.2` beat `beta`.
 */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;

  for (let i = 0; i < 3; i++) {
    const left = a.parts[i] ?? 0;
    const right = b.parts[i] ?? 0;
    if (left !== right) return left > right;
  }

  if (a.pre.length === 0 && b.pre.length === 0) return false;
  if (a.pre.length === 0) return true;
  if (b.pre.length === 0) return false;

  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const left = a.pre[i];
    const right = b.pre[i];
    if (left === undefined) return false;
    if (right === undefined) return true;
    if (left === right) continue;
    const both = /^\d+$/.test(left) && /^\d+$/.test(right);
    return both ? Number(left) > Number(right) : left > right;
  }
  return false;
}

/** What GitHub says, reduced to the three fields anything here reads. */
interface Release {
  tag_name?: unknown;
  body?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

let cached: { check: UpdateCheck; at: number } | null = null;

export async function checkForUpdate(force = false): Promise<UpdateCheck> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.check;

  const base: UpdateCheck = {
    current: VERSION,
    latest: null,
    newer: false,
    notes: null,
    // Filled in by the route, which is where the theme that the code blocks are
    // highlighted against is known. Kept out of here so this file stays what it
    // says it is: a fetch and a comparison.
    notesHtml: null,
    url: null,
    checkedAt: Date.now(),
    error: null,
  };

  /**
   * A checkout has no version to compare with, and saying "up to date" to
   * somebody running from source would be a lie in whichever direction they are
   * actually in. It is not an error either — they know how they started it — so
   * the answer is the truthful nothing, and the dialog draws the sentence.
   */
  if (!IS_RELEASE_BUILD) {
    const check = { ...base, error: "running from a checkout, so there is no version to compare" };
    cached = { check, at: Date.now() };
    return check;
  }

  try {
    const res = await fetch(API, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: {
        accept: "application/vnd.github+json",
        // GitHub refuses an unidentified client, and this is the one place
        // kururu speaks to somebody who is entitled to know who called.
        "user-agent": `kururu/${VERSION}`,
      },
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const release = (await res.json()) as Release;

    const tag = typeof release.tag_name === "string" ? release.tag_name : null;
    // A draft has no business being offered and `releases/latest` should never
    // hand one over; checked anyway, because the cost is a line and the failure
    // is offering somebody a build that does not exist yet.
    if (!tag || release.draft === true) throw new Error("no published release to compare against");

    const check: UpdateCheck = {
      ...base,
      latest: tag.replace(/^v/, ""),
      newer: isNewer(tag, VERSION),
      notes: typeof release.body === "string" && release.body.trim() ? release.body : null,
      url: typeof release.html_url === "string" ? release.html_url : null,
    };
    cached = { check, at: Date.now() };
    return check;
  } catch (error) {
    /**
     * Not cached for the full half hour. A failure is usually the network being
     * briefly absent — a laptop that has just woken, a phone changing cell — and
     * making somebody wait thirty minutes to try again would turn a blip into a
     * button that appears broken.
     */
    const check = { ...base, error: error instanceof Error ? error.message : "could not reach GitHub" };
    cached = { check, at: Date.now() - CACHE_MS + 30_000 };
    return check;
  }
}
