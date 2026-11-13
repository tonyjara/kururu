/**
 * Tags in Kuru's drawer: the filter that narrows the conversation by them —
 * its button in the header, its panel, and the strip that says what is
 * picked — the chips on a line, and the button that adds or takes one off.
 * The rules are `shared/kurutags.ts`'s and the corrections the server's; this
 * is their drawing, kept out of `KuruDrawer.tsx` as the pins are, so the
 * pieces read together and that file grows by the lines that place them.
 *
 * **The filter is a button and a panel, where it was a row.** The row under
 * the header (Todo · the nodes · a chip per workspace) held four chips in a
 * drawer of four hundred pixels and scrolled the other twenty sideways, and
 * the owner has twenty-one workspaces (2026-11-12: "they don't all fit, maybe
 * we can have a filters button?"). The panel is a list that is typed into,
 * ordered so its top is short (`kurufilter.ts`), and every row is a switch
 * that leaves it open, so several are picked in one visit while the list
 * behind it narrows. It keeps what the row did: the nodes are in it on a
 * kururu linked with others, in their own hues, an away one greyed with its
 * unheard count; several workspaces read as any of them, and a node with
 * them as that node's lines about any of them. "Todo" is everything.
 *
 * **It hangs from the header inside the drawer** rather than being a menu in
 * `document.body`: the floating chat is a window 320 by 260 at its smallest
 * and a phone's drawer is a sheet, and in both a box positioned against the
 * drawer's own edges cannot be drawn outside what is there to draw it in. It
 * lies over the list and does not push it, so the line being read stays put
 * while the filter is chosen.
 *
 * **What is picked is always in sight**, as it was when a lit chip said so:
 * a strip under the header, drawn only while something is picked, with those
 * chips and Todo before them. A chip pressed is let go of.
 *
 * A workspace has no colour of its own since 2026-10-12, so its tag takes a
 * hue off its key the way a node takes one off its id (`nodeHue`), from the
 * same palette tokens: the same workspace is the same hue on every line and
 * every device, and no hex is written here.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type WheelEvent } from "react";
import type { PeerKuru } from "../../../shared/kuru";
import type { TagFilter } from "../../../shared/kurutags";
import { nodeHue } from "../../../shared/remote";
import { dropLast, filterGroups, onlyRow, pressRow, rowCovered, rowId, rowOn, type FilterNode, type FilterRow } from "../kurufilter";
import { fingerPointer } from "../terminals";
import { Icon } from "./Icon";
import { Menu, type MenuAt } from "./Menu";
import { hueStyle } from "./NodeChip";

/** A workspace's hue, as the custom property a tag tints itself by. */
export function tagHue(key: string): CSSProperties {
  return { "--tag-hue": `var(--ws-${nodeHue(key)})` } as CSSProperties;
}

/**
 * A workspace or a project as a tag draws it. A project wears its
 * workspace's hue, so the four of Shared Landings read as one family, and
 * says which workspace it is in where there is room and on hover where there
 * is not.
 */
export interface TagName {
  key: string;
  name: string;
  /** A project's workspace; absent for a workspace. */
  parent?: { key: string; name: string };
  /** A project's other names, which the filter's field finds it by. */
  names?: readonly string[];
}

/** The hue a tag wears: its own workspace's, a project's workspace's. */
function hueOf(tag: { key: string; parent?: { key: string } | null }): CSSProperties {
  return tagHue(tag.parent?.key ?? tag.key);
}

