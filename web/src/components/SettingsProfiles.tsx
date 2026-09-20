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
 * **A profile is a drawer of workspaces and nothing else.** It carried accounts
 * for a while — a Claude config directory, a gh config directory, a gitconfig
 * and an ssh key, applied to every pty it spawned — and that is gone. Two
 * accounts on one machine is a problem the tools own, kururu's copy of it was a
 * second place for a login to go wrong quietly, and what was left when it went
 * wrong was a terminal opened as somebody you did not expect. So there is
 * nothing here to describe a profile *as*: a name, what is in it, and the two
 * things you can do to it.
 *
 * It holds nothing but what is being typed. Every control sends a verb and draws
 * the snapshot that comes back, which is what makes a rename here appear in the
 * sidebar behind the dialog, and on a phone looking at the same server.
 */
import { useCallback, useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import type { ProfileSummary } from "../../../shared/model";
import * as api from "../session";

export function ProfileSettings({
  profiles,
  activeProfileId,
  onEditing,
}: {
  profiles: ProfileSummary[];
  activeProfileId: string;
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
              active={profile.id === activeProfileId}
              deletable={profiles.length > 1}
              onEditing={bump}
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
  onEditing,
}: {
  profile: ProfileSummary;
  active: boolean;
  deletable: boolean;
  onEditing: (on: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);

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
    </li>
  );
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
