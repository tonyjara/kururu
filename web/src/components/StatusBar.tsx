/**
 * One line along the bottom: where you are, and whether the mux is listening.
 *
 * The PREFIX badge is the load-bearing part. A prefix is a mode, and an unlabelled
 * mode is the thing that makes people distrust modal interfaces — you press the
 * chord, something else takes your attention, and three seconds later you cannot
 * tell whether the next key will split a pane or go into your shell. So the bar
 * says, and it stops saying when the prefix times out.
 */
import type { Profile, Workspace } from "../../../shared/model";
import { PREFIX_LABEL } from "../keys";

interface Props {
  profile: Profile;
  workspace: Workspace;
  connected: boolean;
  prefixArmed: boolean;
  resizeMode: boolean;
  onHelp: () => void;
}

export function StatusBar({ profile, workspace, connected, prefixArmed, resizeMode, onHelp }: Props) {
  const index = profile.workspaces.findIndex((w) => w.id === workspace.id);
  return (
    <footer className="statusbar">
      <span className="sb-profile">{profile.name}</span>
      <span className="sb-sep">/</span>
      <span className="sb-workspace">
        {index >= 0 && index < 9 ? `${index + 1} ` : ""}
        {workspace.name}
      </span>

      {prefixArmed && <span className="sb-badge sb-prefix">PREFIX</span>}
      {resizeMode && <span className="sb-badge sb-resize">RESIZE hjkl · esc</span>}
      {!connected && <span className="sb-badge sb-off">reconnecting…</span>}

      <span className="sb-spacer" />
      <button className="sb-help" onClick={onHelp} title="Keys">
        {PREFIX_LABEL} ?
      </button>
    </footer>
  );
}
