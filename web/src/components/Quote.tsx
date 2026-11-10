/**
 * Part of a card, of one of Kuru's messages or of a markdown file, quoted to Kuru with a
 * comment on it: select words, press the quote mark that comes up by them,
 * and write what you have to say about that part — the reference, the quote
 * and the comment go into Kuru's box as a line, as a review's comments go on
 * the lines they are about, and several of them make up one message.
 *
 * **One popover for the whole page, not one per card.** The words that can
 * be quoted are marked where they are drawn — `quotable` on a card's title
 * and body, a note's body, a reply of Kuru's, a notice's message and a
 * message of your own, and
 * `quotableFile` on a reader's document — with
 * the reference to write in front of the quote: the card's own, the words
 * its menu's "Reference in Kuru" writes, the message's, the words its
 * reply arrow writes, or the file's, with where in it the words are. This listens to the document's selection and opens
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
 * **The field is Kuru's own box** (`ChipField`), not an input: it was one,
 * and a comment longer than its width scrolled out of sight inside it. As
 * the box does, it wraps, grows with what is written up to its max-height
 * and scrolls inside past that, shrinks as words are taken out, and takes
 * Shift+Enter as a new line. The new line is for writing only — a quote is
 * one line in the box (`quoteLine` folds a comment's whitespace), so it
 * arrives as a space. The popover is placed again whenever it changes size,
 * so a field that grows stays inside the window.
 *
 * **Or the comment is said.** A mic sits by the mark and by the field: it is
 * Kuru's own microphone (`dictate` in `voice.ts` — the same recorder, and the
 * same recogniser on the server) with the words handed back here rather than
 * sent to Kuru. Held, it listens until it is let go; tapped, until it is
 * pressed again, as Kuru's box's mic does (the user, 2026-11-06 — it was held
 * only). Stopped either way, the words go after whatever was typed, and the
 * quote goes into the box with them exactly as Enter would put it, unsent.
 * Escape drops what is being said and leaves the quote as it was. Words that
 * do not come — refused, too short, nothing heard, a recogniser that would
 * not run — leave the quote where it was, in the field, with why under it.
 * While it listens and while it is heard, a press elsewhere and the selection
 * going do not close the popover, since what is on its way is this
 * popover's.
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
import { fileReference, placeIn, type FileRef } from "../filequote";
import { micPress, micTitle, pressWasTap, sayLine } from "../micpress";
import { dictate, dictateCancel, dictateStop, dictateToggled, useDictation } from "../voice";
import { zoomStore } from "../zoom";
import { ChipField, type ChipFieldHandle } from "./ChipField";
import { MicIcon } from "./VoiceIcons";

/**
 * What a quote is of: a card — its title or its body, wherever it is drawn —
 * a message in Kuru's drawer, or a markdown file in a reader. Only where it
 * lands differs: a card's quote puts the board and the sheet away to show the
 * box, and a message's is in the drawer already; a file's is in a pane, which
 * the drawer opens beside.
 */
export type QuoteFrom = "card" | "message" | "file";

