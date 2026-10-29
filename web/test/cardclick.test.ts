/**
 * A card's click and double-click on one surface: a single opens the card
 * only once the wait has passed with no second click, the clicks of a double
 * never open it, a drag or a gone card forgets a waiting click, and a click
 * on the card's controls or on a selection in it is not the card's at all.
 */
import { describe, expect, it } from "bun:test";
import { CLICK_WAIT_MS, clickSplit, ownClick, selectedIn, type ClickNode, type Timers } from "../src/cardclick";

/** A clock turned by hand, so the wait is a number and not a sleep. */
function clock() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; run: () => void }>();
  const timers: Timers = {
    set: (run, ms) => {
      const id = next++;
      due.set(id, { at: now + ms, run });
      return id;
    },
    clear: (id) => {
      due.delete(id);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...due].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > now) continue;
      due.delete(id);
      timer.run();
    }
  };
  return { timers, advance, pending: () => due.size };
}

/** A click split on a hand-turned clock, counting how often the card opened. */
function card() {
  const time = clock();
  const split = clickSplit(CLICK_WAIT_MS, time.timers);
  let opened = 0;
  const click = (detail: number) => split.click(detail, () => opened++);
  return { split, click, time, opened: () => opened };
}

describe("clickSplit", () => {
  it("opens on a single click, but only once the wait has passed", () => {
    const c = card();
    c.click(1);
    expect(c.opened()).toBe(0);
    c.time.advance(CLICK_WAIT_MS - 1);
    expect(c.opened()).toBe(0);
    c.time.advance(1);
    expect(c.opened()).toBe(1);
  });

  it("never opens on the clicks of a double, whose second the browser counts as 2", () => {
    const c = card();
    c.click(1);
    c.time.advance(120);
    c.click(2);
    c.time.advance(CLICK_WAIT_MS * 4);
    expect(c.opened()).toBe(0);
    expect(c.time.pending()).toBe(0);
  });

  it("never opens on a triple click either", () => {
    const c = card();
    c.click(1);
    c.click(2);
    c.click(3);
    c.time.advance(CLICK_WAIT_MS * 4);
    expect(c.opened()).toBe(0);
  });

  it("is cancelled by a dblclick that arrives without a counted second click, as a touch screen may send", () => {
    const c = card();
    c.click(1);
    c.time.advance(80);
    c.split.cancel();
    c.time.advance(CLICK_WAIT_MS * 4);
    expect(c.opened()).toBe(0);
  });

  it("opens and closes on two singles a wait apart, each its own click", () => {
    const c = card();
    c.click(1);
    c.time.advance(CLICK_WAIT_MS);
    c.time.advance(400);
    c.click(1);
    c.time.advance(CLICK_WAIT_MS);
    expect(c.opened()).toBe(2);
  });

  it("keeps one waiting click at most: a second single restarts the wait rather than queueing", () => {
    const c = card();
    c.click(1);
    c.time.advance(CLICK_WAIT_MS - 10);
    c.click(1);
    expect(c.time.pending()).toBe(1);
    c.time.advance(CLICK_WAIT_MS);
    expect(c.opened()).toBe(1);
  });

  it("acts at once on a click with no count, which cannot be half of a double", () => {
    const c = card();
    c.click(0);
    expect(c.opened()).toBe(1);
    expect(c.time.pending()).toBe(0);
  });

  it("forgets a waiting click when a drag begins or the card goes", () => {
    const c = card();
    c.click(1);
    c.split.cancel();
    c.time.advance(CLICK_WAIT_MS * 2);
    expect(c.opened()).toBe(0);
    c.split.cancel();
    expect(c.time.pending()).toBe(0);
  });

  it("waits a short moment", () => {
    expect(CLICK_WAIT_MS).toBeGreaterThanOrEqual(150);
    expect(CLICK_WAIT_MS).toBeLessThanOrEqual(300);
  });
});

