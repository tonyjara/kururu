/**
 * Settings → General → Workspaces: where a workspace's shells run, where the
 * agents kururu starts in it open, and what a card's worktree gets, for the
 * repository each workspace is in.
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
import type { AgentPlacement } from "../../../shared/agentpane";
import { projectSettingsFor, worktreeDir, type ProjectSettings, type ProjectSettingsMap, type WorktreeOutcome } from "../../../shared/projects";
import type { WorkspaceProject } from "../../../shared/wire";
import * as api from "../session";
import { useKururu } from "../session";
import { PLACEMENT_OPTIONS } from "./Agents";
import { Bullets, Choice, Danger, Details, Empty, Field, Group, Mono, Outcome, P, plural, Readout, Row, Segments } from "./ui";

export function WorkspacesPage({
  profileId,
  agentPlacement,
  workspaces,
  activeWorkspaceId,
  projects,
  settings,
}: {
  profileId: string;
  /** The profile's own, which a workspace with none of its own follows. */
  agentPlacement: AgentPlacement;
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

      {shown && <RunsOn key={shown.id} workspace={shown} />}
      {shown && <AgentsHere profileId={profileId} workspace={shown} profilePlacement={agentPlacement} />}

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
 * Where a workspace's new shells open: here, or on a machine, in a folder
 * there, inside tmux. The folder is the server's to refuse: it goes into a
 * command line on the far side, and the sentence that comes back says which
 * characters it will not put there.
 */
function RunsOn({ workspace }: { workspace: Workspace }) {
  const { machines } = useKururu();
  const pin = workspace.machine;
  const machine = pin ? (machines.find((m) => m.id === pin.machineId) ?? null) : null;
  const [error, setError] = useState<string | null>(null);
  const pinTo = (machineId: string | null, dir: string) => {
    setError(null);
    api.pinWorkspace(workspace.id, machineId, dir).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <Group
      title="Runs on"
      foot={
        machines.length === 0
          ? "Add a machine under Connections to run this workspace's shells there."
          : machine
            ? "New terminals open there in a tmux session, so a dropped connection reattaches. Only shells go: agents, nvim, files and dev servers stay on this Mac."
            : "Only shells move; agents and everything that reads files stay on this Mac."
      }
    >
      <Choice
        label="Shells"
        hint={error ? <Outcome bad>{error}</Outcome> : undefined}
        value={machine?.id ?? "local"}
        onChange={(value) => pinTo(value === "local" ? null : value, "~")}
        options={[["local", "This Mac"] as const, ...machines.map((m) => [m.id, m.name, `ssh ${m.host}`] as const)]}
      />
      {machine && pin && <Field label="Folder" hint={`On ${machine.name}.`} mono value={pin.dir} placeholder="~" onCommit={(dir) => pinTo(machine.id, dir)} ariaLabel={`Folder on ${machine.name}`} />}
    </Group>
  );
}

/**
 * Where a card's or Kuru's agents open in this workspace, when it should
 * differ from the profile: one more segment than the Agents page has, for
 * "as the profile says", which is where every workspace starts.
 */
function AgentsHere({ profileId, workspace, profilePlacement }: { profileId: string; workspace: Workspace; profilePlacement: AgentPlacement }) {
  const said = PLACEMENT_OPTIONS.find(([id]) => id === profilePlacement)?.[1] ?? profilePlacement;
  return (
    <Group title="Agents">
      <Choice
        label="A card's or Kuru's agent"
        hint={`The profile says ${said.toLowerCase()}, under Agents.`}
        value={workspace.agentPlacement ?? "profile"}
        onChange={(value) => api.setAgentPlacement(profileId, value === "profile" ? null : value, workspace.id)}
        options={[["profile", "Profile", `As the profile says: ${said}`] as const, ...PLACEMENT_OPTIONS]}
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