interface Marks {
  "data-quote-ref": string;
  "data-quote-part": QuotePart;
  "data-quote-from"?: "message" | "file";
  "data-quote-file"?: string;
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
 * The attributes that make a reader's document quotable. A file's reference
 * is not one string, as a card's is: it says where in the file the quote is
 * (`filequote.ts`), which is known only once there is a selection, so the
 * file is marked with what names it and the reference is written as the
 * selection is read.
 */
export function quotableFile(ref: FileRef): Marks {
  return { "data-quote-ref": fileReference(ref), "data-quote-part": "body", "data-quote-from": "file", "data-quote-file": JSON.stringify(ref) };
}

/** A file's reference with the place of `range` in it, or null when the mark is not a file's. */
function fileReferenceAt(host: HTMLElement, range: Range): string | null {
  try {
    const ref = JSON.parse(host.dataset.quoteFile ?? "") as FileRef;
    if (typeof ref?.path !== "string" || (ref.project !== null && typeof ref.project !== "string")) return null;
    return fileReference(ref, placeIn(host, range));
  } catch {
    return null;
  }
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

/**
 * What the popover that is up is quoting, or null with none up. The window's
 * key handler asks, because a comment on a quote of a reader's document is
 * that reader's field: ⌘+ in it resizes the document, where in Kuru's box or a
 * card's comment it is left to the window.
 */
let upFrom: QuoteFrom | null = null;
export function quoteFrom(): QuoteFrom | null {
  return upFrom;
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
/** A comment has no files of its own to draw; one array, so the field never sees a new one. */
const NO_FILES: readonly string[] = [];

/** The selection, when it is some words inside one quotable element. */
function readSelection(): Selected | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const host = (common instanceof Element ? common : common.parentElement)?.closest<HTMLElement>("[data-quote-ref]");
  const part = host?.dataset.quotePart;
  if (!host || (part !== "body" && part !== "title")) return null;
  const from: QuoteFrom = host.dataset.quoteFrom === "message" ? "message" : host.dataset.quoteFrom === "file" ? "file" : "card";
  const reference = from === "file" ? fileReferenceAt(host, range) : host.dataset.quoteRef;
  if (!reference) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  return { reference, part, from, text, range: range.cloneRange() };
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
  /** Why a dictation came to nothing, said under the field the quote is still in. */
  const [note, setNote] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<ChipFieldHandle>(null);
  const open = useRef(false);
  open.current = at !== null;
  const writingNow = useRef(false);
  writingNow.current = writing;
  // What an answer that arrives later — a dictation's words — is put in with.
  const atNow = useRef(at);
  atNow.current = at;
  const commentNow = useRef(comment);
  commentNow.current = comment;
  const onQuoteNow = useRef(onQuote);
  onQuoteNow.current = onQuote;
  /** This popover's dictation is under way: from the mic's press until its words, or why there are none, are back. */
  const speaking = useRef(false);
  /** That dictation was started by a tap, and listens until the mic is pressed again. */
  const [toggled, setToggled] = useState(false);
  const toggledNow = useRef(false);
  /** The field takes the keys as it opens — after the mark's press, and not after the mic's, whose press a phone's keyboard would only get in the way of. */
  const focusOnOpen = useRef(false);
  const dictation = useDictation();
  useEffect(() => {
    up = at !== null;
    upFrom = at?.from ?? null;
    return () => {
      up = false;
      upFrom = null;
    };
  }, [at]);
  /** Where the keyboard was before the field took it, to give it back to on Escape. */
  const before = useRef<Element | null>(null);

  const close = () => {
    if (speaking.current) {
      speaking.current = false;
      dictateCancel();
    }
    toggledNow.current = false;
    setToggled(false);
    before.current = null;
    markRange(null);
    setAt(null);
    setWriting(false);
    setComment("");
    setPlace(null);
    setNote(null);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    let down = false;
    let settle = 0;
    const check = () => {
      window.clearTimeout(settle);
      if (down || writingNow.current || speaking.current) return;
      const found = readSelection();
      // The mark follows a selection pulled about, and goes with one let go.
      if (found) setAt(found);
      else if (open.current) closeRef.current();
    };
    const onDown = (event: PointerEvent) => {
      const inside = event.target instanceof Node && box.current?.contains(event.target);
      // A press elsewhere while a comment is being said or heard is not a
      // reason to lose it: the words are on their way to this popover.
      if (inside || speaking.current) return;
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
      if (down || writingNow.current || speaking.current) return;
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
      // Mid-comment, Escape drops what is being said and nothing else: the
      // quote stays up as it was, to type into or say again. `voice.ts`'s
      // own Escape may have dropped it already, whichever heard the key first.
      if (speaking.current) {
        dictateCancel();
        return;
      }
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
      if (speaking.current) {
        speaking.current = false;
        dictateCancel();
      }
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
    // The field grows and shrinks with the comment, and the popover with it,
    // so its place is worked out again from its new height: one that would
    // now run past the window's foot goes over the words instead.
    const sized = box.current && typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
    if (sized && box.current) sized.observe(box.current);
    window.addEventListener("scroll", fit, true);
    window.addEventListener("resize", fit);
    // A reader's zoom moves the quoted words without scrolling or resizing
    // anything the two above hear: the same nodes are laid out again at the
    // new size, so the range is still right and only where it is has changed.
    // The popover is not inside the reader and keeps its own size, which is
    // the chrome's, at every zoom.
    const unzoom = zoomStore.subscribe(fit);
    return () => {
      sized?.disconnect();
      unzoom();
      window.removeEventListener("scroll", fit, true);
      window.removeEventListener("resize", fit);
    };
  }, [at, writing]);

  // The keys go to the field when it opens, as the input's `autoFocus` did.
  useEffect(() => {
    if (writing && focusOnOpen.current) field.current?.focus();
  }, [writing]);

  /** The quote, with `said` as its comment, into Kuru's box — unsent, as Enter puts it. */
  const put = (said: string) => {
    const quoted = atNow.current;
    if (!quoted) return;
    onQuoteNow.current(quoted.reference, { part: quoted.part, text: quoted.text, comment: said }, quoted.from);
    window.getSelection()?.removeAllRanges();
    closeRef.current();
  };

  /**
   * The mic went down. Its release is listened for on the window rather than
   * on the button, because a finger slides off a button it is holding and
   * the button may not be the same one by then; a release within `TAP_MS`
   * of the press was a tap, and the dictation listens on until the next
   * press. The words, when they are back, go after whatever was typed and
   * the quote goes in with them. With no words the quote stays, in the
   * field, with what went wrong under it.
   */
  const speak = (pressed: number) => {
    const press = micPress(speaking.current ? dictation.phase : "idle", toggledNow.current);
    if (press === "stop") dictateStop();
    if (press !== "start") return;
    if (!writingNow.current) {
      // From the mark, the selection is read as the mark's own press reads
      // it, and marked: a phone may let go of it while the button is held.
      const now = readSelection() ?? atNow.current;
      if (!now) return;
      before.current = document.activeElement;
      markRange(now.range);
      atNow.current = now;
      setAt(now);
    }
    setNote(null);
    speaking.current = true;
    toggledNow.current = false;
    setToggled(false);
    const unlisten = () => {
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
    const up = (event: PointerEvent) => {
      unlisten();
      if (pressWasTap(pressed, event.timeStamp) && dictateToggled("drop")) {
        toggledNow.current = true;
        setToggled(true);
      } else dictateStop();
    };
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    void dictate().then((outcome) => {
      unlisten();
      toggledNow.current = false;
      setToggled(false);
      if (!speaking.current) return;
      speaking.current = false;
      if (outcome.ok) {
        put([commentNow.current.trim(), outcome.text].filter(Boolean).join(" "));
        return;
      }
      if (outcome.why === null) return;
      if (writingNow.current) field.current?.focus();
      else {
        focusOnOpen.current = true;
        setWriting(true);
      }
      setNote(outcome.why);
    });
  };
  const said = speaking.current ? dictation.phase : "idle";
  const mic = <SayMark phase={said} toggled={toggled} level={dictation.level} onPress={speak} />;

  if (!at) return null;
  const go = () => put(comment);
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
            if (speaking.current) return;
            const now = readSelection() ?? at;
            before.current = document.activeElement;
            markRange(now.range);
            setAt(now);
            focusOnOpen.current = true;
            setWriting(true);
          }}
        >
          <QuoteMark />
        </button>
        {mic}
        {said !== "idle" && (
          <span className="quote-pop-say" role="status">
            {sayLine(said, toggled, null, false)}
          </span>
        )}
      </div>,
      document.body,
    );
  }
  return createPortal(
    <div ref={box} className="quote-pop quote-pop-write" role="dialog" aria-label="Quote to Kuru" style={style}>
      <QuoteMark />
      <ChipField
        ref={field}
        className="quote-pop-field"
        value={comment}
        files={NO_FILES}
        bold={null}
        placeholder="Your comment on this part"
        ariaLabel="Your comment on this part"
        enterKeyHint="done"
        onChange={(next) => {
          setComment(next);
          if (note) setNote(null);
        }}
        // Shift+Enter is the field's own new line, and never reaches here.
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!speaking.current) go();
          }
        }}
        onEnter={() => {
          if (!speaking.current) go();
        }}
      />
      {mic}
      <button
        type="button"
        className="quote-pop-go"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (!speaking.current) go();
        }}
        title="Put this part and your comment into Kuru's box (Enter)"
        aria-label="Quote to Kuru"
      >
        <GoMark />
      </button>
      {(said !== "idle" || note) && (
        <p className={`quote-pop-say quote-pop-say-line ${note && said === "idle" ? "quote-pop-say-failed" : ""}`} role="status">
          {sayLine(said, toggled, note, true)}
        </p>
      )}
    </div>,
    document.body,
  );
}

