/**
 * Settings → Workspaces: where the robot on a card starts its agent, one
 * sub-tab per workspace in the profile.
 *
 * Drawn per workspace and stored per repository, and the two are not in
 * tension. A person thinks in workspaces — that is the list in the sidebar and
 * the board they pressed the robot on — so that is the list here, as tabs
 * rather than sections, because six workspaces stacked is a page you scroll
 * and a page you scroll is one where you edit the wrong project. Under the tab
 * is the repository that workspace is in, and the settings are that
 * repository's: two workspaces on one checkout show the same three controls
 * and say so, since a setup line that differed by which drawer you opened it
 * from would be a setting nobody could predict.
 *
 * The repository is the server's finding (`projects` in the snapshot), never
 * typed here, and a workspace with no terminal in a repository yet says so
 * rather than offering controls that would apply to nothing.
 *
 * The text boxes commit on blur and Enter like a profile's name, and for the
 * same reason — a line sent per keystroke is a settings file rewritten thirty
 * times on the way to `bun install`.
 *
 * Switching worktrees off is the one control here that does something to the
 * disk, and it asks first. The worktrees standing for that repository are
 * merged back and removed, which ends any agent still in one, so the switch
 * shows the list and waits for a second click — in the page rather than in a
 * dialog over it, the way deleting a profile asks: Settings is already modal,
 * and a confirm over a confirm is a stack.
 */
import { useState } from "react";
import type { Card } from "../../../shared/board";
import type { Workspace } from "../../../shared/model";
import {
  projectSettingsFor,
  worktreeDir,
  type ProjectSettings,
  type ProjectSettingsMap,
  type WorktreeOutcome,
} from "../../../shared/projects";
import type { WorkspaceProject } from "../../../shared/wire";
import * as api from "../session";
import { Text } from "./SettingsProfiles";

export function WorkspaceSettings({
  workspaces,
  activeWorkspaceId,
  projects,
  settings,
  onEditing,
}: {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  projects: WorkspaceProject[];
  settings: ProjectSettingsMap;
  onEditing: (on: boolean) => void;
}) {
  /**
   * Opens on the workspace you are in, which is the one whose board you were
   * just looking at. A workspace deleted while the page is open falls back to
   * the active one rather than to an empty tab.
   */
  const [chosen, setChosen] = useState(activeWorkspaceId);
  const shown = workspaces.find((w) => w.id === chosen) ?? workspaces.find((w) => w.id === activeWorkspaceId);
  const rootOf = (id: string) => projects.find((project) => project.workspaceId === id)?.root ?? null;
  const root = shown ? rootOf(shown.id) : null;
  const sharedWith = shown && root ? workspaces.filter((w) => w.id !== shown.id && rootOf(w.id) === root) : [];
  /*
   * Every card in the profile with a worktree in this repository, whichever
   * board it is on: a repository's worktrees are the repository's, and the
   * switch below is about all of them, not the ones on the tab you happen to
   * be looking at.
   */
  const standing = root ? workspaces.flatMap((w) => w.board?.cards ?? []).filter((card) => card.worktree?.root === root) : [];

  return (
    <div className="set-page">
      <section className="set-section">
        <h3 className="set-h">Workspaces</h3>
        <p className="set-note">
          Where the robot on a card starts its agent, for the repository each workspace is in.
        </p>
      </section>

      <div className="set-subtabs" role="tablist" aria-label="Workspaces">
        {workspaces.map((workspace) => (
          <button
            key={workspace.id}
            role="tab"
            aria-selected={shown?.id === workspace.id}
            className={`set-choice ${shown?.id === workspace.id ? "set-choice-on" : ""}`}
            onClick={() => setChosen(workspace.id)}
          >
            {workspace.name}
          </button>
        ))}
      </div>

      {shown && !root && (
        <section className="set-section">
          <p className="set-note">
            <strong>{shown.name}</strong> is not in a repository yet. Open a terminal in one and it appears here.
          </p>
        </section>
      )}
      {shown && root && (
        <RepositorySettings
          key={root}
          root={root}
          settings={projectSettingsFor(settings, root)}
          sharedWith={sharedWith.map((w) => w.name)}
          standing={standing}
          onEditing={onEditing}
        />
      )}
    </div>
  );
}

