/**
 * Settings → Backups: a private repository the precious things go to.
 *
 * The page is mostly the two lists, and that is deliberate: before anybody
 * pastes a repository URL they should see exactly what will leave the
 * machine and exactly what never will, and the second list is the one that
 * earns the trust. The controls are a URL, a switch and an interval. The
 * URL is tried when it is saved — the server runs `ls-remote` — and a
 * repository that does not answer is a sentence here and no change.
 *
 * It holds only what is being typed, like every page here; what it draws
 * afterwards is the `backup` status every window is sent.
 */
import { useEffect, useState } from "react";
import { BACKUP_INTERVAL_MAX, BACKUP_INTERVAL_MIN, CONFIG_DIRS, CONFIG_FILES, EXCLUDED } from "../../../shared/backup";
import * as api from "../session";
import { useKururu } from "../session";

export function BackupSettings({ onEditing }: { onEditing: (on: boolean) => void }) {
  const { backup } = useKururu();
  const [url, setUrl] = useState("");
  const [interval, setInterval] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  // What the server has, until something is typed over it.
  useEffect(() => {
    if (!backup || touched) return;
    setUrl(backup.settings.url ?? "");
    setInterval(backup.settings.intervalMin);
  }, [backup, touched]);

  if (!backup) {
    return (
      <div className="set-page">
        <p className="set-note">Waiting for the server…</p>
      </div>
    );
  }

  const save = (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api
      .setBackup({ url: url.trim() || null, enabled, intervalMin: interval })
      .then(() => setTouched(false))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const now = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api
      .backupNow()
      .then((status) => {
        if (status.error) setError(status.error);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const { settings } = backup;
  return (
    <div className="set-page">
      <section className="set-section">
        <h3 className="set-h">Backups</h3>
        <p className="set-note">
          Every few minutes, when something changed, kururu writes the precious things as text into a git
          repository of its own at <code>{backup.dir}</code> and pushes it to a private repository you give
          it. Make one on GitHub, private, empty, and paste its URL. Git pushes with your own credentials —
          an ssh key or the keychain — and kururu never sees them.
        </p>
      </section>

      <section className="set-section">
        <div className="set-row">
          <span className="set-label">Repository</span>
          <input
            className="set-text"
            type="text"
            value={url}
            placeholder="git@github.com:you/kururu-backup.git"
            aria-label="Backup repository"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onFocus={() => onEditing(true)}
            onBlur={() => onEditing(false)}
            onChange={(event) => {
              setTouched(true);
              setUrl(event.target.value);
            }}
          />
        </div>
        <div className="set-row">
          <span className="set-label">Every</span>
          <input
            className="set-text set-text-short"
            type="number"
            min={BACKUP_INTERVAL_MIN}
            max={BACKUP_INTERVAL_MAX}
            value={interval}
            aria-label="Minutes between backups"
            onFocus={() => onEditing(true)}
            onBlur={() => onEditing(false)}
            onChange={(event) => {
              setTouched(true);
              const n = Number(event.target.value);
              if (Number.isFinite(n)) setInterval(Math.round(n));
            }}
          />
          <span className="set-note set-note-inline">minutes, when something changed</span>
        </div>
        <div className="set-row">
          <button className="button" disabled={busy || !url.trim()} onClick={() => save(true)}>
            {busy ? "Checking…" : settings.enabled && !touched ? "Backing up" : "Save and turn on"}
          </button>
          {settings.enabled && (
            <button className="set-choice" disabled={busy} onClick={() => save(false)}>
              Turn off
            </button>
          )}
          <button className="set-choice" disabled={busy || !settings.url} onClick={now}>
            Back up now
          </button>
        </div>
        {error && <p className="set-warn">{error}</p>}
        <p className="set-note">{describe(backup)}</p>
      </section>

      <section className="set-section">
        <h3 className="set-h">What goes</h3>
        <ul className="set-note backup-list">
          <li>
            <code>config/</code> — {CONFIG_FILES.join(", ")}, and the <code>{CONFIG_DIRS.join("/")}</code> and{" "}
            <code>{CONFIG_DIRS[1]}/</code> folders
          </li>
          <li>
            <code>boards/</code> — every board as JSON: columns, cards, each card's runs and its history of moves;
            deleted cards marked, not dropped
          </li>
          <li>
            <code>conversations/</code> — what you typed or said to Kuru and what it answered, one turn per line
          </li>
          <li>
            <code>memory/</code> — the harness's memory folders, and each profile's Claude settings with its{" "}
            <code>env</code> block dropped
          </li>
          <li>
            <code>state/session.json</code> — the arrangement of panes
          </li>
        </ul>
        <h3 className="set-h">What never goes</h3>
        <ul className="set-note backup-list">
          {EXCLUDED.map(({ what, why }) => (
            <li key={what}>
              <code>{what}</code> — {why}
            </li>
          ))}
        </ul>
        <p className="set-note">
          A new Mac: clone kururu, then <code>bun run restore &lt;this repository&gt;</code>. It puts everything
          above back and prints what is left to do by hand — a login per profile and the OpenRouter key.
        </p>
      </section>
    </div>
  );
}

function describe(status: { settings: { enabled: boolean; url: string | null }; running: boolean; pending: boolean; lastCommit: string | null; lastCommitAt: number | null; lastPushAt: number | null; error: string | null; unpushed: number }): string {
  if (!status.settings.url) return "No repository yet.";
  const parts: string[] = [];
  if (status.running) parts.push("Backing up now…");
  else if (!status.settings.enabled) parts.push("Off.");
  else parts.push(status.pending ? "Something changed since the last backup." : "Nothing changed since the last backup.");
  if (status.lastCommitAt) parts.push(`Last commit ${when(status.lastCommitAt)}: ${status.lastCommit ?? ""}.`);
  if (status.lastPushAt) parts.push(`Last pushed ${when(status.lastPushAt)}.`);
  if (status.unpushed) parts.push(`${status.unpushed} commit${status.unpushed === 1 ? "" : "s"} not yet pushed.`);
  return parts.join(" ");
}

function when(at: number): string {
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString();
  return today ? `at ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : `on ${date.toLocaleDateString()} at ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
