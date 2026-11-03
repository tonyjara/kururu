/**
 * Kuru's box, as a field that can draw a chip inside a line of words.
 *
 * It was a textarea, and `Composer` gives the reasons one was chosen: the
 * value, IME, undo and the phone's keyboard come free. It stopped being one
 * because a textarea draws every character it holds, and the box holds text
 * written for Kuru — a card's reference, a quote, a path — that took up most
 * of the box and made three quotes of one note read as one (`chips.ts`). A
 * chip is narrower than the text it stands for, which no overlay on a
 * textarea can draw: the text under it still takes its width. So this is a
 * `contenteditable`, with what a textarea gave for free taken back by hand:
 *
 * - **The value is a string, as it was.** The DOM is drawn from it — words as
 *   text, each chip a `contenteditable="false"` span holding its text in
 *   `data-raw` — and read back into it after every edit, so the composer, the
 *   draft in localStorage and what is sent never see a node. An edit the
 *   browser makes on its own (a key typed, a selection deleted) is read back;
 *   anything else — a paste, Shift+Enter, a chip deleted, an undo — is made
 *   to the string and the DOM drawn again from it, so no browser's idea of
 *   pasted HTML or of a new line ever lives in the box.
 * - **The cursor is a number, as it was.** `selectionStart`, `selectionEnd`
 *   and `setSelectionRange` read and place it in the string's terms, a chip
 *   counting as all of its text, so the composer's own code — the `@`
 *   suggestions, where a reference goes in — did not change.
 * - **Undo is the box's own.** The browser's undo stack does not survive the
 *   DOM being drawn again under it, and an undo that puts back half a chip is
 *   worse than none, so ⌘Z and ⇧⌘Z (and the Edit menu's, which arrives as
 *   `historyUndo`) step through the box's own list of values.
 * - **The `@node` bold is real bold.** The textarea needed a mirror behind it
 *   with stroked glyphs; a contenteditable can just bold the name.
 *
 * Nothing is drawn again while an IME is composing — the browser owns the
 * text then — and only when what is on screen differs from what the string
 * says it should be, so ordinary typing is never touched.
 *
 * **It is also the quote's comment field** (`Quote.tsx`), which was a
 * one-line input that scrolled a long comment out of sight. Being this field
 * rather than a textarea of its own gives it the box's growth (a
 * contenteditable is as tall as its words, up to `.chip-field`'s
 * `max-height`) and the box's keys — Enter is the caller's, Shift+Enter a new
 * line — so the two cannot drift apart. The `@` list is the composer's alone,
 * which is why the combobox's attributes are optional: a field with no list
 * is a plain multi-line textbox to a screen reader.
 */
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { chipAt, piecesOf, type Chip, type Piece } from "../chips";

export interface ChipFieldHandle {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly focused: boolean;
  setSelectionRange(from: number, to: number): void;
  focus(): void;
  blur(): void;
}

interface Props {
  value: string;
  /** The escaped paths the box put in itself, which are drawn as files. */
  files: readonly string[];
  /** The `@node` at the front that will route, drawn bold. */
  bold: { from: number; to: number } | null;
  placeholder: string;
  /** Added to `chip-field`, which is what makes it grow and wrap. */
  className?: string;
  onChange: (value: string, caret: number) => void;
  /** The cursor moved while the box has the keyboard. */
  onCaret?: (from: number, to: number) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  /** A paste with files in it; the box takes a paste of words itself unless this prevents it. */
  onPaste?: (event: React.ClipboardEvent<HTMLDivElement>) => void;
  /** Enter on a keyboard that sends no key for it — a phone's — which the composer's `onKeyDown` never heard. */
  onEnter: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** What a phone's return key is labelled. */
  enterKeyHint?: React.HTMLAttributes<HTMLDivElement>["enterKeyHint"];
  ariaLabel: string;
  /** Whether a list of suggestions is open under the field; left out, the field has no list and is no combobox. */
  ariaExpanded?: boolean;
  ariaControls?: string;
  ariaActiveDescendant?: string;
}

/** How long typing goes on being one step of undo. */
const UNDO_JOIN_MS = 800;
const UNDO_MAX = 200;

