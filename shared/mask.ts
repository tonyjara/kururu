/**
 * A command's output with the vault's values taken out, as it streams.
 *
 * `vault run` hands a command its secrets in the environment and sends what
 * it prints back to an agent, whose model reads every byte. A test that
 * prints its config, a `set -x`, an error that quotes a request — each would
 * put the key into a transcript. So every value is replaced by
 * `[vault:<name>]` before a byte leaves, and so are the two shapes a value
 * most often comes back in: its base64 (an `Authorization: Basic` header)
 * and its URL-encoding (a query string).
 *
 * It works on bytes, held as `latin1` strings so one character is one byte
 * and a value split by a multi-byte character still matches. Output comes
 * in chunks, and a value can straddle two, so the end of each chunk that
 * could still be the start of a value is held back until the next one or
 * the end — and only that much: a tail that cannot begin a value goes at once.
 *
 * What it cannot do is stated in `docs/vault.md`: a value the command
 * transforms first — reversed, split, hashed, encrypted — goes through. This
 * catches accidents, not intent.
 *
 * Pure, so the edges — a value split at every byte, overlapping values, a
 * value inside its own replacement — are tested without a process.
 */

export interface Secret {
  name: string;
  value: string;
}

/** Values shorter than this are not masked: a one-letter password would turn every "a" in the output into a marker. They are still never printed by kururu, and the docs say so. */
export const MASK_MIN = 4;

const latin = (text: string) => Buffer.from(text, "utf8").toString("latin1");

/** Every byte pattern to replace, longest first so a value inside another's base64 is not cut in two. */
export function patternsOf(secrets: readonly Secret[]): { pattern: string; mark: string }[] {
  const out = new Map<string, string>();
  for (const { name, value } of secrets) {
    if (value.length < MASK_MIN) continue;
    const mark = `[vault:${name}]`;
    for (const form of [value, Buffer.from(value, "utf8").toString("base64"), encodeURIComponent(value)]) {
      const pattern = latin(form);
      if (pattern.length >= MASK_MIN && !out.has(pattern)) out.set(pattern, mark);
    }
  }
  return [...out].map(([pattern, mark]) => ({ pattern, mark })).sort((a, b) => b.pattern.length - a.pattern.length);
}

export class Masker {
  private readonly patterns: { pattern: string; mark: string }[];
  private readonly hold: number;
  private tail = "";

  constructor(secrets: readonly Secret[]) {
    this.patterns = patternsOf(secrets);
    this.hold = Math.max(0, ...this.patterns.map((p) => p.pattern.length - 1));
  }

  private replace(text: string): string {
    let out = text;
    for (const { pattern, mark } of this.patterns) out = out.split(pattern).join(latin(mark));
    return out;
  }

  /** The bytes that are safe to send now. */
  push(chunk: Uint8Array): Buffer {
    if (!this.patterns.length) return Buffer.from(chunk);
    const text = this.tail + Buffer.from(chunk).toString("latin1");
    // Replace over everything, then keep back what could still begin a value
    // — but never part of a marker that was just written, which cannot.
    const replaced = this.replace(text);
    // Only as much as is the start of some value: a line that cannot be one
    // goes now, so a prompt or a progress line is not kept waiting.
    let keep = 0;
    for (let k = Math.min(this.hold, replaced.length); k > 0; k -= 1) {
      const end = replaced.slice(-k);
      if (this.patterns.some((p) => p.pattern.startsWith(end))) {
        keep = k;
        break;
      }
    }
    let cut = replaced.length - keep;
    for (const { mark } of this.patterns) {
      const m = latin(mark);
      const at = replaced.lastIndexOf(m);
      if (at >= 0) cut = Math.max(cut, at + m.length);
    }
    this.tail = replaced.slice(cut);
    return Buffer.from(replaced.slice(0, cut), "latin1");
  }

  /** What was held back, at the end of the stream. */
  end(): Buffer {
    const rest = this.replace(this.tail);
    this.tail = "";
    return Buffer.from(rest, "latin1");
  }
}

/** A whole text masked at once: for a line the server writes about a run, which is never a value but might be by accident. */
export function maskText(text: string, secrets: readonly Secret[]): string {
  const m = new Masker(secrets);
  return Buffer.concat([m.push(Buffer.from(text, "utf8")), m.end()]).toString("utf8");
}
