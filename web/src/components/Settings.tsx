/**
 * Settings: the cog's dialog, and the pages in it.
 *
 * It was one page because it had one setting on it. A second — the keyboard —
 * would have made it a scroll through unrelated subjects, where the sheet picker
 * is a picture you drag on and the keymap is a list of thirty rows. Tabs rather
 * than sections for exactly that reason: these are separate jobs, you are doing
 * one of them, and the others being a page-down away is worse than them being a
 * click away.
 *
 * The tab is local state and deliberately not the server's. Which page of
 * Settings a window is on is not a fact about the session — a phone should not
 * be dragged onto the keymap because the desktop went there — and it is the same
 * line the `settings` flag in `App.tsx` already draws: what this *edits* is the
 * server's, whether it is open is the window's.
 *
 * No page holds what it edits. Each sends verbs and draws what comes back in the
 * snapshot, which is the rule the layout follows and the reason a second window
 * sees a rebinding, or a renamed profile, without being told.
 */
import { useState } from "react";
import type { KeyOverrides } from "../../../shared/keys";
import type { MascotSet, ProfileSummary } from "../../../shared/model";
import type { NotifySettings as NotifyConfig } from "../../../shared/notify";
import type { StyleLibrary } from "../../../shared/styles";
import type { Appearance } from "../../../shared/theme";
import { AboutSettings } from "./SettingsAbout";
import { AppearanceSettings } from "./SettingsAppearance";
import { KeySettings } from "./SettingsKeys";
import { MascotSettings } from "./SettingsMascot";
import { NotifySettings } from "./SettingsNotify";
import { ProfileSettings } from "./SettingsProfiles";
import { StyleSettings } from "./SettingsStyles";

export type Tab = "appearance" | "styles" | "profiles" | "mascot" | "notify" | "keys" | "about";

/**
 * Appearance first, and not alphabetically: it is the page somebody opens
 * Settings to find, and the rest are things you go looking for once. It is also
 * the only one whose effect is visible behind the dialog while you are using it,
 * which is worth having on the tab that opens by default.
 *
 * Profiles is second and is the exception that makes the ordering worth
 * defending: it is the one page that is mostly arrived at rather than browsed
 * for, because the profile name in the sidebar opens Settings straight onto it.
 * Which is also why `tab` is a prop here — where Settings opens is the caller's
 * to say, even though where it goes next is not.
 */
const TABS: ReadonlyArray<readonly [Tab, string, string]> = [
  ["appearance", "Appearance", "the theme, and what a terminal is set in"],
  /**
   * Second, and beside Appearance rather than inside it. The line between the
   * two is what you are *wearing* against what there is to *get*: Appearance
   * lists every theme and skin this machine has, built-in and installed alike,
   * with no idea where any of them came from, and this is the one that knows.
   * Somebody changing theme ten times an afternoon should never pass through a
   * list of downloads to do it.
   */
  ["styles", "Styles", "themes, skins and mascots from the kururu-styles registry"],
  ["profiles", "Profiles", "the sessions, and which accounts they open terminals as"],
  ["mascot", "Mascot", "what the badge does while an agent is working"],
  /**
   * Beside the Mascot rather than beside Appearance, and the two are the same
   * subject read one step further out: the badge is how kururu says an agent
   * wants you while you are looking at the window, and this is how it says so
   * while you are not. Before Keys, which stays last because it is the one page
   * that is a table rather than a form.
   */
  ["notify", "Notifications", "when kururu interrupts you, and what it sounds like"],
  ["keys", "Keys", "what each key does after the prefix"],
  /**
   * Last, and after the one page that is a table, because it is the only page
   * here that edits nothing — you arrive at it once, to answer a question about
   * kururu rather than to change it.
   */
  ["about", "About", "which kururu this is, and whether there is a newer one"],
];

export function Settings({
  appearance,
  styles,
  mascots,
  notify,
  keys,
  profiles,
  activeProfileId,
  initialTab,
  onClose,
  onEditing,
}: {
  appearance: Appearance;
  /** Every theme and skin installed from the registry, and the record of them. */
  styles: StyleLibrary;
  mascots: MascotSet;
  notify: NotifyConfig;
  keys: KeyOverrides;
  profiles: ProfileSummary[];
  activeProfileId: string;
  /**
   * Which page this opening is about. Only the opening: the tab you move to
   * afterwards is this window's business and not the server's, which is the same
   * line the `settings` flag in `App.tsx` draws — what this *edits* is shared,
   * whether it is open, and where it is, is not.
   */
  initialTab: Tab;
  onClose: () => void;
  /**
   * Something in here is taking typing — a name being edited, or a key being
   * captured. The window's keyboard stands down while it is, the same way it
   * does for a rename in the sidebar: without it, escape out of a half-typed
   * name closes the whole dialog, and a captured key is eaten by the shortcut it
   * is being unbound from.
   */
  onEditing: (on: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const note = TABS.find(([id]) => id === tab)?.[2];

  return (
    <div className="scrim" onPointerDown={onClose}>
      <div
        className="dialog dialog-wide"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal
        aria-label="Settings"
      >
        <div className="set-tabs" role="tablist" aria-label="Settings">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`set-tab ${tab === id ? "set-tab-on" : ""}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
          <span className="set-note set-tabs-note">{note}</span>
        </div>

        <div className="set-body">
          {tab === "appearance" ? (
            <AppearanceSettings appearance={appearance} styles={styles} onEditing={onEditing} />
          ) : tab === "styles" ? (
            <StyleSettings styles={styles} />
          ) : tab === "profiles" ? (
            <ProfileSettings
              profiles={profiles}
              activeProfileId={activeProfileId}
              onEditing={onEditing}
              onClose={onClose}
            />
          ) : tab === "mascot" ? (
            <MascotSettings mascots={mascots} onEditing={onEditing} />
          ) : tab === "notify" ? (
            <NotifySettings notify={notify} />
          ) : tab === "about" ? (
            <AboutSettings />
          ) : (
            <KeySettings keys={keys} onEditing={onEditing} />
          )}
        </div>

        <div className="dialog-actions">
          <button className="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