// ---------------------------------------------------------------------------
// The DOM and the string
// ---------------------------------------------------------------------------

function isChipNode(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && node.dataset.raw !== undefined;
}

/** The last `<br>` drawn after a final new line, which only gives the empty last line somewhere to be and is not a character. */
function isTail(node: Node): boolean {
  return node instanceof HTMLElement && node.tagName === "BR" && node.dataset.tail !== undefined;
}

const BLOCK = new Set(["DIV", "P", "LI"]);

function clean(text: string): string {
  return text.replace(/ /g, " ");
}

/** The string the DOM says, a chip as its text. */
function serialize(root: HTMLElement): string {
  let out = "";
  const walk = (parent: Node) => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) out += clean((child as Text).data);
      else if (isChipNode(child)) out += child.dataset.raw ?? "";
      else if (child instanceof HTMLElement && child.tagName === "BR") {
        if (!(isTail(child) && child === root.lastChild)) out += "\n";
      } else if (child instanceof HTMLElement && BLOCK.has(child.tagName)) {
        if (out && !out.endsWith("\n")) out += "\n";
        walk(child);
      } else walk(child);
    }
  };
  walk(root);
  return out;
}

/** How far into the string a point in the DOM is — a point inside a chip counts as its end. */
function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  let count = 0;
  const walk = (parent: Node): boolean => {
    const kids = Array.from(parent.childNodes);
    for (let i = 0; i < kids.length; i++) {
      if (parent === node && i === offset) return true;
      const child = kids[i]!;
      if (child.nodeType === Node.TEXT_NODE) {
        if (child === node) {
          count += clean((child as Text).data.slice(0, offset)).length;
          return true;
        }
        count += (child as Text).data.length;
      } else if (isChipNode(child)) {
        count += (child.dataset.raw ?? "").length;
        if (child === node || child.contains(node)) return true;
      } else if (child instanceof HTMLElement && child.tagName === "BR") {
        if (!(isTail(child) && child === root.lastChild)) count += 1;
      } else {
        if (child instanceof HTMLElement && BLOCK.has(child.tagName) && count > 0) count += 1;
        if (walk(child)) return true;
      }
    }
    return parent === node;
  };
  walk(root);
  return count;
}

/** The point in the DOM at an offset into the string, as `draw` lays it out. */
function pointAt(root: HTMLElement, at: number): { node: Node; offset: number } {
  let left = Math.max(0, at);
  const kids = Array.from(root.childNodes);
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i]!;
    if (child.nodeType === Node.TEXT_NODE) {
      const len = (child as Text).data.length;
      if (left <= len) return { node: child, offset: left };
      left -= len;
    } else if (isChipNode(child)) {
      const len = (child.dataset.raw ?? "").length;
      if (left === 0) return { node: root, offset: i };
      if (left <= len) return { node: root, offset: i + 1 };
      left -= len;
    } else if (isTail(child)) {
      return { node: root, offset: i };
    } else {
      const text = child.firstChild;
      const len = (child.textContent ?? "").length;
      if (left <= len) return text ? { node: text, offset: left } : { node: root, offset: i };
      left -= len;
    }
  }
  const end = kids.length > 0 && isTail(kids[kids.length - 1]!) ? kids.length - 1 : kids.length;
  return { node: root, offset: end };
}

const ICONS: Record<Chip["kind"], string> = {
  card: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M8 9h8M8 13h5"/>',
  quote: '<path fill="currentColor" stroke="none" d="M4 17.5c0-4.6 2.2-8.4 6-10.5l1 1.6C8.7 10 7.6 11.8 7.4 13.6H10V19H4v-1.5Zm10 0c0-4.6 2.2-8.4 6-10.5l1 1.6c-2.3 1.4-3.4 3.2-3.6 5H20V19h-6v-1.5Z"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 16-5-5-8 8"/>',
  file: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-10Z"/><path d="M14 3.5v5h5"/>',
};

const KIND_WORD: Record<Chip["kind"], string> = { card: "Card", quote: "Quote", image: "Picture", file: "File" };

