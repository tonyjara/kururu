/**
 * OSC 52: a program putting text on the clipboard of whoever is looking at it.
 *
 * A copy made on another machine has no clipboard of this Mac's to land in.
 * tmux's copy mode on omarchy1 copies into tmux's buffer on omarchy1, and a
 * TUI's own selection into whatever that box has, which over ssh is usually
 * nothing at all. The terminal is the one thing that is on both sides, so the
 * protocol for crossing is a sequence the program writes to it —
 * `ESC ] 52 ; Pc ; <base64> ST` — and the terminal puts the text on its own
 * clipboard. tmux sends one every time it copies, if the terminal outside it
 * looks able (its `set-clipboard` defaults to `external`, and `xterm*` is in
 * its default `terminal-features` with `clipboard`); Claude Code sends one of
 * its own beside `tmux load-buffer -w`; nvim's `osc52` provider sends nothing
 * else.
 *
 * ghostty-web takes the bytes and the WASM parses the sequence, but nothing
 * comes back out: there is no clipboard callback on the bridge, so every copy
 * made on a remote machine was thrown away inside the emulator. It is read off
 * the stream here instead, the way `shared/cursor.ts` reads the cursor, and
 * for the same reason — the one piece of state the emulator will not hand
 * over. The protocol is this file; the policy, which window is allowed to act
 * on one, is at the call site in `terminals.ts`.
 *
 * **Writes only, and never a read.** `Pd = ?` asks the terminal to type the
 * clipboard back up the pty, which would hand the user's clipboard to any
 * program that asked — the one in a remote shell included. Ghostty asks first
 * and xterm refuses by default; kururu has nowhere to ask from, so a query is
 * not answered. An empty payload, which some terminals read as "clear the
 * clipboard", is ignored too: nothing a person did there was a copy.
 *
 * A scanner with state rather than a function with a carry, unlike the cursor
 * next door, and the size is why. A cursor sequence is a few dozen bytes, so
 * carrying the start of one into the next chunk costs nothing. A copy is
 * whatever was selected — a screenful of an agent's reply is tens of
 * kilobytes of base64, arriving across however many reads the pty cut it into
 * — and gluing each chunk onto the carry and scanning the lot again would be
 * quadratic in the size of the copy. So the pieces are held in a list and only
 * the new chunk is ever searched.
 */

/** The introducer. Every byte a pane receives is searched for this and nothing else. */
const INTRO = "\x1b]52;";

/**
 * The most body one sequence may have, in characters of base64 and selector.
 *
 * Eight megabytes is six of text, which is more than anybody selects and less
 * than a stream that never terminates could make a nuisance of. A sequence
 * over it is dropped whole rather than cut: half a copy on the clipboard is
 * worse than the copy before it, because it looks like it worked.
 */
const BODY_MAX = 8 << 20;

/**
 * What may appear between the introducer and the terminator: the selector
 * (`c`, `p`, `q`, `s`, `0`–`7`), its `;`, base64, and the `?` of a query.
 * Anything else means this was not an OSC 52 after all — or that a CAN, an
 * SUB or a stray byte broke it off — and the scan gives it up rather than
 * holding the rest of the stream hostage waiting for a terminator.
 */
const BODY = /^[A-Za-z0-9+/=;?]*$/;

/**
 * The selector names *which* clipboard — the system's, the primary selection,
 * a cut buffer. A Mac has one, so they are all that one; xterm's own default
 * for an empty selector is `s0`, which is the same answer here.
 */
const SELECTOR = /^[cpqs0-7]*$/;

/** The text one finished body asks to be copied, or undefined for a query, an empty write or a bad one. */
function textOf(body: string): string | undefined {
  const semi = body.indexOf(";");
  if (semi < 0) return undefined;
  const selector = body.slice(0, semi);
  const data = body.slice(semi + 1);
  if (!SELECTOR.test(selector) || !data || !/^[A-Za-z0-9+/=]+$/.test(data)) return undefined;
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    // `atob` refuses what is not base64 — a length that cannot be one, say.
    // There is nothing to copy, and nothing worth saying about it.
    return undefined;
  }
}

/**
 * A scanner for one terminal's output: hand it every chunk, in order, and it
 * answers with the text the chunk finished asking to copy — the last, if it
 * finished several, since each replaces the one before on a clipboard.
 */
export function clipboardScanner(): (chunk: string) => string | undefined {
  /** The body so far, when a sequence has begun and not ended; null when none has. */
  let parts: string[] | null = null;
  let size = 0;
  /**
   * Bytes held back from the end of the last chunk: the front of an
   * introducer, outside a sequence, or the ESC that may be the front of its
   * ST, inside one. A handful of characters at most, so gluing them onto the
   * next chunk is free.
   */
  let held = "";

  return (chunk) => {
    const data = held ? held + chunk : chunk;
    held = "";
    let text: string | undefined;
    let i = 0;
    while (i < data.length) {
      if (parts === null) {
        const at = data.indexOf(INTRO, i);
        if (at < 0) {
          // The end of the chunk may be the start of the next sequence. Only
          // ever a strict prefix: a whole introducer was found above.
          for (let n = INTRO.length - 1; n > 0; n--) {
            if (data.endsWith(INTRO.slice(0, n))) {
              held = INTRO.slice(0, n);
              break;
            }
          }
          break;
        }
        parts = [];
        size = 0;
        i = at + INTRO.length;
        continue;
      }

      // Inside a body: find where it stops, which is BEL, or ESC — the front
      // of ST, or of something else that ends it.
      const bel = data.indexOf("\x07", i);
      const esc = data.indexOf("\x1b", i);
      const end = bel < 0 ? esc : esc < 0 ? bel : Math.min(bel, esc);
      const piece = data.slice(i, end < 0 ? data.length : end);
      size += piece.length;
      if (!BODY.test(piece) || size > BODY_MAX) {
        // Not a body after all, or not one worth holding. Scan on from here
        // for the next introducer: what follows is ordinary output.
        parts = null;
        continue;
      }
      parts.push(piece);
      if (end < 0) break;

      if (data[end] === "\x07") {
        text = textOf(parts.join("")) ?? text;
        parts = null;
        i = end + 1;
      } else if (end + 1 >= data.length) {
        // An ESC at the very end, which the next chunk will say is ST or not.
        held = "\x1b";
        break;
      } else if (data[end + 1] === "\\") {
        text = textOf(parts.join("")) ?? text;
        parts = null;
        i = end + 2;
      } else {
        // ESC and anything else is another sequence starting, and this one
        // never finished. It is abandoned, and the ESC scanned again as the
        // possible start of the next.
        parts = null;
        i = end;
      }
    }
    return text;
  };
}
