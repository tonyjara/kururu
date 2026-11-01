/**
 * The server's half of a search, as a keystroke reaches it.
 *
 * A hook rather than a few lines in the drawer because of the one thing it has
 * to get right: the answer to the last thing typed, and never a slower answer to
 * the thing before it. So a keystroke waits out a short pause, and aborts the
 * request before it, which also ends the scan on the server. Between answers the
 * drawer draws what it can already judge for itself, so the wait is never a
 * blank list.
 */
import { useEffect, useState } from "react";
import type { KuruSearchAnswer } from "../../shared/kurusearch";
import { searchKuru } from "./session";

/** A pause in typing, so a word is one request and not five. Short enough that it reads as instant over the tailnet too. */
const SEARCH_PAUSE_MS = 120;

/** The latest answer the server gave for this profile, and whether the last question failed. `raw` is the trimmed words, or null for none. */
export function useKuruSearch(profileId: string, raw: string | null): { answer: KuruSearchAnswer | null; failed: boolean } {
  const [answer, setAnswer] = useState<KuruSearchAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (raw === null) {
      setAnswer(null);
      return;
    }
    const asked = new AbortController();
    const pause = setTimeout(() => {
      searchKuru(profileId, raw, asked.signal).then(setAnswer, (err: unknown) => {
        if (!asked.signal.aborted) setFailed(err instanceof Error ? err.name !== "AbortError" : true);
      });
    }, SEARCH_PAUSE_MS);
    return () => {
      clearTimeout(pause);
      asked.abort();
    };
  }, [profileId, raw]);
  return { answer, failed };
}
