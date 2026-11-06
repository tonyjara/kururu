/**
 * Settings → General → Agents: what the new-tab button offers besides a
 * terminal, where the agents kururu starts itself open, when an idle card's
 * agent is put to sleep, what Kuru does to the screen, and — on the Mac —
 * lending this profile's Claude login to a node (`Secrets.tsx`).
 *
 * A switch per CLI and a dropdown of its models under it, a switch each. The
 * CLI's switch leaves its models' switches as they were rather than turning
 * them off, so switching Codex off for a month and back on gives back the menu
 * you had — which is why the dropdown dims rather than empties.
 *
 * Where the models come from is not this page's business: the catalogue is
 * `shared/launchers.ts`, kept current by a skill, and a page that let you type
 * model names in would be a second catalogue nobody updates.
 */
import { useState } from "react";

import {
  adoptOpencodeModel,
  AGENT_CLIS,
  AGY_DEFAULT_MODEL,
  BYPASS_FLAG,
  CLI_LABELS,
  HARNESS_CLI_LABELS,
  LAUNCHERS,
  launcherCommand,
  OPENCODE_DEFAULT_MODEL,
  SLEEP_MINUTES_MAX,
  SLEEP_MINUTES_MIN,
  type AgentCli,
  type HarnessCli,
  type LaunchSettings,
} from "../../../shared/launchers";
import type { AgentPlacement } from "../../../shared/agentpane";
import * as api from "../session";
import { LendLogin } from "./Secrets";
import { Choice, Danger, Details, Field, Group, Mono, NumField, Outcome, P, Select, SwitchMenu, Toggle } from "./ui";

