/**
 * Settings → OpenRouter: the key the sidebar's balance is read with.
 *
 * One box and two paragraphs, and the paragraphs are the page. Before anybody
 * pastes a key that can delete every other key on their account, it has to
 * say which kind of key, where to make one, and what kururu does with it —
 * and the first thing most people will try is the inference key already in
 * their `.env`, which the server refuses with a sentence pointing back here.
 *
 * It holds only what is being typed, like every page here, and here that is
 * the point rather than the convention: the key goes to the server once and is
 * not sent back, so what this page draws afterwards is the `hint` every window
 * is sent.
 */
import { useState } from "react";
import * as api from "../session";
import { useKururu } from "../session";

const KEYS_URL = "https://openrouter.ai/settings/management-keys";

export function OpenRouterSettings({ onEditing }: { onEditing: (on: boolean) => void }) {
  const { openrouter } = useKururu();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const save = () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    api
      .setOpenRouterKey(key)
      .then(() => {
        setKey("");
        setConfirming(false);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="set-page">
      <section className="set-section">
        <h3 className="set-h">OpenRouter</h3>
        <p className="set-note">
          Your account's balance in the sidebar, with what every key on it has spent today, this
          week and this month. kururu asks OpenRouter once a minute while a window is open.
        </p>
        <p className="set-note">
          OpenRouter only tells the balance to a <strong>management key</strong>, not the kind your
          projects use — make one at{" "}
          <a href={KEYS_URL} target="_blank" rel="noreferrer noopener">
            openrouter.ai/settings/management-keys
          </a>
          . A management key cannot run a model but can create and delete your API keys; kururu only
          ever reads with it. It is kept in <code>~/.config/kururu/openrouter.json</code>, readable
          only by you, and is never sent back to a window.
        </p>
      </section>

      <section className="set-section">
        {openrouter && (
          <div className="set-row">
            <span className="set-label">Key</span>
            <span className="set-mono">{openrouter.hint}</span>
            <span className="set-note set-note-inline">
              {openrouter.error
                ? `— ${openrouter.error}`
                : openrouter.reading
                  ? "— connected"
                  : "— connecting…"}
            </span>
            {confirming ? (
              <button
                className="set-choice set-choice-warn set-reset"
                onClick={() => {
                  api.clearOpenRouterKey();
                  setConfirming(false);
                }}
              >
                Forget the key?
              </button>
            ) : (
              <button className="set-choice set-reset" onClick={() => setConfirming(true)}>
                Remove
              </button>
            )}
          </div>
        )}
        <div className="set-row">
          <span className="set-label">{openrouter ? "Replace" : "Key"}</span>
          <input
            className="set-text"
            type="password"
            value={key}
            placeholder="sk-or-v1-…"
            aria-label="OpenRouter management key"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onFocus={() => onEditing(true)}
            onBlur={() => onEditing(false)}
            onKeyDown={(event) => {
              if (event.key === "Enter") save();
            }}
            onChange={(event) => setKey(event.target.value)}
          />
          <button className="button" disabled={!key.trim() || busy} onClick={save}>
            {busy ? "Checking…" : "Save"}
          </button>
        </div>
        {error && <p className="set-warn">{error}</p>}
      </section>
    </div>
  );
}
