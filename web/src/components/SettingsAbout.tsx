/**
 * Which kururu this is, and whether there is a newer one.
 *
 * The only page in Settings that edits nothing. It is here rather than in a
 * menu item because *what version am I running* and *is that a problem* are one
 * question in practice, and the second half of it wants somewhere to put a
 * paragraph of release notes — which a menu item has not got.
 *
 * It asks rather than being told, because this is the world's state and not
 * kururu's. It changes when somebody publishes a release,
 * which is not an event this server can be notified of, so putting it in the
 * snapshot would mean polling GitHub forever to keep a value that is drawn by a
 * page almost nobody has open. So the fetch happens when the page opens, and
 * again when somebody presses the button — which is the one case that skips the
 * server's cache, because pressing it twice is how a person asks *are you sure*.
 *
 * **It installs nothing itself, and that is deliberate.** What installing means
 * depends on how kururu got onto the machine — a DMG has an updater, a Homebrew
 * cask has `brew upgrade`, a checkout has `git pull` — and only the thing that
 * did the installing knows which. So this page says what is out there and hands
 * the doing to the window, or to the person.
 *
 * The window now answers, which is what `GetIt` below is about: in a packaged
 * app showing its own server, *Get it* fetches the release and restarts into it,
 * and everywhere else — a browser, the phone, a window pointed at a machine in a
 * cupboard — it stays the link to GitHub it has always been. Note which way
 * round that is. The page does not decide it can install; it asks the runtime it
 * happens to be in, and takes the link for an answer.
 *
 * Below that is the server's own story — when it started, why, and the last
 * lines of `lifecycle.log` — because "which kururu is this" is the question
 * people bring here right after the window has reconnected, and the real
 * question is why it did.
 */
import { useCallback, useEffect, useState } from "react";
import type { LifeEvent, LifecycleReport } from "../../../shared/lifecycle";
import type { HostInfo } from "../../../shared/model";
import type { UpdateCheck } from "../../../shared/wire";
import { desktop, type UpdateState } from "../desktop";

