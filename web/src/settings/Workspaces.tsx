/**
 * Settings → General → Workspaces: a workspace's root folder and the machine
 * it runs on, whether it builds a mobile app, and what a card's worktree
 * gets, for the repository each workspace is in.
 *
 * Drawn per workspace and stored per repository: a person thinks in
 * workspaces, so that is the list, and under the one chosen is the repository
 * it is in and that repository's settings — two workspaces on one checkout
 * show the same controls and say so. The repository is the server's finding,
 * never typed here.
 *
 * Whether a card runs in a worktree is the card's, ticked in its composer.
 * What is here is what a fresh one needs, and the one control that does
 * something to the disk: merging every standing worktree back and removing
 * it, which asks first in place since it ends any agent still in one.
 */
import { useState } from "react";
import type { Card } from "../../../shared/board";
import type { Workspace } from "../../../shared/model";
import { projectSettingsFor, worktreeDir, type ProjectSettings, type ProjectSettingsMap, type WorktreeOutcome } from "../../../shared/projects";
import type { WorkspaceProject } from "../../../shared/wire";
import * as api from "../session";
import { useKururu } from "../session";
import { desktop } from "../desktop";
import { Btn, Bullets, Choice, Danger, Details, Empty, errorText, Field, Group, Mono, Outcome, P, plural, Readout, Row, Segments, TextBox, Toggle } from "./ui";

export function WorkspacesPage({
  profileId,
  workspaces,
  activeWorkspaceId,
  projects,
  settings,
}: {
  profileId: string;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  projects: WorkspaceProject[];
  settings: ProjectSettingsMap;
}) {
  /** Opens on the workspace you are in; one deleted while the page is open falls back to it. */
  const [chosen, setChosen] = useState(activeWorkspaceId);
  const shown = workspaces.find((w) => w.id === chosen) ?? workspaces.find((w) => w.id === activeWorkspaceId);
  const rootOf = (id: string) => projects.find((project) => project.workspaceId === id)?.root ?? null;
  const root = shown ? rootOf(shown.id) : null;
  const sharedWith = shown && root ? workspaces.filter((w) => w.id !== shown.id && rootOf(w.id) === root) : [];
  /** Every card in the profile with a worktree in this repository, whichever board it is on. */
  const standing = root ? workspaces.flatMap((w) => w.board?.cards ?? []).filter((card) => card.worktree?.root === root) : [];

  return (
    <>
      <Group>
        <Row label="Workspace" wide>
          <Segments value={shown?.id ?? ""} onChange={setChosen} label="Workspace" options={workspaces.map((w) => [w.id, w.name] as const)} />
        </Row>
      </Group>

      {shown && <Root key={shown.id} profileId={profileId} workspace={shown} />}
      {shown && <Mobile profileId={profileId} workspace={shown} />}

      {shown && !root && (
        <Group title="Repository">
          <Empty>
            {shown.machine
              ? `${shown.name} has no repository on this Mac. Worktrees and their settings apply only to a terminal opened here.`
              : `${shown.name} is not in a repository yet. Open a terminal in one and it appears here.`}
          </Empty>
        </Group>
      )}
      {shown && root && <Repository key={root} root={root} settings={projectSettingsFor(settings, root)} sharedWith={sharedWith.map((w) => w.name)} standing={standing} />}
    </>
  );
}

/**
 * The workspace's root folder, and the machine it runs on: the one place
 * everything new in it starts (`Workspace.root`).
 *
 * One field for both, because to the person they are one question, "where is
 * this project": on this Mac it is a folder here, with the system's chooser
 * beside it in the desktop app, and on a machine it is the pin's folder there,
 * which is all a pinned workspace's root ever was. The server is the one to
 * refuse either: a folder here must be there, and a folder on a machine goes
 * into a command line, so the sentence that comes back says which characters
 * it will not put there.
 */
function Root({ profileId, workspace }: { profileId: string; workspace: Workspace }) {
  const { machines } = useKururu();
  const pin = workspace.machine;
  const machine = pin ? (machines.find((m) => m.id === pin.machineId) ?? null) : null;
  const [error, setError] = useState<string | null>(null);
  const fail = (err: unknown) => setError(errorText(err));
  const pinTo = (machineId: string | null, dir: string) => {
    setError(null);
    api.pinWorkspace(workspace.id, machineId, dir).catch(fail);
  };
  const setRoot = (root: string) => {
    setError(null);
    api.setWorkspaceRoot(profileId, workspace.id, root).catch(fail);
  };
  const bridge = desktop();
  const choose = () => {
    void bridge
      ?.pickFolder?.(workspace.root)
      .then((picked) => {
        if (picked) setRoot(picked);
      })
      .catch(fail);
  };

  return (
    <Group
      title="Root"
      foot={
        machine
          ? `New terminals, nvim, LazyGit, agents and card runs open on ${machine.name}, in this folder, inside tmux, so a dropped connection reattaches. The file tree and dev servers stay on this Mac.`
          : workspace.root
            ? "New terminals, nvim, LazyGit, agents, card runs and automations start in this folder, whichever pane they are opened from. A card's worktree and a folder given to Kuru still win."
            : "None yet, so a new terminal starts wherever the one it was opened from is. Give the project's folder and everything new starts there."
      }
    >
      {machines.length > 0 && (
        <Choice
          label="Runs on"
          value={machine?.id ?? "local"}
          onChange={(value) => pinTo(value === "local" ? null : value, "~")}
          options={[["local", "This Mac"] as const, ...machines.map((m) => [m.id, m.name, `ssh ${m.host}`] as const)]}
        />
      )}
      {machine && pin ? (
        <Field
          label="Root folder"
          hint={error ? <Outcome bad>{error}</Outcome> : `On ${machine.name}.`}
          mono
          value={pin.dir}
          placeholder="~"
          onCommit={(dir) => pinTo(machine.id, dir)}
          ariaLabel={`Root folder on ${machine.name}`}
        />
      ) : (
        <Row label="Root folder" hint={error ? <Outcome bad>{error}</Outcome> : "On this Mac. ~ is your home folder."} wide>
          <span className="st-keybox">
            <TextBox mono value={workspace.root ?? ""} placeholder="~/projects/name" onCommit={setRoot} aria-label="Root folder" />
            {bridge?.pickFolder && <Btn onClick={choose}>Choose…</Btn>}
          </span>
        </Row>
      )}
    </Group>
  );
}

