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
import { useCallback, useState } from "react";
import type { KeyOverrides } from "../../../shared/keys";
import type { LaunchSettings } from "../../../shared/launchers";
import type { HostInfo, LoginSummary, MascotSet, ProfileSummary, Workspace } from "../../../shared/model";
import type { NotifySettings as NotifyConfig } from "../../../shared/notify";
import type { ProjectSettingsMap } from "../../../shared/projects";
import type { StyleLibrary } from "../../../shared/styles";
import type { Appearance } from "../../../shared/theme";
import type { WorkspaceProject } from "../../../shared/wire";
import { AboutSettings } from "./SettingsAbout";
import { AgentSettings } from "./SettingsAgents";
import { AppearanceSettings } from "./SettingsAppearance";
import { KeySettings } from "./SettingsKeys";
import { MascotSettings } from "./SettingsMascot";
import { NotifySettings } from "./SettingsNotify";
import { OpenRouterSettings } from "./SettingsOpenRouter";
import { ProcessSettings } from "./SettingsProcesses";
import { ProfileSettings } from "./SettingsProfiles";
import { WorkspaceSettings } from "./SettingsWorkspaces";
import { StyleSettings } from "./SettingsStyles";
import { StudioSettings } from "./SettingsStudio";
import { VoiceSettings } from "./SettingsVoice";
import { VpsSettings } from "./SettingsVps";

export type Tab =
  | "appearance"
  | "styles"
  | "studio"
  | "mascot"
  | "profiles"
  | "workspaces"
  | "agents"
  | "processes"
  | "notify"
  | "voice"
  | "vps"
  | "openrouter"
  | "keys"
  | "about";

/**
 * The strip along the top, each holding one page or several.
 *
 * It was eleven tabs in a row, which on a desktop was a strip you read left to
 * right to find anything and on a phone was most of a strip you could not see.
 * Pages that answer the same question now share a tab and are told apart by a
 * second, smaller row under it: what the window looks like (the palette, what
 * there is to download, what you make yourself, what moves in the sidebar), and
 * where the work lives (profiles, and the repositories their workspaces are in).
 *
 * `Tab` stays the name of a *page*, not of a section, and that is deliberate:
 * the sidebar's "Profile settings…" opens a page, `App` remembers a page across
 * a reload, and both would have had to learn a pair of names if the section were
 * part of the address. A section is found from its page, never the other way.
 *
 * Appearance first: it is the page somebody opens Settings to find, the cog
 * opens on it, and it is the only one whose effect is visible behind the dialog
 * while you use it. About last, because it edits nothing.
 */
const SECTIONS: ReadonlyArray<{
  id: string;
  label: string;
  pages: ReadonlyArray<readonly [Tab, string]>;
}> = [
  {
    id: "appearance",
    label: "Appearance",
    pages: [
      ["appearance", "Theme"],
      /**
       * What you are *wearing* against what there is to *get*: Theme lists every
       * theme and skin this machine has with no idea where any came from, and
       * this is the one that knows. Somebody changing theme ten times an
       * afternoon should never pass through a list of downloads to do it, which
       * is why it is the second page and not the first.
       */
      ["styles", "Explore"],
      /**
       * The shop's other door: what you could not find there you make here, and
       * what you make here is one pull request from being there. It edits a
       * skin live — the window behind the dialog is the preview.
       */
      ["studio", "Skin studio"],
      ["mascot", "Mascot"],
    ],
  },
  {
    id: "general",
    label: "General",
    pages: [
      /**
       * Profiles first: it is the page the sidebar's profile name opens straight
       * onto. Workspaces after it because a profile is a drawer of them, and the
       * page is about the repository each one is in.
       */
      ["profiles", "Profiles"],
      ["workspaces", "Workspaces"],
    ],
  },
  /**
   * What the new-tab button will start — beside General because both are about
   * what you work *in* rather than what it looks like.
   */
  { id: "agents", label: "Agents", pages: [["agents", "Agents"]] },
  /**
   * What everything started from those two pages is costing, and the place to
   * close what is not worth it. Right after Agents, which is where they came from.
   */
  { id: "processes", label: "Processes", pages: [["processes", "Processes"]] },
  /**
   * How kururu says an agent wants you while you are not looking at the window.
   */
  { id: "notify", label: "Notifications", pages: [["notify", "Notifications"]] },
  /**
   * How you talk to the harness and how it talks back. Beside Notifications
   * because both are about the window reaching you when you are not reading
   * it — one with a croak, the other with a sentence.
   */
  { id: "voice", label: "Voice", pages: [["voice", "Voice"]] },
  /**
   * The sidebar's gauges of things that are not this machine — a server, an
   * account — each set up once and then only looked at in the sidebar.
   */
  {
    id: "monitors",
    label: "Monitors",
    pages: [
      ["vps", "VPS"],
      ["openrouter", "OpenRouter"],
    ],
  },
  { id: "keys", label: "Keys", pages: [["keys", "Keys"]] },
  { id: "about", label: "About", pages: [["about", "About"]] },
];

function sectionOf(tab: Tab) {
  return SECTIONS.find((section) => section.pages.some(([page]) => page === tab)) ?? SECTIONS[0]!;
}