export function AboutSettings({ host }: { host: HostInfo }) {
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
      {/* The other half of the version question. The pty host is a process
          apart and keeps the bundle it started with, so it can be older than
          what is drawing this page — silently, unless somebody says so here.
          From the snapshot rather than the fetch above, because the server
          learnt it when it connected and nothing about it changes until the
          host is restarted. */}
      <p className="set-note">
        pty host {host.version ?? "of an older build"}
        {host.current ? "" : " — behind this server. Restart it to update, which ends every agent."}
      </p>

      <div className="about-check">
        <button className="button" onClick={() => void ask(true)} disabled={asking}>
          {asking ? "Checking…" : "Check for updates"}
        </button>
        <span className="set-note">{describe(check, asking)}</span>
      </div>

      <ServerLife />

      {check?.newer && check.latest && (
        <section className="about-release">
          <header className="about-release-head">
            <h4 className="about-release-title">What's new in {check.latest}</h4>
            <GetIt url={check.url} />
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
 * Why the server is the one it is: when it started, what its supervisor said
 * when it started it, and what the record says happened before.
 *
 * Fetched when the page opens, like the update check and for a sharper reason:
 * the lines that matter most were written by a process that is gone, so there
 * is no event to push. Newest first, because the question is always about the
 * last time. A crash's stack is folded away, there for whoever is going to
 * file the bug and out of the way of whoever only wanted the sentence.
 */
function ServerLife() {
  const [report, setReport] = useState<LifecycleReport | null>(null);

  useEffect(() => {
    let live = true;
    void fetch("/api/lifecycle")
      .then((response) => (response.ok ? (response.json() as Promise<LifecycleReport>) : null))
      .then((answer) => {
        if (live && answer) setReport(answer);
      })
      // A server from before the record existed, or one restarting right now.
      // Either way there is nothing to say yet, and saying nothing is honest.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!report) return null;
  const events = [...report.events].reverse();
  return (
    <section className="about-life">
      <h4 className="about-release-title">Server</h4>
      <p className="set-note">
        Up since {when(report.startedAt)}
        {report.because ? `, started because ${report.because}.` : "."}
      </p>
      {report.orphaned && (
        <p className="set-note set-note-bad">
          The process supervising it has gone, so a save will not restart it and prefix+B is refused rather than
          ending it. Restart <code>bun run dev</code> to get the watcher back.
        </p>
      )}
      {events.length > 0 && (
        <ol className="about-life-list">
          {events.map((event, i) => (
            <LifeRow key={`${event.at}-${event.pid}-${i}`} event={event} />
          ))}
        </ol>
      )}
      <p className="set-note">
        The whole record is <code>{report.file}</code>, and <code>bun run status</code> prints the end of it.
      </p>
    </section>
  );
}

function LifeRow({ event }: { event: LifeEvent }) {
  const bad = event.what === "crash" || event.what === "down" || event.what === "orphaned";
  return (
    <li className={bad ? "about-life-row about-life-bad" : "about-life-row"}>
      <span className="about-life-at">{when(event.at)}</span>
      <span className="about-life-by">{event.by}</span>
      <span className="about-life-why">{event.why}</span>
      {event.error && !event.why.includes(event.error) && <span className="about-life-more">{event.error}</span>}
      {event.stack && (
        <details className="about-life-more">
          <summary>{event.what === "down" ? "What the build said" : "Stack"}</summary>
          <pre className="about-notes-raw">{event.stack}</pre>
        </details>
      )}
    </li>
  );
}

/** Today's as a time, anybody else's with its date. */
function when(iso: string): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (at.toDateString() === new Date().toDateString()) return time;
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
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

/**
 * The one control on this page that does anything, in whichever of its two
 * shapes this runtime has earned.
 *
 * Which shape is not a matter of taste and is not this component's to decide:
 * `desktop().update` answers `unavailable` for a browser, for the phone, and
 * for a window showing a server it did not start — that last one because the
 * version above is the *server's*, and swapping this .app would leave it
 * reading the same as before. So the link is the fallback in the strict sense.
 * It is correct everywhere, it is what shipped before any of this existed, and
 * every branch that cannot do better ends at it.
 *
 * The subscription is taken before the first state is asked for, and the answer
 * to that question is dropped if a push beat it home. Settings can be opened
 * onto a download that is already running, which is exactly when the two would
 * race and exactly when showing a stale zero would be worst.
 */
function GetIt({ url }: { url: string | null }) {
  const [state, setState] = useState<UpdateState>({ status: "unavailable" });

  useEffect(() => {
    const updater = desktop()?.update;
    if (!updater) return;

    let pushed = false;
    const stop = updater.onState((next) => {
      pushed = true;
      setState(next);
    });
    void updater.state().then((first) => {
      if (!pushed) setState(first);
    });
    return stop;
  }, []);

  if (state.status === "downloading") {
    return (
      <div className="about-get">
        <progress className="about-progress" max={100} value={state.percent} />
        <span className="set-note">{state.percent}%</span>
      </div>
    );
  }

  if (state.status === "ready") {
    return (
      <div className="about-get">
        <button className="button" onClick={() => desktop()?.update?.install()}>
          Restart to install
        </button>
      </div>
    );
  }

  if (state.status === "idle") {
    return (
      <div className="about-get">
        <button className="button" onClick={() => desktop()?.update?.download()}>
          Get it
        </button>
      </div>
    );
  }

  /**
   * Unavailable, or a download that failed. Both end at the link — a failure is
   * not a reason to leave somebody with no way to get the release, and saying
   * what went wrong beside a button that still works is better than either
   * half on its own.
   */
  return (
    <div className="about-get">
      {state.status === "error" && <span className="set-note">{state.message}</span>}
      {url && (
        <a className="button" href={url} target="_blank" rel="noreferrer">
          Get it
        </a>
      )}
    </div>
  );
}