/**
 * Whether this workspace builds a mobile app, and so shares the Mac's builds
 * and simulators with the other agents through the slot queue. Ticked, a
 * card run here is told how before its own words, and the queue's line sits
 * under the agents' pane. What the paragraph says is kururu's unless
 * `~/.config/kururu/slots-brief.md` says otherwise; see `docs/slots.md`.
 */
function Mobile({ profileId, workspace }: { profileId: string; workspace: Workspace }) {
  return (
    <Group
      title="Mobile"
      foot="A card run here starts with a paragraph on queueing for builds, simulators and test runs (the slot queue), and a line under the agents' pane says what its agents hold and wait for. Your own paragraph goes in ~/.config/kururu/slots-brief.md."
    >
      <Toggle
        label="Builds a mobile app"
        hint={workspace.machine ? "Only card runs on this Mac are told; a run on a machine has no slot queue there." : undefined}
        on={workspace.mobile}
        onChange={(on) => api.setWorkspaceMobile(profileId, workspace.id, on)}
      />
    </Group>
  );
}

function Repository({ root, settings, sharedWith, standing }: { root: string; settings: ProjectSettings; sharedWith: string[]; standing: Card[] }) {
  const name = root.slice(root.lastIndexOf("/") + 1) || root;
  const set = (patch: Partial<ProjectSettings>) => api.setProject(root, { ...settings, ...patch });
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<WorktreeOutcome[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const retire = () => {
    setBusy(true);
    setOutcomes(null);
    setFailed(null);
    api
      .retireWorktrees(root)
      .then(setOutcomes, (err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <Group title="Repository" foot={sharedWith.length > 0 ? `The same repository as ${sharedWith.join(", ")}, so these settings are shared.` : undefined}>
      <Readout label={name} value={<Mono>{root}</Mono>} />
      <Field label="Setup" hint="Run once in a fresh worktree, before the agent." mono value={settings.setup} placeholder="bun install" onCommit={(setup) => set({ setup })} ariaLabel="Setup command" />
      <Field label="Dev server" hint="Started in its own tab when a card gets a worktree; given a free PORT." mono value={settings.dev} placeholder="bun run dev" onCommit={(dev) => set({ dev })} ariaLabel="Dev server command" />
      <Details summary="How a card's worktree works">
        <P>
          A card ticked <b>Worktree</b> runs beside the repository, as <Mono>{worktreeDir(root, "<card>")}</Mono>, on a branch under <Mono>kururu/</Mono>. Unticked, it runs in the
          checkout the board is in. A worktree starts with the tracked files and a copy of the main checkout's ignored <Mono>.env*</Mono> files, no dependencies. The dev server is
          ended when the card goes to Done, and the card links to the port it actually took.
        </P>
      </Details>
      {outcomes && outcomes.length > 0 && (
        <Row label="Merged" wide>
          <Bullets
            items={outcomes.map((outcome) => (
              <span key={outcome.cardId}>
                <b>{outcome.title}</b>: {outcome.error ? `nothing merged, left standing: ${outcome.error}` : `${plural(outcome.commits, "commit")} merged, worktree removed`}
              </span>
            ))}
          />
        </Row>
      )}
      {standing.length > 0 && (
        <Danger
          label={`${plural(standing.length, "worktree")} standing`}
          hint={
            failed ? (
              <Outcome bad>{failed}</Outcome>
            ) : (
              <>
                {standing.map((card) => `${card.worktree?.branch} into ${card.worktree?.base}${card.run?.agentId && card.run.state !== "ended" ? " (agent running)" : ""}`).join(" · ")}. Anything
                uncommitted is left where it is, and that worktree stays.
              </>
            )
          }
          button="Merge and remove"
          ask={`Merge ${standing.length === 1 ? "it" : `all ${standing.length}`} back and remove ${standing.length === 1 ? "it" : "them"}, ending any agent still inside?`}
          confirm={`Merge and remove ${standing.length === 1 ? "it" : `all ${standing.length}`}`}
          onConfirm={retire}
          busy={busy}
          busyLabel="Merging…"
        />
      )}
    </Group>
  );
}
