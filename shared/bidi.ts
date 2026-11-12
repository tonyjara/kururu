/**
 * The Unicode bidirectional controls, and words with them taken out.
 *
 * They exist because typing them into a Claude Code prompt loses the Enter
 * after them. A line with one U+200E anywhere in it goes into the prompt box
 * and stays there; the `\r` kururu types after it does nothing, and so does
 * the next one. Found on 2026-11-12, when a voice message with two screen
 * marks on WhatsApp — whose window title begins with U+200E, and a mark's
 * label quotes the title — was typed into Kuru's terminal six times over
 * two servers and a Resend and taken once, as one prompt holding all six,
 * when an Enter finally landed. Everything typed after it joined the pile,
 * which looked like the floating chat not sending. Tried against Claude Code
 * 2.1.322 in a pty, with a prompt hook that blocked every submit: U+200E,
 * U+202E and U+2066 each kept "hello …WhatsApp test" from going; U+200B,
 * U+200D, U+FEFF and U+00AD did not. So the whole bidi set goes — the marks
 * (U+200E, U+200F, U+061C), the embeddings and overrides (U+202A–U+202E) and
 * the isolates (U+2066–U+2069) — and nothing else: a zero-width joiner is
 * half an emoji, and the others did no harm.
 *
 * Taken out rather than escaped. What they do is reorder how text is drawn,
 * which is nothing to a model reading a prompt, and they are also the
 * Trojan Source trick — text that reads one way and says another — in a
 * window title somebody else wrote.
 */

export const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

/** The words without any bidi control in them; the same string when there is none. */
export function withoutBidi(text: string): string {
  return text.replace(BIDI_CONTROLS, "");
}
