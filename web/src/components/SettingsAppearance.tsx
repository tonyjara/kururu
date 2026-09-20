/**
 * Settings → Appearance: the theme, and the type a terminal is set in.
 *
 * Two subjects on one page rather than two tabs, because they are answered
 * together — somebody who has just made the window darker is the same person who
 * then finds 12px too small in it — and because neither is a list of thirty rows
 * the way the keymap is. The Mascot tab is a picture you drag on and the Keys tab
 * is a table; this is a short form, and a short form does not earn a tab of its
 * own per field.
 *
 * It holds nothing. Every control sends a verb and draws what comes back in the
 * snapshot, which is the rule the whole client follows and is what makes a theme
 * picked here land on a phone that is looking at the same server. The one piece
 * of local state is the font name being typed, and it exists for the reason the
 * sidebar's rename does: a controlled input fed from a round trip loses
 * characters typed during the round trip.
 *
 * The theme list draws each option in its own colours. A row of names would make
 * you pick a theme to find out what it is and then pick again — the swatches are
 * the whole of what is being chosen, so they are what is on screen, and they are
 * built from the same `Theme` the window is about to wear rather than from
 * anything written out beside it.
 */
import { useEffect, useMemo, useState } from "react";
import { allSkins, partVarNames, partVars, type Skin } from "../../../shared/skin";
import { EMPTY_LIBRARY, type InstalledStyle, type StyleLibrary } from "../../../shared/styles";
import {
  allThemes,
  CURSOR_STYLES,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  type Appearance,
  type CursorStyle,
  type Theme,
} from "../../../shared/theme";
import { canEnumerate, enumerate, knownFonts } from "../fonts";
import * as api from "../session";

