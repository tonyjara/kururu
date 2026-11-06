/**
 * Whether something of kururu's is drawn over a browser tab.
 *
 * A browser tab's page is not in this document. It is a native view the main
 * process lays over the tab's box (`desktop/browser.js`), and a native view is
 * above all of the window's DOM — so a menu, a drawer, a dialog or a dragged
 * tab that crosses a page would be drawn *under* it, cut off at the page's
 * edge. The answer is VS Code's: while anything of ours covers a tab, the tab
 * shows a still of its page and the view is hidden, and the view comes back
 * when the cover goes (`BrowserView.tsx` does the swap; this says when).
 *
 * **Found, not registered.** The plan's version had every overlay register
 * itself, with the risk that one added later forgets and draws under the page.
 * This looks instead, on three tests, any one of which is a cover:
 *
 * - **A drag in flight.** HTML drags are the window's, and their drop zones
 *   are in the pane body under the page; a page left up would swallow every
 *   `dragover` aimed at them.
 * - **Something known to float** (`FLOATING`: menus, sheets, drawers, scrims,
 *   popovers, notes, a portal on `body`) whose box meets the tab's and is the
 *   topmost thing at the middle of where they meet — the plan's rule, so a
 *   drawer that sits beside a tab does not swap it.
 * - **Anything topmost on a grid of points** over the tab that is not the
 *   tab's own stub: the catch-all for an overlay nobody listed, at the price of
 *   missing one small enough to fall between the points, which is what the
 *   list is for.
 *
 * Checked on any change to the document (a frame later, coalesced), on a
 * resize, and on a slow beat for a cover that moved without changing the
 * document — and only while a tab is being watched at all.
 */

/** Things that float over the panes, by class: what the grid could miss. */
const FLOATING = [
  ".menu",
  ".menu-backdrop",
  ".picker",
  ".overlay",
  ".scrim",
  ".sidebar-scrim",
  ".kuru-drawer",
  ".kuru-sheet",
  ".needs-drawer",
  ".quote-pop",
  ".notes .note",
  ".reload-notice",
  ".voice-pill",
  "[role=dialog]",
  "[data-overlay]",
].join(",");

/** The grid, per side: 4×4 points inside the box, away from its edges. */
const GRID = 4;
/** The slow beat, for a cover that moves without a mutation or a resize. */
const BEAT_MS = 400;

interface Watch {
  stub: HTMLElement;
  covered: boolean;
  onChange: (covered: boolean) => void;
}

const watches = new Set<Watch>();
let dragging = false;
let queued = false;
let observer: MutationObserver | null = null;
let beat: ReturnType<typeof setInterval> | null = null;

/**
 * Watch a browser tab's stub — the empty box the page is laid over — and be
 * told whenever it becomes covered or uncovered. Told once at the start.
 * Returns the way to stop.
 */
export function watchCover(stub: HTMLElement, onChange: (covered: boolean) => void): () => void {
  const watch: Watch = { stub, covered: false, onChange };
  watches.add(watch);
  start();
  watch.covered = coveredNow(stub);
  onChange(watch.covered);
  return () => {
    watches.delete(watch);
    if (watches.size === 0) stop();
  };
}

/** Look again now, for a change this module cannot see coming — a drag's start, a tab shown. */
export function recheckCover(): void {
  queue();
}

function start(): void {
  if (observer) return;
  observer = new MutationObserver(queue);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "open", "hidden"] });
  window.addEventListener("resize", queue);
  window.addEventListener("dragstart", onDragStart, true);
  window.addEventListener("dragend", onDragEnd, true);
  window.addEventListener("drop", onDragEnd, true);
  beat = setInterval(queue, BEAT_MS);
}

function stop(): void {
  observer?.disconnect();
  observer = null;
  window.removeEventListener("resize", queue);
  window.removeEventListener("dragstart", onDragStart, true);
  window.removeEventListener("dragend", onDragEnd, true);
  window.removeEventListener("drop", onDragEnd, true);
  if (beat) clearInterval(beat);
  beat = null;
  dragging = false;
}

function onDragStart(): void {
  dragging = true;
  check();
}

function onDragEnd(): void {
  dragging = false;
  queue();
}

function queue(): void {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    check();
  });
}

function check(): void {
  for (const watch of watches) {
    const covered = coveredNow(watch.stub);
    if (covered === watch.covered) continue;
    watch.covered = covered;
    watch.onChange(covered);
  }
}

/** Whether `el` is the stub or inside it — the only things allowed on top of the tab's box. */
function ours(stub: HTMLElement, el: Element | null): boolean {
  return el !== null && (el === stub || stub.contains(el));
}

function coveredNow(stub: HTMLElement): boolean {
  if (dragging) return true;
  if (!stub.isConnected) return false;
  const box = stub.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return false;

  for (const el of document.querySelectorAll(FLOATING)) {
    if (stub.contains(el) || el.contains(stub)) continue;
    const r = el.getBoundingClientRect();
    const left = Math.max(box.left, r.left);
    const right = Math.min(box.right, r.right);
    const top = Math.max(box.top, r.top);
    const bottom = Math.min(box.bottom, r.bottom);
    if (right - left < 1 || bottom - top < 1) continue;
    const at = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    if (!ours(stub, at)) return true;
  }

  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const x = box.left + ((i + 0.5) / GRID) * box.width;
      const y = box.top + ((j + 0.5) / GRID) * box.height;
      const at = document.elementFromPoint(x, y);
      if (at && !ours(stub, at)) return true;
    }
  }
  return false;
}
