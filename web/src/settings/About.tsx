/**
 * Settings → System → About: which kururu this is, whether there is a newer
 * one, where the data is, and why the server is the one it is.
 *
 * The only page that edits nothing. It asks rather than being told, because a
 * release is the world's state: the fetch happens when the page opens and
 * again on the button, which is the one case that skips the server's cache.
 *
 * **It installs nothing itself.** What installing means depends on how kururu
 * got onto the machine, and only the thing that did the installing knows. In a
 * packaged app showing its own server, Get it fetches the release and restarts
 * into it; everywhere else it is the link to GitHub it always was.
 *
 * Below is the server's own story: when it started, why, and the last lines of
 * `lifecycle.log`, because "which kururu is this" is the question people bring
 * here right after the window reconnected, and the real question is why.
 */
import { useCallback, useEffect, useState } from "react";
import type { LifeEvent, LifecycleReport } from "../../../shared/lifecycle";
import type { HostInfo } from "../../../shared/model";
import type { UpdateCheck } from "../../../shared/wire";
import { desktop, type UpdateState } from "../desktop";
import { Action, Banner, Btn, Details, Group, Item, Mono, Readout } from "./ui";

export function AboutPage({ host }: { host: HostInfo }) {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [asking, setAsking] = useState(false);

  const ask = useCallback(async (force: boolean) => {
    setAsking(true);
    try {
      const response = await fetch(`/api/update${force ? "?force=1" : ""}`);
      if (!response.ok) throw new Error(String(response.status));
      setCheck((await response.json()) as UpdateCheck);
    } catch {
      // A failed request is not a failed check: the answer has an `error`
      // field for the case where the check itself could not be made.
      setCheck((was) => was ?? null);
    } finally {
      setAsking(false);
    }
  }, []);
  useEffect(() => {
    void ask(false);
  }, [ask]);

  return (
    <>
      <Group title="kururu">
        <Readout label="Version" value={<Mono>{check ? check.current : "…"}</Mono>} />
        <Readout
          label="pty host"
          tone={host.current ? "ok" : "warn"}
          value={<Mono>{host.version ?? "an older build"}</Mono>}
          hint={host.current ? undefined : "Behind this server. Restart it to update, which ends every agent."}
        />
        <Action label="Updates" button="Check" busy={asking} busyLabel="Checking…" onClick={() => void ask(true)} outcome={describe(check, asking)} />
        {check?.newer && check.latest && (
          <>
            <Readout label="Latest" tone="warn" value={<Mono>{check.latest}</Mono>}>
              <GetIt url={check.url} />
            </Readout>
            <Details summary={`What's new in ${check.latest}`}>
              {check.notesHtml ? (
                <div className="st-notes markdown" dangerouslySetInnerHTML={{ __html: check.notesHtml }} />
              ) : check.notes ? (
                <pre className="st-pre">{check.notes}</pre>
              ) : (
                <p className="st-p">This release came with no notes.</p>
              )}
            </Details>
          </>
        )}
      </Group>

      <DataHome />
      <ServerLife />
    </>
  );
}

interface DataReport {
  path: string;
  bytes: number;
}

/** Where the boards are. One file, and nothing to do about it here. */
function DataHome() {
  const [report, setReport] = useState<DataReport | null>(null);
  useEffect(() => {
    let live = true;
    void fetch("/api/data")
      .then((response) => (response.ok ? (response.json() as Promise<DataReport>) : null))
      .then((answer) => live && answer && setReport(answer))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!report) return null;
  return (
    <Group title="Data" foot="Boards, conversations and the voice's lists. Nothing in it is ever deleted outright: a deleted card is marked, and every move is on its history.">
      <Readout label="Database" value={<Mono>{report.path}</Mono>} hint={fileSize(report.bytes)} />
    </Group>
  );
}

function fileSize(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`;
  const mb = kb / 1024;
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

/** Why the server is the one it is. Newest first, because the question is always about the last time. */
function ServerLife() {
  const [report, setReport] = useState<LifecycleReport | null>(null);
  useEffect(() => {
    let live = true;
    void fetch("/api/lifecycle")
      .then((response) => (response.ok ? (response.json() as Promise<LifecycleReport>) : null))
      .then((answer) => live && answer && setReport(answer))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!report) return null;
  const events = [...report.events].reverse();
  return (
    <>
      {report.orphaned && (
        <Banner tone="bad">
          The process supervising the server has gone, so a save will not restart it and prefix+B is refused. Restart <Mono>bun run dev</Mono> to get the watcher back.
        </Banner>
      )}
      <Group
        title="Server"
        foot={
          <>
            The whole record is <Mono>{report.file}</Mono>, and <Mono>bun run status</Mono> prints the end of it.
          </>
        }
      >
        <Readout label="Up since" value={clock(report.startedAt)} hint={report.because ? `Started because ${report.because}.` : undefined} />
        {events.map((event, i) => (
          <LifeRow key={`${event.at}-${event.pid}-${i}`} event={event} />
        ))}
      </Group>
    </>
  );
}

function LifeRow({ event }: { event: LifeEvent }) {
  const bad = event.what === "crash" || event.what === "down" || event.what === "orphaned";
  return (
    <Item
      className={bad ? "st-item-bad" : undefined}
      lead={<span className="st-when">{clock(event.at)}</span>}
      name={event.why}
      sub={
        <>
          {event.by}
          {event.error && !event.why.includes(event.error) && <> · {event.error}</>}
          {event.stack && (
            <Details summary={event.what === "down" ? "What the build said" : "Stack"}>
              <pre className="st-pre">{event.stack}</pre>
            </Details>
          )}
        </>
      }
    />
  );
}

/** Today's as a time, anybody else's with its date. */
function clock(iso: string): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (at.toDateString() === new Date().toDateString()) return time;
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** "Up to date" and "I could not find out" are opposite facts, so the error is its own branch. */
function describe(check: UpdateCheck | null, asking: boolean): { text: string; bad?: boolean } | null {
  if (asking && !check) return { text: "Asking GitHub…" };
  if (!check) return null;
  if (check.error) return { text: `Could not check: ${check.error}.`, bad: true };
  if (check.newer && check.latest) return { text: `${check.latest} is out.` };
  if (check.latest) return { text: `Up to date: ${check.latest} is the newest there is.` };
  return { text: "There is nothing published to compare against yet." };
}

/**
 * The one control that does anything, in whichever of its two shapes this
 * runtime has earned: `desktop().update` answers `unavailable` for a browser,
 * the phone, and a window showing a server it did not start. The link is the
 * fallback in the strict sense: correct everywhere, and every branch that
 * cannot do better ends at it.
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
      <span className="st-progress-row">
        <progress className="st-progress" max={100} value={state.percent} />
        <span className="st-hint">{state.percent}%</span>
      </span>
    );
  }
  if (state.status === "ready") {
    return (
      <Btn primary onClick={() => desktop()?.update?.install()}>
        Restart to install
      </Btn>
    );
  }
  if (state.status === "idle") {
    return (
      <Btn primary onClick={() => desktop()?.update?.download()}>
        Get it
      </Btn>
    );
  }
  return (
    <>
      {state.status === "error" && <span className="st-hint">{state.message}</span>}
      {url && (
        <a className="st-btn st-btn-primary" href={url} target="_blank" rel="noreferrer">
          Get it
        </a>
      )}
    </>
  );
}
