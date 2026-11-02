/**
 * Part of a card quoted to Kuru, with a comment on it: select words in a
 * card or a note, and a popover by the selection takes a comment and puts
 * both into Kuru's box — as a review's comments go on the lines they are
 * about, and several of them make up one message.
 *
 * **One popover for the whole page, not one per card.** The words that can
 * be quoted are marked where they are drawn — `quotable` on a card's title
 * and body, a note's body — with the card's own reference, the words its
 * menu's "Reference in Kuru" writes; this listens to the document's
 * selection and opens over a selection that lies inside one of them. A
 * card memoised on its board (`CardView`) then draws nothing new for a
 * selection, and a board, a note and the profile's board all get it from
 * the one mounting. A selection across two cards, or across a card's title
 * and its body, is in neither and opens nothing.
 *
 * **It never takes the keyboard by itself.** The selection is still the
 * page's while the popover is up: ⌘C copies it, a drag extends it, and the
 * field is clicked into only by somebody who means to comment. What was
 * selected is read when the popover opens, so focusing the field — which
 * moves the document's selection into it — loses nothing. Escape closes
 * it, Enter in the field puts the quote in, and a press anywhere else
 * closes it on the way to whatever the press was for, which is what makes
 * a fresh selection elsewhere the next popover rather than this one moved.
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

/** The attributes that make an element's words quotable as `part` of the card `cardRef` is the reference of. */
export function quotable(cardRef: string, part: QuotePart): { "data-quote-ref": string; "data-quote-part": QuotePart } {
  return { "data-quote-ref": cardRef, "data-quote-part": part };
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
  cardRef: string;
  part: QuotePart;
  text: string;
  /** The selection as it was, kept to place the popover by as the page scrolls under it. */
  range: Range;
}

/** A selection on a touch screen or by the keyboard settles on its own time; this long after its last change it is read. */
const SETTLE_MS = 300;
/** How far the popover keeps from the selection and from the window's edges, in CSS pixels as `getBoundingClientRect` gives them. */
const POP_GAP = 8;

/** The selection, when it is some words inside one quotable element. */
function readSelection(): Selected | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const host = (common instanceof Element ? common : common.parentElement)?.closest<HTMLElement>("[data-quote-ref]");
  const cardRef = host?.dataset.quoteRef;
  const part = host?.dataset.quotePart;
  if (!cardRef || (part !== "body" && part !== "title")) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  return { cardRef, part, text, range: range.cloneRange() };
}

export function QuoteToKuru({ onQuote }: { onQuote: (cardRef: string, quote: CardQuote) => void }) {
  const [at, setAt] = useState<Selected | null>(null);
  const [comment, setComment] = useState("");
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const open = useRef(false);
  open.current = at !== null;
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
    setAt(null);
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
      if (down || open.current) return;
      const found = readSelection();
      if (found) setAt(found);
    };
    const onDown = (event: PointerEvent) => {
      down = true;
      if (open.current && !(event.target instanceof Node && box.current?.contains(event.target))) closeRef.current();
    };
    // After the press's own work is done — a click that collapses the
    // selection has collapsed it by then.
    const onUp = () => {
      down = false;
      window.clearTimeout(settle);
      settle = window.setTimeout(check, 0);
    };
    const onChange = () => {
      if (down || open.current) return;
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
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
      document.removeEventListener("selectionchange", onChange);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  // Under the selection, or over it when there is no room under; inside the
  // window either way, and following the words as whatever they are in
  // scrolls. A selection whose words have gone keeps the last place.
  useLayoutEffect(() => {
    if (!at) return;
    const fit = () => {
      const pop = box.current;
      const rect = at.range.getBoundingClientRect();
      if (!pop || (rect.width === 0 && rect.height === 0)) return;
      const { width, height } = pop.getBoundingClientRect();
      const left = Math.max(POP_GAP, Math.min(rect.left, window.innerWidth - width - POP_GAP));
      const under = rect.bottom + POP_GAP;
      const top = under + height <= window.innerHeight - POP_GAP ? under : Math.max(POP_GAP, rect.top - height - POP_GAP);
      setPlace({ left, top });
    };
    fit();
    window.addEventListener("scroll", fit, true);
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("scroll", fit, true);
      window.removeEventListener("resize", fit);
    };
  }, [at]);

  if (!at) return null;
  const go = () => {
    onQuote(at.cardRef, { part: at.part, text: at.text, comment });
    window.getSelection()?.removeAllRanges();
    close();
  };
  return createPortal(
    <div
      ref={box}
      className="quote-pop"
      role="dialog"
      aria-label="Quote to Kuru"
      style={place ? { left: place.left, top: place.top } : { visibility: "hidden" }}
    >
      <p className="quote-pop-quote">{at.text.replace(/\s+/g, " ").trim()}</p>
      <div className="quote-pop-row">
        <input
          className="quote-pop-field"
          value={comment}
          placeholder="Your comment on this part"
          aria-label="Your comment on this part"
          onFocus={(event) => {
            const from = event.relatedTarget;
            if (from instanceof Element && !box.current?.contains(from)) before.current = from;
          }}
          onChange={(event) => setComment(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              go();
            }
          }}
        />
        <button type="button" className="quote-pop-go" onClick={go} title="Put this part and your comment into Kuru's box">
          Quote to Kuru
        </button>
      </div>
    </div>,
    document.body,
  );
}
