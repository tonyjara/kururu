/**
 * The right-click menu: the actions a row has, where the pointer already is.
 *
 * Everything in here is reachable another way — a keybind, a button, a drag —
 * and that is the point rather than a redundancy. A prefix keymap is worth
 * learning and worth nothing to somebody who has not learnt it yet, and the
 * sidebar has no room to print five buttons on every workspace. Right-click is
 * the one gesture that costs nothing until it is used.
 *
 * It closes on the first thing that happens next: a click anywhere (including
 * inside itself, after the item has run), a second right-click, escape, or a
 * scroll. A menu left open over a moving layout is pointing at the wrong row,
 * and the backdrop that catches those clicks is also what stops one reaching
 * the terminal underneath.
 *
 * **A row may open a list instead of doing something** — a profile card's
 * "Send to", whose list is every workspace in the profile. Twenty workspaces
 * spelt out as twenty rows made the card's own verbs the thing you scrolled
 * past to find. The list opens beside the menu, on whichever side has the
 * room, and in the menu's place on a phone or when neither side does. It is
 * one level deep on purpose: a menu you have to steer through is a dialog
 * that has not admitted it, and the type says so (`MenuParent` holds
 * actions, not items).
 *
 * **A pointer opens a list by resting on its row, not by passing it**
 * (`OPEN_MS`, `web/src/menuaim.ts`). Opening on the first touch of the row
 * meant that going down a card's menu past "Send to" put twenty workspaces
 * over the rows you were heading for (the owner, 2026-11-11). A click, Enter
 * or → still opens it at once. Once a list is open, a pointer on its way
 * there is let cross the rows under its row (`aiming`) and only a pointer
 * that has turned away, or stopped on one of them, closes it. And a hover
 * never draws a list in the menu's place: that is the whole menu gone under
 * a pointer that was only passing, so with no room beside, the row waits to
 * be clicked.
 *
 * **It takes the keyboard while it is open.** A list a mouse opens by hovering
 * has to be one a keyboard can open too, and a key can only open something it
 * reaches: so the menu focuses its own box on opening — no row lit, the way a
 * menu opened by a click looks — the arrows walk the rows, Right or Enter opens
 * a row's list and Left or Escape backs out of it. When it closes, focus goes
 * back where it came from, which is usually a terminal: a right-click that left
 * the keyboard nowhere would be typing into nothing until the next click.
 *
 * **A row may be a switch, and a switch does not close the menu.** It is the
 * one exception to closing on the first thing that happens: Settings' list of
 * models is a menu you go down, turning off three, and reopening it for each
 * would be a dropdown worse than the row of switches it replaced. It is one
 * field, `on`, rather than a "stay open" beside a "checked", because a switch
 * that shut the menu and a row that stayed open for no reason are both things
 * nobody wants. What it draws is the caller's snapshot, as every switch in
 * Settings does: the row changes when the answer comes back.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AIM_MS, aiming, OPEN_MS, type Point, REST_PX } from "../menuaim";

interface MenuRow {
  label: string;
  /** Draw a rule above this one — what separates "delete" from the rest. */
  sep?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /**
   * This row is the one you are already on. A menu that is a list of places
   * rather than a list of actions has to say which place you are in, or the
   * first thing you do with it is pick the one you are already standing in.
   */
  mark?: boolean;
  /** A few quiet characters on the right — a count, a number, a shortcut. */
  hint?: string;
  /**
   * Something in here has output nobody has looked at, drawn as the same dot a
   * tab carries. It is a separate field rather than a character in the label
   * because the label is what you read to find the row and the dot is what you
   * scan for, and because `mark` has already spent the bullet on "you are here"
   * — two bullets in one row would be a row saying two things with one glyph.
   */
  unread?: boolean;
  /** What a pointer resting on the row is told, for what the row has no room to say. */
  title?: string;
  /** A row that belongs to the one above it — a workspace's project under the workspace — drawn indented. */
  indent?: boolean;
}

/** A row that does something. */
export interface MenuAction extends MenuRow {
  run: () => void;
  /** This row is a switch, in this position, and `run` flips it — see the module comment. */
  on?: boolean;
}

/** A row that opens a list of its own — see the module comment. */
export interface MenuParent extends MenuRow {
  items: MenuAction[];
}

export type MenuItem = MenuAction | MenuParent;

