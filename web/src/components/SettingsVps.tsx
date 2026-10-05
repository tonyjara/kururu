/**
 * Settings → VPS: which machines the sidebar watches.
 *
 * A form of three boxes and a list, and the page's real job is the paragraph
 * above them: this works through the user's own ssh, so what makes a VPS work
 * here is what makes `ssh <host>` work in a terminal without a question — and
 * the one thing the page can usefully say when it does not is to go and do that
 * once. The row in the sidebar carries ssh's own error for the rest.
 *
 * It holds nothing but what is being typed, like every page here: the list is
 * the server's, pushed to every window, so a VPS added on the desktop is on the
 * phone before the dialog closes.
 */
import { useState } from "react";
import * as api from "../session";
import { useKururu } from "../session";

export function VpsSettings({ onEditing }: { onEditing: (on: boolean) => void }) {
  const { vps } = useKururu();
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [panel, setPanel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const add = () => {
    if (!host.trim() || busy) return;
    setBusy(true);
    setError(null);
    api
      .addVps(name, host, panel)
      .then(() => {
        setName("");
        setHost("");
        setPanel("");
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const field = {
    className: "set-text",
    onFocus: () => onEditing(true),
    onBlur: () => onEditing(false),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "Enter") add();
    },
  };

  return (
    <div className="set-page">
      <section className="set-section">
        <h3 className="set-h">VPS</h3>
        <p className="set-note">
          CPU, memory and disk of a server, in the sidebar. kururu runs{" "}
          <code>ssh</code> with your own <code>~/.ssh/config</code> every fifteen seconds while a
          window is open, and runs one fixed, read-only script there — <code>/proc</code> and{" "}
          <code>df</code>. Nothing is installed and no port is opened.
        </p>
        <p className="set-note">
          It never answers a prompt, so the host has to work with <code>ssh &lt;host&gt;</code> in
          a terminal without asking anything: the key loaded and the host key already accepted.
          If a row says it cannot connect, do that once.
        </p>
      </section>

      <section className="set-section">
        <div className="set-row">
          <span className="set-label">Host</span>
          <input
            {...field}
            value={host}
            placeholder="my-vps or root@203.0.113.7"
            aria-label="ssh host"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setHost(event.target.value)}
          />
        </div>
        <div className="set-row">
          <span className="set-label">Name</span>
          <input
            {...field}
            value={name}
            placeholder="the host, if blank"
            aria-label="Name"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="set-row">
          <span className="set-label">Panel</span>
          <input
            {...field}
            value={panel}
            placeholder="https://dokploy.example.com (optional)"
            aria-label="Dashboard URL"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setPanel(event.target.value)}
          />
          <button className="button" disabled={!host.trim() || busy} onClick={add}>
            Add
          </button>
        </div>
        {error && <p className="set-warn">{error}</p>}
      </section>

      {vps.length > 0 && (
        <section className="set-section">
          <h3 className="set-h">Watching</h3>
          {vps.map((server) => (
            <div key={server.id} className="set-row">
              <strong>{server.name}</strong>
              <span className="set-mono">{server.host}</span>
              <span className="set-note set-note-inline">
                {server.error ? `— ${server.error}` : server.reading ? "— connected" : "— connecting…"}
              </span>
              {confirming === server.id ? (
                <button className="set-choice set-choice-warn set-reset" onClick={() => api.removeVps(server.id)}>
                  Stop watching?
                </button>
              ) : (
                <button className="set-choice set-reset" onClick={() => setConfirming(server.id)}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
