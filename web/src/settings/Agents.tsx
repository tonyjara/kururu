/**
 * Settings → General → Agents: what the new-tab button offers besides a
 * terminal, where the agents kururu starts itself open, when an idle card's
 * agent is put to sleep, and what Kuru does to the screen.
 *
 * A switch per CLI and a switch per model under it. The CLI's switch leaves
 * its models' switches as they were rather than turning them off, so switching
 * Codex off for a month and back on gives back the menu you had — which is why
 * the models sit in a card that dims rather than a list that empties.
 *
 * Where the models come from is not this page's business: the catalogue is
 * `shared/launchers.ts`, kept current by a skill, and a page that let you type
 * model names in would be a second catalogue nobody updates.
 */
import {
  AGENT_CLIS,
  BYPASS_FLAG,
  CLI_LABELS,
  LAUNCHERS,
  launcherCommand,
  SLEEP_MINUTES_MAX,
  SLEEP_MINUTES_MIN,
  type AgentCli,
  type LaunchSettings,
} from "../../../shared/launchers";
import type { AgentPlacement } from "../../../shared/agentpane";
import * as api from "../session";
import { Choice, Details, Group, Mono, NumField, P, Toggle } from "./ui";

/** The three answers, as the segments say them; the third's tooltip is what off means. */
export const PLACEMENT_OPTIONS = [
  ["bottom", "Bottom", "A tab in the bottom pane"],
  ["top", "Top", "A tab in the top pane"],
  ["off", "Off", "Beside the board, in the pane you came from, as before"],
] as const satisfies ReadonlyArray<readonly [AgentPlacement, string, string]>;

export function AgentsPage({
  launch,
  profileId,
  profileName,
  autoSwap,
  agentPlacement,
}: {
  launch: LaunchSettings;
  profileId: string;
  profileName: string;
  autoSwap: boolean;
  agentPlacement: AgentPlacement;
}) {
  const toggleCli = (cli: AgentCli, on: boolean) => api.setLaunch({ ...launch, offClis: on ? launch.offClis.filter((c) => c !== cli) : [...launch.offClis, cli] });
  const toggleLauncher = (id: string, on: boolean) =>
    api.setLaunch({ ...launch, offLaunchers: on ? launch.offLaunchers.filter((l) => l !== id) : [...launch.offLaunchers, id] });
  const toggleBypass = (cli: AgentCli, on: boolean) =>
    api.setLaunch({ ...launch, bypassClis: on ? [...launch.bypassClis, cli] : launch.bypassClis.filter((c) => c !== cli) });

  return (
    <>
      {AGENT_CLIS.map((cli) => {
        const on = !launch.offClis.includes(cli);
        return (
          <Group key={cli} title={CLI_LABELS[cli]} foot={cli === AGENT_CLIS[AGENT_CLIS.length - 1] ? "The model list is written into kururu and refreshed by the update-models skill." : undefined}>
            <Toggle label="In the + menu" on={on} onChange={(next) => toggleCli(cli, next)} />
            <fieldset className="st-sub" disabled={!on}>
              {/* Above the models because it applies to all of them, and it
                  changes the next launch only. */}
              <Toggle label="Bypass permissions" hint={<Mono>{BYPASS_FLAG[cli]}</Mono>} on={launch.bypassClis.includes(cli)} onChange={(next) => toggleBypass(cli, next)} />
              {LAUNCHERS.filter((launcher) => launcher.cli === cli).map((launcher) => (
                <Toggle
                  key={launcher.id}
                  label={launcher.model ? launcher.label : `${launcher.label}, default model`}
                  hint={<Mono>{launcherCommand(launcher, launch)}</Mono>}
                  on={!launch.offLaunchers.includes(launcher.id)}
                  onChange={(next) => toggleLauncher(launcher.id, next)}
                />
              ))}
            </fieldset>
          </Group>
        );
      })}

      <Group title="Where they open" foot={`For ${profileName}; a workspace can say otherwise under Workspaces. An agent from a pane's + menu opens where you asked.`}>
        <Choice
          label="A card's or Kuru's agent"
          hint="Joins one pane on that edge as a tab, split off when there is none."
          value={agentPlacement}
          onChange={(placement) => api.setAgentPlacement(profileId, placement)}
          options={PLACEMENT_OPTIONS}
        />
        <Details summary="Which pane is the bottom one">
          <P>
            The pane kururu put the last agent in, while it still runs along the bottom edge with something above it. Otherwise the widest pane along the bottom edge, then the
            tallest, then the leftmost. A pane showing the board or a document is passed over. When nothing qualifies, the whole workspace is split: what is there keeps its
            arrangement on top and the agents get the full width below. An empty workspace is split too, and keeps an empty top half. Top is the same, upside down.
          </P>
          <P>Where the agent starts is unchanged: the directory of the pane you came from. The keyboard stays where it was.</P>
        </Details>
      </Group>

      <Group title="Idle cards">
        <Toggle label="Sleep an idle card's agent" hint="The card keeps its conversation; running it again resumes." on={launch.sleepIdle} onChange={(sleepIdle) => api.setLaunch({ ...launch, sleepIdle })} />
        <NumField
          label="After"
          value={launch.sleepMinutes}
          min={SLEEP_MINUTES_MIN}
          max={SLEEP_MINUTES_MAX}
          unit="min"
          disabled={!launch.sleepIdle}
          ariaLabel="Minutes idle before a card's agent is put to sleep"
          onCommit={(sleepMinutes) => api.setLaunch({ ...launch, sleepMinutes })}
        />
        <Details summary="What counts as idle">
          <P>
            Only agents started from a card, never one you opened in a tab, never Kuru. Idle means its turn is over and nothing is waiting on you: no prompt or question on its
            screen, no message kururu is holding for it, nothing typed into its prompt, no command still running under it, and a last reply that did not end by asking you
            something. Nothing on disk is touched.
          </P>
        </Details>
      </Group>

      <Group title="Kuru" foot={`For ${profileName}. C-a z takes you back.`}>
        <Toggle
          label="Auto Swap"
          hint="The screen follows the agent Kuru is acting on. Waits while you type, gives way when you move."
          on={autoSwap}
          onChange={(on) => api.setAutoSwap(profileId, on)}
        />
      </Group>
    </>
  );
}
