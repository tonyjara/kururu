/**
 * Settings → Appearance → Fonts: the type a terminal is set in and the shape
 * of its cursor, and under it the face and the size of kururu's own
 * interface.
 *
 * One page with two groups, the terminal's and then the interface's. They
 * were two pages for a day, and the owner asked for both in sight at once
 * (2026-11-10): they are the same two questions asked of the two kinds of
 * text in the window, and somebody setting one is usually about to look at
 * the other.
 *
 * Settings could set a terminal's type and nothing else's until then, and
 * most of what is read in kururu is not in a terminal: the sidebar, the
 * boards, Kuru's drawer, the reader, this dialog. The interface's two are
 * custom properties on the root that every rule already reaches through
 * `--ui` and the type ramp: see `applyInterface` in `fonts.ts`.
 *
 * The colours and the shape are not here: kururu has one look and it is the
 * stylesheet's. This page holds nothing but a font name being typed. Every
 * other control sends a verb and draws the snapshot, which is what lands a
 * size picked here on a phone looking at the same server; an interface size
 * is on the screen behind the dialog as the slider moves.
 */
import { useMemo, useState, type ReactNode } from "react";
import {
  CURSOR_STYLES,
  DEFAULT_UI_FONT_SIZE,
  interfaceOf,
  MAX_FONT_SIZE,
  MAX_UI_FONT_SIZE,
  MIN_FONT_SIZE,
  MIN_UI_FONT_SIZE,
  type Appearance,
  type CursorStyle,
} from "../../../shared/theme";
import { canEnumerate, enumerate, knownFonts, knownInterfaceFonts } from "../fonts";
import * as api from "../session";
import { Action, Group, Row, Select, Slider, TextBox, Toggle } from "./ui";

/**
 * Not a font name, and it cannot become one: `adoptFontFamily` strips `<` and
 * `>` on the way in, so no value the server will ever hold can collide with it.
 */
const CUSTOM = "<custom>";

export function FontsPage({ appearance }: { appearance: Appearance }) {
  const { terminal } = appearance;
  // A server from before the interface had a setting sends no `ui`; the defaults are what it draws.
  const ui = interfaceOf(appearance);
  const setTerminal = (patch: Partial<typeof terminal>) => api.setTerminalAppearance({ ...terminal, ...patch });
  const setInterface = (patch: Partial<typeof ui>) => api.setInterfaceAppearance({ ...ui, ...patch });
  const changed = ui.fontFamily !== "" || ui.fontSize !== DEFAULT_UI_FONT_SIZE;

  return (
    <>
      <Group title="Terminal" foot="The cursor is the default, not the rule: a program with its own opinion about it gets its way.">
        <FontRow
          value={terminal.fontFamily}
          onPick={(fontFamily) => setTerminal({ fontFamily })}
          fonts={knownFonts}
          generic="monospace"
          hint="Goes in front of the built-in stack, so an agent's icons keep working."
        />
        <Slider label="Size" min={MIN_FONT_SIZE} max={MAX_FONT_SIZE} step={1} value={terminal.fontSize} onChange={(fontSize) => setTerminal({ fontSize })} format={(n) => `${n}px`} />
        <Select label="Cursor" value={terminal.cursorStyle} onChange={(value) => setTerminal({ cursorStyle: value as CursorStyle })}>
          {CURSOR_STYLES.map((style) => (
            <option key={style} value={style}>
              {style[0]!.toUpperCase() + style.slice(1)}
            </option>
          ))}
        </Select>
        <Toggle label="Blink" on={terminal.cursorBlink} onChange={(cursorBlink) => setTerminal({ cursorBlink })} />
      </Group>
      <Group title="Interface" foot="The sidebar, the boards, Kuru's drawer, the reader and Settings. The reader's ⌘+ and ⌘− still zoom a document on top of this.">
        <FontRow
          value={ui.fontFamily}
          onPick={(fontFamily) => setInterface({ fontFamily })}
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
          onChange={(fontSize) => setInterface({ fontSize })}
          format={(n) => `${n}px`}
        />
        {changed && <Action label="The system's face at 13px" hint="What kururu ships with." button="Reset" onClick={() => setInterface({ fontFamily: "", fontSize: DEFAULT_UI_FONT_SIZE })} />}
      </Group>
    </>
  );
}

/**
 * A face, as a list of the ones this machine has, with a box behind
 * `Custom…` for the one it cannot find: the terminal's and the interface's,
 * each with its own list. `web/src/fonts.ts` finds fonts two ways and neither
 * is complete, so there will always be a machine with a font that is not in
 * the list, and the server accepts any string because what is *valid* and
 * what is *offered* are different questions. The enumeration hangs off
 * `onPointerDown` because the good API needs a user activation.
 */
function FontRow({
  value,
  onPick,
  fonts: known,
  generic,
  hint,
}: {
  value: string;
  onPick: (value: string) => void;
  /** The faces to offer: `knownFonts` or `knownInterfaceFonts`. */
  fonts: () => string[];
  /** What a name in the list is drawn in when this device turns out not to have it. */
  generic: "monospace" | "sans-serif";
  hint: ReactNode;
}) {
  const [scanned, setScanned] = useState(0);
  const [custom, setCustom] = useState(false);
  // Recomputed when a scan lands, and not otherwise: the installed faces are a
  // fact about the machine and do not change while the window is open.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fonts = useMemo(() => known(), [scanned, known]);
  const unknown = value !== "" && !fonts.includes(value);
  const showBox = custom || unknown;

  return (
    <>
      <Select
        label="Font"
        hint={hint}
        wide
        value={showBox ? CUSTOM : value}
        onPointerDown={() => {
          if (canEnumerate()) void enumerate().then((more) => more && setScanned((n) => n + 1));
        }}
        onChange={(next) => {
          if (next === CUSTOM) setCustom(true);
          else {
            setCustom(false);
            onPick(next);
          }
        }}
      >
        <option value="">System default</option>
        {fonts.map((font) => (
          <option key={font} value={font} style={{ fontFamily: `"${font}", ${generic}` }}>
            {font}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </Select>
      {showBox && (
        <Row label="Name" hint="Exactly as the system spells it." wide as="label">
          <TextBox
            value={value}
            mono={generic === "monospace"}
            placeholder="A font name"
            /* Focused when `Custom…` opened this box, and not when it is merely
               here because this device cannot find the font that is set — the
               ordinary condition of a phone looking at a desktop's session,
               where autofocusing slid a soft keyboard over Settings on every
               opening. */
            autoFocus={custom}
            onCommit={(next) => {
              setCustom(false);
              onPick(next);
            }}
          />
        </Row>
      )}
    </>
  );
}
