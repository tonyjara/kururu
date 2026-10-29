/**
 * A card's two clicks: one opens it in place, two open its editor.
 *
 * It exists because the double-click was there first. A card opened its
 * editor on a double-click long before a click did anything, and a browser
 * delivers both clicks of a double before the `dblclick` — so a card that
 * opened on every click would open and shut again, under the editor, each
 * time somebody meant the editor. The first click therefore waits a moment
 * to see whether a second follows, and acts only if none does. Waiting is
 * the price of keeping both gestures on one surface; the alternative, acting
 * at once and undoing it when the second click comes, is the flicker.
 *
 * `detail` is what tells them apart, rather than a clock of our own: the
 * browser counts the clicks of a double by the system's own double-click
 * speed, so a second click it calls the second is never also a first. A
 * `dblclick` cancels the wait as well, for a touch screen that sends one
 * without counting the taps. A click with no count at all (`detail` 0) is
 * not from a mouse or a finger — a program's `click()`, a key — and cannot
 * be half of a double, so it acts at once.
 *
 * Only the card's own surface is the gesture. Its buttons, links, fields and
 * whatever region a board names as having a job of its own (`keep`: the run
 * line, the links to what an agent made) keep their clicks, and a click that
 * ends a selection in the card is somebody reading it, not closing it.
 */
import { useEffect, useRef } from "react";

/**
 * How long a first click waits for a second before the card opens. Short,
 * because every single click pays it; long enough for an ordinary double,
 * whose clicks land well inside it. A slower double than this opens the card
 * and then the editor over it — which is the editor, and nothing undone.
 */
export const CLICK_WAIT_MS = 250;

export interface Timers {
  set: (run: () => void, ms: number) => number;
  clear: (timer: number) => void;
}

const WINDOW_TIMERS: Timers = {
  set: (run, ms) => window.setTimeout(run, ms),
  clear: (timer) => window.clearTimeout(timer),
};

export interface ClickSplit {
  /** A click on the card's own surface, with the browser's `detail`; `single` runs if it turns out to be one. */
  click: (detail: number, single: () => void) => void;
  /** Forget a click still waiting: a double arrived, a drag began, or the card went. */
  cancel: () => void;
}

/** The wait, as a value: one pending single at most, and every second click cancels it. */
export function clickSplit(wait = CLICK_WAIT_MS, timers: Timers = WINDOW_TIMERS): ClickSplit {
  let pending: number | null = null;
  const cancel = () => {
    if (pending !== null) timers.clear(pending);
    pending = null;
  };
  return {
    click: (detail, single) => {
      cancel();
      if (detail > 1) return;
      if (detail < 1) {
        single();
        return;
      }
      pending = timers.set(() => {
        pending = null;
        single();
      }, wait);
    },
    cancel,
  };
}

/** The part of an element `ownClick` reads, so a test can hand it a few plain objects. */
export interface ClickNode {
  tagName: string;
  isContentEditable?: boolean;
  parentElement: ClickNode | null;
  getAttribute: (name: string) => string | null;
  classList: { contains: (name: string) => boolean };
}

const CONTROL_TAGS = new Set(["a", "button", "input", "textarea", "select", "option", "label", "summary"]);
const CONTROL_ROLES = new Set(["button", "link", "menuitem", "checkbox", "switch", "radio", "tab", "option", "textbox", "slider"]);

/**
 * Whether a click on `target` is a click on `card` itself, and not on
 * something inside it with a job of its own: a control, an editable field,
 * or an element carrying one of the `keep` classes. A target outside the
 * card's elements — a menu drawn into `document.body` whose events React
 * still bubbles through the card — is not the card's either.
 */
export function ownClick(target: ClickNode | null, card: ClickNode, keep: readonly string[] = []): boolean {
  let at = target;
  for (; at && at !== card; at = at.parentElement) {
    if (CONTROL_TAGS.has(at.tagName.toLowerCase())) return false;
    const role = at.getAttribute("role");
    if (role !== null && CONTROL_ROLES.has(role)) return false;
    if (at.isContentEditable) return false;
    const node = at;
    if (keep.some((name) => node.classList.contains(name))) return false;
  }
  return at === card;
}

/** Whether some of `card`'s text is selected — a click that made or ends one is reading, not opening. */
export function selectedIn(
  selection: Pick<Selection, "isCollapsed" | "rangeCount" | "anchorNode" | "focusNode"> | null,
  card: Pick<Node, "contains">,
): boolean {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  return card.contains(selection.anchorNode) || card.contains(selection.focusNode);
}

/**
 * The card's click handlers. `onSingle` is read when the wait ends, not when
 * the click lands, so a card drawn by a `memo` still acts on its state as it
 * is then; `onDouble` is the editor, as the card's double-click was before.
 * Spread `onClick` and `onDoubleClick` onto the card, and call `cancel` from
 * its `onDragStart`, so a press that became a drag does not open the card
 * under the drop.
 */
export function useCardClick(onSingle: () => void, onDouble: () => void, keep: readonly string[] = []) {
  const split = useRef<ClickSplit | null>(null);
  split.current ??= clickSplit();
  const single = useRef(onSingle);
  single.current = onSingle;
  useEffect(() => () => split.current?.cancel(), []);
  return {
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const card = event.currentTarget;
      if (!ownClick(event.target as Element, card, keep)) return;
      if (selectedIn(window.getSelection(), card)) return;
      split.current!.click(event.detail, () => {
        if (!selectedIn(window.getSelection(), card)) single.current();
      });
    },
    onDoubleClick: () => {
      split.current!.cancel();
      onDouble();
    },
    cancel: () => split.current!.cancel(),
  };
}