/**
 * The mic that says the comment: Kuru's own mic glyph, and its colour while
 * it listens — the drawer's red — with the level as a ring around it. Held
 * or tapped; which it was, and what the next press does, is the caller's
 * (`micPress`), so the press hands on its event's own stamp.
 *
 * A finger's press is kept from the page by a `touchstart` that is not
 * passive (React's own are): without it a long press scrolls the page,
 * brings up the callout, or moves a phone's selection — the words being
 * quoted — onto the button.
 */
function SayMark({ phase, toggled, level, onPress }: { phase: "idle" | "listening" | "hearing"; toggled: boolean; level: number; onPress: (pressed: number) => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = button.current;
    if (!el) return;
    const hold = (event: TouchEvent) => event.preventDefault();
    el.addEventListener("touchstart", hold, { passive: false });
    return () => el.removeEventListener("touchstart", hold);
  }, []);
  return (
    <button
      ref={button}
      type="button"
      className={`quote-pop-mic ${phase === "listening" ? "quote-pop-mic-on" : phase === "hearing" ? "quote-pop-mic-hearing" : ""}`}
      style={{ "--quote-level": phase === "listening" ? level : 0 } as React.CSSProperties}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // As the mark's: the selection and the field's keys stay where they are.
        event.preventDefault();
        onPress(event.timeStamp);
      }}
      onMouseDown={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
      title={micTitle(phase, toggled)}
      aria-label={micTitle(phase, toggled)}
      aria-pressed={phase === "listening"}
    >
      <MicIcon />
    </button>
  );
}

/**
 * A quotation mark, drawn rather than typed, since a font's `“` is a
 * different weight and height in every face. Inline as the drawer's
 * reply arrow is, in the text's own colour.
 */
function QuoteMark() {
  return (
    <svg className="glyph quote-pop-glyph" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M4 17.5c0-4.6 2.2-8.4 6-10.5l1 1.6C8.7 10 7.6 11.8 7.4 13.6H10V19H4v-1.5Zm10 0c0-4.6 2.2-8.4 6-10.5l1 1.6c-2.3 1.4-3.4 3.2-3.6 5H20V19h-6v-1.5Z" />
    </svg>
  );
}

/** The arrow that puts it in: into the box, not sent, so an arrow in rather than a paper plane away. */
function GoMark() {
  return (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}
