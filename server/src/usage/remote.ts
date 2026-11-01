/**
 * What the other nodes spent, on the parent's Usage page.
 *
 * A node reads its own logs into its own ledger, by the same code, on its own
 * disk: a parent cannot reach a child's transcripts and has no business wanting
 * to. So all this does is ask each linked child, every few minutes, for the days
 * of its usage the parent does not already hold, and keep the answer. The shape of
 * that answer and why it is cut as it is are `shared/usagepull.ts`; carrying it is
 * `nodes.ts`; keeping it is `store.ts`.
 *
 * **Asking costs nothing when nothing moved,** which is most of the time: the ask
 * says what it holds, and an answer with no days says so back. A node that is away
 * is not asked and its numbers stand, with the time they were last good on the
 * page. It reads on the node's side off its own ledger and spends no token on
 * either: nothing here is told to Kuru.
 *
 * A machine reached over ssh is a different road and lives in `sweep.ts`, since
 * it is the reader's own loop run through a longer pipe.
 */
import { adoptKnownDays, adoptUsagePart, daysToSend, type RemoteSource, type UsagePart } from "../../../shared/usagepull";
import type { Ledger } from "./store";

/** How often each node is asked. The same pace as the sweep behind the numbers it would be sending. */
export const PULL_MS = 5 * 60_000;
/** After a link comes up, long enough for its summary to say what it speaks. */
const LINKED_DELAY_MS = 3_000;
/** Between the answers of a long first pull, so the link's own pings get a turn. */
const PULL_GAP_MS = 250;
/** Answers in one go: past this the next interval carries on, and it does not matter which. */
const PULL_PARTS_MAX = 200;

/** What a node needs lent to answer: the words its numbers go by, off its own database. */
export interface ExportNames {
  workspace(key: string): string | null;
  card(id: string): string | null;
}

/** A node answering its parent: the days that differ, as many as one frame takes. */
export function exportUsage(ledger: Ledger, knownRaw: unknown, names: ExportNames): UsagePart {
  const known = adoptKnownDays(knownRaw);
  const { days, more } = daysToSend(ledger.usageDaySigns(), known, (day) => ledger.usageDayWeight(day));
  const out: UsagePart["days"] = days.map(({ day, sig }) => ({ day, sig, cells: ledger.usageDayCells(day) }));
  const ids = new Set<string>();
  for (const day of out) for (const cell of day.cells) ids.add(cell.sessionId);
  const sessions = ledger.usageSessionsToSend(ids);
  const workspaces: Record<string, string> = {};
  const cards: Record<string, string> = {};
  for (const session of sessions) {
    if (session.workspaceKey && !(session.workspaceKey in workspaces)) {
      const name = names.workspace(session.workspaceKey);
      if (name) workspaces[session.workspaceKey] = name;
    }
    if (session.cardId && !(session.cardId in cards)) {
      const title = names.card(session.cardId);
      if (title) cards[session.cardId] = title;
    }
  }
  return { days: out, sessions, names: { workspaces, cards }, more };
}

/** A member of the roster as this cares about it. */
export interface PulledNode {
  id: string;
  name: string;
  up: boolean;
  /** Whether its summary says it answers. Unknown until it has sent one. */
  answers: boolean;
}

export interface NodeUsageDeps {
  ledger: Ledger;
  /** Every other member, on the parent. Empty anywhere else, which is what keeps a child from asking. */
  nodes: () => readonly PulledNode[];
  ask: (nodeId: string, known: Record<string, string>) => Promise<unknown>;
  log: (line: string) => void;
  gapMs?: number;
}

export class NodeUsage {
  private interval: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pulling: Promise<void> | null = null;
  private owed = false;
  private stopped = false;
  private readonly errors = new Map<string, string>();

  constructor(private readonly deps: NodeUsageDeps) {}

  start(): void {
    this.interval = setInterval(() => this.pullSoon(), PULL_MS);
    this.interval.unref?.();
    this.pullSoon(LINKED_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    if (this.timer) clearTimeout(this.timer);
  }

  /** A link came up, or the time came round. */
  pullSoon(delayMs = 0): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pullAll();
    }, delayMs);
    this.timer.unref?.();
  }

  /** Every node that can be asked, in turn. A second call while one is under way is one more pass after it. */
  pullAll(): Promise<void> {
    if (this.pulling) {
      this.owed = true;
      return this.pulling;
    }
    this.pulling = this.run().finally(() => {
      this.pulling = null;
      if (this.owed && !this.stopped) {
        this.owed = false;
        this.pullSoon();
      }
    });
    return this.pulling;
  }

  private async run(): Promise<void> {
    for (const node of this.deps.nodes()) {
      if (this.stopped) return;
      if (!node.up || !node.answers) continue;
      try {
        await this.pullOne(node);
        this.errors.delete(node.id);
      } catch (err) {
        // The link's or the database's own words. What came before this is kept, and the next pass asks again from there.
        const why = err instanceof Error ? err.message : String(err);
        this.errors.set(node.id, why);
        this.deps.log(`kururu: could not read what ${node.name} spent: ${why}`);
      }
    }
  }

  private async pullOne(node: PulledNode): Promise<void> {
    for (let parts = 0; parts < PULL_PARTS_MAX && !this.stopped; parts++) {
      const part = adoptUsagePart(await this.deps.ask(node.id, this.deps.ledger.nodeDaysKnown(node.id)));
      if (!part) throw new Error("its answer was not one");
      this.deps.ledger.applyNodeUsage(node.id, node.name, part);
      if (!part.more) return;
      await new Promise((done) => setTimeout(done, this.deps.gapMs ?? PULL_GAP_MS));
    }
  }

  /** Every node with numbers here or a link now, and how fresh they are. A node gone from the roster keeps its row: its numbers are still on the page. */
  sources(): RemoteSource[] {
    const held = new Map(this.deps.ledger.nodePulls().map((row) => [row.node, row] as const));
    const out: RemoteSource[] = [];
    for (const node of this.deps.nodes()) {
      const row = held.get(node.id);
      held.delete(node.id);
      const why = this.errors.get(node.id) ?? (!node.up ? "away" : !node.answers ? "its kururu is too old to say; update it" : null);
      out.push({ name: node.name, kind: "node", at: row?.at ?? null, error: why });
    }
    for (const row of held.values()) out.push({ name: row.name, kind: "node", at: row.at, error: "no longer a member" });
    return out;
  }
}