/** What a node's row or chip says when hovered: how its link stands, and how to talk to it. */
function peerTitle(peer: PeerKuru): string {
  if (peer.state !== "up") {
    const seen = peer.lastSeen ? `, last seen ${new Date(peer.lastSeen).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "";
    return `${peer.node.name} ${peer.state === "away" ? "is away" : "is not linked yet"}${seen}. Its last items are kept here.`;
  }
  return peer.talks ? `The Kuru on ${peer.node.name}. Start a message with @${peer.node.name} to talk to it.` : `The kururu on ${peer.node.name} is too old to talk to; update it there.`;
}

/**
 * The header's door to the filter: the funnel, the word where the header has
 * the room for it, and how many things are picked. In the accent while
 * anything is, since a list that is not the whole conversation should say so
 * from the place that made it so.
 */
export function FilterButton({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  const title = `${count ? `Showing ${count === 1 ? "one thing" : `${count} things`} only. ` : ""}Choose which workspaces and nodes the conversation shows (⌘⇧F)`;
  return (
    <button
      type="button"
      className={`kuru-head-btn kuru-head-icon kuru-filter-btn ${open ? "kuru-head-btn-on" : count ? "kuru-head-btn-set" : ""}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={count ? `Filter the conversation, ${count} picked` : "Filter the conversation"}
      title={title}
      // The keyboard stays where it is until the panel takes it: a press that
      // moved the focus first would have it remembered as where to go back to.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
    >
      <FilterIcon />
      <span className="kuru-head-label">Filter</span>
      {count > 0 && <span className="kuru-head-count">{count}</span>}
    </button>
  );
}

/**
 * The panel. The field has the keyboard from the moment it opens — not on a
 * touch screen, where that is a keyboard over the list being chosen from —
 * and the arrows walk the rows from it, so nothing in here needs the Tab key:
 * Enter switches the row the arrows are on, Shift+Enter makes it the only
 * one and closes, Backspace in an empty field lets go of the last one picked,
 * and Escape closes. A pointer does the same with a press on a row and with
 * the "only" at its end.
 *
 * `onClose(back)` says whether the keyboard should go back where it was: yes
 * for the keys, no for a press outside, which has already put it somewhere.
 */
