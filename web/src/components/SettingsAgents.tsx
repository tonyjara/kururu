/**
 * Settings → Agents: what the new-tab button offers besides a terminal.
 *
 * A switch per CLI and a box per model under it. The CLI's switch leaves its
 * models' boxes as they were rather than unticking them, so switching Codex off
 * for a month and back on again gives back the menu you had — which is why the
 * models sit in a fieldset that dims rather than a list that empties.
 *
 * Where the models come from is not this page's business, and it says so in one
 * line: the catalogue is `shared/launchers.ts`, kept current by a skill, and a
 * page that let you type model names in would be a second catalogue that nobody
 * updates.
 *
 * It holds nothing, like every page here: a tick sends a verb and the box draws
 * what the snapshot says, so the phone's menu changes with the desktop's.
 */
import {
  AGENT_CLIS,
  BYPASS_FLAG,
  CLI_LABELS,
  LAUNCHERS,
  launcherCommand,
  type AgentCli,
  type LaunchSettings,
} from "../../../shared/launchers";
import * as api from "../session";

export function AgentSettings({ launch }: { launch: LaunchSettings }) {
  const toggleCli = (cli: AgentCli, on: boolean) =>
    api.setLaunch({
      ...launch,
      offClis: on ? launch.offClis.filter((c) => c !== cli) : [...launch.offClis, cli],
    });

  const toggleLauncher = (id: string, on: boolean) =>
    api.setLaunch({
      ...launch,
      offLaunchers: on ? launch.offLaunchers.filter((l) => l !== id) : [...launch.offLaunchers, id],
    });

  const toggleBypass = (cli: AgentCli, on: boolean) =>
    api.setLaunch({
      ...launch,
      bypassClis: on ? [...launch.bypassClis, cli] : launch.bypassClis.filter((c) => c !== cli),
    });

  return (
    <div className="set-page">
      <section className="set-section">
        <h3 className="set-h">Agents</h3>
        <p className="set-note">
          What the + on a tab strip offers besides a terminal. Each one opens a tab running that
          command in the pane's project.
        </p>
      </section>

      {AGENT_CLIS.map((cli) => {
        const on = !launch.offClis.includes(cli);
        return (
          <section key={cli} className="set-section">
            <label className="set-check set-check-row">
              <input type="checkbox" checked={on} onChange={(event) => toggleCli(cli, event.target.checked)} />
              <strong>{CLI_LABELS[cli]}</strong>
            </label>
            <fieldset className="set-fieldset" disabled={!on}>
              {/* Above the models because it applies to all of them, and it
                  changes the next launch only — a running agent keeps the
                  prompts it was started with. */}
              <label className="set-check set-check-row">
                <input
                  type="checkbox"
                  checked={launch.bypassClis.includes(cli)}
                  onChange={(event) => toggleBypass(cli, event.target.checked)}
                />
                Bypass permissions
                <span className="set-note set-note-inline">— {BYPASS_FLAG[cli]}</span>
              </label>
              {LAUNCHERS.filter((launcher) => launcher.cli === cli).map((launcher) => (
                <label key={launcher.id} className="set-check set-check-row">
                  <input
                    type="checkbox"
                    checked={!launch.offLaunchers.includes(launcher.id)}
                    onChange={(event) => toggleLauncher(launcher.id, event.target.checked)}
                  />
                  {launcher.model ? launcher.label : `${launcher.label}, default model`}
                  <span className="set-note set-note-inline">— {launcherCommand(launcher, launch)}</span>
                </label>
              ))}
            </fieldset>
          </section>
        );
      })}

      <p className="set-note set-note-under">
        The model list is written into kururu and refreshed by the <code>update-models</code> skill,
        so a model you just heard about may not be here yet. The default-model rows always start
        whatever the CLI itself is set to.
      </p>
    </div>
  );
}