/** One chip, drawn by hand: it lives inside a contenteditable, where React does not. */
function chipNode(chip: Chip, raw: string): HTMLElement {
  const el = document.createElement("span");
  el.className = `kc kc-${chip.kind}`;
  el.contentEditable = "false";
  el.draggable = false;
  el.dataset.raw = raw;
  el.title = chip.full;
  el.setAttribute("aria-label", `${KIND_WORD[chip.kind]}: ${chip.full}`);
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.9");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  icon.classList.add("kc-icon");
  icon.innerHTML = ICONS[chip.kind];
  el.append(icon);
  if (chip.kind === "card") {
    const code = document.createElement("span");
    code.className = "kc-code";
    code.textContent = chip.source;
    el.append(code);
  }
  const label = document.createElement("span");
  label.className = "kc-label";
  label.textContent = chip.label;
  el.append(label);
  if (chip.kind === "quote" && chip.source) {
    const from = document.createElement("span");
    from.className = "kc-from";
    from.textContent = chip.source;
    el.append(from);
  }
  // Shown when a tap opens the chip — the hover's `title` is a desktop's only.
  const full = document.createElement("span");
  full.className = "kc-full";
  full.textContent = chip.full;
  el.append(full);
  return el;
}

/** Text with the bold run in it, as nodes. */
function textNodes(text: string, start: number, bold: { from: number; to: number } | null): Node[] {
  if (!bold || bold.to <= start || bold.from >= start + text.length) return [document.createTextNode(text)];
  const a = Math.max(0, bold.from - start);
  const b = Math.min(text.length, bold.to - start);
  const nodes: Node[] = [];
  if (a > 0) nodes.push(document.createTextNode(text.slice(0, a)));
  const strong = document.createElement("b");
  strong.textContent = text.slice(a, b);
  nodes.push(strong);
  if (b < text.length) nodes.push(document.createTextNode(text.slice(b)));
  return nodes;
}

/** The nodes a value is drawn as. */
function nodesFor(value: string, pieces: Piece[], bold: { from: number; to: number } | null): Node[] {
  const nodes: Node[] = [];
  let at = 0;
  for (const piece of pieces) {
    if ("text" in piece) {
      nodes.push(...textNodes(piece.text, at, bold));
      at += piece.text.length;
    } else {
      nodes.push(chipNode(piece.chip, value.slice(piece.chip.from, piece.chip.to)));
      at = piece.chip.to;
    }
  }
  if (value.endsWith("\n")) {
    const tail = document.createElement("br");
    tail.dataset.tail = "";
    nodes.push(tail);
  }
  return nodes;
}

/** Whether what is on screen is what `nodesFor` would draw — compared node by node, so typing into a word leaves the DOM alone. */
function drawnAs(root: HTMLElement, want: Node[]): boolean {
  const have = Array.from(root.childNodes);
  if (have.length !== want.length) return false;
  return want.every((node, i) => {
    const there = have[i]!;
    if (node.nodeType === Node.TEXT_NODE) return there.nodeType === Node.TEXT_NODE && clean((there as Text).data) === (node as Text).data;
    if (isChipNode(node as HTMLElement)) return isChipNode(there) && there.dataset.raw === (node as HTMLElement).dataset.raw && there.title === (node as HTMLElement).title;
    const el = node as HTMLElement;
    return there instanceof HTMLElement && there.tagName === el.tagName && there.childNodes.length <= 1 && (there.textContent ?? "") === (el.textContent ?? "");
  });
}

// ---------------------------------------------------------------------------
// The field
// ---------------------------------------------------------------------------

