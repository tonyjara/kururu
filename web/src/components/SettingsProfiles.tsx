/**
 * Settings → Profiles: the drawers your workspaces live in.
 *
 * This page is where the profile switcher went. It was a pick dialog — a list,
 * with rename and delete hung off the rows — and a dialog is for choosing one of
 * several things and getting out of the way, which is not what renaming and
 * deleting want. So the whole of it is here, and the profile name in the sidebar
 * opens this tab. Switching is still the menu under that name: switching is
 * navigation, and a "Switch to" button on every row here means opening a modal
 * to move between two rooms, and leaves the dialog standing over a window that
 * changed behind it.
 *
 * **A profile is a drawer of workspaces and — if you switch it on — a login of
 * its own.** It carried *accounts* for a while: a Claude config directory, a gh
 * config directory, a gitconfig and an ssh key, each chosen per profile and
 * applied to every pty it spawned. The choosing is what went. A path typed into
 * a box was a second place for a login to go wrong quietly, and what was left
 * when it did was a terminal opened as somebody you did not expect. What came
 * back is one switch, under the list, that gives every profile a directory of
 * its own that Claude Code and Codex are pointed into, and whoever you log in as
 * inside a profile is who it is from then on.
 *
 * The one choice on a card is which of *those* directories the profile uses.
 * The picker lists the logins kururu already holds — each labelled by the
 * account signed into it — and a profile can be pointed at another's, so that
 * two drawers of workspaces are one account. Nothing is typed and no path is
 * read off a form: the server offers a list read from its own disk and accepts
 * a key from that list, which is how this is choosing without the place the old
 * choosing went wrong. A fresh login is the other option, for a profile that
 * should be somebody nobody here has signed in as yet.
 *
 * It holds nothing but what is being typed. Every control sends a verb and draws
 * the snapshot that comes back, which is what makes a rename here appear in the
 * sidebar behind the dialog, and on a phone looking at the same server.
 */
