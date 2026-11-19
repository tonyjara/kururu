/**
 * This Mac on the bottom bar, beside the allowances: how much of its
 * processors and its memory is in use now — and, on a hover or a tap, what is
 * using them, and what the slot queue holds and who is waiting in it.
 *
 * It drew the 1-minute load average until 2026-11-19, as "146 · 7 GB", and
 * its popover said "146 on 12 cores". The owner asked what that even meant,
 * which is the right question: a load has no ceiling and no unit, and the
 * free memory beside it read as comfortable on a Mac with 20 GB pushed out
 * to swap. So the chip says what a person already has a feel for — a share
 * of the cores, with the last three minutes drawn beside it, and memory used
 * of what there is — and the load is a sentence in the popover
 * (`loadWords`), kept because it is what the queue admits by and the only
 * figure that says how long the line for a core is.
 *
 * The colour is still the slot queue's gates, so it means what the queue
 * does — amber, builds wait; red, tests do too — with macOS's own memory
 * pressure added (`macMood` in `shared/mac.ts`). Each figure wears its own
 * part of it and the dial the worst of the two, so an amber "9%" never has
 * to be explained by the memory beside it; the popover's first line says in
 * words which it is and what is behind it. `loadSeverity` is
 * the same rule without the pressure; nothing here decides it a third time.
 *
 * The readings are the server's (`server/src/mac.ts`), off the process sweep
 * it already makes, and they come to their own store (`../mac`) so that a
 * figure moving every three seconds redraws this chip and nothing else. On a
 * phone only the share is drawn; the rest is in the popover.
 */
import { useState } from "react";
import { gb, loadWords, MAC_HISTORY, type MacConsumer, type MacMemory, macMood, type MacView, memWords, sortConsumers } from "../../../shared/mac";
import { fmtDur, laneLabel, type SlotsView } from "../../../shared/slots";
import { DEV_SCAN_MS } from "../../../shared/wire";
import { useMac } from "../mac";
import { useKururu } from "../session";
import { BarChip } from "./BarChip";

/** How many consumers the popover lists in the order chosen. */
const ROWS = 5;

export function LoadChip() {
  const { slots } = useKururu();
  const mac = useMac();
  if (!slots) return null;
  const mood = mac ? macMood(mac, slots) : null;
  const busy = slots.leases.length + slots.waiting.length;
  const memory = mac?.memory ?? null;
  const label = mac
    ? `This Mac — ${mood!.word}: ${mac.cpu}% of ${mac.cores} cores in use${memory ? `, ${gb(memory.usedMb)} of ${gb(memory.totalMb)} GB of memory` : ""}${busy ? `; ${slots.leases.length} held, ${slots.waiting.length} waiting in the slot queue` : ""}`
    : "This Mac";
  return (
    <BarChip
      label={label}
      className="sb-load"
      chip={
        <>
          <span className="sb-usage-mark load-mark" data-severity={mood?.severity} aria-hidden="true">
            <GaugeMark />
          </span>
          {mac ? (
            <>
              <Spark history={mac.history} className="mac-spark-chip" />
              <span className="load-figure" data-severity={mood!.cpu}>
                {mac.cpu}%
              </span>
              {memory && (
                <span className="load-figure load-free" data-severity={mood!.mem}>
                  {gb(memory.usedMb)}/{gb(memory.totalMb)} GB
                </span>
              )}
            </>
          ) : (
            <span className="load-figure load-free">…</span>
          )}
          {slots.waiting.length > 0 && <span className="load-waiting">{slots.waiting.length} waiting</span>}
        </>
      }
    >
      <LoadDetail view={slots} mac={mac} />
    </BarChip>
  );
}

function LoadDetail({ view, mac }: { view: SlotsView; mac: MacView | null }) {
  const now = Date.now();
  const mood = mac ? macMood(mac, view) : null;
  const booted = mac ? mac.sims : view.booted;
  return (
    <>
      <span className="usage-pop-head">
        <span className="sb-usage-mark" aria-hidden="true">
          <GaugeMark />
        </span>
        This Mac
        {mood && (
          <span className="mac-word" data-severity={mood.severity}>
            {mood.word}
          </span>
        )}
      </span>
      {mac && mood ? (
        <>
          <span className="mac-line">{mood.line}</span>
          <Processors mac={mac} view={view} />
          {mac.memory && <Memory memory={mac.memory} view={view} />}
          <Consumers mac={mac} />
        </>
      ) : (
        <span className="usage-pop-empty">Reading the processors and the memory…</span>
      )}
      {booted !== null && (booted > 0 || view.booted !== null) && (
        <ul className="usage-list">
          <li className="usage-item">
            <span className="usage-head">
              <span className="usage-name">Simulators booted</span>
              <span className="usage-used">
                {booted} of {view.bootedMax}
              </span>
            </span>
          </li>
        </ul>
      )}
      <span className="usage-pop-head load-queue-head">Slot queue</span>
      {view.leases.length === 0 && view.waiting.length === 0 ? (
        <span className="usage-pop-empty">Nothing held, nobody waiting.</span>
      ) : (
        <ul className="usage-list">
          {view.leases.map((lease) => (
            <li key={lease.id} className="usage-item">
              <span className="usage-head">
                <span className="usage-name">
                  {lease.who} · {lease.lane === "sim" ? (lease.name ?? "simulator") : lease.lane}
                </span>
                <span className="usage-used">
                  {fmtDur(now - lease.since)} of {fmtDur(lease.until - lease.since)}
                </span>
              </span>
              <span className="usage-reset">{lease.why}</span>
            </li>
          ))}
          {view.waiting.map((wait) => (
            <li key={wait.id} className="usage-item">
              <span className="usage-head">
                <span className={`usage-name ${wait.long ? "load-long" : ""}`}>
                  {wait.who} · waiting for {laneLabel(wait.lane)}
                  {wait.priority ? " · you're waiting" : ""}
                </span>
                <span className="usage-used">{fmtDur(now - wait.since)}</span>
              </span>
              <span className="usage-reset">{wait.reason ? `${wait.why} — ${wait.reason}` : wait.why}</span>
            </li>
          ))}
        </ul>
      )}
      <span className="usage-pop-foot">
        <code>slot status</code> in a terminal says the same; <code>slot help</code> says how to queue.
      </span>
    </>
  );
}

