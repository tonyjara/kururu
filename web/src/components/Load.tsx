/**
 * This Mac's load on the bottom bar, beside the allowances: the 1-minute
 * load average and the memory that can be handed out without swapping, in
 * the colour of the slot queue's gates — and, on a hover or a tap, what the
 * queue holds and who is waiting in it.
 *
 * On the bar because it is the number the queue admits by. An agent waiting
 * for a build "because the load is over 24" is a sentence nobody can check
 * from a window that does not say what the load is; and when six things are
 * running at once, the figure going red is the first sign of it anyone sees.
 * The gates are the queue's own (`SlotsView.buildGate`, `maestroGate`), so
 * the colour means what the queue does: over a build's gate, builds wait;
 * over a test's, tests do too.
 *
 * A figure rather than a ring, on the OpenRouter chip's argument: a load has
 * no whole to be a share of. On a phone only the load is drawn, and the
 * memory is in the popover.
 */
import { fmtDur, laneLabel, loadSeverity, type SlotsView } from "../../../shared/slots";
import { useKururu } from "../session";
import { BarChip } from "./BarChip";

export function LoadChip() {
  const { slots } = useKururu();
  if (!slots) return null;
  const severity = loadSeverity(slots);
  const busy = slots.leases.length + slots.waiting.length;
  const label = `This Mac — load ${slots.load1} on ${slots.cores} cores, ${slots.freeGb} GB free${busy ? `; ${slots.leases.length} held, ${slots.waiting.length} waiting in the slot queue` : ""}`;
  return (
    <BarChip
      label={label}
      className="sb-load"
      chip={
        <>
          <span className="sb-usage-mark" aria-hidden="true">
            <GaugeMark />
          </span>
          <span className="load-figure" data-severity={severity}>
            {slots.load1}
            <span className="load-free"> · {slots.freeGb} GB</span>
          </span>
          {slots.waiting.length > 0 && <span className="load-waiting">{slots.waiting.length} waiting</span>}
        </>
      }
    >
      <LoadDetail view={slots} />
    </BarChip>
  );
}

function LoadDetail({ view }: { view: SlotsView }) {
  const now = Date.now();
  return (
    <>
      <span className="usage-pop-head">
        <span className="sb-usage-mark" aria-hidden="true">
          <GaugeMark />
        </span>
        This Mac
      </span>
      <ul className="usage-list">
        <li className="usage-item">
          <span className="usage-head">
            <span className="usage-name">Load</span>
            <span className="load-figure" data-severity={loadSeverity(view)}>
              {view.load1} on {view.cores} cores
            </span>
          </span>
          {(view.buildGate !== null || view.maestroGate !== null) && (
            <span className="usage-reset">
              Builds wait over {view.buildGate ?? "—"}, tests over {view.maestroGate ?? "—"}
            </span>
          )}
        </li>
        <li className="usage-item">
          <span className="usage-head">
            <span className="usage-name">Free memory</span>
            <span className="usage-used">{view.freeGb} GB</span>
          </span>
          <span className="usage-reset">Builds and simulators wait under {view.minFreeGb} GB</span>
        </li>
        {view.booted !== null && (
          <li className="usage-item">
            <span className="usage-head">
              <span className="usage-name">Simulators booted</span>
              <span className="usage-used">
                {view.booted} of {view.bootedMax}
              </span>
            </span>
          </li>
        )}
      </ul>
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