import { useCallback, useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import type { LaunchSettings } from "../../../shared/launchers";
import type { HostInfo, LoginSummary, ProfileSummary } from "../../../shared/model";
import * as api from "../session";

export function ProfileSettings({
  profiles,
  logins,
  activeProfileId,
  launch,
  host,
  onEditing,
}: {
  profiles: ProfileSummary[];
  /** What a profile may be pointed at — see `LoginSummary`. Drawn only while the switch is on. */
  logins: LoginSummary[];
  activeProfileId: string;
  /** The one field of these read here is `loginsPerProfile`; the rest is sent back untouched. */
  launch: LaunchSettings;
  /** Whether the pty host running now will apply the switch. It is a setting that can be on and not yet in force. */
  host: HostInfo;
  /**
   * Counted rather than set, which is where this differs from the other pages:
   * there is a box per profile and focus moves from one straight into the next.
   * A plain boolean would have the blur of the box you just left switch the
   * window's keyboard back on underneath the box you just entered, and the next
   * `d` typed into a name would close the pane behind the dialog.
   */
  onEditing: (on: boolean) => void;
}) {
  const [editing, setEditing] = useState(0);
  useEffect(() => onEditing(editing > 0), [editing, onEditing]);
  const bump = useCallback((on: boolean) => setEditing((n) => Math.max(0, n + (on ? 1 : -1))), []);
  // Unmounting mid-edit — the dialog closing while a name is focused — would
  // otherwise leave the window's keyboard switched off with nothing on screen
  // still taking typing.
  useEffect(() => () => onEditing(false), [onEditing]);

  return (
    <div className="set-page">
      <section className="set-section">
        <h3 className="set-h">Profiles</h3>
        <p className="set-note">
          A profile is a set of workspaces. The one you leave keeps running — switching is a
          different view of the same server, not a restart.
        </p>
        <ul className="prof-list">
          {profiles.map((profile) => (
            <ProfileRow
              key={profile.id}
              profile={profile}
              profiles={profiles}
              logins={logins}
              active={profile.id === activeProfileId}
              deletable={profiles.length > 1}
              showLogin={launch.loginsPerProfile}
              onEditing={bump}
            />
          ))}
        </ul>
        <NewProfile onEditing={bump} />
      </section>

      <section className="set-section">
        <h3 className="set-h">Logins</h3>
        <label className="set-check set-check-row">
          <input
            type="checkbox"
            checked={launch.loginsPerProfile}
            onChange={(event) => api.setLaunch({ ...launch, loginsPerProfile: event.target.checked })}
          />
          <strong>Each profile keeps its own logins</strong>
        </label>
        <p className="set-note">
          On, every terminal a profile opens starts Claude Code and Codex on that profile's own
          directories, so <code>/login</code> inside one signs in that profile alone, and it stays
          signed in as whoever you logged into there last. Each profile begins as a fresh install
          of both — sign in, and set them up as you like. <code>~/.claude</code> and{" "}
          <code>~/.codex</code> are not touched, and switching this off goes back to them. The
          usage bar follows the profile you are in.
        </p>
        <p className="set-note">
          Each profile's card says which login it uses. Point two profiles at the same one and
          they are the same account, with the same settings and memory; pick <em>a new login</em>{" "}
          to start a profile as nobody in particular and sign in there. Only terminals opened
          afterwards change — an agent already running keeps the account it started with.
        </p>
        {/* On and not in force is a state, not an error, and the reason it can
            happen is the design: the host outlives the app and keeps the code
            it started with. Said here rather than by refusing the tick, because
            the person may well be about to restart the host. */}
        {launch.loginsPerProfile && !host.current && (
          <p className="set-warn">
            Switched on, but the pty host running now predates it, so terminals still open with
            the machine's own logins. Restart the host to make it take effect — that ends every
            agent.
          </p>
        )}
      </section>
    </div>
  );
}

function ProfileRow({
  profile,
  profiles,
  logins,
  active,
  deletable,
  showLogin,
  onEditing,
}: {
  profile: ProfileSummary;
  /** All of them, to say which other profiles a login is shared with. */
  profiles: ProfileSummary[];
  logins: LoginSummary[];
  active: boolean;
  deletable: boolean;
  /** Draw which login it uses and where — only while that is a place anything is pointed at. */
  showLogin: boolean;
  onEditing: (on: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  /**
   * The picker's rows. The profile's own key is always among them — the server
   * lists every key a profile holds — but the list is a poll behind a fresh
   * profile for a moment, and a `<select>` whose value is not among its options
   * draws the first one, which would show a new profile as somebody else's
   * account for the length of a round trip. So the own key is added if missing.
   */
  const options = logins.some((login) => login.key === profile.loginKey)
    ? logins
    : [...logins, { key: profile.loginKey, email: null }];

  return (
    <li className={`prof ${active ? "prof-on" : ""}`}>
      <div className="prof-head">
        <Text
          className="set-text prof-name"
          value={profile.name}
          aria-label="Profile name"
          onCommit={(name) => name.trim() && api.renameProfile(profile.id, name)}
          onEditing={onEditing}
        />
        <span className="prof-meta">
          {profile.workspaces} ws · {profile.agents} live
        </span>
        {/* Marked, never switched to — see the note at the top of this file. */}
        {active && <span className="prof-here">Current</span>}
        {/* Asked in the button rather than through a dialog, the way removing a
            sheet is: Settings is already modal, and a confirm over a confirm is
            a stack. The count is in the label because this is the one button on
            the page that ends anything. */}
        {deletable &&
          (confirming ? (
            <button
              className="set-choice set-choice-warn"
              onClick={() => api.deleteProfile(profile.id)}
            >
              Delete, ending {profile.agents}?
            </button>
          ) : (
            <button className="set-choice" onClick={() => setConfirming(true)}>
              Delete
            </button>
          ))}
      </div>
      {/* Who the profile is, then where. The picker is labelled by the account
          Claude Code recorded in each directory, because an email is the only
          thing that tells two logins apart; the directory below is what
          somebody copying a settings file across will want. The empty value is
          the one row that is not a key: it asks the server to mint a fresh one. */}
      {showLogin && (
        <>
          <label className="prof-login">
            <span className="prof-login-label">Login</span>
            <select
              className="set-select set-select-wide"
              aria-label="Which login this profile uses"
              value={profile.loginKey}
              onChange={(event) =>
                api.setProfileLogin(profile.id, event.target.value === "" ? null : event.target.value)
              }
            >
              {options.map((login) => (
                <option key={login.key} value={login.key}>
                  {loginLabel(login, profile, profiles)}
                </option>
              ))}
              <option value="">a new login — sign in fresh</option>
            </select>
          </label>
          <p className="prof-dir" title={profile.loginDir}>
            {profile.loginDir}
          </p>
        </>
      )}
    </li>
  );
}

/**
 * What a login is called in the picker: who is signed in, and which other
 * profiles are already pointed at it. A directory nobody has signed into is said
 * to be that, rather than shown as its key — the key is a name for a folder and
 * tells nobody anything. The profiles sharing it are named so that choosing one
 * reads as "the same account as *work*" and not as a bare email that might or
 * might not be the one you meant.
 */
function loginLabel(login: LoginSummary, own: ProfileSummary, profiles: ProfileSummary[]): string {
  const who = login.email ?? "not signed in yet";
  const others = profiles.filter((p) => p.loginKey === login.key && p.id !== own.id).map((p) => p.name);
  return others.length ? `${who} · ${others.join(", ")}` : who;
}

/**
 * A box and a button rather than the prompt dialog the old switcher opened. The
 * page is already a form; opening a modal on top of a modal to collect one word
 * would be the stack the delete button is deliberately avoiding.
 */
function NewProfile({ onEditing }: { onEditing: (on: boolean) => void }) {
  const [name, setName] = useState("");
  const add = () => {
    if (!name.trim()) return;
    api.newProfile(name.trim());
    setName("");
  };
  return (
    <div className="prof-new">
      <input
        className="set-text"
        placeholder="New profile…"
        aria-label="New profile name"
        spellCheck={false}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onFocus={() => onEditing(true)}
        onBlur={() => onEditing(false)}
        onKeyDown={(event) => {
          if (event.key === "Enter") add();
          if (event.key === "Escape") event.currentTarget.blur();
        }}
      />
      <button className="set-choice" disabled={!name.trim()} onClick={add}>
        Add
      </button>
    </div>
  );
}

/**
 * A text box that follows the server while nobody is typing in it, and stops
 * following the moment somebody is.
 *
 * The same shape as the font field in Appearance and for the same reason — a
 * controlled input fed from a round trip drops the characters typed during the
 * round trip. Committing on blur and on Enter, reverting on Escape: a name is
 * one word and sending it per keystroke would rename the profile six times on
 * the way to one.
 */
function Text({
  value,
  onCommit,
  onEditing,
  className,
  placeholder,
  ...rest
}: {
  value: string;
  onCommit: (value: string) => void;
  onEditing: (on: boolean) => void;
  className: string;
  placeholder?: string;
} & Omit<ComponentPropsWithoutRef<"input">, "value" | "onChange" | "className">) {
  const [typing, setTyping] = useState<string | null>(null);
  /**
   * Set by Escape on the way to the blur it causes. A flag rather than clearing
   * `typing` first: the blur handler closes over the render it was created in,
   * so a state update queued a moment earlier is not visible to it and the
   * reverted value would be committed anyway.
   */
  const reverting = useRef(false);
  return (
    <input
      {...rest}
      className={className}
      placeholder={placeholder}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      value={typing ?? value}
      onChange={(event) => setTyping(event.target.value)}
      onFocus={() => {
        setTyping(value);
        onEditing(true);
      }}
      onBlur={() => {
        if (!reverting.current && typing !== null && typing !== value) onCommit(typing);
        reverting.current = false;
        setTyping(null);
        onEditing(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          reverting.current = true;
          event.currentTarget.blur();
        }
      }}
    />
  );
}
