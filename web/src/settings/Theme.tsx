/**
 * Settings → Appearance → Theme: what the window is wearing, and the type a
 * terminal is set in.
 *
 * Every theme and skin on this machine, built-in and installed alike, with no
 * idea where any came from — Explore is the shop, this is the wardrobe. A
 * theme is drawn in its own colours and a skin in its own shape, because the
 * picture is the whole of what is being chosen and a name would make you pick
 * one to find out what it is.
 *
 * It holds nothing but the font name being typed. Every other control sends a
 * verb and draws the snapshot, which is what lands a theme picked here on a
 * phone looking at the same server.
 */
import { useMemo, useState } from "react";
import { allSkins, partVarNames, partVars, type Skin } from "../../../shared/skin";
import { EMPTY_LIBRARY, type InstalledStyle, type StyleLibrary } from "../../../shared/styles";
import { allThemes, CURSOR_STYLES, MAX_FONT_SIZE, MIN_FONT_SIZE, type Appearance, type CursorStyle, type Theme } from "../../../shared/theme";
import { canEnumerate, enumerate, knownFonts } from "../fonts";
import * as api from "../session";
import { Btn, Card, Gallery, Group, Item, Outcome, Row, Select, Slider, TextBox, Toggle } from "./ui";

/**
 * Not a font name, and it cannot become one: `adoptFontFamily` strips `<` and
 * `>` on the way in, so no value the server will ever hold can collide with it.
 */
const CUSTOM = "<custom>";

export function ThemePage({ appearance, styles = EMPTY_LIBRARY }: { appearance: Appearance; styles?: StyleLibrary }) {
  const { terminal } = appearance;
  const set = (patch: Partial<typeof terminal>) => api.setTerminalAppearance({ ...terminal, ...patch });

  const packs = styles.installed.filter((record) => record.kind === "pack").sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      {packs.length > 0 && <Packs packs={packs} />}

      <Group title="Theme">
        <Gallery size="md" label="Theme">
          {allThemes(styles.themes).map((theme) => (
            <ThemeCard key={theme.id} theme={theme} on={theme.id === appearance.themeId} onPick={() => api.setTheme(theme.id)} />
          ))}
        </Gallery>
      </Group>

      <Group title="Skin" foot="Shape, not colour: every skin works in every theme. A heavier border resizes the terminals inside it.">
        <Gallery size="lg" label="Skin">
          {allSkins(styles.skins).map((skin) => (
            <SkinCard key={skin.id} skin={skin} on={skin.id === appearance.skinId} onPick={() => api.setSkin(skin.id)} />
          ))}
        </Gallery>
      </Group>

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
 * An installed pack, put back on: theme, skin, mascot, sound and font together,
 * with nothing downloaded. A row per pack and a button rather than a gallery,
 * because wearing a pack is an act and not a saved choice — the moment you
 * change the skin you are no longer quite in any of them, which is the whole
 * reason the button exists.
 */
function Packs({ packs }: { packs: InstalledStyle[] }) {
  const [wearing, setWearing] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const wear = async (pack: InstalledStyle) => {
    if (wearing) return;
    setWearing(pack.id);
    setFailed(null);
    try {
      const res = await fetch(`/api/styles/wear?kind=pack&id=${encodeURIComponent(pack.id)}`, { method: "POST" });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) setFailed(body.error ?? `could not put ${pack.name} on`);
    } catch {
      setFailed(`could not put ${pack.name} on — is the server up?`);
    } finally {
      setWearing(null);
    }
  };

  return (
    <Group title="Packs" foot="Theme, skin, mascot, sound and font, back on together. Nothing is downloaded.">
      {packs.map((pack) => (
        <Item key={pack.id} name={pack.name} sub={failed && wearing === null ? <Outcome bad>{failed}</Outcome> : undefined}>
          <Btn onClick={() => void wear(pack)} disabled={wearing !== null}>
            {wearing === pack.id ? "Putting it on…" : "Put on"}
          </Btn>
        </Item>
      ))}
    </Group>
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

/**
 * One theme, drawn in itself. The swatches are `chrome`, `accent`, and the
 * three status colours — what you look at all day — because a row of neutrals
 * would make every dark flavour look identical, which is exactly the question
 * somebody choosing between Mocha and Macchiato is asking. The card wears the
 * theme rather than describing it, so these are the one place in the client
 * that sets a colour from a theme other than the one that is on.
 */
function ThemeCard({ theme, on, onPick }: { theme: Theme; on: boolean; onPick: () => void }) {
  return (
    <Card
      on={on}
      onClick={onPick}
      className="st-theme"
      style={{
        background: theme.ui.bg,
        borderColor: on ? theme.ui.accent : theme.ui.line,
        color: theme.ui.text,
        ["--ring" as string]: theme.ui.accent,
      }}
      name={theme.name}
      picture={
        <span className="st-theme-swatches" aria-hidden>
          {[theme.ui.chrome, theme.ui.accent, theme.ui.working, theme.ui.blocked, theme.ui.done].map((color, i) => (
            <span key={i} className="st-theme-swatch" style={{ background: color }} />
          ))}
        </span>
      }
    />
  );
}

/**
 * One skin, drawn in itself — its own radius, border weight and face, with a
 * little pane inside carrying the frame recipe, which is the one thing a label
 * cannot tell you. Shape inline and colour from the cascade, the inverse of
 * the theme card, so a skin is never previewed in colours the window is not
 * wearing. A skin that painted its pane shows that picture, compiled exactly
 * as the window compiles it.
 */
function SkinCard({ skin, on, onPick }: { skin: Skin; on: boolean; onPick: () => void }) {
  const t = skin.tokens;
  const pane = skin.parts.pane ? partVars({ pane: skin.parts.pane }) : null;
  const pv = partVarNames("pane");
  return (
    <Card
      on={on}
      onClick={onPick}
      className="st-skin"
      style={{ borderRadius: t.radiusXl, borderWidth: t.border, borderStyle: t.borderStyle, fontFamily: t.ui }}
      name={<span style={{ fontSize: t.fsLg, letterSpacing: t.uiLetterSpacing }}>{skin.name}</span>}
      sub={<span style={{ fontSize: t.fsXs, letterSpacing: t.uiLetterSpacing, lineHeight: t.uiLineHeight }}>{skin.description}</span>}
      picture={
        <span
          className="st-skin-pane"
          style={
            pane
              ? {
                  borderRadius: t.radiusLg,
                  borderImage: pane[pv.frame],
                  borderWidth: pane[pv.w],
                  borderStyle: "solid",
                  borderColor: "transparent",
                  background: `${pane[pv.bg]}, var(--bg)`,
                  imageRendering: "pixelated",
                }
              : { borderRadius: t.radiusLg, borderWidth: t.border, borderStyle: t.borderStyle, boxShadow: t.frame }
          }
        >
          <span className="st-skin-bar" style={{ fontSize: t.fsXs, letterSpacing: t.uiLetterSpacing }}>
            {skin.icons.run}
          </span>
        </span>
      }
    />
  );
}