function RepositorySettings({
  root,
  settings,
  sharedWith,
  standing,
  onEditing,
}: {
  root: string;
  settings: ProjectSettings;
  /** The other workspaces in this same repository, whose settings these also are. */
  sharedWith: string[];
  /** The cards whose worktree is in this repository, from every board in the profile. */
  standing: Card[];
  onEditing: (on: boolean) => void;
}) {
  const name = root.slice(root.lastIndexOf("/") + 1) || root;
  const set = (patch: Partial<ProjectSettings>) => api.setProject(root, { ...settings, ...patch });
  /**
   * The switch's second click, and what came of it. `asking` is the list
   * showing with the switch drawn off but nothing sent; `outcomes` is the
   * reply, kept on the page until the tab changes so a worktree that was left
   * standing has its reason next to it. `failed` is the sweep refused as a
   * whole, which the reply does not itemise.
   */
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<WorktreeOutcome[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const toggle = (on: boolean) => {
    if (on || standing.length === 0) set({ worktrees: on });
    else setAsking(true);
  };
  const retire = () => {
    setAsking(false);
    setBusy(true);
    setOutcomes(null);
    setFailed(null);
    // The setting goes first: the person turned it off, and a worktree that
    // refuses to merge is a reason to say so, not to leave the switch on.
    if (settings.worktrees) set({ worktrees: false });
    api
      .retireWorktrees(root)
      .then(setOutcomes, (err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="set-section">
      <h3 className="set-h">{name}</h3>
      <p className="set-note set-mono">{root}</p>
      {sharedWith.length > 0 && (
        <p className="set-note set-note-under">
          The same repository as <strong>{sharedWith.join(", ")}</strong>, so these settings are shared.
        </p>
      )}
      <label className="set-check set-check-row">
        <input
          type="checkbox"
          checked={settings.worktrees && !asking}
          disabled={busy}
          onChange={(event) => toggle(event.target.checked)}
        />
        Run each card in a worktree of its own
      </label>
      <p className="set-note set-note-under">
        Beside the repository, as <span className="set-mono">{worktreeDir(root, "<card>")}</span>, on a branch
        under <span className="set-mono">kururu/</span>. Off, cards run in the checkout the board is in.
      </p>

      {asking && (
        <div className="set-warn set-retire">
          <p className="set-retire-lead">
            Turning this off merges {count(standing.length, "worktree")} back into the branch each was cut from and
            removes {standing.length === 1 ? "it" : "them"}. An agent still working in one is ended first. Anything
            uncommitted is left where it is, and that worktree stays.
          </p>
          <ul className="set-retire-list">
            {standing.map((card) => (
              <li key={card.id}>
                <span className="set-mono">{card.worktree?.branch}</span> into{" "}
                <span className="set-mono">{card.worktree?.base}</span> · {card.title}
                {card.run?.agentId && card.run.state !== "ended" ? " · agent running" : ""}
              </li>
            ))}
          </ul>
          <div className="set-retire-actions">
            <button className="set-choice" onClick={() => setAsking(false)}>
              Keep them
            </button>
            <button className="set-choice set-choice-warn" onClick={retire}>
              Merge and remove {standing.length === 1 ? "it" : `all ${standing.length}`}
            </button>
          </div>
        </div>
      )}

      {/* Worktrees off and some still standing — a sweep that left some behind,
          or a repository switched off before there was a sweep. The same
          question, from the other side of the switch. */}
      {!asking && !busy && !settings.worktrees && standing.length > 0 && (
        <p className="set-note set-note-under">
          {count(standing.length, "worktree")} still standing.{" "}
          <button className="set-choice set-button-inline" onClick={() => setAsking(true)}>
            Merge and remove
          </button>
        </p>
      )}

      {busy && <p className="set-note set-note-under">Merging…</p>}
      {failed && <p className="set-warn">{failed}</p>}
      {outcomes && outcomes.length > 0 && (
        <ul className="set-retire-list set-retire-done">
          {outcomes.map((outcome) => (
            <li key={outcome.cardId}>
              <strong>{outcome.title}</strong>:{" "}
              {outcome.error
                ? `nothing merged, left standing — ${outcome.error}`
                : `${count(outcome.commits, "commit")} merged, worktree removed`}
            </li>
          ))}
        </ul>
      )}

      <fieldset className="set-fieldset" disabled={!settings.worktrees}>
        <div className="set-row">
          <span className="set-label">Setup</span>
          <Text
            className="set-text"
            value={settings.setup}
            placeholder="bun install"
            onCommit={(setup) => set({ setup })}
            onEditing={onEditing}
            aria-label="Setup command"
          />
        </div>
        <p className="set-note set-note-under">
          Run once in a fresh worktree, in the agent's terminal, before the agent. A worktree starts
          with the tracked files and nothing else — no dependencies, no <span className="set-mono">.env</span>.
        </p>
      </fieldset>
      <div className="set-row">
        <span className="set-label">Dev server</span>
        <Text
          className="set-text"
          value={settings.dev}
          placeholder="bun run dev"
          onCommit={(dev) => set({ dev })}
          onEditing={onEditing}
          aria-label="Dev server command"
        />
      </div>
      <p className="set-note set-note-under">
        Started in a tab of its own whenever a card gets a worktree, and ended when the card goes to
        Done. It is given a free port in <span className="set-mono">PORT</span>; the one it actually
        takes is read off the machine, and the card links to it.
      </p>
    </section>
  );
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