export function FilterPanel({
  filter,
  self,
  peers,
  lately,
  spaces,
  onPick,
  onClose,
  onEditing,
}: {
  filter: TagFilter;
  self: string;
  peers: readonly PeerKuru[];
  /** Workspace keys, the most recently talked about first. */
  lately: readonly string[];
  /** Every workspace of the profile. */
  spaces: readonly TagName[];
  onPick: (next: TagFilter) => void;
  onClose: (back: boolean) => void;
  /** The field has the keyboard, so the prefix and the panes must leave it alone. */
  onEditing: (editing: boolean) => void;
}) {
  const [typed, setTyped] = useState("");
  /** The row the arrows are on, by id; null until one is pressed, when Enter takes the first. */
  const [at, setAt] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const nodes: FilterNode[] = peers.length
    ? [{ name: self, id: null, state: "up", unheard: 0, talks: true }, ...peers.map((peer) => ({ name: peer.node.name, id: peer.node.id, state: peer.state, unheard: peer.unheard, talks: peer.talks }))]
    : [];
  const groups = filterGroups({ typed, nodes, lately, spaces });
  const rows = groups.flatMap((group) => group.rows);
  const active = rows.find((row) => rowId(row) === at) ?? null;

  useEffect(() => {
    if (!fingerPointer()) field.current?.focus();
  }, []);
  // A press anywhere else closes it, and is still a press on whatever it was
  // on — the list, a terminal, the box — since the panel is not modal. The
  // filter's own button is left to close it itself, or it would shut on the
  // press and open again on the click.
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || box.current?.contains(target) || target.closest(".kuru-filter-btn")) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose]);
  // The row the arrows reached, kept in view of the panel's own scroll.
  useLayoutEffect(() => {
    if (at) box.current?.querySelector(`[data-row="${CSS.escape(at)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const press = (row: FilterRow) => onPick(pressRow(filter, row));
  const only = (row: FilterRow) => {
    onPick(onlyRow(row));
    onClose(true);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      if (!rows.length || ((event.key === "Home" || event.key === "End") && typed)) return;
      event.preventDefault();
      const i = active ? rows.indexOf(active) : -1;
      const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : event.key === "ArrowDown" ? (i + 1) % rows.length : i <= 0 ? rows.length - 1 : i - 1;
      setAt(rowId(rows[next]!));
    } else if (event.key === "Enter") {
      event.preventDefault();
      // With something typed and no arrow pressed, Enter means the first thing found.
      const row = active ?? (typed.trim() ? rows[0] : undefined);
      if (!row) return;
      if (event.shiftKey) only(row);
      else press(row);
    } else if (event.key === "Backspace" && !typed && (filter.spaces.length || filter.nodes.length)) {
      event.preventDefault();
      onPick(dropLast(filter));
    }
  };

  const listId = "kuru-filter-rows";
  return (
    <div className="kuru-filter-anchor">
      <div className="kuru-filter" ref={box} role="dialog" aria-label="Show the conversation about" onKeyDown={onKeyDown}>
        <div className="kuru-filter-find">
          <FindIcon />
          <input
            ref={field}
            className="kuru-filter-field"
            type="text"
            value={typed}
            placeholder={peers.length ? "Workspace, project or node…" : spaces.some((space) => space.parent) ? "Workspace or project…" : "Workspace…"}
            aria-label="Find a workspace, a project or a node"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={active ? `kuru-filter-${rowId(active)}` : undefined}
            enterKeyHint="done"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(event) => {
              setTyped(event.target.value);
              setAt(null);
            }}
            onFocus={() => onEditing(true)}
            onBlur={() => onEditing(false)}
          />
          <button type="button" className="kuru-quoting-cancel" onMouseDown={(event) => event.preventDefault()} onClick={() => onClose(true)} title="Close (Esc)" aria-label="Close the filter">
            <Icon name="close" />
          </button>
        </div>
        <div className="kuru-filter-rows" id={listId} role="listbox" aria-multiselectable aria-label="Workspaces and nodes">
          {groups.map((group, g) => (
            <Fragment key={group.title ?? `g${g}`}>
              {group.title && (
                <div className="kuru-filter-title" role="presentation">
                  {group.title}
                </div>
              )}
              {group.rows.map((row) => {
                const id = rowId(row);
                const on = rowOn(filter, row);
                const covered = !on && rowCovered(filter, row);
                const peer = row.kind === "node" && row.id !== null ? peers.find((p) => p.node.id === row.id) : undefined;
                const gone = row.kind === "node" && row.state !== "up";
                return (
                  <div
                    key={id}
                    id={`kuru-filter-${id}`}
                    data-row={id}
                    role="option"
                    aria-selected={on}
                    className={`kuru-filter-row ${on ? "kuru-filter-row-on" : ""} ${covered ? "kuru-filter-row-covered" : ""} ${row.kind === "space" && row.depth === 1 ? "kuru-filter-row-inner" : ""} ${at === id ? "kuru-filter-row-at" : ""} ${gone ? "kuru-filter-row-away" : ""}`}
                    title={
                      row.kind === "todo"
                        ? "The whole conversation"
                        : peer
                          ? peerTitle(peer)
                          : row.kind === "node"
                            ? "This node's Kuru"
                            : covered
                              ? `In ${row.parent!.name}, which is picked`
                              : row.kind === "space" && row.parent
                                ? `${row.name}, a project in ${row.parent.name}`
                                : undefined
                    }
                    style={row.kind === "space" ? hueOf(row) : row.kind === "node" && row.id !== null ? hueStyle(row.id) : undefined}
                    // The field keeps the keyboard, so the next thing typed still narrows the rows.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => press(row)}
                  >
                    <span className="kuru-filter-check" aria-hidden="true" />
                    {row.kind === "space" ? <span className="kuru-tag-dot" aria-hidden="true" /> : row.kind === "node" && row.id !== null ? <span className="node-chip-dot" aria-hidden="true" /> : null}
                    <span className="kuru-filter-name">{row.kind === "todo" ? "Todo" : row.name}</span>
                    {row.kind === "todo" && <span className="kuru-filter-hint">the whole conversation</span>}
                    {row.kind === "space" && row.parent && row.depth === 0 && <span className="kuru-filter-hint">{row.parent.name}</span>}
                    {row.kind === "node" && row.id === null && <span className="kuru-filter-hint">this node</span>}
                    {row.kind === "node" && gone && <span className="kuru-filter-hint">{row.state === "away" ? "away" : "not linked yet"}</span>}
                    {row.kind === "node" && !gone && !row.talks && <span className="kuru-filter-hint">too old</span>}
                    {row.kind === "node" && row.unheard > 0 && (
                      <span className="kuru-node-count" title={`${row.unheard} unheard`}>
                        {row.unheard}
                      </span>
                    )}
                    {row.kind !== "todo" && (
                      <button
                        type="button"
                        className="kuru-filter-only"
                        tabIndex={-1}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => {
                          event.stopPropagation();
                          only(row);
                        }}
                        title={`Show only ${row.name} (Shift+Enter)`}
                      >
                        only
                      </button>
                    )}
                  </div>
                );
              })}
            </Fragment>
          ))}
          {rows.length === 0 && (
            <div className="kuru-filter-none" role="status">
              {spaces.length || peers.length ? <>Nothing here is called “{typed.trim()}”.</> : "No workspaces in this profile"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * What the list is narrowed to, under the header while it is narrowed: Todo,
 * which lets go of everything, then the nodes and the workspaces picked, each
 * let go of by a press. One line that scrolls along inside itself if somebody
 * picks more than fit — the list never scrolls sideways — and a wheel turned
 * over it scrolls it, since a mouse has no other way to.
 */
export function FilterStrip({
  filter,
  tagOf,
  peers,
  onPick,
}: {
  filter: TagFilter;
  /** A workspace or a project by its key. */
  tagOf: ReadonlyMap<string, TagName>;
  peers: readonly PeerKuru[];
  onPick: (next: TagFilter) => void;
}) {
  const onWheel = (event: WheelEvent<HTMLElement>) => {
    const el = event.currentTarget;
    if (event.deltaX !== 0 || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft += event.deltaY;
  };
  return (
    <nav className="kuru-tags" aria-label="The conversation is narrowed to" onWheel={onWheel}>
      <button type="button" className="kuru-tag-chip" onClick={() => onPick({ spaces: [], nodes: [] })} title="Show the whole conversation again">
        Todo
      </button>
      {filter.nodes.map((name) => {
        const peer = peers.find((p) => p.node.name === name);
        return (
          <button
            key={`node-${name}`}
            type="button"
            className={`kuru-tag-chip kuru-tag-node kuru-tag-chip-on ${peer && peer.state !== "up" ? "kuru-tag-chip-away" : ""}`}
            onClick={() => onPick({ ...filter, nodes: filter.nodes.filter((n) => n !== name) })}
            title={`Stop showing only ${name}`}
            style={peer ? hueStyle(peer.node.id) : undefined}
          >
            {peer && <span className="node-chip-dot" aria-hidden="true" />}
            <span className="kuru-tag-name">{name}</span>
            {peer && peer.unheard > 0 && <span className="kuru-node-count">{peer.unheard}</span>}
            <Icon name="close" className="kuru-tag-x" />
          </button>
        );
      })}
      {filter.spaces.map((key) => {
        const tag = tagOf.get(key) ?? { key, name: key };
        return (
          <button
            key={`space-${key}`}
            type="button"
            className="kuru-tag-chip kuru-tag-chip-on"
            onClick={() => onPick({ ...filter, spaces: filter.spaces.filter((k) => k !== key) })}
            title={`Stop showing only ${tag.name}${tag.parent ? ` (in ${tag.parent.name})` : ""}`}
            style={hueOf(tag)}
          >
            <span className="kuru-tag-dot" aria-hidden="true" />
            <span className="kuru-tag-name">{tag.name}</span>
            {tag.parent && <span className="kuru-tag-in">{tag.parent.name}</span>}
            <Icon name="close" className="kuru-tag-x" />
          </button>
        );
      })}
    </nav>
  );
}

/**
 * A line's tags, small, after its time. A press shows that workspace's
 * thread — or, when it is already what is shown, the whole conversation again.
 */
export function LineTags({ tags, filter, onShow }: { tags: readonly TagName[]; filter: TagFilter; onShow: (key: string) => void }) {
  if (!tags.length) return null;
  return (
    <span className="kuru-line-tags">
      {tags.map((tag) => {
        const only = filter.spaces.length === 1 && filter.spaces[0] === tag.key;
        return (
          <button
            key={tag.key}
            type="button"
            className={`kuru-line-tag ${tag.parent ? "kuru-line-tag-project" : ""}`}
            style={hueOf(tag)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              onShow(tag.key);
            }}
            title={`${tag.parent ? `${tag.name}, in ${tag.parent.name}. ` : ""}${only ? "Show the whole conversation" : `Show only what was said about ${tag.name}`}`}
          >
            <span className="kuru-tag-dot" aria-hidden="true" />
            {tag.name}
          </button>
        );
      })}
    </span>
  );
}

/**
 * The tag on a line, beside its pin and on its terms: on hover, quietly always
 * on a touch screen. It opens the profile's workspaces as switches, the line's
 * own on, and a switch keeps the menu open (`Menu`) so three can be set in one
 * visit. What it shows is the line's tags as the drawer has them, with the
 * presses not yet answered laid over them.
 */
export function TagButton({ tagged, spaces, onSet }: { tagged: readonly string[]; spaces: readonly TagName[]; onSet: (key: string, on: boolean) => void }) {
  const [at, setAt] = useState<MenuAt | null>(null);
  // Every workspace with its projects under it, as given; the ones the line
  // wears, or wears a project of, first, so what it is tagged with is in view.
  const families = spaces.filter((s) => !s.parent).map((top) => [top, ...spaces.filter((s) => s.parent?.key === top.key)]);
  const wears = (family: TagName[]) => family.some((s) => tagged.includes(s.key));
  const rows = [...families.filter(wears), ...families.filter((family) => !wears(family))].flat();
  return (
    <>
      <button
        type="button"
        className={`kuru-tag-btn ${at ? "kuru-tag-btn-open" : ""}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          const box = event.currentTarget.getBoundingClientRect();
          setAt({ x: box.right, y: box.bottom + 2, fromRight: true });
        }}
        title="Which workspaces and projects this is about"
        aria-label="Tags"
        aria-haspopup="menu"
      >
        <TagIcon />
      </button>
      {at && (
        <Menu
          at={at}
          onClose={() => setAt(null)}
          items={
            rows.length
              ? rows.map((space) => {
                  const on = tagged.includes(space.key);
                  return {
                    label: space.name,
                    on,
                    indent: space.parent !== undefined,
                    title: space.parent ? `${space.name}, a project in ${space.parent.name}` : undefined,
                    run: () => onSet(space.key, !on),
                  };
                })
              : [{ label: "No workspaces in this profile", disabled: true, run: () => {} }]
          }
        />
      )}
    </>
  );
}

function TagIcon() {
  return (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
    </svg>
  );
}

/** A funnel, for the filter — drawn here for `TagIcon`'s reason: a picture that means the same in any chrome. */
function FilterIcon() {
  return (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 5h17l-6.5 7.6V18l-4 2v-7.4Z" />
    </svg>
  );
}

/** The magnifier in the panel's field, as the conversation's own search wears it. */
function FindIcon() {
  return (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </svg>
  );
}
