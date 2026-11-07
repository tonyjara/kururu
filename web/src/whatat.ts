/**
 * What is at a point of this page, for the screen pen (docs/plans/screen-annotate.md).
 *
 * A mark drawn on kururu's own window should say what it was drawn on the
 * way a person would — "the agent Fastermenu migration", "card KUR-12", "the
 * sidebar" — and not "Kururu", which is all the window list knows. Main asks
 * the page under the ink (`inkWhatAt` in `desktop/main.js`, through
 * `executeJavaScript`), and this answers from the element at that point.
 *
 * **From the page as drawn, not from the state.** The panes, cards and note
 * windows carry `data-ink-what`, `data-ink-name` and the like, set where they
 * are rendered from what they show (`paneInk` in `Panes.tsx`); this reads the
 * innermost of them over the point, so a card on a board in a pane is the
 * card, in the pane's workspace. The parts of the window that are one thing
 * whatever they hold — the sidebar, the drawers, Settings — are named by
 * their class here, which costs nothing in the components that draw them.
 * Nothing here holds or returns an id; a title is what an agent reads.
 *
 * **Kuru's drawer and the pill say which part of them** (2026-11-06): a mark
 * on the drawer's header came out as "the screen" once, and "Kuru's drawer"
 * alone would not have been much better when the ink was round one button
 * of five. So the drawer names its header, its search, a line in the
 * conversation — whose, when, and its first words — the box and the live
 * line, and the pill what it is saying; the control under the ink is named
 * as everywhere, by its label and never a field's value.
 */
import type { KururuAt } from "../../shared/ink";

/**
 * The parts of the window named by what they are, innermost first in the
 * DOM's order of nesting, and for some the part of them under the point.
 */
const PLACES: readonly [string, string, ((el: Element) => string)?][] = [
  [".voice-pill", "Kuru's voice pill", pillPart],
  [".st-dialog", "Settings"],
  [".needs-drawer", "the Needs you drawer"],
  [".kuru-drawer", "Kuru's drawer", drawerPart],
  [".files", "the file tree"],
  [".sidebar", "the sidebar"],
  [".statusbar", "the bottom bar"],
];

const CONTROLS =
  "button, a[href], input, textarea, select, [contenteditable=''], [contenteditable=true], [role=button], [role=tab], [role=menuitem], [role=link], [role=checkbox], [role=switch], [role=textbox], [role=combobox]";

const flat = (text: string | null | undefined, max: number): string => {
  const one = (text ?? "").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** The control under the point, by its words: `button "Send"`. Never a field's value — an editable box's text is its value too. */
function controlOf(el: Element): string {
  const control = el.closest(CONTROLS);
  if (!control) return "";
  const tag = control.getAttribute("role") || control.tagName.toLowerCase();
  const field =
    control instanceof HTMLInputElement ||
    control instanceof HTMLTextAreaElement ||
    control instanceof HTMLSelectElement ||
    (control instanceof HTMLElement && control.isContentEditable) ||
    tag === "textbox" ||
    tag === "combobox";
  const words = flat(control.getAttribute("aria-label") || control.getAttribute("title") || (field ? control.getAttribute("placeholder") : control.textContent), 80);
  return words ? `${tag} "${words.replace(/"/g, "'")}"` : tag;
}

/** In a document, the heading over the point: the last one whose top is above it. */
function headingAbove(root: Element, y: number): string {
  let best = "";
  for (const h of root.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const top = h.getBoundingClientRect().top;
    if (top <= y) best = flat(h.textContent, 120);
    else break;
  }
  return best;
}

/** Which part of Kuru's drawer a point is on. */
function drawerPart(el: Element): string {
  if (el.closest(".kuru-head")) return "its header";
  if (el.closest(".kuru-search")) return "its search";
  const line = el.closest(".kuru-item, .kuru-notice");
  if (line) return lineOf(line);
  if (el.closest(".kuru-composer")) return "the box you write to Kuru in";
  if (el.closest(".kuru-live, .kuru-live-off-box")) return "the line saying what Kuru is doing";
  if (el.closest(".kuru-list")) return "the conversation";
  return "";
}

/**
 * A line of the conversation: whose, when, and its first words — a folded
 * line's one row, or the words under its meta row — so "this one" in what
 * was said can be found again in a long history.
 */
function lineOf(line: Element): string {
  const who = line.classList.contains("kuru-you") ? "your message" : line.classList.contains("kuru-reply") ? "Kuru's reply" : "a notice";
  const when = flat(line.querySelector("time")?.textContent, 24);
  let words = line.querySelector(".kuru-fold-line")?.textContent ?? "";
  if (!words.trim()) {
    for (const child of line.children) {
      if (child.classList.contains("kuru-meta") || child.tagName === "BUTTON") continue;
      words += ` ${child.textContent ?? ""}`;
    }
  }
  const first = flat(words, 80);
  return `${who}${when ? ` at ${when}` : ""}${first ? ` "${first.replace(/"/g, "'")}"` : ""}`;
}

/** What the pill is saying, when it is saying something: a reply's words, or what went wrong. */
function pillPart(el: Element): string {
  const said = flat(el.closest(".voice-pill")?.querySelector(".voice-text")?.textContent, 80);
  return said ? `saying "${said.replace(/"/g, "'")}"` : "";
}

/** What is at a point of the window, in CSS pixels; null over nothing. */
export function whatAt(x: number, y: number): KururuAt | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const element = controlOf(el);
  const marked = el.closest("[data-ink-what]");
  const workspace = el.closest("[data-ink-workspace]")?.getAttribute("data-ink-workspace") ?? "";
  if (marked) {
    const what = flat(marked.getAttribute("data-ink-what"), 80);
    let detail = flat(marked.getAttribute("data-ink-detail"), 120);
    if (what === "document") {
      const heading = headingAbove(marked, y);
      if (heading) detail = `under the heading "${heading.replace(/"/g, "'")}"`;
    }
    return { what, name: flat(marked.getAttribute("data-ink-name"), 200), detail, workspace: flat(workspace, 120), element };
  }
  for (const [selector, what, part] of PLACES) {
    if (el.closest(selector)) return { what, name: "", detail: part ? flat(part(el), 160) : "", workspace: "", element };
  }
  return { what: "the window", name: "", detail: "", workspace: "", element };
}

/** Answer main's question on this page. Every page of the app: the window, a note, the pill. */
export function installWhatAt(): void {
  (window as unknown as { __kururuWhatAt?: typeof whatAt }).__kururuWhatAt = whatAt;
}
