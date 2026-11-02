/**
 * Part of a card, or of one of Kuru's messages, quoted to Kuru with a
 * comment on it: select words, press the quote mark that comes up by them,
 * and write what you have to say about that part — the reference, the quote
 * and the comment go into Kuru's box as a line, as a review's comments go on
 * the lines they are about, and several of them make up one message.
 *
 * **One popover for the whole page, not one per card.** The words that can
 * be quoted are marked where they are drawn — `quotable` on a card's title
 * and body, a note's body, a reply of Kuru's and a notice's message — with
 * the reference to write in front of the quote: the card's own, the words
 * its menu's "Reference in Kuru" writes, or the message's, the words its
 * reply arrow writes. This listens to the document's selection and opens
 * over a selection that lies inside one of them. A card memoised on its
 * board (`CardView`) then draws nothing new for a selection, and a board, a
 * note, the profile's board and the drawer all get it from the one mounting.
 * A selection across two cards, or across a card's title and its body, is
 * in neither and opens nothing.
 *
 * **A mark first, and the field only when it is pressed.** A selection is
 * mostly made to read or to copy, so what comes up is one small button by
 * its end, which is in the way of nothing; the field comes when it is
 * pressed, which is the one moment somebody has said they mean to comment.
 * The selected words are not drawn again in it: they are on the screen
 * where they were chosen, and stay marked there (a CSS highlight, since the
 * field taking the keyboard takes the document's selection with it) while
 * the comment is written. Until then the mark follows the selection as it
 * is pulled about — a phone's handles move it without a press the page sees.
 *
 * **It never takes the keyboard by itself.** ⌘C copies while the mark is up,
 * a drag extends the selection, and only the press on the mark puts the
 * keys in the field. What was selected is read before that press lands, so
 * the field taking the selection loses nothing. Escape closes it, Enter in
 * the field puts the quote in, and a press anywhere else closes it on the way
 * to whatever the press was for, which is what makes a fresh selection
 * elsewhere the next mark rather than this one moved.
 *
 * **A board card selects only while it is open.** A card is `draggable`,
 * and a press on a draggable is the start of a drag, never of a selection
 * — so a closed card stays the thing you drag, and an open one, which is
 * being read, lets a press on its words select them (`selectNotDrag`):
 * it is not draggable for the length of that press only. A click opens
 * any card, a short one too (`useCardOpen`), so every card can be quoted
 * from.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CardQuote, QuotePart } from "../../../shared/kuru";

/**
 * What a quote is of: a card — its title or its body, wherever it is drawn —
 * or a message in Kuru's drawer. Only where it lands differs: a card's quote
 * puts the board and the sheet away to show the box, and a message's is in
 * the drawer already.
 */
export type QuoteFrom = "card" | "message";

interface Marks {
  "data-quote-ref": string;
  "data-quote-part": QuotePart;
  "data-quote-from"?: "message";
}

/**
 * The attributes that make an element's words quotable as `part` of what
 * `reference` refers to: a card's reference (`cardReference`), or a
 * message's (`replyReference`) with `from` "message".
 */
export function quotable(reference: string, part: QuotePart, from: QuoteFrom = "card"): Marks {
  return from === "message"
    ? { "data-quote-ref": reference, "data-quote-part": part, "data-quote-from": "message" }
    : { "data-quote-ref": reference, "data-quote-part": part };
}

/**
 * For a draggable card's `onPointerDown`: a press on its quotable words
 * selects them rather than dragging the card, by taking `draggable` away
 * until the press ends. Set on the element itself and not through React,
 * whose prop is still true and so is never written back over this; the
 * press's end puts it back. The browser decides between a drag and a
 * selection after `pointerdown` has run, which is why this is in time.
 */
export function selectNotDrag(event: React.PointerEvent<HTMLElement>): void {
  if (event.button !== 0 || !(event.target instanceof Element) || !event.target.closest("[data-quote-ref]")) return;
  const card = event.currentTarget;
  card.draggable = false;
  const back = () => {
    card.draggable = true;
    window.removeEventListener("pointerup", back, true);
    window.removeEventListener("pointercancel", back, true);
  };
  window.addEventListener("pointerup", back, true);
  window.addEventListener("pointercancel", back, true);
}

