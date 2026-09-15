/**
 * A rolling record of what actually reached a terminal, for the bugs you cannot
 * reproduce on purpose.
 *
 * Some things go wrong in a terminal only occasionally, and by the time anybody
 * notices, the evidence is gone: the pty has moved on, the emulator holds the
 * *result* rather than the sequence that produced it, and a screenshot shows
 * what was drawn rather than what was said. `screen.ts` deliberately cannot
 * answer this — it reconstructs state, which is the right thing for replaying
 * history and useless for explaining how that state came about.
 *
 * So this keeps the last little while of the raw stream, interleaved with the
 * things kururu itself did: resizes, watches, the backlog it sent. That
 * interleaving is the whole point. Nearly every terminal bug worth chasing is a
 * disagreement about *ordering* — a repaint that arrived before a resize, a
 * backlog that overtook live output — and a recording of the bytes alone cannot
 * show it.
 *
 * On by default, because a facility you have to arm before the bug happens is
 * one that is always off the time it matters. It costs a push and a subtraction
 * per chunk, against an emulator that is already parsing every one of those
 * bytes; `KURURU_RECORD=0` turns it off, and a server restart forgets it.
 *
 * It records what the *server* sees, which is only terminals somebody has open:
 * unwatched ptys are never streamed across the link (that is deliberate, and
 * `index.ts` says why). So a terminal records while a pane is showing it and not
 * otherwise — which is the right half for anything you noticed happening, and no
 * use at all for something that went wrong in a pane you had closed.
 *
 * This buffer is for **reading**, never for replaying. It is trimmed by budget
 * and therefore starts mid-escape-sequence, which is exactly the failure mode
 * `screen.ts` exists to avoid. Nothing may ever write it back to a terminal.
 */

/** Per agent. Enough to hold a repaint and whatever led up to it. */
const BUDGET = 128 * 1024;

const ON = process.env.KURURU_RECORD !== "0";

/**
 * `dev` and `sign-in` are kururu typing into a terminal on its own account — the
 * workspace row's ▸ and ↻, and the button that starts a login for a profile.
 * Each is a note beside the `in` that carries the bytes rather than a kind of
 * its own for them, because a tape read after the fact cannot otherwise tell a
 * line somebody typed from one a button did. Two names rather than one because
 * the tape is read when something went wrong and *which* button did it is the
 * first thing you want to know.
 */
type Kind = "out" | "in" | "resize" | "watch" | "backlog" | "replayed" | "dev" | "sign-in";

interface Entry {
  at: number;
  kind: Kind;
  data: string;
}

const tapes = new Map<string, { entries: Entry[]; bytes: number }>();

function push(agentId: string, kind: Kind, data: string): void {
  if (!ON) return;
  let tape = tapes.get(agentId);
  if (!tape) tapes.set(agentId, (tape = { entries: [], bytes: 0 }));
  tape.entries.push({ at: Date.now(), kind, data });
  tape.bytes += data.length;
  // Oldest first, which is also the order they are least interesting in.
  while (tape.bytes > BUDGET && tape.entries.length > 1) {
    tape.bytes -= tape.entries.shift()!.data.length;
  }
}

/** Bytes the pty produced. */
export function recordOutput(agentId: string, data: string): void {
  push(agentId, "out", data);
}

/** Bytes somebody typed. Included because a repaint is usually an answer to one. */
export function recordInput(agentId: string, data: string): void {
  push(agentId, "in", data);
}

/**
 * The backlog itself, as it went out.
 *
 * Recorded in full because a screen that came back wrong can only be explained
 * by the bytes that rebuilt it — the note saying how many there were tells you
 * an emulator was replaced and nothing about what it was replaced with.
 */
export function recordBacklog(agentId: string, data: string): void {
  push(agentId, "replayed", data);
}

/** Something kururu did to this terminal, in the same timeline as the bytes. */
export function recordNote(agentId: string, kind: Exclude<Kind, "out" | "in" | "replayed">, what: string): void {
  push(agentId, kind, what);
}

export function forget(agentId: string): void {
  tapes.delete(agentId);
}

/**
 * The tape, rendered for a human.
 *
 * Control characters are spelled out rather than emitted, because the one thing
 * this must never do is be a terminal escape sequence itself: it is read in a
 * terminal, and a dump that repainted the screen it was printed on would be a
 * practical joke rather than a diagnostic.
 */
export function dump(agentId: string, tail?: number): string {
  const tape = tapes.get(agentId);
  if (!tape) return ON ? `no recording for ${agentId}\n` : "recording is off (KURURU_RECORD=0)\n";

  // A full tape is a hundred kilobytes of escape sequences. That is the right
  // thing to have and the wrong thing to print by accident, so the caller can
  // ask for the end of it — which is where a bug that has just happened is.
  const entries =
    tail && tail > 0 && tail < tape.entries.length ? tape.entries.slice(-tail) : tape.entries;

  const started = entries[0]?.at ?? Date.now();
  const lines = [
    `# ${agentId}: ${entries.length} of ${tape.entries.length} entries, ${tape.bytes} bytes held`,
    "",
  ];
  for (const entry of entries) {
    const ms = String(entry.at - started).padStart(7);
    lines.push(
      entry.kind === "out" || entry.kind === "in" || entry.kind === "replayed"
        ? `${ms}ms ${entry.kind === "out" ? "<<" : entry.kind === "in" ? ">>" : "=="} ${visible(entry.data)}`
        : `${ms}ms -- ${entry.kind}: ${entry.data}`,
    );
  }
  return lines.join("\n") + "\n";
}

/** `\x1b[?1049h` rather than an actual escape. Everything else stays readable. */
function visible(data: string): string {
  return data.replace(/[\x00-\x1f\x7f]/g, (ch) => {
    if (ch === "\x1b") return "\\e";
    if (ch === "\r") return "\\r";
    if (ch === "\n") return "\\n";
    if (ch === "\t") return "\\t";
    return `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}
