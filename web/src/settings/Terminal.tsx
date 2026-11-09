/**
 * Settings → Appearance → Terminal: the type a terminal is set in and the
 * shape of its cursor.
 *
 * The colours and the chrome are not here: kururu has one look and it is the
 * stylesheet's. This page holds nothing but the font name being typed. Every
 * other control sends a verb and draws the snapshot, which is what lands a
 * size picked here on a phone looking at the same server.
 */
import { useMemo, useState } from "react";
import { CURSOR_STYLES, MAX_FONT_SIZE, MIN_FONT_SIZE, type Appearance, type CursorStyle } from "../../../shared/theme";
import { canEnumerate, enumerate, knownFonts } from "../fonts";
import * as api from "../session";
import { Group, Row, Select, Slider, TextBox, Toggle } from "./ui";

/**
 * Not a font name, and it cannot become one: `adoptFontFamily` strips `<` and
 * `>` on the way in, so no value the server will ever hold can collide with it.
 */
const CUSTOM = "<custom>";

export function TerminalPage({ appearance }: { appearance: Appearance }) {
  const { terminal } = appearance;
  const set = (patch: Partial<typeof terminal>) => api.setTerminalAppearance({ ...terminal, ...patch });

  return (
    <>
      <Group title="Terminal" foot="The cursor is the default, not the rule: a program with its own opinion about it gets its way.">
        <FontRow value={terminal.fontFamily} onPick={(fontFamily) => set({ fontFamily })} />
        <Slider label="Size" min={MIN_FONT_SIZE} max={MAX_FONT_SIZE} step={1} value={terminal.fontSize} onChange={(fontSize) => set({ fontSize })} format={(n) => `${n}px`} />
        <Select label="Cursor" value={terminal.cursorStyle} onChange={(value) => set({ cursorStyle: value as CursorStyle })}>
          {CURSOR_STYLES.map((style) => (
            <option key={style} value={style}>
              {style[0]!.toUpperCase() + style.slice(1)}
            </option>
          ))}
        </Select>
        <Toggle label="Blink" on={terminal.cursorBlink} onChange={(cursorBlink) => set({ cursorBlink })} />
      </Group>
    </>
  );
}

/**
 * The terminal's face, as a list of the ones this machine has, with a box
 * behind `Custom…` for the one it cannot find. `web/src/fonts.ts` finds fonts
 * two ways and neither is complete, so there will always be a machine with a
 * font that is not in the list, and the server accepts any string because what
 * is *valid* and what is *offered* are different questions. The enumeration
 * hangs off `onPointerDown` because the good API needs a user activation.
 */
function FontRow({ value, onPick }: { value: string; onPick: (value: string) => void }) {
  const [scanned, setScanned] = useState(0);
  const [custom, setCustom] = useState(false);
  // Recomputed when a scan lands, and not otherwise: the installed faces are a
  // fact about the machine and do not change while the window is open.
  const fonts = useMemo(() => knownFonts(), [scanned]);
  const unknown = value !== "" && !fonts.includes(value);
  const showBox = custom || unknown;

  return (
    <>
      <Select
        label="Font"
        hint="Goes in front of the built-in stack, so an agent's icons keep working."
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
          <option key={font} value={font} style={{ fontFamily: `"${font}", monospace` }}>
            {font}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </Select>
      {showBox && (
        <Row label="Name" hint="Exactly as the system spells it." wide as="label">
          <TextBox
            value={value}
            mono
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
