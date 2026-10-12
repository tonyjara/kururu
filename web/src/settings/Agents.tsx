/**
 * Settings → General → Agents: what the new-tab button offers besides a
 * terminal, when an idle card's agent is put to sleep, and what Kuru does to
 * the screen.
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
import * as api from "../session";
import { Details, Group, Mono, NumField, P, Toggle } from "./ui";

export function AgentsPage({ launch, profileId, profileName, autoSwap }: { launch: LaunchSettings; profileId: string; profileName: string; autoSwap: boolean }) {
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
