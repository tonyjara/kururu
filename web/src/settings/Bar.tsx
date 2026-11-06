/**
 * Settings → Appearance → Bottom bar: a switch for each chip on the bar.
 *
 * Under Appearance because that is all it is — the list lives in
 * `appearance.json` beside the theme (see `shared/statusbar.ts`), the phone
 * and the desktop draw the same bar, and switching a chip off stops its
 * drawing and nothing else.
 *
 * Two groups, by the end of the bar a chip stands at, so the page reads in
 * the order the eye meets the bar. The modes and the phone's controls are not
 * here, and the foot says so rather than leaving somebody to look for them.
 */
import { BAR_ITEMS, barShows, withBarItem, type BarItem, type BarSettings } from "../../../shared/statusbar";
import * as api from "../session";
import { Group, Toggle } from "./ui";

const LEFT: ReadonlySet<BarItem> = new Set(["claude", "codex", "agy", "load", "machines", "openrouter"]);

export function BarPage({ bar }: { bar: BarSettings }) {
  const row = (item: (typeof BAR_ITEMS)[number]) => (
    <Toggle key={item.id} label={item.label} hint={item.hint} on={barShows(bar, item.id)} onChange={(on) => api.setBar(withBarItem(bar, item.id, on))} />
  );
  return (
    <>
      <Group title="Gauges" lead="The left end. A chip with nothing to say is not drawn either way.">
        {BAR_ITEMS.filter((item) => LEFT.has(item.id)).map(row)}
      </Group>
      <Group
        title="Status"
        lead="The right end."
        foot="PREFIX, RESIZE and reconnecting always show: they are modes, and a mode you cannot see is one you stop trusting. On a phone, the pane swap and the key bar toggle stay too, since they are the only way to do what they do."
      >
        {BAR_ITEMS.filter((item) => !LEFT.has(item.id)).map(row)}
      </Group>
    </>
  );
}
