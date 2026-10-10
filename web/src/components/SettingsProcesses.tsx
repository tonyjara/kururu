/**
 * Settings → Processes: what every terminal is running and what it costs, and
 * the place to close the ones that are not worth it.
 *
 * The sidebar answers "which of the rows in front of me is heavy". This answers
 * the question that comes before closing anything — how many claudes, how many
 * nvims, how many dev servers, and where — across every profile, including the
 * ones this window is not showing. See `shared/footprint.ts`.
 *
 * Measured while the page is open and never otherwise. The read is a `ps` with
 * argv in it, which is fine every few seconds for as long as somebody is
 * looking and pointless the rest of the time, so the timer belongs to this
 * component and dies with it. Hidden documents skip a beat, for the same reason.
 *
 * Closing is `close-tab`, the one verb that ends a terminal, and it asks in
 * place first — the button turns into its own question, the way removing a VPS
 * does. A second dialog on top of Settings would be a lot of ceremony for a
 * thing the button can say in two words.
 *
 * The nvims are the exception, twice over. They are every nvim on this Mac and
 * not only kururu's, because the page is about what the machine is paying for
 * and an nvim left open in another app costs the same as one in a tab. And
 * closing one is not `close-tab`, because an nvim is the one thing in here that
 * can be holding unsaved work and can say so: the buttons ask it to `:qa`
 * (`close-nvims`), and an editor that refuses stays open and is listed with its
 * reason. Ending those anyway (`kill-nvims`) is a button of its own that asks
 * again, so nothing here signals an editor on the first yes.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  agentKinds,
  nvimWhere,
  tally,
  type Footprint,
  type FootprintNvim,
  type FootprintTally,
  type FootprintTerminal,
  type NvimCloseReport,
} from "../../../shared/footprint";
import { colorValue } from "../colors";
import { shortenPath } from "../labels";
import * as api from "../session";

/** How often to measure while the page is open. The sidebar's poll is the same. */
const EVERY_MS = 5000;

