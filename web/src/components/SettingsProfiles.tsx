/**
 * Settings → Profiles: the profiles themselves, and which accounts each one
 * opens terminals as.
 *
 * This page is where the profile switcher went. It was a pick dialog — a list,
 * with rename and delete hung off the rows — and that was the right shape while
 * a profile was only a name over a list of workspaces. It stopped being the
 * right shape the moment a profile also carried an identity: a dialog is for
 * choosing one of several things and getting out of the way, and a form is not
 * that. Rather than keep a dialog that picks and a page that edits — two places
 * that would immediately start disagreeing about what a profile is — the whole
 * of it is here, and the profile name in the sidebar opens this tab.
 *
 * **What is being chosen is an account, not a directory.** Underneath, a profile
 * identity is three paths (`ProfileIdentity`) and nothing else; but nobody
 * thinks "my work profile uses `~/.config/gh/work`", they think "my work profile
 * is that github user". Both tools already know which accounts exist, so the
 * control is a list of them, and the path is only what the choice is stored as —
 * shown in the line underneath, typeable behind `Custom…`, for the arrangement
 * kururu did not make and should not stand in the way of.
 *
 * The two dropdowns are built differently and the asymmetry is the tools' own.
 * gh holds several accounts in one keyring and a config directory only says
 * which is active, so an account can be named before its directory exists —
 * picking one is a name, and the server writes the directory. A Claude account
 * *is* its config directory and has no name until somebody has signed in to one,
 * so that list is the directories kururu knows about, each labelled with
 * whatever email was found in it.
 *
 * Signing in is a button and not a flow, deliberately. Both are a browser, a
 * code to paste and a few questions, and the only thing this page could add by
 * wrapping them is somewhere for them to go wrong quietly. So it does the setup
 * — which directory, and making sure it is not the one holding your main account
 * — then opens a terminal in that profile and types the line. Settings closes
 * behind it, because the next thing to look at is the terminal.
 *
 * It holds nothing but what is being typed. Every control sends a verb and draws
 * the snapshot that comes back, which is what makes a rename here appear in the
 * sidebar behind the dialog, and on a phone looking at the same server.
 */
