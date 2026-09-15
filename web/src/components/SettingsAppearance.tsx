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
import { useEffect, useState } from "react";
import { SKINS, type Skin } from "../../../shared/skin";
import {
  CURSOR_STYLES,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  THEMES,
  type Appearance,
  type CursorStyle,
  type Theme,
} from "../../../shared/theme";
import * as api from "../session";

export function AppearanceSettings({
  appearance,
  onEditing,
}: {
  appearance: Appearance;
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

  const set = (patch: Partial<typeof terminal>) =>
    api.setTerminalAppearance({ ...terminal, ...patch });

  return (
    <div className="set-page">
      <section className="set-section">
        <h3 className="set-h">Theme</h3>
        <p className="set-note">
          What the window and the terminals are painted in — one palette, so an agent's output and
          the chrome around it are the same set of colours.
        </p>
        <div className="theme-list" role="radiogroup" aria-label="Theme">
          {THEMES.map((theme) => (
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
          What shape the window is, which is a separate question from what colour — every skin works
          in every theme. This one does reach an agent: a heavier border and a different typeface
          change the box a pane holds, so the terminals in it are resized to match.
        </p>
        <div className="skin-list" role="radiogroup" aria-label="Skin">
          {SKINS.map((skin) => (
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
        <p className="set-note">
          The size is the one setting here that reaches an agent: it decides the cell, the cell
          decides how many columns a pane holds, and the pty is resized to match.
        </p>

        <label className="set-row">
          <span className="set-label">Font</span>
          <input
            className="set-text"
            placeholder="System default"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={typing ?? terminal.fontFamily}
            onChange={(event) => setTyping(event.target.value)}
            onFocus={() => setTyping(terminal.fontFamily)}
            onBlur={() => {
              if (typing !== null && typing !== terminal.fontFamily) set({ fontFamily: typing });
              setTyping(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setTyping(null);
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <p className="set-note set-note-under">
          A face to put in front of the built-in stack, not instead of it — the patched Nerd Font
          faces stay behind whatever you name, so an agent's devicons keep working.
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
      </section>
    </div>
  );
}

/**
 * One skin, drawn in itself — `ThemeOption`'s argument, about the other axis.
 *
 * A row of names would make you pick a skin to find out what it is and then pick
 * again, and for shape that is worse than it is for colour: "8-bit" tells you
 * roughly what the palette would have been, but nothing about how thick a border
 * gets or how much smaller the type becomes. So the card wears its own tokens —
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
      <span className="skin-opt-preview" style={{ borderRadius: t.radiusLg, borderWidth: t.border, borderStyle: t.borderStyle, boxShadow: t.frame }}>
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