/**
 * The page names alone, derived rather than typed out a second time, for the
 * reason `ICON_NAMES` is one list: `App` has to check a name that came back out
 * of storage against something at runtime, and a hand-written copy of this is a
 * copy that loses a page the day one is added here.
 */
export const TAB_NAMES: readonly Tab[] = SECTIONS.flatMap((section) => section.pages.map(([name]) => name));

export function Settings({
  appearance,
  styles,
  mascots,
  notify,
  launch,
  host,
  keys,
  profiles,
  logins,
  activeProfileId,
  autoSwap,
  workspaces,
  activeWorkspaceId,
  projects,
  projectSettings,
  initialTab,
  onClose,
  onEditing,
}: {
  appearance: Appearance;
  /** The active profile's workspaces — the Workspaces page's tabs — and which you are in. */
  workspaces: Workspace[];
  activeWorkspaceId: string;
  /** The repository each of them is in, as the server found it. */
  projects: WorkspaceProject[];
  projectSettings: ProjectSettingsMap;
  /** Every theme and skin installed from the registry, and the record of them. */
  styles: StyleLibrary;
  mascots: MascotSet;
  notify: NotifyConfig;
  /** Which agents the new-tab button offers. */
  launch: LaunchSettings;
  /** The pty host as it introduced itself: whether a setting that needs a newer one is in force. */
  host: HostInfo;
  keys: KeyOverrides;
  profiles: ProfileSummary[];
  logins: LoginSummary[];
  activeProfileId: string;
  /** The active profile's Auto Swap, for the Agents page. */
  autoSwap: boolean;
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
  const section = sectionOf(tab);
  /**
   * The page last open in each section, so that going to Agents and back to
   * Appearance lands on Explore if Explore is where you were. The window's,
   * like `tab`, and forgotten when the dialog closes.
   */
  const [lastPage, setLastPage] = useState<Record<string, Tab>>({});
  const go = (page: Tab) => {
    setTab(page);
    setLastPage((last) => ({ ...last, [sectionOf(page).id]: page }));
  };

  /**
   * Keep the tab you are on inside the strip, which only ever moves anything on
   * a window too narrow to hold eight of them — a phone. Two cases and they are
   * the same line of code: Settings opened on a tab somebody else chose
   * (`initialTab` is Profiles when the sidebar's name opens it, which would be
   * off the right edge at 390px), and a tab tapped when half of it was showing.
   *
   * A callback ref rather than an effect because the node *is* the event: it is
   * called when the selected tab changes, which is exactly when there is
   * something to scroll, and never on the renders in between. `nearest` on both
   * axes so a tab already in view moves nothing at all, and so that the vertical
   * half can never scroll the page under the dialog.
   */
  const onTab = useCallback((node: HTMLButtonElement | null) => {
    node?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);

  return (
    <div className="scrim" onPointerDown={onClose}>
      <div
        className="dialog dialog-wide"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal
        aria-label="Settings"
      >
        <div className="set-tabbar">
          <div className="set-tabs" role="tablist" aria-label="Settings">
            {SECTIONS.map(({ id, label, pages }) => (
              <button
                key={id}
                role="tab"
                aria-selected={section.id === id}
                ref={section.id === id ? onTab : undefined}
                className={`set-tab ${section.id === id ? "set-tab-on" : ""}`}
                onClick={() => go(lastPage[id] ?? pages[0]![0])}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {section.pages.length > 1 && (
          <div className="set-subtabs set-pagetabs" role="tablist" aria-label={section.label}>
            {section.pages.map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={`set-choice ${tab === id ? "set-choice-on" : ""}`}
                onClick={() => go(id)}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <div className="set-body">
          {tab === "appearance" ? (
            <AppearanceSettings appearance={appearance} styles={styles} onEditing={onEditing} />
          ) : tab === "styles" ? (
            <StyleSettings styles={styles} volume={notify.volume} onEditing={onEditing} />
          ) : tab === "studio" ? (
            <StudioSettings styles={styles} appearance={appearance} onEditing={onEditing} />
          ) : tab === "profiles" ? (
            <ProfileSettings
              profiles={profiles}
              logins={logins}
              activeProfileId={activeProfileId}
              launch={launch}
              host={host}
              onEditing={onEditing}
            />
          ) : tab === "agents" ? (
            <AgentSettings
              launch={launch}
              profileId={activeProfileId}
              profileName={profiles.find((p) => p.id === activeProfileId)?.name ?? "this profile"}
              autoSwap={autoSwap}
            />
          ) : tab === "workspaces" ? (
            <WorkspaceSettings
              workspaces={workspaces}
              activeWorkspaceId={activeWorkspaceId}
              projects={projects}
              settings={projectSettings}
              onEditing={onEditing}
            />
          ) : tab === "mascot" ? (
            <MascotSettings mascots={mascots} onEditing={onEditing} />
          ) : tab === "notify" ? (
            <NotifySettings notify={notify} />
          ) : tab === "vps" ? (
            <VpsSettings onEditing={onEditing} />
          ) : tab === "voice" ? (
            <VoiceSettings onEditing={onEditing} />
          ) : tab === "openrouter" ? (
            <OpenRouterSettings onEditing={onEditing} />
          ) : tab === "processes" ? (
            <ProcessSettings />
          ) : tab === "about" ? (
            <AboutSettings host={host} />
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