/**
 * The processors: the share in use, the last three minutes of it, and the
 * load as a sentence. Pointing at the drawing reads off the share at that
 * moment, in the figure's place, so the one number on the row is always the
 * one being looked at.
 */
function Processors({ mac, view }: { mac: MacView; view: SlotsView }) {
  const [at, setAt] = useState<number | null>(null);
  const shown = at !== null && at < mac.history.length ? at : null;
  const ago = shown === null ? 0 : (mac.history.length - 1 - shown) * DEV_SCAN_MS;
  const times = (gate: number | null) => (gate === null ? null : `${Math.round((gate / Math.max(1, mac.cores)) * 10) / 10}×`);
  const build = times(view.buildGate);
  const test = times(view.maestroGate);
  return (
    <div className="mac-block">
      <span className="usage-head">
        <span className="usage-name">Processors</span>
        <span className="mac-figure">
          {shown === null ? `${mac.cpu}% of ${mac.cores} cores` : `${mac.history[shown]}% · ${ago < 1000 ? "now" : `${fmtDur(ago)} ago`}`}
        </span>
      </span>
      <Spark history={mac.history} className="mac-spark" at={shown} onAt={setAt} />
      <span className="usage-reset">
        Load {mac.load1} over the last minute: {loadWords(mac.load1, mac.cores)}.
        {build && test ? ` Builds wait past ${build} the cores, tests past ${test}.` : build ? ` Builds wait past ${build} the cores.` : ""}
      </span>
    </div>
  );
}

/**
 * The share of the cores over the last few minutes, the newest at the right
 * edge whatever its length, on a scale that is always 0 to 100: a drawing
 * that rescaled to its own peak would make an idle Mac look as busy as a
 * building one.
 */
function Spark({ history, className, at = null, onAt }: { history: readonly number[]; className: string; at?: number | null; onAt?: (index: number | null) => void }) {
  const W = 120;
  const H = 32;
  const step = W / (MAC_HISTORY - 1);
  const x = (i: number) => W - (history.length - 1 - i) * step;
  const y = (v: number) => H - 1 - (Math.max(0, Math.min(100, v)) / 100) * (H - 2);
  const points = history.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const line = points.length > 1 ? `M${points.join("L")}` : "";
  const area = line ? `${line}L${W},${H}L${x(0).toFixed(1)},${H}Z` : "";
  return (
    <svg
      className={className}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      onPointerMove={
        onAt &&
        ((event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const index = history.length - 1 - Math.round(((box.right - event.clientX) / box.width) * (MAC_HISTORY - 1));
          onAt(index >= 0 && index < history.length ? index : null);
        })
      }
      onPointerLeave={onAt && (() => onAt(null))}
    >
      {onAt && <line className="mac-spark-grid" x1="0" x2={W} y1={H / 2} y2={H / 2} />}
      {area && <path className="mac-spark-area" d={area} />}
      {line && <path className="mac-spark-line" d={line} />}
      {at !== null && <line className="mac-spark-at" x1={x(at)} x2={x(at)} y1="0" y2={H} />}
    </svg>
  );
}

const PRESSURE_WORDS = { normal: "normal", warn: "tight", critical: "run out" } as const;

/**
 * Memory in use of what there is, in Activity Monitor's parts, and the two
 * things "free" never said: the pressure, which is macOS's own verdict, and
 * what has been pushed out to disk. The parts are named under the bar, each
 * with its figure, so a colour is never the only thing telling two apart.
 */