import { useCallback, useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import type { ProfileIdentity, ProfileSummary } from "../../../shared/model";
import type { IdentityWho, KnownAccounts } from "../../../shared/wire";
import * as api from "../session";

/**
 * The two options every dropdown ends with, which are not accounts: one opens a
 * login, the other gets out of the way and lets you type. They are safe as
 * sentinels because every real value is a path, and a path here has already been
 * refused unless it starts with a slash or a tilde.
 */
const SIGN_IN = "@sign-in";
const CUSTOM = "@custom";
/** "Whatever this machine is set to", which is a real choice and not an absence. */
const DEFAULT = "";

export function ProfileSettings({
  profiles,
  activeProfileId,
  onEditing,
  onClose,
}: {
  profiles: ProfileSummary[];
  activeProfileId: string;
  /**
   * Counted rather than set, which is where this differs from the other pages:
   * there are several boxes per profile and a dozen on the page, and focus moves
   * from one straight into the next. A plain boolean would have the blur of the
   * box you just left switch the window's keyboard back on underneath the box
   * you just entered, and the next `d` typed into a path would close the pane
   * behind the dialog.
   */
  onEditing: (on: boolean) => void;
  /** Signing in has somewhere else to be looked at, so the dialog gets out of the way. */
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(0);
  useEffect(() => onEditing(editing > 0), [editing, onEditing]);
  const bump = useCallback((on: boolean) => setEditing((n) => Math.max(0, n + (on ? 1 : -1))), []);
  // Unmounting mid-edit — the dialog closing while a path is focused — would
  // otherwise leave the window's keyboard switched off with nothing on screen
  // still taking typing.
  useEffect(() => () => onEditing(false), [onEditing]);

  const known = useKnown();

  const signIn = (profileId: string, tool: "claude" | "gh") => {
    api.signIn(profileId, tool);
    onClose();
  };

  return (
    <div className="set-page">
      <section className="set-section">
        <h3 className="set-h">Profiles</h3>
        <p className="set-note">
          A profile is a set of workspaces and the accounts its terminals open with. The one you
          leave keeps running — switching costs nothing and ends nothing.
        </p>
        <p className="set-note set-note-under">
          An account is picked, never logged in and out of: two profiles on two Claude accounts are
          both signed in at once. It is read when a terminal is spawned, so a change here is about
          the next terminal rather than the ones already open.
        </p>
        <ul className="prof-list">
          {profiles.map((profile) => (
            <ProfileRow
              key={profile.id}
              profile={profile}
              active={profile.id === activeProfileId}
              deletable={profiles.length > 1}
              known={known}
              onEditing={bump}
              onSignIn={signIn}
            />
          ))}
        </ul>
        <NewProfile onEditing={bump} />
      </section>
    </div>
  );
}

function ProfileRow({
  profile,
  active,
  deletable,
  known,
  onEditing,
  onSignIn,
}: {
  profile: ProfileSummary;
  active: boolean;
  deletable: boolean;
  known: KnownAccounts | null;
  onEditing: (on: boolean) => void;
  onSignIn: (profileId: string, tool: "claude" | "gh") => void;
}) {
  const who = useWho(profile);
  const [confirming, setConfirming] = useState(false);
  const identity = profile.identity;

  const patch = (field: keyof ProfileIdentity, value: string | null) =>
    api.setProfileIdentity(profile.id, { ...identity, [field]: value?.trim() || null });

  /**
   * The machine's own directory is already the first option, so a Claude account
   * found there is dropped rather than listed twice under two names.
   */
  const claudeOptions = (known?.claude ?? [])
    .filter((account) => account.dir)
    .map((account) => ({
      value: account.dir!,
      label: account.email ?? "signed in",
      hint: account.dir!,
    }));
  const ghOptions = (known?.gh ?? []).map((account) => ({
    value: account.dir,
    label: account.login,
    hint: account.host === "github.com" ? null : account.host,
  }));

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
        {/* Marked, never switched to. Switching is navigation and belongs to the
            menu under the sidebar's profile name; a "Switch to" button on every
            row here meant opening a modal, reading a list and clicking twice to
            move between two rooms — and left the dialog standing over a window
            that had changed behind it. */}
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

      <div className="prof-id">
        <Account
          label="Claude"
          profile={profile}
          current={identity.claudeConfigDir}
          options={claudeOptions}
          loading={known === null}
          says={saysClaude(who)}
          defaultLabel="This machine (~/.claude)"
          signInLabel="Sign in to another account…"
          onPick={(dir) => patch("claudeConfigDir", dir)}
          onSignIn={() => onSignIn(profile.id, "claude")}
          onEditing={onEditing}
        />
        <Account
          label="GitHub"
          profile={profile}
          current={identity.ghConfigDir}
          options={ghOptions}
          loading={known === null}
          says={saysGh(who)}
          defaultLabel="Whatever gh is set to"
          signInLabel="Add another account…"
          /* A github account is picked by name: the directory that means it is
             the server's to write, so the dropdown sends the account and only
             the custom box ever sends a path. */
          onPick={(dir) => {
            if (dir === null) return api.useGhAccount(profile.id, null);
            const account = known?.gh.find((candidate) => candidate.dir === dir);
            if (account) api.useGhAccount(profile.id, { host: account.host, login: account.login });
            else patch("ghConfigDir", dir);
          }}
          onSignIn={() => onSignIn(profile.id, "gh")}
          onEditing={onEditing}
        />

        {/* No dropdown, because there is no list to build one from: git has no
            registry of identities, only whichever file you point it at. */}
        <label className="prof-field">
          <span className="set-label">Git</span>
          <Text
            className="set-text"
            value={identity.gitConfigGlobal ?? ""}
            placeholder="~/.gitconfig"
            aria-label={`Git config for ${profile.name}`}
            onCommit={(value) => patch("gitConfigGlobal", value)}
            onEditing={onEditing}
          />
          <span className="prof-who">{saysGit(who)}</span>
        </label>
      </div>
    </li>
  );
}

/**
 * One tool's account, as a list of the accounts there are plus the two things
 * that are not accounts: signing in, and naming a directory yourself.
 *
 * Whatever the profile is *currently* pointed at is always in the list, even
 * while the real list is still being fetched and even if it is a directory
 * kururu knows nothing about. Without that the select spends the second the
 * lookup takes with nothing selected at all, which reads as "this profile has no
 * account" — the one thing it definitely is not — and a hand-written path would
 * read the same way forever. It is labelled with the path, because a directory
 * nothing can name is exactly the case where the path is the only honest name.
 *
 * `Custom…` is therefore only how you *enter* one, not how one is displayed, and
 * it opens the box pre-filled with whatever is set.
 */
function Account({
  label,
  profile,
  current,
  options,
  loading,
  says,
  defaultLabel,
  signInLabel,
  onPick,
  onSignIn,
  onEditing,
}: {
  label: string;
  profile: ProfileSummary;
  current: string | null;
  options: { value: string; label: string; hint: string | null }[];
  loading: boolean;
  says: string;
  defaultLabel: string;
  signInLabel: string;
  onPick: (dir: string | null) => void;
  onSignIn: () => void;
  onEditing: (on: boolean) => void;
}) {
  const [custom, setCustom] = useState(false);
  const shown =
    current !== null && !options.some((option) => option.value === current)
      ? [...options, { value: current, label: current, hint: null }]
      : options;

  return (
    <label className="prof-field">
      <span className="set-label">{label}</span>
      <select
        className="set-select"
        aria-label={`${label} account for ${profile.name}`}
        value={custom ? CUSTOM : (current ?? DEFAULT)}
        onChange={(event) => {
          const picked = event.target.value;
          if (picked === SIGN_IN) return onSignIn();
          setCustom(picked === CUSTOM);
          if (picked === CUSTOM) return;
          onPick(picked === DEFAULT ? null : picked);
        }}
      >
        <option value={DEFAULT}>{defaultLabel}</option>
        {shown.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
            {option.hint ? ` — ${option.hint}` : ""}
          </option>
        ))}
        <option value={SIGN_IN}>{signInLabel}</option>
        <option value={CUSTOM}>Custom directory…</option>
      </select>
      <span className="prof-who">{loading ? "…" : says}</span>
      {custom && (
        <Text
          className="set-text prof-path"
          value={current ?? ""}
          placeholder="Absolute path, or ~/…"
          aria-label={`${label} config directory for ${profile.name}`}
          onCommit={(value) => onPick(value.trim() || null)}
          onEditing={onEditing}
        />
      )}
    </label>
  );
}

