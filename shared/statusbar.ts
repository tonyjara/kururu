/**
 * Which of the bottom bar's chips are drawn — Settings → Bottom bar.
 *
 * The bar grew a chip at a time (the allowances, this Mac's load, the
 * machines, the nodes, OpenRouter) and every one was right for somebody, but not every
 * one for everybody: a person who already watches their Mac's load in another
 * tool reads the load chip as noise at the edge of the eye. So each one that
 * is *information* gets a switch, and the ones that are controls or modes —
 * PREFIX, RESIZE, reconnecting, the phone's pane swap and key bar toggle — do
 * not, because hiding a mode is how a modal interface stops being trusted,
 * and hiding a control on a phone hides the only door to what it does.
 *
 * What is kept is the list of chips switched **off**, not the ones on, which
 * is `LaunchSettings`'s shape and for its reason: a chip added in a later
 * version is shown to everybody until somebody says otherwise, rather than
 * hidden from everybody whose file predates it.
 *
 * It lives in `Appearance` — `appearance.json`, the snapshot, one verb — since
 * it is what the window looks like and nothing else: the phone and the desktop
 * agree about it, and hiding a chip changes nothing behind it. The load chip
 * hidden still leaves the slot queue admitting by the load, sampled as often.
 */

/** A chip that can be switched off, in the order the bar draws them. */
export type BarItem = "claude" | "codex" | "agy" | "load" | "machines" | "nodes" | "openrouter" | "watched" | "agents";

/** Every switchable chip, in bar order, with the words Settings shows beside its switch. */
export const BAR_ITEMS: ReadonlyArray<{ id: BarItem; label: string; hint: string }> = [
  { id: "claude", label: "Claude", hint: "Your Claude plan's allowance, a ring a window." },
  { id: "codex", label: "Codex", hint: "Codex's allowance, as its last session recorded it." },
  { id: "agy", label: "Antigravity", hint: "Antigravity's quota, as agy last reported it." },
  { id: "load", label: "This Mac", hint: "Load, free memory and the slot queue. Hiding it changes nothing behind it." },
  { id: "machines", label: "Machines", hint: "Your other computers, in the colour of the worst load." },
  { id: "nodes", label: "Nodes", hint: "The other kururus, their workspaces and what needs you there." },
  { id: "openrouter", label: "OpenRouter", hint: "Your balance, once a key is set." },
  { id: "watched", label: "Watched by", hint: "On a node: which window can type into its terminals." },
  { id: "agents", label: "Agent count", hint: "How many agents are running, and how many are working." },
];

export interface BarSettings {
  /** The chips switched off. Absent ones are drawn, so a new chip is on by default. */
  hidden: BarItem[];
}

export const DEFAULT_BAR: BarSettings = { hidden: [] };

const IDS = new Set<string>(BAR_ITEMS.map((item) => item.id));

/**
 * Whatever arrived, as something the bar can be drawn by: a hand-edited file
 * or a message from a phone. A name this version does not know is dropped
 * rather than kept — it would hide nothing, and a downgrade that kept it would
 * have a later version hide a chip nobody switched off in it. Kept in bar
 * order and once each, so the file reads the same however the switches were
 * pressed.
 */
export function adoptBar(value: unknown): BarSettings {
  const hidden = (value as { hidden?: unknown } | null)?.hidden;
  if (!Array.isArray(hidden)) return { hidden: [] };
  const named = new Set(hidden.filter((id): id is BarItem => typeof id === "string" && IDS.has(id)));
  return { hidden: BAR_ITEMS.map((item) => item.id).filter((id) => named.has(id)) };
}

/** Whether a chip is drawn. */
export function barShows(bar: BarSettings | undefined, item: BarItem): boolean {
  return !bar?.hidden.includes(item);
}

/** The settings with one chip switched on or off. */
export function withBarItem(bar: BarSettings, item: BarItem, shown: boolean): BarSettings {
  const rest = bar.hidden.filter((id) => id !== item);
  return adoptBar({ hidden: shown ? rest : [...rest, item] });
}
