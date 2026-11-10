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
import type { ReactNode } from "react";
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
        <FontRow
          value={terminal.fontFamily}
          onPick={(fontFamily) => set({ fontFamily })}
          fonts={knownFonts}
          generic="monospace"
          hint="Goes in front of the built-in stack, so an agent's icons keep working."
        />
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
 * A face, as a list of the ones this machine has, with a box behind
 * `Custom…` for the one it cannot find: the terminal's here, and the
 * interface's on its own page (`Interface.tsx`), each with its own list. `web/src/fonts.ts` finds fonts
 * two ways and neither is complete, so there will always be a machine with a
 * font that is not in the list, and the server accepts any string because what
 * is *valid* and what is *offered* are different questions. The enumeration
 * hangs off `onPointerDown` because the good API needs a user activation.
 */
export function FontRow({
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