/**
 * What the tool at that path says it is.
 *
 * An em dash where the answer is unknown rather than a guess or a blank: a blank
 * reads as "nothing set", which is a different and much more reassuring thing
 * than "that command could not be run". The three cases a person is looking for
 * — signed in as somebody, signed in as nobody, could not ask — are each a
 * different string for that reason.
 */
function saysClaude(who: IdentityWho | null): string {
  if (!who) return "…";
  if (!who.claude) return "— claude not found";
  if (!who.claude.loggedIn) return "not signed in";
  return [who.claude.email, who.claude.org, who.claude.plan].filter(Boolean).join(" · ");
}

function saysGh(who: IdentityWho | null): string {
  if (!who) return "…";
  if (!who.gh) return "not signed in";
  return who.gh.state && who.gh.state !== "success"
    ? `${who.gh.login} — ${who.gh.state}`
    : who.gh.login;
}

function saysGit(who: IdentityWho | null): string {
  if (!who) return "…";
  if (!who.git?.name && !who.git?.email) return "no global identity";
  return [who.git.name, who.git.email && `<${who.git.email}>`].filter(Boolean).join(" ");
}

/**
 * Ask the server who this profile is, again whenever the paths change.
 *
 * Keyed on the identity rather than on the profile id, so picking an account
 * re-asks with it — which is the feedback loop the dropdown is worth having. The
 * server caches per directory, so profiles sharing one account are one lookup
 * between them rather than one each.
 */
function useWho(profile: ProfileSummary): IdentityWho | null {
  const [who, setWho] = useState<IdentityWho | null>(null);
  const key = JSON.stringify(profile.identity);
  useEffect(() => {
    let live = true;
    setWho(null);
    void fetch(`/api/identity?profile=${encodeURIComponent(profile.id)}`)
      .then((response) => (response.ok ? (response.json() as Promise<IdentityWho>) : null))
      .then((answer) => live && setWho(answer))
      .catch(() => live && setWho(null));
    return () => {
      live = false;
    };
  }, [profile.id, key]);
  return who;
}

/**
 * What there is to pick between, asked once for the page rather than once per
 * row — it spans every profile, and the rows would otherwise ask one question as
 * many times as there are profiles. Not refreshed while the dialog is open: the
 * only thing that changes it is a login, and a login closes the dialog.
 */
function useKnown(): KnownAccounts | null {
  const [known, setKnown] = useState<KnownAccounts | null>(null);
  useEffect(() => {
    let live = true;
    void fetch("/api/identity/known")
      .then((response) => (response.ok ? (response.json() as Promise<KnownAccounts>) : null))
      .then((answer) => live && setKnown(answer ?? { claude: [], gh: [] }))
      .catch(() => live && setKnown({ claude: [], gh: [] }));
    return () => {
      live = false;
    };
  }, []);
  return known;
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
 * round trip — but shared here because this page has several of them. Committing
 * on blur and on Enter, reverting on Escape: a path is long enough that sending
 * it on every keystroke would ask the server to describe six half-typed
 * directories on the way to one real one.
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
