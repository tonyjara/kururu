/**
 * The machines on the bottom bar: a server glyph in the colour of the worst
 * load on any of them, how many are connected, and — on a hover, a tap on a
 * phone — each one's rings.
 *
 * They were a section of the sidebar until 2026-10-18, under the usage rings
 * that had already gone to the bar, and they followed for the same reason: a
 * machine's load is a glance on the way past, not a list to read, and the bar
 * is where the window keeps those. What the section drew all the time, the
 * popover draws on request; what the section could not do — say at a glance
 * that *something*, somewhere, is maxing out — the colour does. The
 * thresholds are the rings' own (`machineSeverity`): amber from three
 * quarters, red from nine tenths, of CPU, memory or disk on any machine, and
 * the title and the popover say which (`worstLoad`).
 *
 * A machine that cannot be reached is news of another kind and is shown
 * another way: the count becomes "2/3" and the chip wears the stale dot, and
 * its row carries ssh's own words. It does not colour the glyph, which is
 * about load, and a box that is down has none.
 *
 * Each row keeps the Shell that answers ssh's question for a machine that
 * cannot get in, and the foot goes to Settings → Machines, where machines are
 * added and removed. Drawn only once one has been added, as the section was:
 * a chip for a feature most people never use is noise on every bar.
 */
import type { MachineStatus } from "../../../shared/machines";
import { formatBytes, machineSeverity, usedShare, worstLoad } from "../../../shared/machines";
import * as api from "../session";
import { useKururu } from "../session";
import { BarChip } from "./BarChip";
import { GaugeRing } from "./Usage";

export function MachinesChip({ onSettings }: { onSettings: () => void }) {
  const { machines } = useKururu();
  if (machines.length === 0) return null;
  const connected = machines.filter((machine) => !machine.error).length;
  const failing = machines.length - connected;
  const worst = worstLoad(machines);
  const severity = worst ? machineSeverity(worst.percent) : "normal";
  const count = failing > 0 ? `${connected}/${machines.length}` : String(machines.length);
  const words =
    failing > 0
      ? `${connected} of ${machines.length} machines connected`
      : `${machines.length} ${machines.length === 1 ? "machine" : "machines"} connected`;
  /* The title names the culprit, so a red glyph is one hover from "which". */
  const title =
    worst && severity !== "normal" ? `${words} — ${worst.name}'s ${worst.label} is at ${Math.round(worst.percent)}%` : words;

  return (
    <BarChip
      label={title}
      className="sb-machines"
      chip={
        <>
          <span className="sb-usage-mark sb-machines-mark" data-severity={severity} aria-hidden="true">
            <ServerIcon />
          </span>
          <span className="sb-machines-n">{count}</span>
          {failing > 0 && <span className="usage-stale">·</span>}
        </>
      }
    >
      {(close) => (
        <>
          <span className="usage-pop-head">
            <span className="sb-usage-mark sb-machines-mark" data-severity={severity} aria-hidden="true">
              <ServerIcon />
            </span>
            Machines
            <span className="machines-head-words">{words}</span>
          </span>
          <ul className="usage-list machines-list">
            {machines.map((machine) => (
              <MachineRow
                key={machine.id}
                machine={machine}
                onShell={() => {
                  void api.openMachineShell(machine.id);
                  close();
                }}
              />
            ))}
          </ul>
          <span className="usage-pop-foot machines-foot">
            <button
              className="kuru-head-btn"
              onClick={() => {
                close();
                onSettings();
              }}
            >
              Settings → Machines
            </button>
          </span>
        </>
      )}
    </BarChip>
  );
}

/**
 * One machine: its name, a ring each for CPU, memory and disk — or why there
 * are none — and its Shell. The name links to the machine's panel when it has
 * one, as the sidebar's row did.
 */
function MachineRow({ machine, onShell }: { machine: MachineStatus; onShell: () => void }) {
  const reading = machine.reading;
  const title = [machine.host, machine.error && `Last attempt: ${machine.error}`].filter(Boolean).join("\n");
  const name = machine.panel ? (
    <a className="machine-name" href={machine.panel} target="_blank" rel="noreferrer noopener" title={`${title}\n→ ${machine.panel}`}>
      {machine.name}
    </a>
  ) : (
    <span className="machine-name" title={title}>
      {machine.name}
    </span>
  );
  const cpu = reading?.cpu ?? null;
  const mem = usedShare(reading?.mem ?? null);
  const disk = usedShare(reading?.disk ?? null);
  const memFigure = reading?.mem ? `${formatBytes(reading.mem.used)} / ${formatBytes(reading.mem.total)}` : "";
  const diskFigure = reading?.disk ? `${formatBytes(reading.disk.used)} / ${formatBytes(reading.disk.total)}` : "";
  return (
    <li className={`machines-row ${machine.stale ? "machine-stale" : ""}`}>
      <span className="gauge-item">
        {name}
        {reading ? (
          <span className="gauge-rings">
            {cpu !== null && <MachineRing label="CPU" percent={cpu} figure={`${Math.round(cpu)}%`} />}
            {mem !== null && <MachineRing label="RAM" percent={mem} figure={memFigure} />}
            {disk !== null && <MachineRing label="Disk" percent={disk} figure={diskFigure} />}
          </span>
        ) : (
          <span className="usage-used">{machine.error ? "unreachable" : "…"}</span>
        )}
        <button
          className="kuru-head-btn machines-shell"
          onClick={onShell}
          title={`Open a shell on ${machine.name} in a new tab\nssh -t ${machine.host}`}
          aria-label={`Shell on ${machine.name}`}
        >
          Shell
        </button>
      </span>
      {machine.error && <span className="machine-error">{machine.error}</span>}
    </li>
  );
}

function MachineRing({ label, percent, figure }: { label: string; percent: number; figure: string }) {
  const rounded = Math.round(percent);
  return (
    <GaugeRing
      label={label}
      mark={label[0] ?? ""}
      percent={percent}
      severity={machineSeverity(percent)}
      title={`${label} ${rounded}% used${figure && figure !== `${rounded}%` ? ` — ${figure}` : ""}`}
    />
  );
}

/**
 * Two units in a rack, a light on each: a server, which is what the chip is
 * about whether the box is a VPS or a PC. Drawn here rather than taken from
 * the skin's icon set on `SidebarIcon`'s reasoning.
 */
function ServerIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  );
}
