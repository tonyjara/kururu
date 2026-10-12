/**
 * Settings → Connections → Backups: a private repository the precious things
 * go to.
 *
 * The page is mostly the two lists, folded, and that is deliberate: before
 * anybody pastes a repository URL they can see exactly what will leave the
 * machine and exactly what never will, and the second list is the one that
 * earns the trust. The URL is tried when it is saved, with `ls-remote`, and a
 * repository that does not answer is a sentence here and no change.
 *
 * It holds only what is being typed; what it draws afterwards is the `backup`
 * status every window is sent.
 */
import { useState } from "react";
import { BACKUP_INTERVAL_MAX, BACKUP_INTERVAL_MIN, CONFIG_DIRS, CONFIG_FILES, EXCLUDED, type BackupStatus } from "../../../shared/backup";
import * as api from "../session";
import { useKururu } from "../session";
import { Action, Bullets, Details, Empty, errorText, Field, Group, Mono, NumField, Outcome, P, Step, Steps, Toggle, when } from "./ui";

export function BackupsPage() {
  const { backup } = useKururu();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);

  if (!backup) {
    return (
      <Group>
        <Empty>Waiting for the server…</Empty>
      </Group>
    );
  }
  const { settings } = backup;

  const save = (patch: Partial<{ url: string | null; enabled: boolean; intervalMin: number }>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api
      .setBackup({ url: settings.url, enabled: settings.enabled, intervalMin: settings.intervalMin, ...patch })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  const now = () => {
    if (busy) return;
    setBusy(true);
    setSaid(null);
    api
      .backupNow()
      .then((status) => setSaid(status.error ? { text: status.error, bad: true } : { text: "Backed up." }))
      .catch((err: unknown) => setSaid({ text: errorText(err), bad: true }))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Group title="Backups" foot="Every few minutes, when something changed, the precious things are written as text into a repository of kururu's own and pushed with your own git credentials.">
        <Toggle label="Back up" hint={describe(backup)} on={settings.enabled} disabled={!settings.url || busy} onChange={(enabled) => save({ enabled })} />
        <NumField label="Every" value={settings.intervalMin} min={BACKUP_INTERVAL_MIN} max={BACKUP_INTERVAL_MAX} unit="min" ariaLabel="Minutes between backups" onCommit={(intervalMin) => save({ intervalMin })} />
        <Action label="Back up now" button="Back up" busy={busy && said === null && !error} busyLabel="Working…" disabled={!settings.url} onClick={now} outcome={said} />
      </Group>

      <Group title="Set up">
        <Steps>
          <Step n={1} done={!!settings.url} title="A private, empty repository" line="On GitHub or anywhere git pushes to. Git uses your own credentials, an ssh key or the keychain; kururu never sees them." />
          <Step n={2} done={!!settings.url} title="Give kururu its URL" line="Tried when saved: a repository that does not answer is refused.">
            <Field
              label="Repository"
              hint={error ? <Outcome bad>{error}</Outcome> : <>The mirror lives at <Mono>{backup.dir}</Mono>.</>}
              mono
              value={settings.url ?? ""}
              placeholder="git@github.com:you/kururu-backup.git"
              ariaLabel="Backup repository"
              onCommit={(url) => save({ url: url.trim() || null, enabled: url.trim() ? true : settings.enabled })}
            />
          </Step>
        </Steps>
      </Group>

      <Group title="What goes, and what never does">
        <Details summary="What goes: config, boards, conversations, memory, the pane layout.">
          <Bullets
            items={[
              <>
                <Mono>config/</Mono>: {CONFIG_FILES.join(", ")}, and the <Mono>{CONFIG_DIRS.join("/")}</Mono> and <Mono>{CONFIG_DIRS[1]}/</Mono> folders
              </>,
              <>
                <Mono>boards/</Mono>: every board as JSON, with each card's runs and history of moves; deleted cards marked, not dropped
              </>,
              <>
                <Mono>conversations/</Mono>: what you typed or said to Kuru and what it answered, one turn per line
              </>,
              <>
                <Mono>memory/</Mono>: Kuru's memory folders, and each profile's Claude settings with its <Mono>env</Mono> block dropped
              </>,
              <>
                <Mono>state/session.json</Mono>: the arrangement of panes
              </>,
            ]}
          />
        </Details>
        <Details summary="What never goes: every secret and every login.">
          <Bullets
            items={EXCLUDED.map(({ what, why }) => (
              <>
                <Mono>{what}</Mono>: {why}
              </>
            ))}
          />
        </Details>
        <Details summary="A new Mac">
          <P>
            Clone kururu, then <Mono>bun run restore &lt;this repository&gt;</Mono>. It puts everything above back and prints what is left to do by hand: a login per profile and
            the keys.
          </P>
        </Details>
      </Group>
    </>
  );
}

function describe(status: BackupStatus): string {
  if (!status.settings.url) return "No repository yet: the steps below.";
  const parts: string[] = [];
  if (status.running) parts.push("Backing up now…");
  else if (!status.settings.enabled) parts.push("Off");
  else parts.push(status.pending ? "Something changed since the last backup" : "Nothing changed since the last backup");
  if (status.lastCommitAt) parts.push(`last commit ${when(status.lastCommitAt)}`);
  if (status.lastPushAt) parts.push(`pushed ${when(status.lastPushAt)}`);
  if (status.unpushed) parts.push(`${status.unpushed} not yet pushed`);
  if (status.error) parts.push(status.error);
  return parts.join(" · ");
}