/** An element with only what `ownClick` reads, parented by hand. */
function el(
  tagName: string,
  parent: ClickNode | null,
  { role, classes = [], editable = false }: { role?: string; classes?: string[]; editable?: boolean } = {},
): ClickNode {
  return {
    tagName: tagName.toUpperCase(),
    isContentEditable: editable,
    parentElement: parent,
    getAttribute: (name) => (name === "role" ? (role ?? null) : null),
    classList: { contains: (name) => classes.includes(name) },
  };
}

describe("ownClick", () => {
  const keep = ["board-run", "board-made", "board-card-note"];
  const article = el("article", el("div", null), { classes: ["board-card"] });
  const top = el("div", article, { classes: ["board-card-top"] });

  it("takes a click on the card itself, its title, its body and its dates", () => {
    expect(ownClick(article, article, keep)).toBe(true);
    expect(ownClick(el("span", top, { classes: ["board-card-title"] }), article, keep)).toBe(true);
    expect(ownClick(el("p", el("div", article), { classes: ["board-card-body"] }), article, keep)).toBe(true);
    expect(ownClick(el("span", article, { classes: ["board-card-when"] }), article, keep)).toBe(true);
  });

  it("leaves a button, and anything inside one, to the button", () => {
    const actions = el("span", top, { classes: ["board-card-actions"] });
    const robot = el("button", actions);
    expect(ownClick(robot, article, keep)).toBe(false);
    expect(ownClick(el("svg", robot), article, keep)).toBe(false);
  });

  it("leaves links, fields, labels and editable text to themselves", () => {
    for (const tag of ["a", "input", "textarea", "select", "label", "summary"]) {
      expect(ownClick(el(tag, article), article, keep)).toBe(false);
    }
    expect(ownClick(el("span", el("div", article, { editable: true }), { editable: true }), article, keep)).toBe(false);
  });

  it("leaves an element that only says it is a control to it", () => {
    expect(ownClick(el("div", article, { role: "button" }), article, keep)).toBe(false);
    expect(ownClick(el("div", article, { role: "menuitem" }), article, keep)).toBe(false);
    expect(ownClick(el("span", article, { role: "checkbox" }), article, keep)).toBe(false);
    expect(ownClick(el("div", article, { role: "note" }), article, keep)).toBe(true);
  });

  it("leaves the run line, the made links and the git note to themselves, words and all", () => {
    const run = el("div", article, { classes: ["board-run", "board-run-finished"] });
    expect(ownClick(el("span", run, { classes: ["board-run-words"] }), article, keep)).toBe(false);
    expect(ownClick(el("div", article, { classes: ["board-made"] }), article, keep)).toBe(false);
    expect(ownClick(el("p", article, { classes: ["board-card-note"] }), article, keep)).toBe(false);
  });

  it("does not take a click from outside the card's elements, as a menu drawn into the body bubbles through React", () => {
    const menuRow = el("div", el("div", el("body", null)), { classes: ["menu-row"] });
    expect(ownClick(menuRow, article, keep)).toBe(false);
    expect(ownClick(null, article, keep)).toBe(false);
  });
});

describe("selectedIn", () => {
  const inside = { name: "text in the card" };
  const outside = { name: "text elsewhere" };
  const box = { contains: (node: Node | null) => node === (inside as unknown as Node) } as Pick<Node, "contains">;
  const selection = (over: Partial<Pick<Selection, "isCollapsed" | "rangeCount" | "anchorNode" | "focusNode">>) => ({
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: inside as unknown as Node,
    focusNode: inside as unknown as Node,
    ...over,
  });

  it("is a selection of the card's own text", () => {
    expect(selectedIn(selection({}), box)).toBe(true);
    expect(selectedIn(selection({ anchorNode: outside as unknown as Node }), box)).toBe(true);
  });

  it("is not a caret, nothing, or text somewhere else", () => {
    expect(selectedIn(null, box)).toBe(false);
    expect(selectedIn(selection({ isCollapsed: true }), box)).toBe(false);
    expect(selectedIn(selection({ rangeCount: 0 }), box)).toBe(false);
    expect(selectedIn(selection({ anchorNode: outside as unknown as Node, focusNode: outside as unknown as Node }), box)).toBe(false);
  });
});
