/**
 * Tags in Kuru's drawer: the row under the header that filters by them, the
 * chips on a line, and the button that adds or takes one off. The rules are
 * `shared/kurutags.ts`'s and the corrections the server's; this is their
 * drawing, kept out of `KuruDrawer.tsx` as the pins are, so the three pieces
 * read together and that file grows by the lines that place them.
 *
 * The row replaced the one that held a chip per node (All · mac · omarchy),
 * and keeps what it did: on a kururu linked with others the nodes are among
 * the tags, in their own hues, an away one greyed with its unheard count, so
 * narrowing to one node is still one press. What it adds is the workspaces,
 * the most recently talked about first, each pressed on or off — several at
 * once read as any of them, and a node with them as that node's lines about
 * any of them. "Todo" is everything.
 *
 * One line that scrolls sideways inside itself rather than rows that wrap:
 * twenty workspaces wrapped would push the conversation down by five rows,
 * and the row's own scroll is not the list's (the list never scrolls
 * sideways). A wheel turned over it scrolls it along, since a mouse has no
 * other way to.
 *
 * A workspace has no colour of its own since 2026-10-12, so its tag takes a
 * hue off its key the way a node takes one off its id (`nodeHue`), from the
 * same palette tokens: the same workspace is the same hue on every line and
 * every device, and no hex is written here.
 */
import { useState, type CSSProperties, type WheelEvent } from "react";
import type { PeerKuru } from "../../../shared/kuru";
import type { TagFilter } from "../../../shared/kurutags";
import { nodeHue } from "../../../shared/remote";
import { Menu, type MenuAt } from "./Menu";
import { hueStyle } from "./NodeChip";

/** A workspace's hue, as the custom property a tag tints itself by. */
export function tagHue(key: string): CSSProperties {
  return { "--tag-hue": `var(--ws-${nodeHue(key)})` } as CSSProperties;
}

/** A workspace as a tag draws it. */
export interface TagName {
  key: string;
  name: string;
}

/**
 * The row: Todo, the nodes when there are others, then the workspaces the
 * loaded lines are about, most recent first, and any picked that none of
 * them is about any more so it can still be let go of.
 */
export function TagRow({
  filter,
  spaces,
  self,
  peers,
  onPick,
}: {
  filter: TagFilter;
  /** The workspaces to offer, in order. */
  spaces: readonly TagName[];
  self: string;
  peers: readonly PeerKuru[];
  onPick: (next: TagFilter) => void;
}) {
  const none = !filter.spaces.length && !filter.nodes.length;
  const toggle = (list: readonly string[], value: string): string[] => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const pickNode = (name: string) => onPick({ ...filter, nodes: toggle(filter.nodes, name) });
  const pickSpace = (key: string) => onPick({ ...filter, spaces: toggle(filter.spaces, key) });
  const onWheel = (event: WheelEvent<HTMLElement>) => {
    const el = event.currentTarget;
    if (event.deltaX !== 0 || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft += event.deltaY;
  };
  return (
    <nav className="kuru-tags" aria-label="Show the conversation about" onWheel={onWheel}>
      <button type="button" className={`kuru-tag-chip ${none ? "kuru-tag-chip-on" : ""}`} aria-pressed={none} onClick={() => onPick({ spaces: [], nodes: [] })} title="The whole conversation">
        Todo
      </button>
      {peers.length > 0 && (
        <>
          <button
            type="button"
            className={`kuru-tag-chip kuru-tag-node ${filter.nodes.includes(self) ? "kuru-tag-chip-on" : ""}`}
            aria-pressed={filter.nodes.includes(self)}
            onClick={() => pickNode(self)}
            title="This node's Kuru"
          >
            {self}
          </button>
          {peers.map((peer) => {
            const gone = peer.state !== "up";
            const on = filter.nodes.includes(peer.node.name);
            const title = gone
              ? `${peer.node.name} ${peer.state === "away" ? "is away" : "is not linked yet"}${peer.lastSeen ? `, last seen ${new Date(peer.lastSeen).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""}. Its last items are kept here.`
              : peer.talks
                ? `The Kuru on ${peer.node.name}. Start a message with @${peer.node.name} to talk to it.`
                : `The kururu on ${peer.node.name} is too old to talk to; update it there.`;
            return (
              <button
                key={peer.node.id}
                type="button"
                className={`kuru-tag-chip kuru-tag-node ${on ? "kuru-tag-chip-on" : ""} ${gone ? "kuru-tag-chip-away" : ""}`}
                aria-pressed={on}
                onClick={() => pickNode(peer.node.name)}
                title={title}
                /* The node's own hue, the one its band and chips wear. */
                style={hueStyle(peer.node.id)}
              >
                <span className="node-chip-dot" aria-hidden="true" />
                {peer.node.name}
                {peer.unheard > 0 && <span className="kuru-node-count">{peer.unheard}</span>}
              </button>
            );
          })}
          <span className="kuru-tags-rule" aria-hidden="true" />
        </>
      )}
      {spaces.map((space) => {
        const on = filter.spaces.includes(space.key);
        return (
          <button
            key={space.key}
            type="button"
            className={`kuru-tag-chip ${on ? "kuru-tag-chip-on" : ""}`}
            aria-pressed={on}
            onClick={() => pickSpace(space.key)}
            title={on ? `Stop showing only ${space.name}` : `Show what was said about ${space.name}`}
            style={tagHue(space.key)}
          >
            <span className="kuru-tag-dot" aria-hidden="true" />
            {space.name}
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
            className="kuru-line-tag"
            style={tagHue(tag.key)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              onShow(tag.key);
            }}
            title={only ? "Show the whole conversation" : `Show only what was said about ${tag.name}`}
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
  // Its own first, then the rest as the row orders them.
  const rows = [...spaces.filter((s) => tagged.includes(s.key)), ...spaces.filter((s) => !tagged.includes(s.key))];
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
        title="Which workspaces this is about"
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
                  return { label: space.name, on, run: () => onSet(space.key, !on) };
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