/** `409993216` → `391 MB`. Gigabytes once megabytes stop being readable. */
function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The counts that are not zero, as a line: `2 agents · 1 nvim · 1 dev server`. */
function countsLine(t: FootprintTally): string {
  const parts = [
    t.agents && plural(t.agents, "agent"),
    t.editors && plural(t.editors, "nvim", "nvims"),
    t.devServers && plural(t.devServers, "dev server"),
    t.shells && plural(t.shells, "shell"),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : plural(t.terminals, "terminal");
}

/**
 * The sentence over what `close-nvims` or `kill-nvims` did, given how many of
 * what it left are still running now.
 */
function nvimLead(report: NvimCloseReport, open: number, hard: boolean): string {
  const parts: string[] = [];
  if (report.closed > 0) parts.push(`${hard ? "Ended" : "Closed"} ${plural(report.closed, "nvim")}.`);
  if (open > 0) {
    const one = open === 1;
    parts.push(
      hard
        ? `${one ? "One" : open} could not be ended:`
        : `${one ? "One" : open} did not quit and ${one ? "is" : "are"} still open:`,
    );
  } else if (report.left.length > 0) parts.push("The rest have gone since.");
  if (parts.length === 0) parts.push("There was no nvim left to close.");
  return parts.join(" ");
}

export function ProcessSettings() {
  const [reading, setReading] = useState<Footprint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The one close button currently asking "sure?" — a terminal id, `ws:<id>`, `nvim:<id>`, `nvims` or `nvims:force`. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [nvimClosing, setNvimClosing] = useState(false);
  /** What the last close did. Held until dismissed, since what refused is what somebody acts on next. */
  const [nvimReport, setNvimReport] = useState<NvimCloseReport | null>(null);
  /** Whether that report is from `kill-nvims`, after which there is no harder button to offer. */
  const [nvimHard, setNvimHard] = useState(false);
  const [nvimFailed, setNvimFailed] = useState<string | null>(null);
  const inFlight = useRef(false);

  const measure = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await fetch("/api/footprint");
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      setReading((await response.json()) as Footprint);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void measure();
    const timer = setInterval(() => {
      if (!document.hidden) void measure();
    }, EVERY_MS);
    return () => clearInterval(timer);
  }, [measure]);

  /**
   * End terminals, then look again shortly after: a process group takes a beat
   * to go, and a row that still says 900 MB after you closed it reads as the
   * button not working.
   */
  const close = (ids: string[]) => {
    for (const id of ids) api.closeTab(id);
    setConfirming(null);
    setTimeout(() => void measure(), 700);
  };

  /**
   * `:qa` in these nvims, or with `hard` the end of them — the ones counted on
   * the button that was pressed, so what was agreed to is what is asked. The
   * server checks each id again and touches nothing else.
   */
  const endNvims = async (ids: string[], hard: boolean) => {
    setConfirming(null);
    setNvimClosing(true);
    setNvimFailed(null);
    try {
      setNvimReport(await (hard ? api.killNvims(ids) : api.closeNvims(ids)));
      setNvimHard(hard);
    } catch (err) {
      setNvimFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setNvimClosing(false);
      void measure();
    }
  };

  const byId = useMemo(
    () => new Map((reading?.terminals ?? []).map((t) => [t.agentId, t] as const)),
    [reading],
  );

  if (!reading) {
    return (
      <div className="set-page">
        <section className="set-section">
          <h3 className="set-h">Processes</h3>
          <p className="set-note">{error ? `Could not measure: ${error}` : "Measuring…"}</p>
        </section>
      </div>
    );
  }

  const all = tally(reading.terminals);
  const kinds = agentKinds(reading.terminals);
  const own = (reading.kururu.host ?? 0) + (reading.kururu.server ?? 0);
  const biggest = Math.max(1, ...reading.terminals.map((t) => t.rss ?? 0));
  const many = reading.profiles.length > 1;
  const nvims = reading.nvims;
  const nvimRss = nvims.reduce((sum, nvim) => sum + nvim.rss, 0);
  const outside = nvims.filter((nvim) => nvim.place.kind === "outside").length;
  const heaviestNvim = Math.max(1, ...nvims.map((nvim) => nvim.rss));
  const askingNvims = confirming === "nvims";
  // What was left and is still running now — somebody may have gone and saved one since.
  const running = new Set(nvims.map((nvim) => nvim.id));
  const stillOpen = (nvimReport?.left ?? []).filter((left) => running.has(left.id));
  const forcing = confirming === "nvims:force";

  const terminalsOf = (ids: string[]) =>
    ids.flatMap((id) => byId.get(id) ?? []).sort((a, b) => (b.rss ?? -1) - (a.rss ?? -1));

  const group = (key: string, title: string, ids: string[], tag: string | null) => {
    const rows = terminalsOf(ids);
    const sum = tally(rows);
    const asking = confirming === key;
    return (
      <div key={key} className="proc-group" style={tag ? ({ "--tag": tag } as CSSProperties) : undefined}>
        <div className="proc-group-head">
          <strong className="proc-group-name">{title}</strong>
          <span className="set-note set-note-inline">{countsLine(sum)}</span>
          <span className="proc-mem">{formatBytes(sum.rss)}</span>
          {rows.length > 1 && (
            <button
              className={`set-choice ${asking ? "set-choice-warn" : ""}`}
              onClick={() => (asking ? close(rows.map((t) => t.agentId)) : setConfirming(key))}
              onBlur={() => asking && setConfirming(null)}
            >
              {asking ? `Close ${plural(rows.length, "tab")}?` : "Close all"}
            </button>
          )}
        </div>
        <ul className="proc-list">
            {rows.map((t) => (
              <TerminalRow
                key={t.agentId}
                terminal={t}
                biggest={biggest}
                asking={confirming === t.agentId}
                onAsk={() => setConfirming(t.agentId)}
                onCancel={() => setConfirming(null)}
                onClose={() => close([t.agentId])}
              />
            ))}
        </ul>
      </div>
    );
  };

  return (
    <div className="set-page">
      <section className="set-section">
        <div className="proc-title">
          <h3 className="set-h">Processes</h3>
          <button className="set-choice set-reset" disabled={busy} onClick={() => void measure()}>
            {busy ? "Measuring…" : "Measure again"}
          </button>
        </div>
        <p className="set-note">
          Every terminal kururu holds, in every profile, and what is running under it. Measured while this
          page is open — every few seconds — and never otherwise. Memory is resident, everything under the
          tab added up; shared pages count once per process, so it runs slightly high.
        </p>
        {error && <p className="set-warn">Last measurement failed: {error}</p>}
      </section>

      <section className="set-section">
        <div className="proc-tiles">
          <Tile
            value={formatBytes(all.rss)}
            label="in terminals"
            under={`of ${formatBytes(reading.machineTotal)} on this machine`}
          />
          <Tile
            value={String(all.agents)}
            label={all.agents === 1 ? "agent" : "agents"}
            under={kinds.length > 0 ? kinds.map(([name, n]) => `${n} ${name}`).join(" · ") : "none running"}
          />
          <Tile
            value={String(nvims.length)}
            label={nvims.length === 1 ? "nvim on this Mac" : "nvims on this Mac"}
            under={
              nvims.length > 0
                ? `${formatBytes(nvimRss)}${outside > 0 ? ` · ${outside} outside kururu` : ""}`
                : "none running"
            }
            action={
              nvims.length > 0 || nvimClosing ? (
                <button
                  className={`set-choice proc-tile-action ${askingNvims ? "set-choice-warn" : ""}`}
                  disabled={nvimClosing}
                  title="Each is sent :qa. One with unsaved changes refuses, stays open, and is listed below."
                  onClick={() =>
                    askingNvims ? void endNvims(nvims.map((nvim) => nvim.id), false) : setConfirming("nvims")
                  }
                  onBlur={() => askingNvims && setConfirming(null)}
                >
                  {nvimClosing ? "Closing…" : askingNvims ? `Close ${plural(nvims.length, "nvim")}?` : "Close all"}
                </button>
              ) : undefined
            }
          />
          <Tile value={String(all.devServers)} label={all.devServers === 1 ? "dev server" : "dev servers"} />
          <Tile value={String(all.shells)} label={all.shells === 1 ? "idle shell" : "idle shells"} />
          <Tile
            value={own ? formatBytes(own) : "—"}
            label="kururu itself"
            under={
              reading.kururu.host !== null
                ? `pty host ${formatBytes(reading.kururu.host)} · server ${formatBytes(reading.kururu.server ?? 0)}`
                : "the server; the host was not found"
            }
          />
        </div>
      </section>

      {(nvims.length > 0 || nvimReport || nvimFailed) && (
        <section className="set-section">
          <h3 className="set-h">nvim</h3>
          <p className="set-note">
            Every nvim on this Mac, whoever started it: kururu's tabs, ones typed into a shell, ones in other
            apps. Memory is each one's whole tree — the editor, the UI drawing it, its language servers. Close
            sends <code>:qa</code>, which refuses while anything is unsaved; what refuses is listed here, with a
            second button that ends it anyway.
          </p>
          {nvimFailed && <p className="set-warn">Could not reach the nvims: {nvimFailed}</p>}
          {nvimReport && (
            <div className={stillOpen.length > 0 ? "set-warn set-retire" : "set-note set-note-under"}>
              <p className="set-retire-lead">{nvimLead(nvimReport, stillOpen.length, nvimHard)}</p>
              {stillOpen.length > 0 && (
                <ul className="set-retire-list">
                  {stillOpen.map((left) => (
                    <li key={left.id}>
                      <strong>{left.label}</strong> — {left.reason}
                    </li>
                  ))}
                </ul>
              )}
              {stillOpen.length > 0 && !nvimHard && (
                <p className="set-retire-lead proc-nvim-force">
                  Force close sends {stillOpen.length === 1 ? "it" : "them"} SIGTERM, which nvim answers by writing
                  its swap files, and SIGKILL a moment later to whatever is still running. Only the nvim and what it
                  started — never the shell or app around it. Unsaved changes are lost.
                </p>
              )}
              <div className="set-retire-actions">
                <button
                  className="set-choice"
                  onClick={() => {
                    setNvimReport(null);
                    setConfirming(null);
                  }}
                >
                  {stillOpen.length > 0 && !nvimHard ? "Leave them open" : "OK"}
                </button>
                {stillOpen.length > 0 && !nvimHard && (
                  <button
                    className={`set-choice ${forcing ? "set-choice-warn" : ""}`}
                    disabled={nvimClosing}
                    onClick={() =>
                      forcing ? void endNvims(stillOpen.map((left) => left.id), true) : setConfirming("nvims:force")
                    }
                    onBlur={() => forcing && setConfirming(null)}
                  >
                    {forcing
                      ? `Kill ${stillOpen.length === 1 ? "it" : `all ${stillOpen.length}`}, losing unsaved changes?`
                      : `Force close ${stillOpen.length}`}
                  </button>
                )}
              </div>
            </div>
          )}
          {nvims.length > 0 && (
            <ul className="proc-list">
              {nvims.map((nvim) => (
                <NvimRow
                  key={nvim.id}
                  nvim={nvim}
                  biggest={heaviestNvim}
                  busy={nvimClosing}
                  asking={confirming === `nvim:${nvim.id}`}
                  onAsk={() => setConfirming(`nvim:${nvim.id}`)}
                  onCancel={() => setConfirming(null)}
                  onClose={() => void endNvims([nvim.id], false)}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {reading.profiles.map((profile) => {
        const ids = profile.workspaces.flatMap((w) => w.terminals);
        const busyWorkspaces = profile.workspaces.filter((w) => w.terminals.length > 0);
        const idle = profile.workspaces.length - busyWorkspaces.length;
        return (
          <section key={profile.id} className="set-section">
            {many && (
              <div className="proc-profile">
                <h3 className="set-h">
                  {profile.name}
                  {profile.active && <span className="proc-here">this profile</span>}
                </h3>
                <span className="set-note set-note-inline">{countsLine(tally(terminalsOf(ids)))}</span>
                <span className="proc-mem">{formatBytes(tally(terminalsOf(ids)).rss)}</span>
              </div>
            )}
            {busyWorkspaces.map((w) => group(`ws:${w.id}`, w.name, w.terminals, colorValue(w.color)))}
            {busyWorkspaces.length === 0 && <p className="set-note">No terminals open.</p>}
            {idle > 0 && busyWorkspaces.length > 0 && (
              <p className="set-note">
                {plural(idle, "other workspace")} with nothing running.
              </p>
            )}
          </section>
        );
      })}

      {reading.unplaced.length > 0 && (
        <section className="set-section">
          <h3 className="set-h">Not in any tab</h3>
          <p className="set-note">
            Terminals the pty host is holding that no tab in any profile points at. Closing them is safe
            unless you meant to bring one back.
          </p>
          {group("unplaced", "Unplaced", reading.unplaced, null)}
        </section>
      )}
    </div>
  );
}

function Tile({ value, label, under, action }: { value: string; label: string; under?: string; action?: ReactNode }) {
  return (
    <div className="proc-tile">
      <span className="proc-tile-value">{value}</span>
      <span className="proc-tile-label">{label}</span>
      {under && <span className="proc-tile-under">{under}</span>}
      {action}
    </div>
  );
}

/**
 * One nvim: what it was opened on, where it is — a kururu tab, or the app it is
 * running under and the directory it is in — and what it costs.
 */
function NvimRow({
  nvim,
  biggest,
  busy,
  asking,
  onAsk,
  onCancel,
  onClose,
}: {
  nvim: FootprintNvim;
  biggest: number;
  busy: boolean;
  asking: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const inKururu = nvim.place.kind === "kururu";
  const badge = inKururu ? "kururu" : (nvim.place.kind === "outside" && nvim.place.app) || "no terminal";
  const detail = inKururu ? nvimWhere(nvim.place) : nvim.cwd ? shortenPath(nvim.cwd) : "";
  return (
    <li className="proc-row">
      <span className="proc-main" title={[nvim.args, nvim.cwd, `pid ${nvim.pid}`].filter(Boolean).join("\n")}>
        <span className="proc-label">{nvim.args}</span>
        <span className="proc-badge">{badge}</span>
        <span className="proc-cwd">{detail}</span>
      </span>
      <span className="proc-count" title="processes in this nvim's tree">
        {plural(nvim.processes, "proc", "procs")}
      </span>
      <span className="proc-bar" aria-hidden>
        <span className="proc-bar-fill" style={{ width: `${Math.round((nvim.rss / biggest) * 100)}%` }} />
      </span>
      <span className="proc-mem">{formatBytes(nvim.rss)}</span>
      <button
        className={`set-choice ${asking ? "set-choice-warn" : ""}`}
        disabled={busy}
        onClick={asking ? onClose : onAsk}
        onBlur={() => asking && onCancel()}
      >
        {asking ? "Close it?" : "Close"}
      </button>
    </li>
  );
}

function TerminalRow({
  terminal: t,
  biggest,
  asking,
  onAsk,
  onCancel,
  onClose,
}: {
  terminal: FootprintTerminal;
  biggest: number;
  asking: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const badges = [
    ...t.agents,
    ...Array.from({ length: t.editors }, () => "nvim"),
    ...t.devServers,
  ];
  return (
    <li className={`proc-row ${t.exited ? "proc-row-exited" : ""}`}>
      <span className={`proc-dot proc-dot-${t.exited ? "exited" : t.status}`} aria-label={t.exited ? "exited" : t.status} />
      <span className="proc-main">
        <span className="proc-label">{t.label}</span>
        {badges.map((badge, i) => (
          <span key={`${badge}-${i}`} className="proc-badge">
            {badge}
          </span>
        ))}
        <span className="proc-cwd" title={t.cwd}>
          {t.summary || shortenPath(t.cwd)}
        </span>
      </span>
      <span className="proc-count" title="processes under this tab">
        {t.exited ? "exited" : plural(t.processes, "proc", "procs")}
      </span>
      <span className="proc-bar" aria-hidden>
        <span className="proc-bar-fill" style={{ width: `${Math.round(((t.rss ?? 0) / biggest) * 100)}%` }} />
      </span>
      <span className="proc-mem">{t.rss === null ? "—" : formatBytes(t.rss)}</span>
      <button
        className={`set-choice ${asking ? "set-choice-warn" : ""}`}
        onClick={asking ? onClose : onAsk}
        onBlur={() => asking && onCancel()}
      >
        {asking ? (t.exited ? "Remove?" : "End it?") : t.exited ? "Remove" : "Close"}
      </button>
    </li>
  );
}
