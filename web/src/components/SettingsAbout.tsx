/**
 * Which kururu this is, and whether there is a newer one.
 *
 * The only page in Settings that edits nothing. It is here rather than in a
 * menu item because *what version am I running* and *is that a problem* are one
 * question in practice, and the second half of it wants somewhere to put a
 * paragraph of release notes — which a menu item has not got.
 *
 * It asks rather than being told, on `/api/identity`'s reasoning: this is the
 * world's state and not kururu's. It changes when somebody publishes a release,
 * which is not an event this server can be notified of, so putting it in the
 * snapshot would mean polling GitHub forever to keep a value that is drawn by a
 * page almost nobody has open. So the fetch happens when the page opens, and
 * again when somebody presses the button — which is the one case that skips the
 * server's cache, because pressing it twice is how a person asks *are you sure*.
 *
 * **It does not install anything, and that is deliberate.** What installing
 * means depends on how kururu got onto the machine — a DMG has an updater, a
 * Homebrew cask has `brew upgrade`, a checkout has `git pull` — and only the
 * thing that did the installing knows which. A page served over HTTP is also the
 * wrong thing to be able to swap the application serving it, which is the line
 * `preload.js` already draws at `file:`. So this says what is out there and
 * hands the doing to the window, or to the person.
 */
import { useCallback, useEffect, useState } from "react";
import type { UpdateCheck } from "../../../shared/wire";

export function AboutSettings() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [asking, setAsking] = useState(false);

  const ask = useCallback(async (force: boolean) => {
    setAsking(true);
    try {
      const response = await fetch(`/api/update${force ? "?force=1" : ""}`);
      if (!response.ok) throw new Error(String(response.status));
      setCheck((await response.json()) as UpdateCheck);
    } catch {
      /**
       * A failed *request* is not a failed check — the server restarts on edit
       * and the socket under this page reconnects forever for that reason. The
       * answer already has an `error` field for the case where the check itself
       * could not be made, and overwriting a real answer with a transport blip
       * would be the page telling a worse story than it has.
       */
      setCheck((was) => was ?? null);
    } finally {
      setAsking(false);
    }
  }, []);

  useEffect(() => {
    void ask(false);
  }, [ask]);

  return (
    <div className="set-page about-page">
      <header className="about-head">
        <h3 className="set-h">kururu</h3>
        <p className="about-version">{check ? check.current : "…"}</p>
      </header>

      <div className="about-check">
        <button className="button" onClick={() => void ask(true)} disabled={asking}>
          {asking ? "Checking…" : "Check for updates"}
        </button>
        <span className="set-note">{describe(check, asking)}</span>
      </div>

      {check?.newer && check.latest && (
        <section className="about-release">
          <header className="about-release-head">
            <h4 className="about-release-title">What's new in {check.latest}</h4>
            {check.url && (
              <a className="button" href={check.url} target="_blank" rel="noreferrer">
                Get it
              </a>
            )}
          </header>
          {/*
            The markup is the server's — rendered by `markdown.ts`, which cannot
            emit raw HTML and refuses any `href` or `src` carrying a scheme a
            browser would run. That is the whole reason this can be set as HTML
            at all, and the reason the fallback below is a `<pre>` rather than a
            second, worse parser living in here.
          */}
          {check.notesHtml ? (
            <div className="about-notes markdown" dangerouslySetInnerHTML={{ __html: check.notesHtml }} />
          ) : check.notes ? (
            <pre className="about-notes about-notes-raw">{check.notes}</pre>
          ) : (
            <p className="set-note">This release came with no notes.</p>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * The sentence under the button, and the one thing this page must not get wrong.
 *
 * "Up to date" and "I could not find out" are the same picture and opposite
 * facts, and only one of them means you can stop thinking about it — so the
 * error is its own branch and is never collapsed into the reassuring one.
 */
function describe(check: UpdateCheck | null, asking: boolean): string {
  if (asking && !check) return "Asking GitHub…";
  if (!check) return "";
  if (check.error) return `Could not check: ${check.error}.`;
  if (check.newer && check.latest) return `${check.latest} is out.`;
  if (check.latest) return `Up to date — ${check.latest} is the newest there is.`;
  return "There is nothing published to compare against yet.";
}
