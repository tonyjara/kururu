/**
 * The disk half of what an agent made: a reply's paths found on this Mac, and
 * the one or two each agent's row carries, kept where a server restart does
 * not lose them.
 *
 * The rule is `shared/made.ts`'s; what is here is everything it cannot be
 * pure about. A path in a reply is the agent's words, so it is resolved the
 * way every path from outside is (`files.ts`): from the agent's directory,
 * realpath'd, and kept only inside a root the server already allows — an
 * agent naming `~/.ssh/id_ed25519` in a reply is naming a file, not
 * granting a window the right to open it. Then it is `stat`ed, which is the
 * other half of the rule: whether the turn changed it.
 *
 * Kept per agent rather than on the snapshot's other server-side fields'
 * terms (`activity`, `rss`), which a restart empties and the next report
 * fills. The next report here is the next *turn*, and an agent that finished
 * its research an hour ago and is sitting at its prompt has no next turn
 * coming — while the server restarts every time somebody saves a file in
 * `server/src`. So the lists go to `made.json` beside `session.json`, and
 * each is keyed by the terminal's id *and* its spawn time: ids are handed out
 * again after a host restart, and a new terminal must not wear the last
 * one's links. A card's agent writes the same list onto the card as well
 * (`Workspaces.setMade`), which is how a link outlives the agent.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { adoptMade, isBinary, mentionsIn, nextMade, sameMade, withPinned, type Located, type MadeFile, type Mention } from "../../shared/made";
import { locate } from "./files";

/** Past this a file is not something to open from a sidebar — `files.ts`'s own limit for reading one. */
const MAX_BYTES = 2 * 1024 * 1024;

/** How long a burst of changes waits before the file is written once for all of them. */
const WRITE_DELAY_MS = 500;

/** One agent's links, and enough to know the terminal they belong to and when its last turn ended. */
interface Entry {
  createdAt: number;
  /** When its last turn ended: the floor for "changed this turn" when the turn's start was not seen. */
  at: number;
  files: MadeFile[];
}

/**
 * A mention as a file under an allowed root, or null.
 *
 * `~/` is the home directory and an absolute path is itself; anything else is
 * tried against each base in turn — the agent's directory, or for Kuru every
 * project of the profile — and where more than one has it, the one most
 * recently written wins, since a reply names what was just made. Never a
 * directory, never something too big to open, never a binary.
 */
function locateOne(mention: Mention, bases: readonly string[], since: number): Located | null {
  if (isBinary(mention.path)) return null;
  const tries = mention.path.startsWith("~/")
    ? [join(homedir(), mention.path.slice(2))]
    : isAbsolute(mention.path)
      ? [mention.path]
      : bases.map((base) => resolve(base, mention.path));
  let best: { found: Located; mtime: number } | null = null;
  for (const candidate of tries) {
    const where = locate(candidate);
    if (!where) continue;
    let mtime: number;
    try {
      const stat = statSync(where.full);
      if (!stat.isFile() || stat.size > MAX_BYTES) continue;
      mtime = stat.mtimeMs;
    } catch {
      continue;
    }
    if (best && best.mtime >= mtime) continue;
    best = { found: { mention, file: { root: where.root, path: where.path, line: mention.line }, changed: mtime >= since }, mtime };
  }
  return best?.found ?? null;
}

/** Every mention that is a file kururu may open, in the reply's order. */
export function locateMentions(mentions: readonly Mention[], bases: readonly string[], since: number): Located[] {
  const found: Located[] = [];
  for (const mention of mentions) {
    const one = locateOne(mention, bases, since);
    if (one) found.push(one);
  }
  return found;
}

/**
 * Whether a link still goes somewhere — a file, where it was. A plain `stat`
 * and not `resolveInRoot`, on purpose: roots are relearnt over the first few
 * seconds after a restart (a terminal's directory at once, a project's on the
 * branch walk, a dev server's on its scan), and a root not allowed *yet* is
 * not a file that has gone. Opening one still goes through the root check.
 */