function Memory({ memory, view }: { memory: MacMemory; view: SlotsView }) {
  const parts = [
    { id: "app", name: "Apps", mb: memory.appMb },
    { id: "wired", name: "System", mb: memory.wiredMb },
    { id: "compressed", name: "Compressed", mb: memory.compressedMb },
    { id: "cached", name: "Cached files", mb: memory.cachedMb },
  ].filter((part) => part.mb > 0);
  const free = Math.max(0, memory.totalMb - memory.usedMb - memory.cachedMb);
  const pressure = memory.pressure;
  return (
    <div className="mac-block">
      <span className="usage-head">
        <span className="usage-name">Memory</span>
        <span className="mac-figure">
          {gb(memory.usedMb)} of {gb(memory.totalMb)} GB in use
        </span>
      </span>
      <span className="mac-mem" role="img" aria-label={`${parts.map((p) => `${p.name} ${gb(p.mb)} GB`).join(", ")}, free ${gb(free)} GB`}>
        {parts.map((part) => (
          <span key={part.id} className="mac-mem-part" data-part={part.id} style={{ flexGrow: part.mb }} title={`${part.name}: ${gb(part.mb)} GB`} />
        ))}
        {free > 0 && <span className="mac-mem-part" data-part="free" style={{ flexGrow: free }} title={`Free: ${gb(free)} GB`} />}
      </span>
      <span className="mac-legend">
        {parts.map((part) => (
          <span key={part.id} className="mac-key">
            <span className="mac-dot" data-part={part.id} aria-hidden="true" />
            {part.name} {gb(part.mb)} GB
          </span>
        ))}
      </span>
      <span className="usage-reset">
        {pressure && (
          <>
            Pressure{" "}
            <span className="mac-pressure" data-pressure={pressure}>
              {PRESSURE_WORDS[pressure]}
            </span>
            {" · "}
          </>
        )}
        {memory.swapMb >= 100 ? `${gb(memory.swapMb)} GB pushed out to disk` : "nothing pushed out to disk"}. Builds and simulators wait under {view.minFreeGb} GB to hand out; there {view.freeGb === 1 ? "is" : "are"} {view.freeGb}.
      </span>
    </div>
  );
}

/**
 * Who has the Mac, heaviest first, by processor or by memory. A terminal is
 * named with its workspace and the programs under it, a simulator as one, and
 * anything else by its app. The share is of every core, so the rows add up to
 * the figure above them; Activity Monitor's "146%" is of one.
 */
function Consumers({ mac }: { mac: MacView }) {
  const [by, setBy] = useState<"cpu" | "mem">("cpu");
  const rows = sortConsumers(mac.top, by).slice(0, ROWS);
  const total = mac.memory?.totalMb ?? 0;
  return (
    <div className="mac-block">
      <span className="usage-head">
        <span className="mac-using-head">What is using it</span>
        <span className="st-seg mac-seg" role="radiogroup" aria-label="Order by">
          {(["cpu", "mem"] as const).map((id) => (
            <button key={id} type="button" role="radio" aria-checked={by === id} className={`st-seg-btn${by === id ? " st-seg-on" : ""}`} onClick={() => setBy(id)}>
              {id === "cpu" ? "Processor" : "Memory"}
            </button>
          ))}
        </span>
      </span>
      {rows.length === 0 ? (
        <span className="usage-pop-empty mac-empty">Nothing read yet.</span>
      ) : (
        <ul className="mac-rows">
          {rows.map((row) => (
            <ConsumerRow key={row.key} row={row} by={by} total={total} cores={mac.cores} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ConsumerRow({ row, by, total, cores }: { row: MacConsumer; by: "cpu" | "mem"; total: number; cores: number }) {
  const share = by === "cpu" ? row.cpu : total > 0 ? (row.memMb / total) * 100 : 0;
  const where = row.kind === "sim" ? "simulator" : row.where;
  const coresUsed = Math.round(((row.cpu / 100) * cores) * 10) / 10;
  return (
    <li className="mac-row" title={`${row.name}: ${coresUsed} of ${cores} cores, ${memWords(row.memMb)}, ${row.processes} process${row.processes === 1 ? "" : "es"}`}>
      <span className="usage-head">
        <span className="mac-row-name">
          {row.name}
          {where && <span className="mac-row-where"> · {where}</span>}
        </span>
        <span className="mac-row-figures">
          <span className={by === "cpu" ? "mac-row-on" : ""}>{row.cpu < 10 ? row.cpu : Math.round(row.cpu)}%</span>
          <span className={by === "mem" ? "mac-row-on" : ""}>{memWords(row.memMb)}</span>
        </span>
      </span>
      <span className="mac-row-bar">
        <span className="mac-row-fill" style={{ width: `${Math.max(0, Math.min(100, share))}%` }} />
      </span>
      {row.what && <span className="usage-reset">{row.what}</span>}
    </li>
  );
}

/**
 * A dial with its needle past the middle: how hard the machine is working.
 * Drawn here as `SidebarIcon` in `StatusBar.tsx` is: the icon set has no
 * drawing of it.
 */
function GaugeMark() {
  return (
    <svg className="glyph glyph-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 18a8 8 0 1 1 16 0" />
      <path d="M12 18l4-6" />
    </svg>
  );
}