export const ChipField = forwardRef<ChipFieldHandle, Props>(function ChipField(props, ref) {
  const root = useRef<HTMLDivElement>(null);
  /** The props as of this render, for the listeners added once. */
  const now = useRef(props);
  now.current = props;
  /** The value the DOM was last drawn from or read as. */
  const shown = useRef<string | null>(null);
  const composing = useRef(false);
  const history = useRef<{ list: { value: string; caret: number }[]; at: number; last: number }>({ list: [{ value: props.value, caret: props.value.length }], at: 0, last: 0 });

  const selection = (): { from: number; to: number } => {
    const el = root.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0) return { from: shown.current?.length ?? 0, to: shown.current?.length ?? 0 };
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) {
      const end = (shown.current ?? props.value).length;
      return { from: end, to: end };
    }
    const a = offsetOf(el, range.startContainer, range.startOffset);
    const b = offsetOf(el, range.endContainer, range.endOffset);
    return { from: Math.min(a, b), to: Math.max(a, b) };
  };

  const place = (from: number, to = from) => {
    const el = root.current;
    const sel = window.getSelection();
    if (!el || !sel) return;
    const a = pointAt(el, from);
    const b = to === from ? a : pointAt(el, to);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  /** Draw the DOM from a value, unless it already shows it; the cursor kept where it was in the string, when the box has it. */
  const draw = (value: string, force = false) => {
    const el = root.current;
    if (!el) return;
    const { files, bold } = now.current;
    const want = nodesFor(value, piecesOf(value, files), bold);
    if (!force && drawnAs(el, want)) {
      shown.current = value;
      return;
    }
    const focused = document.activeElement === el;
    const caret = focused ? selection() : null;
    el.replaceChildren(...want);
    shown.current = value;
    if (caret) place(Math.min(caret.from, value.length), Math.min(caret.to, value.length));
  };

  const remember = (value: string, caret: number, join: boolean) => {
    const h = history.current;
    const t = Date.now();
    const top = h.list[h.at];
    if (top && top.value === value) {
      top.caret = caret;
      return;
    }
    if (join && h.at > 0 && h.at === h.list.length - 1 && t - h.last < UNDO_JOIN_MS) h.list[h.at] = { value, caret };
    else {
      h.list = h.list.slice(0, h.at + 1);
      h.list.push({ value, caret });
      if (h.list.length > UNDO_MAX) h.list.shift();
      h.at = h.list.length - 1;
    }
    h.last = join ? t : 0;
  };

  /** An edit made to the string: drawn, the cursor put after it, and told. */
  const replace = (from: number, to: number, words: string) => {
    const value = shown.current ?? now.current.value;
    const next = value.slice(0, from) + words + value.slice(to);
    const caret = from + words.length;
    remember(next, caret, false);
    draw(next);
    place(caret);
    now.current.onChange(next, caret);
  };

  /** Read back an edit the browser made. */
  const readBack = () => {
    const el = root.current;
    if (!el || composing.current) return;
    // An emptied box keeps a stray `<br>` in some browsers — Chrome leaves one
    // as its only child after everything in it is selected and deleted. It is
    // the browser's, not a line: read as one, the box kept a second line's
    // height and hid the placeholder over a box with nothing in it.
    const only = el.childNodes.length === 1 ? el.firstChild : null;
    const value = only instanceof HTMLElement && only.tagName === "BR" ? "" : serialize(el);
    if (value === "" && el.childNodes.length > 0) el.replaceChildren();
    const caret = selection().from;
    remember(value, caret, true);
    shown.current = value;
    now.current.onChange(value, caret);
  };

  const step = (back: boolean) => {
    const h = history.current;
    const at = back ? h.at - 1 : h.at + 1;
    const to = h.list[at];
    if (!to) return;
    h.at = at;
    h.last = 0;
    draw(to.value);
    place(to.caret);
    now.current.onChange(to.value, to.caret);
  };

  // A value from outside — a reference put in, the draft sent, a name picked — is drawn; one the box itself just read back is only checked.
  useLayoutEffect(() => {
    if (composing.current) return;
    if (shown.current !== props.value) remember(props.value, props.value.length, false);
    draw(props.value);
  }, [props.value, props.files.join("\n"), props.bold?.from, props.bold?.to]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onBeforeInput = (event: InputEvent) => {
      const type = event.inputType;
      if (type === "historyUndo" || type === "historyRedo") {
        event.preventDefault();
        step(type === "historyUndo");
      } else if (type === "insertParagraph") {
        // A phone's return key, which arrives as no key at all.
        event.preventDefault();
        now.current.onEnter();
      } else if (type === "insertLineBreak") {
        event.preventDefault();
        const { from, to } = selection();
        replace(from, to, "\n");
      } else if (type === "deleteContentBackward" || type === "deleteContentForward") {
        const { from, to } = selection();
        if (from !== to) return;
        const value = shown.current ?? now.current.value;
        const chip = chipAt(value, now.current.files, from, type === "deleteContentBackward");
        if (!chip) return;
        event.preventDefault();
        replace(chip.from, chip.to, "");
      } else if (type === "insertFromDrop" || type === "insertFromPaste" || type === "insertFromYank") {
        // Taken in `paste` and `drop` as words; never the browser's HTML.
        event.preventDefault();
      }
    };
    const onSelectionChange = () => {
      if (document.activeElement !== el) return;
      const { from, to } = selection();
      now.current.onCaret?.(from, to);
    };
    el.addEventListener("beforeinput", onBeforeInput);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      el.removeEventListener("beforeinput", onBeforeInput);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(
    ref,
    () => ({
      get value() {
        return shown.current ?? now.current.value;
      },
      get selectionStart() {
        return selection().from;
      },
      get selectionEnd() {
        return selection().to;
      },
      get focused() {
        return document.activeElement === root.current;
      },
      setSelectionRange(from: number, to: number) {
        if (document.activeElement !== root.current) return;
        place(from, to);
      },
      focus() {
        root.current?.focus();
      },
      blur() {
        root.current?.blur();
      },
    }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /** The string under a selection, for a copy or a cut to carry what is sent rather than what is drawn. */
  const copied = (event: React.ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    const { from, to } = selection();
    if (from === to) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", (shown.current ?? props.value).slice(from, to));
    if (cut) replace(from, to, "");
  };

  const listed = props.ariaExpanded !== undefined;
  return (
    <div
      ref={root}
      className={props.className ? `chip-field ${props.className}` : "chip-field"}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      enterKeyHint={props.enterKeyHint}
      data-placeholder={props.placeholder}
      role={listed ? "combobox" : "textbox"}
      aria-multiline="true"
      aria-label={props.ariaLabel}
      aria-autocomplete={listed ? "list" : undefined}
      aria-expanded={props.ariaExpanded}
      aria-controls={props.ariaControls}
      aria-activedescendant={props.ariaActiveDescendant}
      onInput={readBack}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        readBack();
      }}
      onKeyDown={(event) => {
        const mod = event.metaKey || event.ctrlKey;
        if (mod && !event.altKey && (event.key === "z" || event.key === "Z")) {
          event.preventDefault();
          step(!event.shiftKey);
          return;
        }
        if (mod && !event.altKey && event.key === "y" && !event.metaKey) {
          event.preventDefault();
          step(false);
          return;
        }
        if (event.key === "Enter" && event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          const { from, to } = selection();
          replace(from, to, "\n");
          return;
        }
        props.onKeyDown(event);
      }}
      onPaste={(event) => {
        props.onPaste?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        const words = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
        if (!words) return;
        const { from, to } = selection();
        replace(from, to, words);
      }}
      onCopy={(event) => copied(event, false)}
      onCut={(event) => copied(event, true)}
      onDrop={(event) => {
        // A file is the composer's, on the form around this; words dropped in
        // go in as words, where they were let go.
        if (event.dataTransfer.files.length > 0) return;
        const words = event.dataTransfer.getData("text/plain");
        if (!words) return;
        event.preventDefault();
        const el = root.current;
        const at = document.caretRangeFromPoint?.(event.clientX, event.clientY);
        const pos = el && at && el.contains(at.startContainer) ? offsetOf(el, at.startContainer, at.startOffset) : (shown.current ?? props.value).length;
        el?.focus();
        replace(pos, pos, words);
      }}
      onClick={(event) => {
        // A tap on a chip opens it to show all of what it stands for — the
        // hover's `title`, for a screen with no hover — and a second closes it.
        const chip = event.target instanceof Element ? event.target.closest<HTMLElement>(".kc") : null;
        if (!chip || !root.current?.contains(chip)) return;
        chip.classList.toggle("kc-open");
        const index = Array.from(root.current.childNodes).indexOf(chip);
        if (index >= 0) {
          const sel = window.getSelection();
          const range = document.createRange();
          range.setStart(root.current, index + 1);
          range.collapse(true);
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      }}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
    />
  );
});
