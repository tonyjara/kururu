/**
 * Settings → System → Processes: what every terminal is running and what it
 * costs, and the place to close the ones that are not worth it.
 *
 * Measured while the page is open and never otherwise: the read is a `ps`
 * with argv in it, fine every few seconds while somebody is looking and
 * pointless the rest of the time, so the timer belongs to this component and
 * dies with it.
 *
 * Closing is `close-tab`, the one verb that ends a terminal, and it asks in
 * place like every destructive thing in Settings. The nvims are the exception
 * twice over: they are every nvim on this Mac, not only kururu's, and closing
 * one asks it to `:qa` — an editor that refuses stays open and is listed with
 * its reason, and ending it anyway is a second button that asks again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentKinds, nvimWhere, tally, type Footprint, type FootprintNvim, type FootprintTally, type FootprintTerminal, type NvimCloseReport } from "../../../shared/footprint";
import { shortenPath } from "../labels";
import * as api from "../session";
import { Action, Banner, Btn, DangerButton, Dot, Empty, errorText, Group, Item, plural, Tile, Tiles, type Tone } from "./ui";

const EVERY_MS = 5000;

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function countsLine(t: FootprintTally): string {
  const parts = [t.agents && plural(t.agents, "agent"), t.editors && plural(t.editors, "nvim", "nvims"), t.devServers && plural(t.devServers, "dev server"), t.shells && plural(t.shells, "shell")].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : plural(t.terminals, "terminal");
}

function nvimLead(report: NvimCloseReport, open: number, hard: boolean): string {
  const parts: string[] = [];
  if (report.closed > 0) parts.push(`${hard ? "Ended" : "Closed"} ${plural(report.closed, "nvim")}.`);
  if (open > 0) parts.push(hard ? `${open === 1 ? "One" : open} could not be ended:` : `${open === 1 ? "One" : open} did not quit and ${open === 1 ? "is" : "are"} still open:`);
  else if (report.left.length > 0) parts.push("The rest have gone since.");
  if (parts.length === 0) parts.push("There was no nvim left to close.");
  return parts.join(" ");
}

export function ProcessesPage() {
  const [reading, setReading] = useState<Footprint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nvimClosing, setNvimClosing] = useState(false);
  const [nvimReport, setNvimReport] = useState<NvimCloseReport | null>(null);
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
      setError(errorText(err));
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

  /** End terminals, then look again shortly after: a process group takes a beat to go. */
  const close = (ids: string[]) => {
    for (const id of ids) api.closeTab(id);
    setTimeout(() => void measure(), 700);
  };

  const endNvims = async (ids: string[], hard: boolean) => {
    setNvimClosing(true);
    setNvimFailed(null);
    try {
      setNvimReport(await (hard ? api.killNvims(ids) : api.closeNvims(ids)));
      setNvimHard(hard);
    } catch (err) {
      setNvimFailed(errorText(err));
    } finally {
      setNvimClosing(false);
      void measure();
    }
  };

  const byId = useMemo(() => new Map((reading?.terminals ?? []).map((t) => [t.agentId, t] as const)), [reading]);

  if (!reading) {
    return (
      <Group>
        <Empty>{error ? `Could not measure: ${error}` : "Measuring…"}</Empty>
      </Group>
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
  const running = new Set(nvims.map((nvim) => nvim.id));
  const stillOpen = (nvimReport?.left ?? []).filter((left) => running.has(left.id));

  const terminalsOf = (ids: string[]) => ids.flatMap((id) => byId.get(id) ?? []).sort((a, b) => (b.rss ?? -1) - (a.rss ?? -1));

  const group = (key: string, title: string, ids: string[]) => {
    const rows = terminalsOf(ids);
    const sum = tally(rows);
    return (
      <div key={key} className="st-proc-group">
        <div className="st-proc-head">
          <span className="st-proc-name">{title}</span>
          <span className="st-hint">{countsLine(sum)}</span>
          <span className="st-mem">{formatBytes(sum.rss)}</span>
          {rows.length > 1 && <DangerButton label="Close all" ask={`Close ${plural(rows.length, "tab")}?`} confirm="Close them" onConfirm={() => close(rows.map((t) => t.agentId))} />}
        </div>
        {rows.map((t) => (
          <TerminalRow key={t.agentId} terminal={t} biggest={biggest} onClose={() => close([t.agentId])} />
        ))}
      </div>
    );
  };

  return (
    <>
      {error && <Banner tone="bad">Last measurement failed: {error}</Banner>}
      {nvimFailed && <Banner tone="bad">Could not reach the nvims: {nvimFailed}</Banner>}

      <Group title="Now" foot="Measured every few seconds while this page is open, never otherwise. Resident memory, shared pages counted once per process, so it runs slightly high.">
        <Tiles>
          <Tile value={formatBytes(all.rss)} label="in terminals" under={`of ${formatBytes(reading.machineTotal)} on this machine`} />
          <Tile value={String(all.agents)} label={all.agents === 1 ? "agent" : "agents"} under={kinds.length > 0 ? kinds.map(([name, n]) => `${n} ${name}`).join(" · ") : "none running"} />
          <Tile value={String(nvims.length)} label={nvims.length === 1 ? "nvim on this Mac" : "nvims on this Mac"} under={nvims.length > 0 ? `${formatBytes(nvimRss)}${outside > 0 ? ` · ${outside} outside kururu` : ""}` : "none running"} />
          <Tile value={String(all.devServers)} label={all.devServers === 1 ? "dev server" : "dev servers"} />
          <Tile value={String(all.shells)} label={all.shells === 1 ? "idle shell" : "idle shells"} />
          <Tile
            value={own ? formatBytes(own) : "—"}
            label="kururu itself"
            under={reading.kururu.host !== null ? `pty host ${formatBytes(reading.kururu.host)} · server ${formatBytes(reading.kururu.server ?? 0)}` : "the server; the host was not found"}
          />
        </Tiles>
        <Action label="Measure again" button="Measure" busy={busy} busyLabel="Measuring…" onClick={() => void measure()} />
      </Group>

      {(nvims.length > 0 || nvimReport) && (
        <Group title="nvim" foot="Every nvim on this Mac, whoever started it. Close sends :qa, which refuses while anything is unsaved; what refuses is listed with a button that ends it anyway.">
          {nvimReport && (
            <div className={`st-report${stillOpen.length > 0 ? " st-report-warn" : ""}`}>
              <span>{nvimLead(nvimReport, stillOpen.length, nvimHard)}</span>
              {stillOpen.length > 0 && (
                <ul className="st-bullets">
                  {stillOpen.map((left) => (
                    <li key={left.id}>
                      <b>{left.label}</b>: {left.reason}
                    </li>
                  ))}
                </ul>
              )}
              <span className="st-report-actions">
                <Btn onClick={() => setNvimReport(null)}>{stillOpen.length > 0 && !nvimHard ? "Leave them open" : "OK"}</Btn>
                {stillOpen.length > 0 && !nvimHard && (
                  <DangerButton
                    label={`Force close ${stillOpen.length}`}
                    ask={`Kill ${stillOpen.length === 1 ? "it" : `all ${stillOpen.length}`}, losing unsaved changes? SIGTERM, then SIGKILL; only the nvim and what it started.`}
                    confirm="Kill"
                    busy={nvimClosing}
                    onConfirm={() => void endNvims(stillOpen.map((left) => left.id), true)}
                  />
                )}
              </span>
            </div>
          )}
          {nvims.map((nvim) => (
            <NvimRow key={nvim.id} nvim={nvim} biggest={heaviestNvim} busy={nvimClosing} onClose={() => void endNvims([nvim.id], false)} />
          ))}
          {nvims.length > 1 && (
            <div className="st-proc-head st-proc-foot">
              <span className="st-hint">All of them</span>
              <DangerButton label="Close all" ask={`Close ${plural(nvims.length, "nvim")}? Each is sent :qa.`} confirm="Close them" busy={nvimClosing} onConfirm={() => void endNvims(nvims.map((nvim) => nvim.id), false)} />
            </div>
          )}
        </Group>
      )}

      {reading.profiles.map((profile) => {
        const ids = profile.workspaces.flatMap((w) => w.terminals);
        const busyWorkspaces = profile.workspaces.filter((w) => w.terminals.length > 0);
        const idle = profile.workspaces.length - busyWorkspaces.length;
        const sum = tally(terminalsOf(ids));
        return (
          <Group
            key={profile.id}
            title={many ? `${profile.name}${profile.active ? " · this profile" : ""}` : "Terminals"}
            foot={`${countsLine(sum)} · ${formatBytes(sum.rss)}${idle > 0 && busyWorkspaces.length > 0 ? ` · ${plural(idle, "other workspace")} with nothing running` : ""}`}
          >
            {busyWorkspaces.map((w) => group(`ws:${w.id}`, w.name, w.terminals))}
            {busyWorkspaces.length === 0 && <Empty>No terminals open.</Empty>}
          </Group>
        );
      })}

      {reading.unplaced.length > 0 && (
        <Group title="Not in any tab" foot="Terminals the pty host is holding that no tab in any profile points at. Closing them is safe unless you meant to bring one back.">
          {group("unplaced", "Unplaced", reading.unplaced)}
        </Group>
      )}
    </>
  );
}

function Bar({ share }: { share: number }) {
  return (
    <span className="st-bar" aria-hidden>
      <span className="st-bar-fill" style={{ width: `${Math.round(share * 100)}%` }} />
    </span>
  );
}

function NvimRow({ nvim, biggest, busy, onClose }: { nvim: FootprintNvim; biggest: number; busy: boolean; onClose: () => void }) {
  const inKururu = nvim.place.kind === "kururu";
  const badge = inKururu ? "kururu" : (nvim.place.kind === "outside" && nvim.place.app) || "no terminal";
  const detail = inKururu ? nvimWhere(nvim.place) : nvim.cwd ? shortenPath(nvim.cwd) : "";
  return (
    <Item
      name={
        <>
          {nvim.args} <span className="st-badge">{badge}</span>
        </>
      }
      sub={`${detail}${detail ? " · " : ""}${plural(nvim.processes, "proc", "procs")}`}
      title={[nvim.args, nvim.cwd, `pid ${nvim.pid}`].filter(Boolean).join("\n")}
    >
      <Bar share={nvim.rss / biggest} />
      <span className="st-mem">{formatBytes(nvim.rss)}</span>
      <DangerButton label="Close" ask="Close it?" onConfirm={onClose} busy={busy} busyLabel="Closing…" />
    </Item>
  );
}

function TerminalRow({ terminal: t, biggest, onClose }: { terminal: FootprintTerminal; biggest: number; onClose: () => void }) {
  const badges = [...t.agents, ...Array.from({ length: t.editors }, () => "nvim"), ...t.devServers];
  const tone: Tone = t.exited ? "off" : t.status === "working" ? "busy" : t.status === "blocked" ? "warn" : t.status === "done" ? "ok" : "off";
  return (
    <Item
      className={t.exited ? "st-item-exited" : undefined}
      lead={<Dot tone={tone} title={t.exited ? "exited" : t.status} />}
      name={
        <>
          {t.label}
          {badges.map((badge, i) => (
            <span key={`${badge}-${i}`} className="st-badge">
              {badge}
            </span>
          ))}
        </>
      }
      sub={`${t.summary || shortenPath(t.cwd)} · ${t.exited ? "exited" : plural(t.processes, "proc", "procs")}`}
      title={t.cwd}
    >
      <Bar share={(t.rss ?? 0) / biggest} />
      <span className="st-mem">{t.rss === null ? "—" : formatBytes(t.rss)}</span>
      <DangerButton label={t.exited ? "Remove" : "Close"} ask={t.exited ? "Remove it?" : "End it?"} onConfirm={onClose} />
    </Item>
  );
}
