/**
 * At most one run per gap, the first of a quiet spell at once.
 *
 * What the snapshot is sent through (`pushSnapshot` in `context.ts`). Changes
 * come in two shapes there and the obvious tools each fit one: coalescing in
 * a microtask fits a burst inside one turn of the loop and does nothing for
 * hook reports, which arrive as separate requests; a trailing debounce fits
 * those and makes every single change wait, and one that restarts on each
 * change holds everything back for as long as a divider is dragged. So the
 * first push after `gapMs` of quiet runs at the end of its turn, as the
 * microtask did, and any push inside the gap waits for the gap's end and runs
 * once, reading the state as it then is.
 *
 * `flush` runs a pending push now, for a caller that must not send anything
 * ahead of it; `pending` says whether there is one.
 */
export class Gap {
  private queued = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ranAt = -Infinity;

  constructor(
    private readonly gapMs: number,
    private readonly run: () => void,
    private readonly clock: () => number = Date.now,
  ) {}

  get pending(): boolean {
    return this.queued;
  }

  push(): void {
    if (this.queued) return;
    this.queued = true;
    const wait = this.ranAt + this.gapMs - this.clock();
    if (wait <= 0) queueMicrotask(() => this.flush());
    else this.timer = setTimeout(() => this.flush(), wait);
  }

  flush(): void {
    if (!this.queued) return;
    this.queued = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ranAt = this.clock();
    this.run();
  }
}
