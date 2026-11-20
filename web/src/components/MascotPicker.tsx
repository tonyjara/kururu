/**
 * Which mascot a workspace's agents wear: the sidebar row's "Mascot…".
 *
 * Each one is drawn animating rather than named, for the same reason the colour
 * picker is swatches: you are choosing between pictures, and "Michi" means
 * nothing until you have seen it hop. The working clip is the one shown, since
 * that is the state you are actually looking for in a sidebar.
 *
 * A grid of badges with their names under them, and a box to type into, since
 * 2026-11-20 (the owner: "there's lots of mascots now and I can't scroll in
 * that dropdown and it's too tall"). It was a column of rows, one per mascot,
 * which at twenty-nine ran past the bottom of the window — and the menu's box
 * closes on a wheel, so the ones past the edge could not be reached at all. A
 * grid five across holds thirty in the height four rows of the old list took,
 * and the box is capped to the window and scrolls inside itself past that,
 * with a wheel over it scrolling it rather than closing it. Typing narrows it,
 * which is how you go to "Platypus" once you know its name; the arrows walk
 * the grid and Enter takes the one under the cursor, which starts on the
 * mascot already chosen, scrolled into view.
 *
 * "Default" is a row of its own above the grid rather than a tile in it, the
 * way "No colour" is a row under the swatches: following the default is a
 * choice with consequences, namely that changing the default later changes
 * this workspace too, and the row has room to say whose badge that is today.
 */
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MascotConfig, MascotSet } from "../../../shared/model";
import { defaultMascot } from "../../../shared/model";
import { matchOptions, stepGrid } from "../mascotpick";
import { type MenuAt, Popover } from "./Menu";
import { Mascot } from "./Status";

interface Option {
  id: string | null;
  name: string;
  also?: string;
  config: MascotConfig;
}

const STEPS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

export function MascotPicker({
  at,
  mascots,
  current,
  onPick,
  onClose,
}: {
  at: MenuAt;
  mascots: MascotSet;
  current: string | null;
  onPick: (mascotId: string | null) => void;
  onClose: () => void;
}) {
  const fallback = defaultMascot(mascots);
  const options = useMemo<Option[]>(
    () => [{ id: null, name: "Default", also: fallback.name, config: fallback }, ...mascots.list.map((one) => ({ id: one.id, name: one.name, config: one }))],
    [mascots, fallback],
  );
  const [query, setQuery] = useState("");
  const shown = useMemo(() => matchOptions(options, query), [options, query]);
  /** The default's row leads only while it is shown, and is first when it is. */
  const lead = shown[0]?.id === null ? 1 : 0;
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((one) => one.id === current)));
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const ids = useId();

  /**
   * The cursor is kept in sight as it moves, and on the first paint that puts
   * the current mascot in view — the one you opened this to change. `nearest`
   * rather than `center`, so a cursor walking inside the visible rows does not
   * drag the grid around under it.
   */
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, shown]);

  /**
   * Focused when there is a keyboard to type with. On a phone the box stays
   * unfocused, since focusing it would put the keyboard over the grid you
   * opened this to look at.
   */
  useLayoutEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) field.current?.focus({ preventScroll: true });
  }, []);

  /** Read off the grid rather than kept in step with the stylesheet: a narrow window has fewer. */
  const columns = (): number => {
    const grid = list.current?.querySelector<HTMLElement>(".mascot-grid");
    if (!grid) return 1;
    return Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length);
  };

  const onKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (STEPS.has(event.key) || ((event.key === "Home" || event.key === "End") && !query)) {
      event.preventDefault();
      setActive((at) => stepGrid(at, event.key, shown.length, columns(), lead));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = shown[active];
      if (chosen) onPick(chosen.id);
    }
  };

  const optionId = (index: number) => `${ids}-${index}`;
  const draw = (one: Option, index: number) => {
    const on = one.id === current;
    const cursor = index === active;
    const common = {
      id: optionId(index),
      role: "option",
      "aria-selected": on,
      "data-index": index,
      tabIndex: -1,
      onClick: () => onPick(one.id),
      onPointerDown: (event: React.PointerEvent) => event.preventDefault(),
    } as const;
    if (one.id === null) {
      return (
        <button key="default" {...common} className={`mascot-option ${on ? "mascot-option-on" : ""} ${cursor ? "mascot-cursor" : ""}`}>
          <span className="status status-working mascot-chip" role="img" aria-hidden>
            <Mascot config={one.config} clip={one.config.working} />
          </span>
          <span className="mascot-name">Default</span>
          <span className="set-note">{one.also}</span>
        </button>
      );
    }
    return (
      <button key={one.id} {...common} title={one.name} className={`mascot-tile ${on ? "mascot-option-on" : ""} ${cursor ? "mascot-cursor" : ""}`}>
        <span className="status status-working mascot-chip" role="img" aria-hidden>
          <Mascot config={one.config} clip={one.config.working} />
        </span>
        <span className="mascot-tile-name">{one.name}</span>
      </button>
    );
  };

  return (
    <Popover at={at} onClose={onClose} className="picker picker-mascots" role="dialog" closeOnScroll={false}>
      <input
        ref={field}
        className="mascot-find"
        type="text"
        role="combobox"
        aria-label="Find a mascot"
        aria-controls={`${ids}-list`}
        aria-expanded
        aria-activedescendant={shown[active] ? optionId(active) : undefined}
        placeholder={`Find a mascot (${mascots.list.length})`}
        spellCheck={false}
        autoComplete="off"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          // The best match, which is the first, is what Enter should take.
          setActive(0);
        }}
        onKeyDown={onKey}
      />
      <div ref={list} id={`${ids}-list`} className="mascot-list" role="listbox" aria-label="Mascots">
        {lead > 0 && draw(shown[0]!, 0)}
        {/* Drawn when empty too: it is what gives the box its width, and a box
            that narrows as you type is one whose find field moves under you. */}
        <div className="mascot-grid">{shown.slice(lead).map((one, i) => draw(one, i + lead))}</div>
        {shown.length === 0 && <p className="mascot-none">No mascot called “{query.trim()}”.</p>}
      </div>
    </Popover>
  );
}
