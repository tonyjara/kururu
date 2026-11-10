/**
 * Settings → Appearance → Interface: the face and the size kururu's own
 * interface is set in.
 *
 * Settings could set a terminal's type and nothing else's, and most of what
 * is read in kururu is not in a terminal: the sidebar, the boards, Kuru's
 * drawer, the reader, this dialog (the owner, 2026-11-10). So the two things
 * about the look that are a person's rather than the design's are here, and
 * they are two custom properties on the root that every rule already reaches
 * through `--ui` and the type ramp: see `applyInterface` in `fonts.ts`.
 *
 * The colours and the shape are still not here. Kururu has one look.
 *
 * The page holds nothing but the font name being typed. The controls send a
 * verb and draw the snapshot, which is what lands a size picked here on a
 * phone looking at the same server; the change is on the screen behind the
 * dialog as the slider moves.
 */
import { DEFAULT_UI_FONT_SIZE, interfaceOf, MAX_UI_FONT_SIZE, MIN_UI_FONT_SIZE, type Appearance } from "../../../shared/theme";
import { knownInterfaceFonts } from "../fonts";
import * as api from "../session";
import { FontRow } from "./Terminal";
import { Action, Group, Slider } from "./ui";

export function InterfacePage({ appearance }: { appearance: Appearance }) {
  // A server from before this page sends no `ui`; the defaults are what it draws.
  const ui = interfaceOf(appearance);
  const set = (patch: Partial<typeof ui>) => api.setInterfaceAppearance({ ...ui, ...patch });
  const changed = ui.fontFamily !== "" || ui.fontSize !== DEFAULT_UI_FONT_SIZE;

  return (
    <Group
      title="Interface"
      foot="The sidebar, the boards, Kuru's drawer, the reader and Settings. A terminal's type is its own, on the Terminal page, and the reader's ⌘+ and ⌘− still zoom a document on top of this."
    >
      <FontRow
        value={ui.fontFamily}
        onPick={(fontFamily) => set({ fontFamily })}
        fonts={knownInterfaceFonts}
        generic="sans-serif"
        hint="Goes in front of the system's own, which a device without this one falls back to."
      />
      <Slider
        label="Size"
        hint="Of running text. Labels, tabs and icons keep their proportions to it."
        min={MIN_UI_FONT_SIZE}
        max={MAX_UI_FONT_SIZE}
        step={1}
        value={ui.fontSize}
        onChange={(fontSize) => set({ fontSize })}
        format={(n) => `${n}px`}
      />
      {changed && <Action label="The system's face at 13px" hint="What kururu ships with." button="Reset" onClick={() => set({ fontFamily: "", fontSize: DEFAULT_UI_FONT_SIZE })} />}
    </Group>
  );
}
