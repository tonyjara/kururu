/**
 * The vault's dialog: Kuru or an agent asked the owner for secrets, and this
 * is where they are pasted, so they never go through a chat.
 *
 * Over everything, on every page of this server — the window and the phone —
 * because the owner may be at either, and the first Save or Cancel answers
 * for all of them. It is not `Dialog.tsx`'s state: that is a question this
 * page asked, and this is one the server holds, which arrives and leaves by
 * itself.
 *
 * **Where the values are:** in the inputs, and nowhere else on the page. The
 * fields are uncontrolled and read once, on Save, straight into the one
 * message that carries them (`answerVault`); nothing puts them in React
 * state, the draft store or a log, and once the ask is answered the inputs
 * are gone with the dialog. Masked by default with a Show per field that is
 * never remembered, and with every hint a password manager or the phone's
 * keyboard reads turned off, because a key offered back by autofill in
 * another field is a key in the wrong place.
 *
 * The scrim does not close it. A tap beside a dialog that holds two pasted
 * keys should not throw them away; Cancel is a button.
 *
 * A `use` ask — a command waiting for the owner to allow an item — is drawn
 * here too, in the same place, with Allow once, Allow for 15 minutes and
 * Deny.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FieldOutcome, UseAnswer, VaultAsk } from "../../../shared/vaultitems";
import * as api from "../session";

type Values = Extract<VaultAsk, { kind: "values" }>;
type Use = Extract<VaultAsk, { kind: "use" }>;

export function VaultAsks() {
  const asks = api.useKururu().vaultAsks;
  // The answered ask stays drawn with its outcomes after the server has
  // already taken it off the list, so the owner sees what happened.
  const [done, setDone] = useState<{ ask: Values; outcomes: FieldOutcome[] } | null>(null);
  if (done) return <Outcomes ask={done.ask} outcomes={done.outcomes} onClose={() => setDone(null)} />;
  const ask = asks[0];
  if (!ask) return null;
  const more = asks.length > 1 ? `1 of ${asks.length}` : null;
  return createPortal(
    <div className="scrim vault-scrim">
      <div className="dialog vault-dialog" role="dialog" aria-modal onPointerDown={(event) => event.stopPropagation()}>
        {ask.kind === "values" ? (
          <ValuesAsk key={ask.id} ask={ask} more={more} onDone={(outcomes) => setDone({ ask, outcomes })} />
        ) : (
          <UseAsk key={ask.id} ask={ask} more={more} />
        )}
      </div>
    </div>,
    document.body,
  );
}

function Field({ field, input, onUse }: { field: Values["fields"][number]; input: (el: HTMLInputElement | null) => void; onUse: (ask: boolean) => void }) {
  const [shown, setShown] = useState(false);
  const [asks, setAsks] = useState(field.use === "ask");
  return (
    <div className="vault-field">
      <label className="vault-label" htmlFor={`vault-${field.id}`}>
        {field.label}
      </label>
      <div className="vault-row">
        <input
          id={`vault-${field.id}`}
          ref={input}
          className="dialog-input vault-input"
          type={shown ? "text" : "password"}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          placeholder={field.exists ? "Paste to replace what is kept" : "Paste here"}
          onKeyDown={(event) => event.stopPropagation()}
        />
        <button type="button" className="button button-quiet vault-show" onClick={() => setShown((s) => !s)} aria-pressed={shown}>
          {shown ? "Hide" : "Show"}
        </button>
      </div>
      <p className="vault-where">
        Keychain · <code>{field.name}</code>
        {field.exists && " (replaces it)"}
        {field.env && (
          <>
            <br />→ <code>{field.env.variable}</code> in <code>{field.env.file}</code>
          </>
        )}
      </p>
      <label className="vault-use">
        <input
          type="checkbox"
          checked={asks}
          onChange={(event) => {
            setAsks(event.target.checked);
            onUse(event.target.checked);
          }}
        />{" "}
        Ask me before each use
      </label>
    </div>
  );
}

function ValuesAsk({ ask, more, onDone }: { ask: Values; more: string | null; onDone: (outcomes: FieldOutcome[]) => void }) {
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const uses = useRef(new Map(ask.fields.map((f) => [f.id, f.use])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    inputs.current.get(ask.fields[0]?.id ?? "")?.focus();
  }, [ask]);

  const send = (cancel: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    let values: Record<string, string> | null = null;
    if (!cancel) {
      values = {};
      for (const [id, el] of inputs.current) values[id] = el.value;
    }
    void api
      .answerVault(ask.id, values, Object.fromEntries(uses.current))
      .then((outcomes) => {
        for (const el of inputs.current.values()) el.value = "";
        if (cancel) return;
        onDone(outcomes);
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        send(false);
      }}
      autoComplete="off"
    >
      <h2 className="dialog-title">{ask.title}</h2>
      <p className="dialog-hint">
        Asked by {ask.from}{more ? ` · ${more}` : ""}. {ask.reason}
      </p>
      {ask.fields.map((field) => (
        <Field
          key={field.id}
          field={field}
          input={(el) => {
            if (el) inputs.current.set(field.id, el);
            else inputs.current.delete(field.id);
          }}
          onUse={(on) => uses.current.set(field.id, on ? "ask" : "free")}
        />
      ))}
      <p className="vault-note">The values go to the vault and to the places above; {ask.from} is told only whether each was saved. An empty field is skipped.</p>
      {error && <p className="dialog-move-refused">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="button button-quiet" onClick={() => send(true)} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="button" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function Outcomes({ ask, outcomes, onClose }: { ask: Values; outcomes: FieldOutcome[]; onClose: () => void }) {
  const allSaved = outcomes.every((o) => o.outcome === "saved");
  useEffect(() => {
    if (!allSaved) return;
    const timer = setTimeout(onClose, 2500);
    return () => clearTimeout(timer);
  }, [allSaved, onClose]);
  const label = new Map(ask.fields.map((f) => [f.id, f.label]));
  return createPortal(
    <div className="scrim vault-scrim" onPointerDown={onClose}>
      <div className="dialog vault-dialog" role="dialog" aria-modal onPointerDown={(event) => event.stopPropagation()}>
        <h2 className="dialog-title">{ask.title}</h2>
        <ul className="vault-outcomes">
          {outcomes.map((o) => (
            <li key={o.field} className={o.outcome === "failed" ? "vault-failed" : undefined}>
              <strong>{label.get(o.field) ?? o.name}</strong>: {o.outcome === "failed" ? `failed — ${o.why}` : o.outcome}
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function UseAsk({ ask, more }: { ask: Use; more: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = (a: UseAnswer) => {
    setBusy(true);
    void api.allowVault(ask.id, a).catch((err: unknown) => {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    });
  };
  return (
    <div onKeyDown={(event) => event.stopPropagation()}>
      <h2 className="dialog-title">Use {ask.items.length === 1 ? "a secret" : `${ask.items.length} secrets`}?</h2>
      <p className="dialog-hint">
        {ask.from} wants to run a command with {ask.items.map((i) => i.label).join(", ")}
        {more ? ` · ${more}` : ""}.
      </p>
      <pre className="vault-command">{ask.command}</pre>
      <p className="vault-where">
        in <code>{ask.cwd}</code> · {ask.items.map((i) => i.name).join(", ")}
      </p>
      {error && <p className="dialog-move-refused">{error}</p>}
      <div className="dialog-actions vault-use-actions">
        <button type="button" className="button button-quiet" onClick={() => answer("deny")} disabled={busy}>
          Deny
        </button>
        {ask.lasting && (
          <button type="button" className="button button-quiet" onClick={() => answer("lasting")} disabled={busy}>
            Allow for 15 min
          </button>
        )}
        <button type="button" className="button" onClick={() => answer("once")} disabled={busy}>
          Allow once
        </button>
      </div>
    </div>
  );
}