/**
 * Whether a popover is up on this page, for the window's own key handler:
 * whichever of the two hears Escape first, it is the popover's. Module
 * state, as the drawer's is, because there is one popover for the page.
 */
let up = false;
export function quoteUp(): boolean {
  return up;
}

interface Selected {
  reference: string;
  part: QuotePart;
  from: QuoteFrom;
  text: string;
  /** The selection as it was, kept to place the popover by as the page scrolls under it, and to mark while the field has the keys. */
  range: Range;
}

/** A selection on a touch screen or by the keyboard settles on its own time; this long after its last change it is read. */
const SETTLE_MS = 300;
/** How far the popover keeps from the selection and from the window's edges, in CSS pixels as `getBoundingClientRect` gives them. */
const POP_GAP = 6;
/** The name the selection is marked under while the field has the keys — `::highlight(kururu-quote)` in `styles.css`. */
const MARK = "kururu-quote";
/** How far into the open field its quote mark's middle is: its padding and half the glyph, as `.quote-pop-write` draws them. */
const MARK_INSET = 16;

/** The selection, when it is some words inside one quotable element. */
function readSelection(): Selected | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const host = (common instanceof Element ? common : common.parentElement)?.closest<HTMLElement>("[data-quote-ref]");
  const reference = host?.dataset.quoteRef;
  const part = host?.dataset.quotePart;
  if (!reference || (part !== "body" && part !== "title")) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  return { reference, part, from: host?.dataset.quoteFrom === "message" ? "message" : "card", text, range: range.cloneRange() };
}

/**
 * The selection marked on the page while it is not the page's selection any
 * more. Where `CSS.highlights` is missing — an older WebKit — the words are
 * only unmarked, which loses nothing that is sent.
 */
function markRange(range: Range | null): void {
  const highlights = typeof CSS !== "undefined" ? CSS.highlights : undefined;
  if (!highlights || typeof Highlight === "undefined") return;
  if (range) highlights.set(MARK, new Highlight(range));
  else highlights.delete(MARK);
}

/** The rectangle the mark sits by: the selection's last line, where reading it ended. */
function endOf(range: Range): DOMRect | null {
  const rects = range.getClientRects();
  const last = rects.length > 0 ? rects[rects.length - 1]! : range.getBoundingClientRect();
  return last.width === 0 && last.height === 0 ? null : last;
}

