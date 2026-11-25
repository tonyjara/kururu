/**
 * "testing: chat:e2e · 2m10s", on an agent's row and on its card, for as long
 * as the run takes.
 *
 * What it draws is `AgentSnapshot.testing`, which the server sets from the
 * agent's own hooks and takes away when the run ends (`server/src/testing.ts`).
 * The clock is the page's: the snapshot says when the run started and this
 * counts up from it, so a run of ten minutes is one message from the server
 * and not six hundred. One interval serves every chip on the page and exists
 * only while one is drawn, on the rule the rest of the window keeps: nothing
 * ticks for nobody.
 *
 * The suite's name and no more. A row is on every phone that has the page
 * open, and the command line stays in the ledger.
 */
import { useSyncExternalStore } from "react";
import { chipName, KIND_LABEL, shortDuration, type LiveTest } from "../../../shared/testing";

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = Date.now();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const each of listeners) each();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The time, a second at a time, for as long as something is counting. */
function useSeconds(): number {
  return useSyncExternalStore(subscribe, () => now, () => now);
}

export function TestChip({ testing, className }: { testing: LiveTest; className?: string }) {
  const at = useSeconds();
  // A phone's clock may be behind the server's; a run has never been going for less than nothing.
  const took = shortDuration(Math.max(0, at - testing.since));
  const title = [
    `${KIND_LABEL[testing.kind]} run: ${testing.suite}`,
    testing.loose ? "This workspace is marked as having no test suite (Settings → Workspaces)." : null,
    testing.more ? `And ${testing.more} more going beside it.` : null,
    "Every run is on Settings → Testing.",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span className={`test-chip test-chip-${testing.kind}${testing.loose ? " test-chip-loose" : ""}${className ? ` ${className}` : ""}`} title={title}>
      <span className="test-chip-dot" aria-hidden="true" />
      <span className="test-chip-name">testing: {chipName(testing.suite)}</span>
      <span className="test-chip-time">· {took}</span>
      {testing.more ? <span className="test-chip-time">+{testing.more}</span> : null}
    </span>
  );
}
