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
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  agentKinds,
  tally,
  type Footprint,
  type FootprintTally,
  type FootprintTerminal,
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

export function ProcessSettings() {
  const [reading, setReading] = useState<Footprint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The one close button currently asking "sure?" — a terminal id or `ws:<id>`. */
  const [confirming, setConfirming] = useState<string | null>(null);
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
          <Tile value={String(all.editors)} label={all.editors === 1 ? "nvim" : "nvims"} />
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

function Tile({ value, label, under }: { value: string; label: string; under?: string }) {
  return (
    <div className="proc-tile">
      <span className="proc-tile-value">{value}</span>
      <span className="proc-tile-label">{label}</span>
      {under && <span className="proc-tile-under">{under}</span>}
    </div>
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
