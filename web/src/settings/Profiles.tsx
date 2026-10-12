/**
 * Settings → General → Profiles: the drawers your workspaces live in.
 *
 * This page is where the profile switcher went, minus the switching: the menu
 * under the sidebar's name is the switcher, and this is the editor, so neither
 * duplicates the other and the dialog never stands over a window that changed
 * behind it.
 *
 * **A profile is a drawer of workspaces and, if you switch it on, a login of
 * its own.** It carried chosen accounts for a version, and a path typed into a
 * box was a second place for a login to go wrong quietly. What is back is one
 * switch that gives every profile a directory Claude Code and Codex are
 * pointed into, and a choice among the directories kururu itself made: the
 * server offers a list read off its own disk and accepts a key from that list,
 * and no path ever comes from a client.
 */
import type { LaunchSettings } from "../../../shared/launchers";
import type { HostInfo, LoginSummary, ProfileSummary } from "../../../shared/model";
import * as api from "../session";
import { AddRow, Banner, DangerButton, Group, Item, Mono, Select, TextBox, Toggle } from "./ui";

export function ProfilesPage({
  profiles,
  logins,
  activeProfileId,
  launch,
  host,
}: {
  profiles: ProfileSummary[];
  logins: LoginSummary[];
  activeProfileId: string;
  /** The one field read here is `loginsPerProfile`; the rest is sent back untouched. */
  launch: LaunchSettings;
  /** Whether the pty host running now will apply the switch: a setting can be on and not yet in force. */
  host: HostInfo;
}) {
  return (
    <>
      {/* On and not in force is a state, not an error: the host outlives the
          app and keeps the code it started with. */}
      {launch.loginsPerProfile && !host.current && (
        <Banner>Logins per profile is on, but the pty host running now predates it. Restart the host to make it take effect, which ends every agent.</Banner>
      )}

      <Group title="Profiles" foot="Switching is the menu under the sidebar's name. The one you leave keeps running.">
        {profiles.map((profile) => (
          <ProfileRow key={profile.id} profile={profile} profiles={profiles} logins={logins} active={profile.id === activeProfileId} deletable={profiles.length > 1} showLogin={launch.loginsPerProfile} />
        ))}
        <AddRow placeholder="New profile…" ariaLabel="New profile name" onAdd={(name) => api.newProfile(name)} />
      </Group>

      <Group title="Logins" foot="Only terminals opened afterwards change; an agent already running keeps the account it started with.">
        <Toggle
          label="Each profile keeps its own logins"
          hint={
            <>
              Claude Code and Codex start on the profile's own directories; <Mono>~/.claude</Mono> and <Mono>~/.codex</Mono> are not touched.
            </>
          }
          on={launch.loginsPerProfile}
          onChange={(loginsPerProfile) => api.setLaunch({ ...launch, loginsPerProfile })}
        />
      </Group>
    </>
  );
}

function ProfileRow({
  profile,
  profiles,
  logins,
  active,
  deletable,
  showLogin,
}: {
  profile: ProfileSummary;
  profiles: ProfileSummary[];
  logins: LoginSummary[];
  active: boolean;
  deletable: boolean;
  showLogin: boolean;
}) {
  /**
   * The picker's rows. The own key is always among them on the server, but
   * the list is a poll behind a fresh profile for a moment, and a select whose
   * value is not among its options draws the first one — a new profile shown
   * as somebody else's account for the length of a round trip.
   */
  const options = logins.some((login) => login.key === profile.loginKey) ? logins : [...logins, { key: profile.loginKey, email: null }];
  return (
    <>
      <Item
        on={active}
        name={<TextBox className="st-input-bare" value={profile.name} aria-label="Profile name" onCommit={(name) => name.trim() && api.renameProfile(profile.id, name)} />}
        sub={
          <>
            {profile.workspaces} {profile.workspaces === 1 ? "workspace" : "workspaces"} · {profile.agents} live
            {active ? " · current" : ""}
          </>
        }
      >
        {deletable && <DangerButton label="Delete" ask={`Delete ${profile.name}, ending ${profile.agents} ${profile.agents === 1 ? "agent" : "agents"}?`} onConfirm={() => api.deleteProfile(profile.id)} />}
      </Item>
      {showLogin && (
        <Select
          label="Login"
          hint={<Mono title={profile.loginDir}>{profile.loginDir}</Mono>}
          value={profile.loginKey}
          ariaLabel={`Which login ${profile.name} uses`}
          onChange={(value) => api.setProfileLogin(profile.id, value === "" ? null : value)}
          wide
        >
          {options.map((login) => (
            <option key={login.key} value={login.key}>
              {loginLabel(login, profile, profiles)}
            </option>
          ))}
          <option value="">A new login: sign in fresh</option>
        </Select>
      )}
    </>
  );
}

/** Who is signed in, and which other profiles are pointed at it, so choosing reads as "the same account as work". */
function loginLabel(login: LoginSummary, own: ProfileSummary, profiles: ProfileSummary[]): string {
  const who = login.email ?? "not signed in yet";
  const others = profiles.filter((p) => p.loginKey === login.key && p.id !== own.id).map((p) => p.name);
  return others.length ? `${who} · ${others.join(", ")}` : who;
}