export function stillThere(file: MadeFile): boolean {
  try {
    return statSync(join(file.root, file.path)).isFile();
  } catch {
    return false;
  }
}

/** The terminal a list belongs to, as the host lists it. */
export interface MadeAgent {
  id: string;
  createdAt: number;
  cwd: string;
}

export class MadeFiles {
  private readonly agents = new Map<string, Entry>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly path: string) {}

  /** Where it lives by default: beside `session.json`, under the same override. */
  static defaultPath(statePath: string): string {
    return join(dirname(statePath), "made.json");
  }

  /** Read what the last server left. Anything unreadable is nothing, and the next turn writes it again. */
  load(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return;
    }
    const agents = (raw as { agents?: unknown } | null)?.agents;
    if (!agents || typeof agents !== "object") return;
    for (const [id, value] of Object.entries(agents as Record<string, unknown>)) {
      const entry = (value ?? {}) as Record<string, unknown>;
      if (!Number.isFinite(entry.createdAt) || !Number.isFinite(entry.at)) continue;
      this.agents.set(id, { createdAt: entry.createdAt as number, at: entry.at as number, files: adoptMade(entry.files) });
    }
  }

  /** The links an agent's row carries now. */
  of(agentId: string): MadeFile[] {
    return this.agents.get(agentId)?.files ?? [];
  }

  /** When its last turn ended, if one has been seen. */
  lastTurn(agentId: string): number | undefined {
    return this.agents.get(agentId)?.at;
  }

  /**
   * A turn ended with this reply. `since` is when it began, as near as the
   * server knows. Returns whether the row's links moved.
   */
  turnEnded(agent: MadeAgent, reply: string, since: number): boolean {
    const found = locateMentions(mentionsIn(reply), [agent.cwd], since);
    const had = this.agents.get(agent.id);
    const previous = had && had.createdAt === agent.createdAt ? had.files : [];
    const files = nextMade(previous, found);
    this.agents.set(agent.id, { createdAt: agent.createdAt, at: Date.now(), files });
    this.save();
    return !sameMade(previous, files);
  }

  /** A file put on the row on purpose — Kuru's `show_file`. */
  pin(agent: Pick<MadeAgent, "id" | "createdAt">, file: MadeFile): MadeFile[] {
    const had = this.agents.get(agent.id);
    const previous = had && had.createdAt === agent.createdAt ? had.files : [];
    const files = withPinned(previous, file);
    this.agents.set(agent.id, { createdAt: agent.createdAt, at: had?.at ?? Date.now(), files });
    this.save();
    return files;
  }

  /**
   * Drop what no longer goes anywhere: lists of terminals that have gone, or
   * whose id now names a different terminal, and links whose file has been
   * deleted or moved. Returns whether any row changed.
   */
  sweep(live: readonly Pick<MadeAgent, "id" | "createdAt">[]): boolean {
    const born = new Map(live.map((agent) => [agent.id, agent.createdAt] as const));
    let changed = false;
    for (const [id, entry] of this.agents) {
      if (born.get(id) !== entry.createdAt) {
        this.agents.delete(id);
        changed ||= entry.files.length > 0;
        continue;
      }
      const files = entry.files.filter(stillThere);
      if (files.length !== entry.files.length) {
        this.agents.set(id, { ...entry, files });
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  forget(agentId: string): void {
    if (this.agents.delete(agentId)) this.save();
  }

  /** Write now rather than in a moment. For tests, and for a server on its way out. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const agents: Record<string, Entry> = {};
    for (const [id, entry] of this.agents) agents[id] = entry;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ version: 1, agents }, null, 2)}\n`, "utf8");
      renameSync(temp, this.path);
    } catch (err) {
      console.error(`kururu: could not write ${this.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS);
    this.timer.unref?.();
  }
}
