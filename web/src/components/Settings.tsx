/**
 * Settings: the cog's dialog, and the two things in it.
 *
 * It was one page because it had one setting on it. A second — the keyboard —
 * would have made it a scroll through two unrelated subjects, where the sheet
 * picker is a picture you drag on and the keymap is a list of thirty rows. Tabs
 * rather than sections for exactly that reason: these are two jobs, you are
 * doing one of them, and the other one being a page-down away is worse than it
 * being a click away.
 *
 * The tab is local state and deliberately not the server's. Which page of
 * Settings a window is on is not a fact about the session — a phone should not
 * be dragged onto the keymap because the desktop went there — and it is the same
 * line the `settings` flag in `App.tsx` already draws: what this *edits* is the
 * server's, whether it is open is the window's.
 *
 * Neither page holds what it edits. Both send verbs and draw what comes back in
 * the snapshot, which is the rule the layout follows and the reason a second
 * window sees a rebinding without being told.
 */
import { useState } from "react";
import type { KeyOverrides } from "../../../shared/keys";
import type { MascotSet } from "../../../shared/model";
import { KeySettings } from "./SettingsKeys";
import { MascotSettings } from "./SettingsMascot";

type Tab = "mascot" | "keys";

const TABS: ReadonlyArray<readonly [Tab, string, string]> = [
  ["mascot", "Mascot", "what the badge does while an agent is working"],
  ["keys", "Keys", "what each key does after the prefix"],
];

export function Settings({
  mascots,
  keys,
  onClose,
  onEditing,
}: {
  mascots: MascotSet;
  keys: KeyOverrides;
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
  const [tab, setTab] = useState<Tab>("mascot");
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
          {tab === "mascot" ? (
            <MascotSettings mascots={mascots} onEditing={onEditing} />
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
