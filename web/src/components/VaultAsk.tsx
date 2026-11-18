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
 * **A file field** — a certificate, a `.p8`, a service account's JSON — is a
 * zone to drop the file on and a Choose file… button, which on a phone is the
 * system's own picker (Files, iCloud Drive), so the phone takes files too and
 * needs no secure context for it. What is held until Save is the `File`, in
 * a ref, never its bytes; the zone draws only its name and size; the bytes
 * are read on Save, as base64, straight into the same message, and dropped
 * with the dialog. A file over `FILE_MAX`, an empty one, or one whose name
 * does not end in what the field accepts is refused on the spot with why.
 *
 * The reason is drawn as Markdown (`kurumd.ts`, as Kuru's replies are), since
 * it is often a walkthrough — which console, which button, what to copy —
 * with steps and links in it. It scrolls inside itself past two-fifths of the
 * screen, the fields under it scroll with it, and the title and Save stay put,
 * so a reason of any length never pushes Save off a phone.
 * A web link opens outside the app, as the drawer's do; a path is words,
 * since a dialog that holds pasted keys is no place to open a file from.
 *
 * The scrim does not close it. A tap beside a dialog that holds two pasted
 * keys should not throw them away; Cancel is a button.
 *
 * A `use` ask — a command waiting for the owner to allow an item — is drawn
 * here too, in the same place, with Allow once, Allow for 15 minutes and
 * Deny.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { acceptsName, FILE_MAX, sizeWords, type FieldOutcome, type UseAnswer, type VaultAsk, type WireValue } from "../../../shared/vaultitems";
import { replyTree } from "../kurumd";
import * as api from "../session";
import { KuruMarkdown, type MarkdownDoors } from "./KuruMarkdown";

type Values = Extract<VaultAsk, { kind: "values" }>;

/** When an ask closes by itself: a time today, else the day and the time. */
function until(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/** "a shell" at the start of a sentence. */
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
type Use = Extract<VaultAsk, { kind: "use" }>;

const REASON_DOORS: MarkdownDoors = { leaf: (text) => text, link: () => null };

/** The caller's reason, steps and links and all, in a box that scrolls rather than pushing Save off the screen. */
function Reason({ text }: { text: string }) {
  const tree = useMemo(() => replyTree(text), [text]);
  if (!text) return null;
  return (
    <div className="vault-reason kuru-md" tabIndex={0}>
      <KuruMarkdown blocks={tree} doors={REASON_DOORS} />
    </div>
  );
}

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

type FieldView = Values["fields"][number];

/** Why a picked file cannot go in this field, or null when it can. */
function fileProblem(file: File, accept: readonly string[] | null | undefined): string | null {
  if (!acceptsName(accept, file.name)) return `${file.name} is not ${accept?.join(" or ")}.`;
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > FILE_MAX) return `${file.name} is ${sizeWords(file.size)}; the vault takes files up to ${sizeWords(FILE_MAX)}.`;
  return null;
}

/**
 * A phone's picker greys out every file when `accept` names an extension it
 * has no type for (.p8 on iOS), so there the list is checked after the pick
 * instead of given to the picker.
 */
const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

function FilePick({ field, onFile }: { field: FieldView; onFile: (file: File | null) => void }) {
  const [picked, setPicked] = useState<{ name: string; size: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const chooser = useRef<HTMLInputElement>(null);
  const take = (file: File | undefined) => {
    if (!file) return;
    const why = fileProblem(file, field.accept);
    setProblem(why);
    if (why) return;
    setPicked({ name: file.name, size: file.size });
    onFile(file);
  };
  const drag = (event: React.DragEvent, on: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    if (on) event.dataTransfer.dropEffect = "copy";
    setOver(on);
  };
  return (
    <>
      <div
        className={`vault-drop${over ? " vault-drop-over" : ""}${picked ? " vault-drop-picked" : ""}`}
        onDragEnter={(event) => drag(event, true)}
        onDragOver={(event) => drag(event, true)}
        onDragLeave={(event) => drag(event, false)}
        onDrop={(event) => {
          drag(event, false);
          take(event.dataTransfer.files[0]);
        }}
      >
        {picked ? (
          <span className="vault-file">
            <span className="vault-file-name">{picked.name}</span> <span className="vault-file-size">{sizeWords(picked.size)}</span>
          </span>
        ) : (
          <span className="vault-drop-hint">
            {coarse ? "Pick the file" : "Drop the file here"}
            {field.accept?.length ? ` (${field.accept.join(", ")})` : ""}
          </span>
        )}
        <span className="vault-drop-buttons">
          {picked && (
            <button
              type="button"
              className="button button-quiet"
              onClick={() => {
                setPicked(null);
                setProblem(null);
                onFile(null);
              }}
            >
              Remove
            </button>
          )}
          <button id={`vault-${field.id}`} type="button" className="button button-quiet" onClick={() => chooser.current?.click()}>
            {picked ? "Choose another…" : "Choose file…"}
          </button>
        </span>
        <input
          ref={chooser}
          type="file"
          hidden
          accept={coarse ? undefined : field.accept?.join(",")}
          onChange={(event) => {
            take(event.target.files?.[0]);
            // So picking the same file again after a Remove still fires.
            event.target.value = "";
          }}
        />
      </div>
      {problem && <p className="vault-file-problem">{problem}</p>}
    </>
  );
}

function Field({
  field,
  input,
  onFile,
  onUse,
}: {
  field: FieldView;
  input: (el: HTMLInputElement | null) => void;
  onFile: (file: File | null) => void;
  onUse: (ask: boolean) => void;
}) {
  const [shown, setShown] = useState(false);
  const [asks, setAsks] = useState(field.use === "ask");
  return (
    <div className="vault-field">
      <label className="vault-label" htmlFor={`vault-${field.id}`}>
        {field.label}
      </label>
      {field.kind === "file" ? (
        <FilePick field={field} onFile={onFile} />
      ) : (
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
      )}
      <p className="vault-where">
        Keychain · <code>{field.name}</code>
        {field.kind === "file" && " as the file's bytes"}
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
  const files = useRef(new Map<string, File>());
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
    const gather = async (): Promise<Record<string, WireValue> | null> => {
      if (cancel) return null;
      const values: Record<string, WireValue> = {};
      for (const [id, el] of inputs.current) values[id] = el.value;
      for (const [id, file] of files.current) values[id] = { name: file.name, base64: await base64Of(file) };
      return values;
    };
    void gather()
      .then((values) => api.answerVault(ask.id, values, Object.fromEntries(uses.current)))
      .then((outcomes) => {
        for (const el of inputs.current.values()) el.value = "";
        files.current.clear();
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
      className="vault-form"
      onSubmit={(event) => {
        event.preventDefault();
        send(false);
      }}
      autoComplete="off"
    >
      <h2 className="dialog-title">{ask.title}</h2>
      <p className="dialog-hint">
        Asked by {ask.from}
        {more ? ` · ${more}` : ""}.
      </p>
      <div className="vault-body">
        <Reason text={ask.reason} />
        {ask.fields.map((field) => (
          <Field
            key={field.id}
            field={field}
            input={(el) => {
              if (el) inputs.current.set(field.id, el);
              else inputs.current.delete(field.id);
            }}
            onFile={(file) => {
              if (file) files.current.set(field.id, file);
              else files.current.delete(field.id);
            }}
            onUse={(on) => uses.current.set(field.id, on ? "ask" : "free")}
          />
        ))}
        <p className="vault-note">
          The values go to the vault and to the places above; {ask.from} is told only whether each was saved. An empty field is skipped{ask.fields.some((f) => f.kind === "file") ? ", and a file's contents are never shown" : ""}. Open until {until(ask.until)}.
        </p>
        {error && <p className="dialog-move-refused">{error}</p>}
      </div>
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

/** A file's bytes as base64, read when Save is pressed and not before. */
function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.readAsDataURL(file);
  });
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
              <strong>{label.get(o.field) ?? o.name}</strong>: {"why" in o ? `${o.outcome} — ${o.why}` : o.outcome}
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
        {capital(ask.from)} wants to run a command with {ask.items.map((i) => i.label).join(", ")}
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