export function AppearanceSettings({
  appearance,
  styles = EMPTY_LIBRARY,
  onEditing,
}: {
  appearance: Appearance;
  /**
   * What has been installed from the registry, so that the two lists here are
   * every theme and every skin rather than only the ones kururu shipped. It is
   * the same list the window is already wearing one of — see `applyAppearance` —
   * and it arrives in the snapshot for that reason.
   */
  styles?: StyleLibrary;
  /**
   * The font box takes typing, so the window's keyboard stands down while it is
   * focused — without it, a `d` typed into a font name closes the pane it was
   * typed in front of.
   */
  onEditing: (on: boolean) => void;
}) {
  const { terminal } = appearance;

  /**
   * The font name as it is being typed, or null when nobody is typing it.
   *
   * Null rather than always-a-string so the field follows the server when it is
   * not being edited — another window changing the font should be visible here,
   * and a box initialised once from the first snapshot would sit on a stale name
   * forever.
   */
  const [typing, setTyping] = useState<string | null>(null);
  useEffect(() => onEditing(typing !== null), [typing, onEditing]);

  /**
   * Which pack is being put on, and what went wrong if one would not go.
   *
   * The only local state on this page besides the font box, and it is here for
   * the same reason: everything else is a control whose answer is the next
   * snapshot, and this is the gap before one arrives. A pack is up to five
   * settings across three files, so it is the one gesture on this page slow
   * enough to need a word said about it.
   */
  const [wearing, setWearing] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const packs = styles.installed
    .filter((record) => record.kind === "pack")
    .sort((a, b) => a.name.localeCompare(b.name));

  const wear = async (pack: InstalledStyle) => {
    if (wearing) return;
    setWearing(pack.id);
    setFailed(null);
    try {
      const res = await fetch(`/api/styles/wear?kind=pack&id=${encodeURIComponent(pack.id)}`, {
        method: "POST",
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) setFailed(body.error ?? `could not put ${pack.name} on`);
    } catch {
      setFailed(`could not put ${pack.name} on — is the server up?`);
    } finally {
      setWearing(null);
    }
  };

  const set = (patch: Partial<typeof terminal>) =>
    api.setTerminalAppearance({ ...terminal, ...patch });

  return (
    <div className="set-page">
      {/* First, because it is the widest gesture on the page: everything below
          is one axis and this is all of them at once. Absent entirely when
          nothing is installed rather than sitting there empty — an installed
          pack is the only thing this section can be about, and the Styles tab
          is where you would go to get one. */}
      {packs.length > 0 && (
        <section className="set-section">
          <h3 className="set-h">Pack</h3>
          <p className="set-note">
            Theme, skin, mascot, sound and font, back on together. Nothing is downloaded.
          </p>
          <div className="pack-list">
            {packs.map((pack) => (
              <button
                key={pack.id}
                className="button button-quiet"
                disabled={wearing !== null}
                onClick={() => void wear(pack)}
                title={`Put ${pack.name} back on`}
              >
                {wearing === pack.id ? "Putting it on…" : pack.name}
              </button>
            ))}
          </div>
          {failed && (
            <p className="set-note set-note-under set-note-bad" role="alert">
              {failed}
            </p>
          )}
        </section>
      )}

      <section className="set-section">
        <h3 className="set-h">Theme</h3>
        <div className="theme-list" role="radiogroup" aria-label="Theme">
          {allThemes(styles.themes).map((theme) => (
            <ThemeOption
              key={theme.id}
              theme={theme}
              on={theme.id === appearance.themeId}
              onPick={() => api.setTheme(theme.id)}
            />
          ))}
        </div>
      </section>

      <section className="set-section">
        <h3 className="set-h">Skin</h3>
        <p className="set-note">
          Shape, not colour — every skin works in every theme. A heavier border resizes the
          terminals inside it.
        </p>
        <div className="skin-list" role="radiogroup" aria-label="Skin">
          {allSkins(styles.skins).map((skin) => (
            <SkinOption
              key={skin.id}
              skin={skin}
              on={skin.id === appearance.skinId}
              onPick={() => api.setSkin(skin.id)}
            />
          ))}
        </div>
      </section>

      <section className="set-section">
        <h3 className="set-h">Terminal</h3>

        <FontRow
          value={terminal.fontFamily}
          typing={typing}
          onTyping={setTyping}
          onPick={(fontFamily) => set({ fontFamily })}
        />
        <p className="set-note set-note-under">
          Goes in front of the built-in stack, so an agent's devicons keep working. The list is
          what this device can draw.
        </p>

        <label className="set-row">
          <span className="set-label">Size</span>
          <input
            type="range"
            className="set-range"
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            step={1}
            value={terminal.fontSize}
            onChange={(event) => set({ fontSize: Number(event.target.value) })}
          />
          <span className="set-value">{terminal.fontSize}px</span>
        </label>

        <label className="set-row">
          <span className="set-label">Cursor</span>
          <select
            className="set-select"
            value={terminal.cursorStyle}
            onChange={(event) => set({ cursorStyle: event.target.value as CursorStyle })}
          >
            {CURSOR_STYLES.map((style) => (
              <option key={style} value={style}>
                {style[0]!.toUpperCase() + style.slice(1)}
              </option>
            ))}
          </select>
          <label className="set-check">
            <input
              type="checkbox"
              checked={terminal.cursorBlink}
              onChange={(event) => set({ cursorBlink: event.target.checked })}
            />
            Blink
          </label>
        </label>
        <p className="set-note set-note-under">
          The default, not the rule: a program with its own opinion about the cursor gets it.
        </p>
      </section>
    </div>
  );
}

/**
 * The terminal's face, as a list of the ones this machine has.
 *
 * It was a text box, which is the honest implementation of "the server cannot
 * know what is installed" and a poor answer to "what can I pick": a name typed
 * one character wrong does not fail, it falls through to the next face in the
 * stack and looks exactly like the setting being ignored. A list cannot be
 * misspelled.
 *
 * The box is still here behind `Custom…`, and that is not a hedge. `web/src/fonts.ts`
 * finds fonts two ways and neither is complete — one needs a permission the
 * browser may not have, the other only finds faces it already knew to ask about
 * — so there will always be a machine with a font that is not in the list, and
 * the server accepts any string precisely because what is *valid* and what is
 * *offered* are different questions.
 *
 * The enumeration is hung off `onPointerDown` because the good API needs a
 * transient user activation and therefore cannot be called on mount. Opening a
 * dropdown is an activation; doing it there is invisible when it works and costs
 * nothing when the browser has never heard of it.
 */
function FontRow({
  value,
  typing,
  onTyping,
  onPick,
}: {
  value: string;
  typing: string | null;
  onTyping: (value: string | null) => void;
  onPick: (value: string) => void;
}) {
  const [scanned, setScanned] = useState(0);
  // Recomputed when a scan lands, and not otherwise: the installed faces are a
  // fact about the machine and do not change while the window is open.
  const fonts = useMemo(() => knownFonts(), [scanned]);
  const custom = typing !== null || (value !== "" && !fonts.includes(value));

  return (
    <>
      <label className="set-row">
        <span className="set-label">Font</span>
        <select
          className="set-select set-select-wide"
          value={custom ? CUSTOM : value}
          onPointerDown={() => {
            if (canEnumerate()) void enumerate().then((more) => more && setScanned((n) => n + 1));
          }}
          onChange={(event) => {
            const next = event.target.value;
            // Picking `Custom…` opens the box on what is already set rather than
            // on nothing, so that "I want to tweak this name" is one keystroke
            // instead of retyping it.
            if (next === CUSTOM) onTyping(value);
            else {
              onTyping(null);
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
        </select>
      </label>
      {custom && (
        <label className="set-row">
          <span className="set-label" />
          <input
            className="set-text"
            placeholder="A font name, exactly as the system spells it"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            /**
             * Focused when picking `Custom…` is what opened this box, and not
             * when it is merely here because *this device* cannot find the font
             * that is set. Two mounts that were one, and the second is the
             * ordinary condition of a phone looking at a desktop's session: the
             * face is a patched Nerd Font installed on the machine the agents
             * are on, no probe in a mobile browser will ever find it, so the box
             * renders — and autofocusing it slid a soft keyboard over Settings
             * every single time Settings was opened. `typing` is null on that
             * mount and a string on the other, which is the whole distinction,
             * and it is why this is a value rather than the bare attribute.
             */
            autoFocus={typing !== null}
            value={typing ?? value}
            onChange={(event) => onTyping(event.target.value)}
            onFocus={() => onTyping(typing ?? value)}
            onBlur={() => {
              if (typing !== null && typing !== value) onPick(typing);
              onTyping(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                onTyping(null);
                event.currentTarget.blur();
              }
            }}
          />
        </label>
      )}
    </>
  );
}

/**
 * Not a font name, and it cannot become one: `adoptFontFamily` strips `<` and
 * `>` on the way in, so no value the server will ever hold can collide with it.
 */
const CUSTOM = "<custom>";

/**
 * One skin, drawn in itself — `ThemeOption`'s argument, about the other axis.
 *
 * A row of names would make you pick a skin to find out what it is and then pick
 * again, and for shape that is worse than it is for colour: "Ironclad" tells
 * you roughly what the palette would have been, but nothing about how thick a
 * border gets or how much smaller the terminal becomes. So the card wears its own tokens —
 * its own radius, its own border weight, its own face — and the little pane
 * inside it carries the frame recipe, which is the one thing you cannot infer
 * from a label at all.
 *
 * It sets *shape* inline and leaves *colour* to the cascade, which is the exact
 * inverse of `ThemeOption` and is what keeps the two lists honest: this card is
 * in whatever theme is currently on, so a skin is never previewed in colours the
 * window is not actually wearing.
 */
function SkinOption({ skin, on, onPick }: { skin: Skin; on: boolean; onPick: () => void }) {
  const t = skin.tokens;
  /**
   * A skin that painted its pane shows that picture here, compiled exactly as
   * the window compiles it — a card drawn from the same `partVars` cannot
   * disagree with the pane it is previewing. One that painted nothing shows the
   * frame recipe, as before.
   */
  const pane = skin.parts.pane ? partVars({ pane: skin.parts.pane }) : null;
  const pv = partVarNames("pane");
  return (
    <button
      role="radio"
      aria-checked={on}
      className={`skin-opt ${on ? "skin-opt-on" : ""}`}
      onClick={onPick}
      style={{
        borderRadius: t.radiusXl,
        borderWidth: t.border,
        borderStyle: t.borderStyle,
        fontFamily: t.ui,
      }}
    >
      <span
        className="skin-opt-preview"
        style={
          pane
            ? { borderRadius: t.radiusLg, borderImage: pane[pv.frame], borderWidth: pane[pv.w], borderStyle: "solid", borderColor: "transparent", background: `${pane[pv.bg]}, var(--bg)`, imageRendering: "pixelated" }
            : { borderRadius: t.radiusLg, borderWidth: t.border, borderStyle: t.borderStyle, boxShadow: t.frame }
        }
      >
        <span className="skin-opt-bar" style={{ fontSize: t.fsXs, letterSpacing: t.uiLetterSpacing }}>
          {skin.icons.run}
        </span>
      </span>
      <span className="skin-opt-text">
        <span className="skin-opt-name" style={{ fontSize: t.fsLg, letterSpacing: t.uiLetterSpacing }}>
          {skin.name}
        </span>
        <span className="skin-opt-desc" style={{ fontSize: t.fsXs, letterSpacing: t.uiLetterSpacing, lineHeight: t.uiLineHeight }}>
          {skin.description}
        </span>
      </span>
    </button>
  );
}

/**
 * One theme, drawn in itself.
 *
 * The swatches are `chrome`, `accent`, and the three status colours, which is
 * not an arbitrary five: they are what you actually look at all day — a sidebar,
 * a focus ring, and the three marks that say an agent wants you. A row of
 * neutrals would make every dark flavour look identical, which is exactly the
 * question somebody choosing between Mocha and Macchiato is trying to answer.
 */
function ThemeOption({ theme, on, onPick }: { theme: Theme; on: boolean; onPick: () => void }) {
  return (
    <button
      role="radio"
      aria-checked={on}
      className={`theme-opt ${on ? "theme-opt-on" : ""}`}
      onClick={onPick}
      style={{
        // The card wears the theme rather than describing it, so these are the
        // one place in the client that sets a colour from a theme other than the
        // one that is on. Hence inline: a stylesheet can hold one palette at a
        // time, and this list is five at once.
        background: theme.ui.bg,
        borderColor: on ? theme.ui.accent : theme.ui.line,
        color: theme.ui.text,
        ["--ring" as string]: theme.ui.accent,
      }}
    >
      <span className="theme-opt-name">{theme.name}</span>
      <span className="theme-opt-swatches" aria-hidden>
        {[theme.ui.chrome, theme.ui.accent, theme.ui.working, theme.ui.blocked, theme.ui.done].map(
          (color, i) => (
            <span key={i} className="theme-opt-swatch" style={{ background: color }} />
          ),
        )}
      </span>
    </button>
  );
}