export interface MenuAt {
  x: number;
  y: number;
  /**
   * `x` is where the box's right edge goes rather than its left: a dropdown
   * under a control at the end of a row, which would otherwise hang out past
   * the edge of the card it belongs to. The width is the box's own, so only
   * `Popover`, which measures it, can do the subtraction.
   */
  fromRight?: boolean;
}

/** How far a box keeps from the window's edge, as `Popover` does. */
const EDGE = 4;
/** How many of the pointer's last places are kept for the aim; the oldest is where the line starts. */
const TRAIL = 4;

/** The rows of a list a key can land on, in order. */
function stops(list: HTMLElement | null | undefined): HTMLButtonElement[] {
  return list ? [...list.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)")] : [];
}

/** One step through a list's rows, wrapping, from wherever the focus is. */
function step(list: HTMLElement | null | undefined, key: string): void {
  const rows = stops(list);
  if (!rows.length) return;
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    key === "Home" ? 0 : key === "End" ? rows.length - 1 : key === "ArrowDown" ? (at + 1) % rows.length : at <= 0 ? rows.length - 1 : at - 1;
  rows[next]?.focus();
}

export function Menu({ at, items, onClose }: { at: MenuAt; items: MenuItem[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  /**
   * The row whose list is open, whether it is drawn in the menu's place, and
   * whether a resting pointer opened it — which may only draw it beside.
   */
  const [open, setOpen] = useState<{ at: number; inPlace: boolean; hovered: boolean } | null>(null);
  // The timers below outlive the render that set them, so they read this.
  const openNow = useRef(open);
  openNow.current = open;
  /** Where the list beside the menu goes; null while it is drawn unseen to be measured. */
  const [sideAt, setSideAt] = useState<MenuAt | null>(null);
  /** The row a key asked for, focused once the list it is in has been drawn. */
  const focusNext = useRef<"first" | number | null>(null);
  /** Running while a pointer aiming at the open list has stopped on a row it was crossing. */
  const linger = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** The row the pointer is on while it is taken to be crossing it. */
  const crossing = useRef<number | null>(null);
  /** Running while the pointer rests on a row with a list: the row, and where the rest began. */
  const intent = useRef<{ row: number; from: Point; timer: ReturnType<typeof setTimeout> } | null>(null);
  /** The pointer's last few places over the menu, oldest first. */
  const trail = useRef<Point[]>([]);
  /** A row a resting pointer found no room beside, which waits to be clicked from then on. */
  const noRoom = useRef<number | null>(null);
  // Read while rendering, before the box below takes the focus — and read
  // once, so a second pass of the effect does not take the box for it.
  const [before] = useState(() => document.activeElement);

  useEffect(() => {
    box.current?.focus({ preventScroll: true });
    return () => {
      clearTimeout(linger.current);
      clearTimeout(intent.current?.timer);
      // Only when the focus went with the menu. A row that opened a field —
      // Rename, Edit — has put it somewhere on purpose.
      const now = document.activeElement;
      if ((!now || now === document.body) && before instanceof HTMLElement && before.isConnected) {
        before.focus({ preventScroll: true });
      }
    };
  }, [before]);

  const parent = open ? items[open.at] : undefined;
  const list = parent && "items" in parent ? parent : undefined;

  /**
   * The list beside the menu is drawn once unseen, measured, and then placed:
   * right of the menu if it fits, left if not, and in the menu's own place if
   * it fits neither — or, when a resting pointer asked, not at all. Its first row lines up with the row it came from, unless
   * that would run it off the bottom; a list taller than the window scrolls.
   */
  useLayoutEffect(() => {
    if (open && !open.inPlace && !sideAt) {
      const row = rows.current[open.at];
      const menu = box.current;
      const el = side.current;
      if (!row || !menu || !el) return;
      const r = row.getBoundingClientRect();
      const m = menu.getBoundingClientRect();
      const { width, height } = el.getBoundingClientRect();
      const x =
        m.right + 2 + width <= window.innerWidth - EDGE ? m.right + 2 : m.left - 2 - width >= EDGE ? m.left - 2 - width : null;
      if (x === null) {
        if (!open.hovered) return setOpen({ at: open.at, inPlace: true, hovered: false });
        noRoom.current = open.at;
        return setOpen(null);
      }
      const lift = el.clientTop + parseFloat(getComputedStyle(el).paddingTop);
      setSideAt({ x, y: Math.max(EDGE, Math.min(r.top - lift, window.innerHeight - height - EDGE)) });
      return;
    }
    const want = focusNext.current;
    focusNext.current = null;
    if (want === "first") stops(open?.inPlace ? box.current?.querySelector<HTMLElement>(".menu-list") : side.current)[0]?.focus();
    else if (typeof want === "number") rows.current[want]?.focus();
  }, [open, sideAt]);

  const openList = (index: number, keyed: boolean, hovered = false) => {
    clearTimeout(linger.current);
    markCrossing(null);
    cancelIntent();
    const open = openNow.current;
    if (open?.at === index) {
      if (keyed) stops(open.inPlace ? box.current?.querySelector<HTMLElement>(".menu-list") : side.current)[0]?.focus();
      return;
    }
    focusNext.current = keyed ? "first" : null;
    setSideAt(null);
    // A phone's layout gets it in place even where a list would squeeze in
    // beside: two boxes side by side fill that screen edge to edge. Read off
    // the mark `App` puts on the root, as the stylesheet does, so the one
    // breakpoint stays stated once. A resting pointer, though, is only ever
    // offered the list beside: see the module comment.
    setOpen({ at: index, inPlace: !hovered && document.documentElement.hasAttribute("data-narrow"), hovered });
  };
  /** Out of a list, back onto the row that opened it. */
  const back = () => {
    if (!open) return;
    focusNext.current = open.at;
    setOpen(null);
  };
  const pick = (item: MenuAction) => {
    item.run();
    if (item.on === undefined) onClose();
  };

  const keys = (event: React.KeyboardEvent, inSide: boolean) => {
    const key = event.key;
    // The keys have taken over from the pointer, and a rest it began must not open a list behind them.
    cancelIntent();
    const inList = inSide || !!open?.inPlace;
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
      step(inSide ? side.current : box.current, key);
    } else if (key === "ArrowRight" && !inList) {
      const index = rows.current.findIndex((row) => row && row === document.activeElement);
      const item = items[index];
      if (!item || !("items" in item) || item.disabled) return;
      openList(index, true);
    } else if ((key === "ArrowLeft" || key === "Escape") && inList) {
      back();
    } else if (key === "Escape" || key === "Tab") {
      onClose();
    } else if (key !== "Enter" && key !== " ") {
      return;
    }
    // Enter and Space are a row's own click, so they keep their default and
    // are only kept from going further — to a board behind, or the window.
    if (key !== "Enter" && key !== " ") event.preventDefault();
    event.stopPropagation();
  };

  /** The pointer on a row: it takes the focus, so the keys go on from there. */
  const hover = (row: HTMLButtonElement) => row.focus({ preventScroll: true });

  const cancelIntent = () => {
    clearTimeout(intent.current?.timer);
    intent.current = null;
  };
  /** Start (or start again) the rest on a row with a list, which opens it beside when it ends. */
  const armIntent = (index: number, from: Point) => {
    cancelIntent();
    intent.current = { row: index, from, timer: setTimeout(() => openList(index, false, true), OPEN_MS) };
  };
  /** Mark the menu while the pointer is crossing rows, so the row under it is not lit as if chosen. */
  const markCrossing = (index: number | null) => {
    crossing.current = index;
    if (box.current) box.current.toggleAttribute("data-aiming", index !== null);
  };

  /** Whether the pointer, now at `to`, is on its way into the list open beside. */
  const aimingAt = (to: Point): boolean => {
    const open = openNow.current;
    const el = side.current;
    const menu = box.current;
    const from = trail.current[0];
    if (!open || open.inPlace || !el || !menu || !from || el.style.visibility === "hidden") return false;
    const list = el.getBoundingClientRect();
    return aiming(from, to, list, list.left >= menu.getBoundingClientRect().left);
  };

  /**
   * The pointer has arrived on a row and means it: the row takes the focus, a
   * list open from another row closes, and a row with a list starts its rest.
   */
  const settle = (index: number, at: Point) => {
    clearTimeout(linger.current);
    markCrossing(null);
    const row = rows.current[index];
    if (row) hover(row);
    const open = openNow.current;
    if (open && !open.inPlace && open.at !== index) setOpen(null);
    const item = items[index];
    if (item && "items" in item && !item.disabled && open?.at !== index && noRoom.current !== index) armIntent(index, at);
    else cancelIntent();
  };

  /** The pointer onto one of the menu's own rows. */
  const enter = (index: number, at: Point) => {
    const open = openNow.current;
    if (open && !open.inPlace && open.at !== index && aimingAt(at)) {
      markCrossing(index);
      clearTimeout(linger.current);
      linger.current = setTimeout(() => crossing.current !== null && settle(crossing.current, at), AIM_MS);
      return;
    }
    settle(index, at);
  };

  /** Every move over the menu: the trail the aim is read from, a crossing that turns away, a rest that did not hold still. */
  const move = (event: React.PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    const at = { x: event.clientX, y: event.clientY };
    const index = crossing.current;
    if (index !== null) {
      if (aimingAt(at)) {
        clearTimeout(linger.current);
        linger.current = setTimeout(() => crossing.current !== null && settle(crossing.current, at), AIM_MS);
      } else settle(index, at);
    }
    const resting = intent.current;
    if (resting && Math.hypot(at.x - resting.from.x, at.y - resting.from.y) > REST_PX) armIntent(resting.row, at);
    trail.current = [...trail.current, at].slice(-TRAIL);
  };

  const aside =
    list && open && !open.inPlace ? (
      <div
        ref={side}
        className="menu menu-side"
        role="menu"
        aria-label={list.label}
        style={sideAt ? { left: sideAt.x, top: sideAt.y } : { left: 0, top: 0, visibility: "hidden" }}
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
        onPointerEnter={() => {
          clearTimeout(linger.current);
          markCrossing(null);
          cancelIntent();
          // What it did out there says nothing about where it goes next on the way back.
          trail.current = [];
        }}
        // A long list scrolls under the wheel, which the backdrop would
        // otherwise take as the layout moving and close everything.
        onWheel={(event) => event.stopPropagation()}
        onKeyDown={(event) => keys(event, true)}
      >
        {list.items.map((item, index) => (
          <Row key={index} item={item} onClick={() => pick(item)} onHover={hover} />
        ))}
      </div>
    ) : null;

  return (
    <Popover
      at={at}
      onClose={onClose}
      className="menu"
      role="menu"
      boxRef={box}
      onKeyDown={(event) => keys(event, false)}
      onPointerMove={move}
      aside={aside}
    >
      {list && open?.inPlace ? (
        <>
          <button className="menu-item menu-back" role="menuitem" aria-label={`Back from ${list.label}`} onClick={back}>
            <span className="menu-mark" aria-hidden>
              ‹
            </span>
            <span className="menu-label">{list.label}</span>
          </button>
          <div className="menu-list" role="group" aria-label={list.label} onWheel={(event) => event.stopPropagation()}>
            {list.items.map((item, index) => (
              <Row key={index} item={item} onClick={() => pick(item)} onHover={hover} />
            ))}
          </div>
        </>
      ) : (
        items.map((item, index) => (
          <Row
            // By position, not by label: a menu of workspaces or profiles is a
            // menu of things a person named, and two of them may be called the
            // same thing. The list is built fresh each time it opens, so there is
            // no reordering for a key to survive.
            key={index}
            item={item}
            open={open?.at === index}
            rowRef={(el) => {
              rows.current[index] = el;
            }}
            // A tap or a click opens a row's list at once and leaves it open;
            // only Enter and Space arrive with no clicks counted, and they
            // move into the list as Right does.
            onClick={(event) => ("items" in item ? openList(index, event.detail === 0) : pick(item))}
            onHover={(_, at) => enter(index, at)}
            onLeave={() => {
              if (intent.current?.row === index) cancelIntent();
            }}
          />
        ))
      )}
    </Popover>
  );
}

function Row({
  item,
  open = false,
  rowRef,
  onClick,
  onHover,
  onLeave,
}: {
  item: MenuItem;
  open?: boolean;
  rowRef?: (el: HTMLButtonElement | null) => void;
  onClick: (event: React.MouseEvent) => void;
  /** A mouse over the row; a finger has no hover and opens a list by tapping. */
  onHover: (row: HTMLButtonElement, at: Point) => void;
  onLeave?: () => void;
}) {
  const opens = "items" in item;
  const on = "items" in item ? undefined : item.on;
  return (
    <button
      ref={rowRef}
      role={on === undefined ? "menuitem" : "menuitemcheckbox"}
      className={`menu-item ${item.danger ? "menu-danger" : ""} ${item.sep ? "menu-sep" : ""} ${item.indent ? "menu-indent" : ""} ${open ? "menu-item-open" : ""}`}
      disabled={item.disabled}
      title={item.title}
      aria-checked={on}
      aria-haspopup={opens ? "menu" : undefined}
      aria-expanded={opens ? open : undefined}
      onClick={onClick}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") onHover(event.currentTarget, { x: event.clientX, y: event.clientY });
      }}
      onPointerLeave={onLeave}
    >
      {/* Always rendered, so the labels line up whether or not anything in
          this menu is markable — a list that shifts sideways by a character
          when one row is current is a list you re-read. */}
      <span className="menu-mark" aria-hidden>
        {item.mark ? "•" : ""}
      </span>
      <span className="menu-label">{item.label}</span>
      {item.unread && <span className="unread" aria-label="waiting for you" />}
      {item.hint && <span className="menu-hint">{item.hint}</span>}
      {on !== undefined && <span className={`menu-switch${on ? " menu-switch-on" : ""}`} aria-hidden />}
      {opens && (
        <span className="menu-more" aria-hidden>
          ›
        </span>
      )}
    </button>
  );
}

