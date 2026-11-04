/**
 * Pins in Kuru's drawer: the pin on a line, the header's count, and the list
 * the count opens. The rules are `shared/kurupin.ts`'s and the pins the
 * server's; this is only their drawing, kept out of `KuruDrawer.tsx` so the
 * three pieces read together and that file grows by the lines that place them.
 *
 * The list is a strip under the header, as the search's field is, rather than
 * a menu or a popover: on a phone the drawer is a sheet over the whole screen
 * and a popover over a sheet is a third layer to dismiss, while a strip is the
 * drawer's own and goes when its button is pressed again or a pin is opened.
 */
import type { KuruPin } from "../../../shared/kurupin";
import { pinOpening } from "../../../shared/kurupin";
import { Icon } from "./Icon";

/**
 * The pin on a line, after its reply arrow and its fold and on their terms —
 * on hover where there is a pointer, quietly always on a touch screen — except
 * that a pinned line wears it always and in the accent, which is how a line
 * looks pinned. Pressed again it comes off.
 */
export function PinButton({ pinned, onPin }: { pinned: boolean; onPin: () => void }) {
  return (
    <button
      type="button"
      className={`kuru-pin-btn ${pinned ? "kuru-pin-on" : ""}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPin}
      title={pinned ? "Unpin this message" : "Pin this message"}
      aria-label="Pin this message"
      aria-pressed={pinned}
    >
      <PinIcon filled={pinned} />
    </button>
  );
}

/** The header's door to the list, with how many there are. Drawn only once something is pinned. */
export function PinsButton({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`kuru-head-btn kuru-pins-btn ${open ? "kuru-head-btn-on" : ""}`}
      aria-pressed={open}
      aria-label={`Pinned messages, ${count}`}
      title={open ? "Hide the pinned messages" : "Pinned messages"}
      onClick={onToggle}
    >
      <PinIcon filled={open} />
      <span className="kuru-pins-count">{count}</span>
    </button>
  );
}

/**
 * Every pin, newest said first: who, when, and the words it opens with. A
 * press opens the chat at the line; the ✕ takes the pin off without going
 * there.
 */
export function PinsList({ pins, onOpen, onUnpin, onClose }: { pins: readonly KuruPin[]; onOpen: (pin: KuruPin) => void; onUnpin: (pin: KuruPin) => void; onClose: () => void }) {
  return (
    <div className="kuru-pins" role="region" aria-label="Pinned messages">
      <div className="kuru-pins-head">
        <PinIcon filled />
        <span className="kuru-pins-title">Pinned</span>
        <button type="button" className="kuru-quoting-cancel" onClick={onClose} title="Hide the pinned messages" aria-label="Hide the pinned messages">
          <Icon name="close" />
        </button>
      </div>
      <ol className="kuru-pins-list">
        {pins.map((pin) => (
          <li key={pin.id} className="kuru-pins-row">
            <button type="button" className="kuru-pins-open" onClick={() => onOpen(pin)} title="Show this in the chat">
              <span className="kuru-pins-who">{pinWho(pin)}</span>
              <time dateTime={new Date(pin.item.at).toISOString()}>{pinnedWhen(pin.item.at)}</time>
              <span className="kuru-pins-words">{pinOpening(pin.item) || "…"}</span>
            </button>
            <button type="button" className="kuru-pin-btn kuru-pins-unpin" onClick={() => onUnpin(pin)} title="Unpin this message" aria-label="Unpin this message">
              <Icon name="close" />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function pinWho(pin: KuruPin): string {
  return pin.item.kind === "you" ? "You" : pin.item.kind === "kuru" ? "Kuru" : pin.item.from;
}

/** The time alone today, the day and the time before then, and the year once it is another year's. */
function pinnedWhen(at: number): string {
  const when = new Date(at);
  const now = new Date();
  const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (when.toDateString() === now.toDateString()) return time;
  const day = when.toLocaleDateString([], { month: "short", day: "numeric", ...(when.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
  return `${day} ${time}`;
}

/** A pushpin — drawn here for the drawer's own icons' reason: a picture of a physical object that means the same in any chrome. Filled once pinned. */
export function PinIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 3h6l-1 1.5V9l3 4H7l3-4V4.5Z" fill={filled ? "currentColor" : "none"} />
      <path d="M12 13v8" />
    </svg>
  );
}