export function QuoteToKuru({ onQuote }: { onQuote: (reference: string, quote: CardQuote, from: QuoteFrom) => void }) {
  const [at, setAt] = useState<Selected | null>(null);
  /** The mark was pressed: the field is up, and the selection is the one read then. */
  const [writing, setWriting] = useState(false);
  const [comment, setComment] = useState("");
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const open = useRef(false);
  open.current = at !== null;
  const writingNow = useRef(false);
  writingNow.current = writing;
  useEffect(() => {
    up = at !== null;
    return () => {
      up = false;
    };
  }, [at]);
  /** Where the keyboard was before the field took it, to give it back to on Escape. */
  const before = useRef<Element | null>(null);

  const close = () => {
    before.current = null;
    markRange(null);
    setAt(null);
    setWriting(false);
    setComment("");
    setPlace(null);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    let down = false;
    let settle = 0;
    const check = () => {
      window.clearTimeout(settle);
      if (down || writingNow.current) return;
      const found = readSelection();
      // The mark follows a selection pulled about, and goes with one let go.
      if (found) setAt(found);
      else if (open.current) closeRef.current();
    };
    const onDown = (event: PointerEvent) => {
      const inside = event.target instanceof Node && box.current?.contains(event.target);
      if (inside) return;
      down = true;
      if (open.current) closeRef.current();
    };
    // After the press's own work is done — a click that collapses the
    // selection has collapsed it by then.
    const onUp = () => {
      if (!down) return;
      down = false;
      window.clearTimeout(settle);
      settle = window.setTimeout(check, 0);
    };
    const onChange = () => {
      if (down || writingNow.current) return;
      window.clearTimeout(settle);
      settle = window.setTimeout(check, SETTLE_MS);
    };
    // On the window, in the capture phase: the window's own key handler is
    // there too, and steps aside for this one (`quoteUp`) whichever order the
    // two were installed in, since its Escape would close the sheet or the
    // drawer under a popover the user only meant to leave.
    const onKey = (event: KeyboardEvent) => {
      if (!open.current || event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const back = before.current;
      closeRef.current();
      if (back instanceof HTMLElement && back.isConnected && box.current?.contains(document.activeElement)) back.focus();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onUp, true);
    document.addEventListener("selectionchange", onChange);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(settle);
      markRange(null);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
      document.removeEventListener("selectionchange", onChange);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  // The mark just under the end of the selection, or over its start when
  // there is no room under; the field from the same corner, kept inside the
  // window. Either follows the words as whatever they are in scrolls, and a
  // selection whose words have gone keeps the last place.
  //
  // Where the words were last seen is kept, so a field opened after they went
  // — a phone's sheet giving way under it — is still placed inside the window.
  const seen = useRef<{ end: DOMRect; all: DOMRect } | null>(null);
  useLayoutEffect(() => {
    if (!at) return;
    const fit = () => {
      const pop = box.current;
      const found = endOf(at.range);
      if (found) seen.current = { end: found, all: at.range.getBoundingClientRect() };
      if (!pop || !seen.current) return;
      const { end, all } = seen.current;
      const { width, height } = pop.getBoundingClientRect();
      // The field opens from where the mark was, its own mark in the same place.
      const left = Math.max(POP_GAP, Math.min(end.right - (writing ? MARK_INSET : width / 2), window.innerWidth - width - POP_GAP));
      const under = end.bottom + POP_GAP;
      const top = under + height <= window.innerHeight - POP_GAP ? under : Math.max(POP_GAP, all.top - height - POP_GAP);
      setPlace((was) => (was && was.left === left && was.top === top ? was : { left, top }));
    };
    fit();
    window.addEventListener("scroll", fit, true);
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("scroll", fit, true);
      window.removeEventListener("resize", fit);
    };
  }, [at, writing]);

  if (!at) return null;
  const go = () => {
    onQuote(at.reference, { part: at.part, text: at.text, comment }, at.from);
    window.getSelection()?.removeAllRanges();
    close();
  };
  const style = place ? { left: place.left, top: place.top } : { visibility: "hidden" as const };
  if (!writing) {
    return createPortal(
      <div ref={box} className="quote-pop quote-pop-mark" style={style}>
        <button
          type="button"
          className="quote-pop-btn"
          title="Quote this to Kuru, with a comment"
          aria-label="Quote this to Kuru, with a comment"
          // The selection stays the page's until the press is over: a button
          // that took the focus on the way down would have collapsed it.
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const now = readSelection() ?? at;
            before.current = document.activeElement;
            markRange(now.range);
            setAt(now);
            setWriting(true);
          }}
        >
          <QuoteMark />
        </button>
      </div>,
      document.body,
    );
  }
  return createPortal(
    <div ref={box} className="quote-pop quote-pop-write" role="dialog" aria-label="Quote to Kuru" style={style}>
      <QuoteMark />
      <input
        className="quote-pop-field"
        autoFocus
        value={comment}
        placeholder="Your comment on this part"
        aria-label="Your comment on this part"
        enterKeyHint="done"
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            go();
          }
        }}
      />
      <button
        type="button"
        className="quote-pop-go"
        onMouseDown={(event) => event.preventDefault()}
        onClick={go}
        title="Put this part and your comment into Kuru's box (Enter)"
        aria-label="Quote to Kuru"
      >
        <GoMark />
      </button>
    </div>,
    document.body,
  );
}

/**
 * A quotation mark, drawn rather than typed, since a font's `“` is a
 * different weight and height in every skin's face. Inline as the drawer's
 * reply arrow is, in the text's own colour.
 */
function QuoteMark() {
  return (
    <svg className="quote-pop-glyph" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M4 17.5c0-4.6 2.2-8.4 6-10.5l1 1.6C8.7 10 7.6 11.8 7.4 13.6H10V19H4v-1.5Zm10 0c0-4.6 2.2-8.4 6-10.5l1 1.6c-2.3 1.4-3.4 3.2-3.6 5H20V19h-6v-1.5Z" />
    </svg>
  );
}

/** The arrow that puts it in: into the box, not sent, so an arrow in rather than a paper plane away. */
function GoMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}