/**
 * The box a menu is drawn in, without the menu.
 *
 * Split out when the colour picker needed the same thing and was not a list of
 * labelled items — a grid of swatches has no `label`, and bending `MenuItem`
 * into a shape that could carry one would have made every caller of it carry the
 * possibility. What is actually shared is smaller than a menu and duller: where
 * the box goes when it does not fit, and the four ways it closes. Those are
 * exactly the parts that are easy to get subtly wrong twice.
 *
 * `closeOnScroll` is the escape hatch from the fourth way: a box with its own
 * scrolling content (the missed-replies list) needs a wheel over *it* to
 * scroll the list, not close the box — only a wheel over the backdrop, outside
 * it, still means "the layout underneath moved."
 *
 * **Drawn into `document.body`, wherever it was opened from.** A pane is a
 * stacking context of its own (`.pane`'s `isolation`), so a menu opened on a
 * board in one could climb no higher than the pane: the drawers, the sidebar
 * over a phone and the floating notes all covered it, whatever its
 * `z-index`. A portal changes where it is in the document and nothing about
 * how it behaves — React still bubbles its events up the tree it was written
 * in, so the pane under it hears a press on it as it did — and it inherits
 * nothing from `.app` it needs, the type being `body`'s.
 */
export function Popover({
  at,
  onClose,
  className,
  role,
  closeOnScroll = true,
  boxRef,
  onKeyDown,
  onPointerMove,
  aside,
  children,
}: {
  at: MenuAt;
  onClose: () => void;
  className: string;
  role?: string;
  closeOnScroll?: boolean;
  /** The box, for a caller that focuses it; a box given keys can take the focus. */
  boxRef?: React.RefObject<HTMLDivElement | null>;
  onKeyDown?: (event: React.KeyboardEvent) => void;
  onPointerMove?: (event: React.PointerEvent) => void;
  /** Drawn over the backdrop beside the box rather than in it — a menu row's list. */
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  const own = useRef<HTMLDivElement>(null);
  const box = boxRef ?? own;
  /**
   * Where it actually fits. It is measured rather than guessed because the
   * height depends on how many items a row has, and a menu opened near the
   * bottom of a short window would otherwise hang off the end of it.
   */
  const [at2, setAt2] = useState(at);

  // A layout effect, so a box placed by its right edge is never painted once
  // with its left edge there instead.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      const { width, height } = el.getBoundingClientRect();
      setAt2({
        x: Math.max(4, Math.min(at.fromRight ? at.x - width : at.x, window.innerWidth - width - 4)),
        y: Math.max(4, Math.min(at.y, window.innerHeight - height - 4)),
      });
    };
    fit();
    // And again whenever the box changes size, because what it holds can
    // change while it is open: a row's list drawn in the menu's place is
    // longer and wider than the menu was, and is fitted from the same point.
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, [at, box]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="menu-backdrop"
      onPointerDown={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
      onWheel={closeOnScroll ? onClose : undefined}
    >
      <div
        ref={box}
        className={className}
        style={{ left: at2.x, top: at2.y }}
        role={role}
        tabIndex={onKeyDown ? -1 : undefined}
        onKeyDown={onKeyDown}
        onPointerMove={onPointerMove}
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        {children}
      </div>
      {aside}
    </div>,
    document.body,
  );
}
