/**
 * Settings: the cog's dialog, the list of its pages, and the shell every page
 * is drawn in.
 *
 * The pages are a list down the left, grouped, every one visible at once. It
 * was a strip of tabs with a second row under some of them, which on a desktop
 * was a strip you read left to right to find anything and on a phone was most
 * of a strip you could not see. A list has no second level to learn and no
 * edge to scroll off; on a phone it is the first screen, and a page opens over
 * it with a way back, which is the shape every phone's own settings have.
 *
 * Which page is open is this window's and deliberately not the server's: a
 * phone should not be dragged onto the keymap because the desktop went there.
 * What a page *edits* is the server's, and every page sends verbs and draws
 * the snapshot, which is why a second window sees a rename without being told.
 *
 * The shell draws the header for every page from the table below, so a page
 * cannot put its title somewhere else; the words a page is allowed are in
 * `ui.tsx`, and that file's header is the argument for the whole of this.
 */
import { useState, type ReactNode } from "react";
import type { KeyOverrides } from "../../../shared/keys";
import type { LaunchSettings } from "../../../shared/launchers";
import type { AgentPlacement } from "../../../shared/agentpane";
import type { HostInfo, LoginSummary, MascotSet, ProfileSummary, Workspace } from "../../../shared/model";
import type { NotifySettings as NotifyConfig } from "../../../shared/notify";
import type { ProjectSettingsMap } from "../../../shared/projects";
import type { StyleLibrary } from "../../../shared/styles";
import type { Appearance } from "../../../shared/theme";
import type { WorkspaceProject } from "../../../shared/wire";
import { channelReady } from "../../../shared/channels";
import { Icon } from "../components/Icon";
import { useKururu } from "../session";
import { AboutPage } from "./About";
import { AgentsPage } from "./Agents";
import { BackupsPage } from "./Backups";
import { ChannelsPage } from "./Channels";
import { ExplorePage } from "./Explore";
import { KeyboardPage } from "./Keyboard";
import { MachinesPage } from "./Machines";
import { NodesPage } from "./Nodes";
import { MascotPage } from "./Mascot";
import { NotificationsPage } from "./Notifications";
import { OpenRouterPage } from "./OpenRouter";
import { ProcessesPage } from "./Processes";
import { ProfilesPage } from "./Profiles";
import { StudioPage } from "./Studio";
import { ThemePage } from "./Theme";
import { EditingScope, type Tone } from "./ui";
import { VoicePage } from "./Voice";
import { WebPage } from "./Web";
import { WorkspacesPage } from "./Workspaces";

export type Tab =
  | "theme"
  | "explore"
  | "studio"
  | "mascot"
  | "profiles"
  | "workspaces"
  | "agents"
  | "keyboard"
  | "voice"
  | "channels"
  | "machines"
  | "nodes"
  | "web"
  | "openrouter"
  | "backups"
  | "notify"
  | "processes"
  | "about";

/**
 * The pages, by the question each group answers: what it looks like, what you
 * work in, the one conversation, what reaches off this Mac, and this Mac.
 * Appearance first because the cog opens on it and it is the only group whose
 * effect is visible behind the dialog; About last, because it edits nothing.
 */
const GROUPS: ReadonlyArray<{ label: string; pages: ReadonlyArray<readonly [Tab, string, string]> }> = [
  {
    label: "Appearance",
    pages: [
      ["theme", "Theme", "What the window is wearing."],
      ["explore", "Explore", "Themes, skins, mascots and sounds other people made."],
      ["studio", "Studio", "Make a skin, with the window as the preview."],
      ["mascot", "Mascot", "What moves in the sidebar while an agent works."],
    ],
  },
  {
    label: "General",
    pages: [
      ["profiles", "Profiles", "The drawers your workspaces live in."],
      ["workspaces", "Workspaces", "Where each one's shells run and agents open, and what a card's worktree gets."],
      ["agents", "Agents", "What the + menu starts, where kururu's own agents open, and when an idle card's agent sleeps."],
      ["keyboard", "Keyboard", "Every action and the keys that reach it."],
    ],
  },
  {
    label: "Kuru",
    pages: [
      ["voice", "Voice", "Talk to Kuru and hear it. Nothing leaves this Mac."],
      ["channels", "Channels", "Talk to Kuru from Telegram."],
    ],
  },
  {
    label: "Connections",
    pages: [
      ["nodes", "Nodes", "The other kururus this one is linked with, and pairing a new one."],
      ["machines", "Machines", "Your other computers, watched over ssh."],
      ["web", "Web", "Search and page reading for agents: who is asked, in what order."],
      ["openrouter", "OpenRouter", "Your balance in the sidebar."],
      ["backups", "Backups", "The precious things, in a private repository."],
    ],
  },
  {
    label: "System",
    pages: [
      ["notify", "Notifications", "When kururu may interrupt you, and what it sounds like."],
      ["processes", "Processes", "What every terminal is running and what it costs."],
      ["about", "About", "Which kururu this is, and why the server is the one it is."],
    ],
  },
];