/** The three programs, as the segments say them, with what each is billed to as the tooltip. */
const HARNESS_OPTIONS = [
  ["claude", HARNESS_CLI_LABELS.claude, "Billed to your Claude subscription"],
  ["opencode", HARNESS_CLI_LABELS.opencode, "Billed to whatever OpenCode is signed in to, usually an API key"],
  ["agy", HARNESS_CLI_LABELS.agy, "Antigravity's own CLI, agy, billed to your Antigravity plan's quota"],
] as const satisfies ReadonlyArray<readonly [HarnessCli, string, string]>;

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
  agentsKururuMcpOnly,
  kuruOn,
  agentPlacement,
}: {
  launch: LaunchSettings;
  profileId: string;
  profileName: string;
  autoSwap: boolean;
  agentsKururuMcpOnly: boolean;
  /** The program this profile's Kuru is running on, or null when it is not running. */
  kuruOn: HarnessCli | null;
  agentPlacement: AgentPlacement;
}) {
  const toggleCli = (cli: AgentCli, on: boolean) => api.setLaunch({ ...launch, offClis: on ? launch.offClis.filter((c) => c !== cli) : [...launch.offClis, cli] });
  const toggleLauncher = (id: string, on: boolean) =>
    api.setLaunch({ ...launch, offLaunchers: on ? launch.offLaunchers.filter((l) => l !== id) : [...launch.offLaunchers, id] });
  const toggleBypass = (cli: AgentCli, on: boolean) =>
    api.setLaunch({ ...launch, bypassClis: on ? [...launch.bypassClis, cli] : launch.bypassClis.filter((c) => c !== cli) });

  return (
    <>
      {AGENT_CLIS.filter((cli) => cli !== "opencode").map((cli) => {
        const on = !launch.offClis.includes(cli);
        return (
          <Group
            key={cli}
            title={CLI_LABELS[cli]}
            foot={
              cli === "codex"
                ? "The model list is written into kururu and refreshed by the update-models skill."
                : cli === "agy"
                  ? "Antigravity's own CLI, agy, on your Antigravity sign-in. Its models are the ones agy models lists."
                  : undefined
            }
          >
            <Toggle label="In the + menu" on={on} onChange={(next) => toggleCli(cli, next)} />
            <fieldset className="st-sub" disabled={!on}>
              {/* Above the models because it applies to all of them, and it
                  changes the next launch only. */}
              <Toggle label="Bypass permissions" hint={<Mono>{BYPASS_FLAG[cli]}</Mono>} on={launch.bypassClis.includes(cli)} onChange={(next) => toggleBypass(cli, next)} />
              {/* Claude only: Codex and OpenCode get their servers in config
                  kururu writes, with no flag that drops the rest. */}
              {cli === "claude" && (
                <Toggle
                  label="Only kururu's MCP servers"
                  hint={`For ${profileName}'s agents, from the next one started: no claude.ai connectors, no plugins' servers, none of your own. Saves their names and instructions on every call. Kuru is kept to kururu's and your own either way.`}
                  on={agentsKururuMcpOnly}
                  onChange={(on) => api.setAgentsKururuMcpOnly(profileId, on)}
                />
              )}
              <SwitchMenu
                label="Models"
                items={LAUNCHERS.filter((launcher) => launcher.cli === cli).map((launcher) => {
                  const shown = !launch.offLaunchers.includes(launcher.id);
                  return {
                    label: launcher.model ? launcher.label : `${launcher.label}, default model`,
                    title: launcherCommand(launcher, launch),
                    on: shown,
                    run: () => toggleLauncher(launcher.id, !shown),
                  };
                })}
              />
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

      <LendLogin profileId={profileId} profileName={profileName} perProfile={launch.loginsPerProfile} />

      <Group title="Kuru" foot={`Auto Swap is for ${profileName}; C-a z takes you back. What Kuru runs on is for every profile.`}>
        <Toggle
          label="Auto Swap"
          hint="The screen follows the agent Kuru is acting on. Waits while you type, gives way when you move."
          on={autoSwap}
          onChange={(on) => api.setAutoSwap(profileId, on)}
        />
        <KuruProgram launch={launch} profileId={profileId} profileName={profileName} kuruOn={kuruOn} />
      </Group>
    </>
  );
}

/**
 * Which program Kuru runs on, and — when the Kuru running now is on the
 * other one — the restart that moves it, since the switch only changes the
 * next start. The restart ends Kuru's process, so it asks; the conversation
 * each program had is kept on the profile and picked up again on a switch
 * back, which is why the sentence says so.
 */
function KuruProgram({ launch, profileId, profileName, kuruOn }: { launch: LaunchSettings; profileId: string; profileName: string; kuruOn: HarnessCli | null }) {
  const [restart, setRestart] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [badModel, setBadModel] = useState(false);
  const want = launch.harnessCli;
  const stale = kuruOn !== null && kuruOn !== want;
  return (
    <>
      <Choice
        label="Runs on"
        hint={
          want === "opencode"
            ? "OpenCode, with its own sign-in: Kuru and every agent use this model and are billed per token."
            : want === "agy"
              ? "Antigravity's agy, on your Antigravity sign-in: Kuru, cards and the Claude rows use this model, on your Antigravity quota."
              : "Claude Code, on your Claude subscription; agents use the normal Claude and Codex launchers."
        }
        value={want}
        options={HARNESS_OPTIONS}
        onChange={(harnessCli) => api.setLaunch({ ...launch, harnessCli })}
      />
      {want === "opencode" && (
        <Field
          label="OpenCode model"
          hint={badModel ? <Outcome bad>Not a model: write provider/model, with #effort if you like.</Outcome> : <>provider/model#effort, as OpenCode spells it. <Mono>{OPENCODE_DEFAULT_MODEL}</Mono> by default.</>}
          value={launch.opencodeModel}
          mono
          placeholder={OPENCODE_DEFAULT_MODEL}
          ariaLabel="The model OpenCode runs Kuru on"
          onCommit={(value) => {
            const model = value.trim() ? adoptOpencodeModel(value) : OPENCODE_DEFAULT_MODEL;
            setBadModel(model === null);
            if (model) api.setLaunch({ ...launch, opencodeModel: model });
          }}
        />
      )}
      {want === "agy" && (
        <Select
          label="Antigravity model"
          hint={<>As agy names it. <Mono>{AGY_DEFAULT_MODEL}</Mono> by default.</>}
          value={launch.agyModel}
          ariaLabel="The model Antigravity runs Kuru and the agents on"
          onChange={(agyModel) => api.setLaunch({ ...launch, agyModel })}
        >
          {LAUNCHERS.filter((launcher) => launcher.cli === "agy" && launcher.model).map((launcher) => (
            <option key={launcher.id} value={launcher.model}>
              {launcher.label.replace(/^Antigravity /, "")}
            </option>
          ))}
        </Select>
      )}
      {stale && (
        <Danger
          label={`Restart Kuru on ${HARNESS_CLI_LABELS[want]}`}
          hint={
            restart.error ? (
              <Outcome bad>{restart.error}</Outcome>
            ) : (
              `${profileName}'s Kuru is running on ${HARNESS_CLI_LABELS[kuruOn]}, and keeps it until it starts again. Its ${HARNESS_CLI_LABELS[kuruOn]} conversation is kept for a switch back.`
            )
          }
          button="Restart"
          ask={`End Kuru's ${HARNESS_CLI_LABELS[kuruOn]} session and start it on ${HARNESS_CLI_LABELS[want]}?`}
          busy={restart.busy}
          busyLabel="Restarting…"
          onConfirm={() => {
            setRestart({ busy: true, error: null });
            api.restartHarness(profileId).then(
              () => setRestart({ busy: false, error: null }),
              (err: unknown) => setRestart({ busy: false, error: err instanceof Error ? err.message : String(err) }),
            );
          }}
        />
      )}
    </>
  );
}