/** The page names alone, derived rather than typed out a second time, for `App` to check a stored name against. */
export const TAB_NAMES: readonly Tab[] = GROUPS.flatMap((group) => group.pages.map(([name]) => name));

/** The cog's page, which on a phone means the list: nobody taps a cog for a theme gallery. */
export const FIRST_TAB: Tab = "theme";

function pageOf(tab: Tab): readonly [Tab, string, string] {
  for (const group of GROUPS) for (const page of group.pages) if (page[0] === tab) return page;
  return GROUPS[0]!.pages[0]!;
}

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
  agentPlacement,
  workspaces,
  activeWorkspaceId,
  projects,
  projectSettings,
  initialTab,
  narrow,
  onClose,
  onEditing,
}: {
  appearance: Appearance;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  projects: WorkspaceProject[];
  projectSettings: ProjectSettingsMap;
  styles: StyleLibrary;
  mascots: MascotSet;
  notify: NotifyConfig;
  launch: LaunchSettings;
  host: HostInfo;
  keys: KeyOverrides;
  profiles: ProfileSummary[];
  logins: LoginSummary[];
  activeProfileId: string;
  autoSwap: boolean;
  agentPlacement: AgentPlacement;
  /** Which page this opening is about. Only the opening: where you go afterwards is this window's business. */
  initialTab: Tab;
  /** A phone, or a window as narrow as one: the list is a screen of its own and a page opens over it. */
  narrow: boolean;
  onClose: () => void;
  /** Something in here is taking typing, so the window's keyboard stands down. */
  onEditing: (on: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  /** On a phone, whether the list is showing rather than a page. Starts on the list unless a page was asked for by name. */
  const [listing, setListing] = useState(narrow && initialTab === FIRST_TAB);
  const [, title, tagline] = pageOf(tab);
  const pill = usePill(tab);

  const go = (next: Tab) => {
    setTab(next);
    setListing(false);
  };

  const nav = (
    <nav className="st-nav" aria-label="Settings pages">
      {GROUPS.map((group) => (
        <div key={group.label} className="st-nav-group">
          <span className="st-nav-h">{group.label}</span>
          {group.pages.map(([id, label]) => (
            <button key={id} type="button" className={`st-nav-item${tab === id && !listing ? " st-nav-on" : ""}`} aria-current={tab === id && !listing ? "page" : undefined} onClick={() => go(id)}>
              {label}
              {narrow && <Icon name="caret" className="st-nav-caret" />}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );

  return (
    <div className="scrim st-scrim" onPointerDown={onClose}>
      <div className={`st-dialog${narrow ? " st-dialog-narrow" : ""}`} onPointerDown={(event) => event.stopPropagation()} role="dialog" aria-modal aria-label="Settings">
        {(!narrow || listing) && (
          <div className="st-side">
            <div className="st-side-head">
              <span className="st-title">Settings</span>
              {narrow && <CloseButton onClose={onClose} />}
            </div>
            {nav}
          </div>
        )}
        {(!narrow || !listing) && (
          <div className="st-main">
            <header className="st-head">
              {narrow && (
                <button type="button" className="st-back" onClick={() => setListing(true)} aria-label="Back to the list">
                  <Icon name="caret" />
                </button>
              )}
              <div className="st-head-text">
                <h2 className="st-title">{title}</h2>
                <span className="st-tagline">{tagline}</span>
              </div>
              {pill && <span className={`st-pill st-pill-${pill.tone}`}>{pill.text}</span>}
              <CloseButton onClose={onClose} />
            </header>
            <div className="st-body">
              <EditingScope onEditing={onEditing}>
                <div className="st-page">
                  <Page
                    tab={tab}
                    props={{ appearance, styles, mascots, notify, launch, host, keys, profiles, logins, activeProfileId, autoSwap, agentPlacement, workspaces, activeWorkspaceId, projects, projectSettings, onClose }}
                  />
                </div>
              </EditingScope>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="st-close" onClick={onClose} aria-label="Close settings" title="Close">
      <Icon name="close" />
    </button>
  );
}

type PageProps = {
  appearance: Appearance;
  styles: StyleLibrary;
  mascots: MascotSet;
  notify: NotifyConfig;
  launch: LaunchSettings;
  host: HostInfo;
  keys: KeyOverrides;
  profiles: ProfileSummary[];
  logins: LoginSummary[];
  activeProfileId: string;
  autoSwap: boolean;
  agentPlacement: AgentPlacement;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  projects: WorkspaceProject[];
  projectSettings: ProjectSettingsMap;
  /** For a page whose action is somewhere else — the machines' Shell, which opens a tab. */
  onClose: () => void;
};

function Page({ tab, props: p }: { tab: Tab; props: PageProps }): ReactNode {
  switch (tab) {
    case "theme":
      return <ThemePage appearance={p.appearance} styles={p.styles} />;
    case "explore":
      return <ExplorePage styles={p.styles} volume={p.notify.volume} />;
    case "studio":
      return <StudioPage styles={p.styles} appearance={p.appearance} />;
    case "mascot":
      return <MascotPage mascots={p.mascots} />;
    case "profiles":
      return <ProfilesPage profiles={p.profiles} logins={p.logins} activeProfileId={p.activeProfileId} launch={p.launch} host={p.host} />;
    case "workspaces":
      return (
        <WorkspacesPage
          profileId={p.activeProfileId}
          agentPlacement={p.agentPlacement}
          workspaces={p.workspaces}
          activeWorkspaceId={p.activeWorkspaceId}
          projects={p.projects}
          settings={p.projectSettings}
        />
      );
    case "agents":
      return (
        <AgentsPage
          launch={p.launch}
          profileId={p.activeProfileId}
          profileName={p.profiles.find((x) => x.id === p.activeProfileId)?.name ?? "this profile"}
          autoSwap={p.autoSwap}
          agentPlacement={p.agentPlacement}
        />
      );
    case "keyboard":
      return <KeyboardPage keys={p.keys} />;
    case "voice":
      return <VoicePage />;
    case "channels":
      return <ChannelsPage profiles={p.profiles} />;
    case "nodes":
      return <NodesPage />;
    case "machines":
      return <MachinesPage onClose={p.onClose} />;
    case "web":
      return <WebPage />;
    case "openrouter":
      return <OpenRouterPage />;
    case "backups":
      return <BackupsPage />;
    case "notify":
      return <NotificationsPage notify={p.notify} />;
    case "processes":
      return <ProcessesPage />;
    case "about":
      return <AboutPage host={p.host} />;
  }
}

/**
 * The word in the header's corner for a page that is a thing that can be on
 * or connected, off the snapshot: a glance at the list of pages is not a
 * glance at whether Telegram is listening, and this is.
 */
function usePill(tab: Tab): { text: string; tone: Tone } | null {
  const { channels, web, openrouter, backup, nodes } = useKururu();
  switch (tab) {
    case "nodes": {
      if (!nodes) return null;
      if (nodes.pairing) return { text: "Pairing", tone: "busy" };
      if (nodes.role === "alone" || nodes.nodes.length === 0) return null;
      const away = nodes.nodes.filter((n) => n.state !== "up").length;
      return away ? { text: `${away} away`, tone: "off" } : { text: `${nodes.nodes.length} linked`, tone: "ok" };
    }
    case "channels": {
      const t = channels?.telegram;
      if (!t || !t.hint) return null;
      if (t.error) return { text: "Error", tone: "bad" };
      if (t.enabled) return t.link === "listening" ? { text: "On", tone: "ok" } : { text: "Connecting", tone: "busy" };
      return { text: channelReady(t) ? "Off" : "Not set up", tone: "off" };
    }
    case "web": {
      if (!web) return null;
      if (!web.active) return { text: "Off", tone: "off" };
      // The first provider that will be tried is the one whose health is the page's.
      const first = web.providers.find((p) => p.enabled && p.ready && p.kind === "service");
      return first?.health.state === "bad" ? { text: `${first.label} down`, tone: "warn" } : { text: "On", tone: "ok" };
    }
    case "openrouter":
      if (!openrouter) return null;
      if (openrouter.error) return { text: "Error", tone: "bad" };
      return openrouter.reading ? { text: "Connected", tone: "ok" } : { text: "Connecting", tone: "busy" };
    case "backups":
      if (!backup?.settings.url) return null;
      if (backup.error) return { text: "Error", tone: "bad" };
      if (backup.running) return { text: "Backing up", tone: "busy" };
      return backup.settings.enabled ? { text: "On", tone: "ok" } : { text: "Off", tone: "off" };
    default:
      return null;
  }
}
