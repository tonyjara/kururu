/**
 * The questions kururu ever asks: name this, are you sure, which one, and —
 * `ask` — does this go ahead, maybe ending an agent on the way.
 *
 * One component rather than several because they are the same shape — a modal
 * that owns the keyboard until it is answered — and because the thing that
 * actually matters about them is shared: while a dialog is up, **no key
 * reaches a pty**. A rename prompt that let keystrokes through to the
 * terminal underneath would type your new tab name into an agent.
 *
 * The picker is a filter, not a fuzzy matcher. Substring matching over a list
 * that is rarely longer than a dozen rows is the whole of what a picker this
 * size needs, and a scoring function nobody can predict is worse than one
 * anybody can.
 *
 * `ask` is deliberately not `confirm`: a merge or a move to Done is a question
 * the person already meant to say yes to when they dragged the card, so focus
 * (and Enter) lands on Yes rather than on the safe answer `confirm` defaults
 * to. It carries an `alt` way through and, for a blocked merge, `choices`
 * instead of a plain yes — the board's own `Ask` shape, drawn centred instead
 * of on the card, so it reads the same wherever it is asked and a phone sees
 * it as a dialog rather than something to scroll a card into view for.
 *
 * `move` is the one that talks to the server while it is up: moving a
 * workspace to another node asks that node whether the folder will do, as
 * the folder is typed, and says what goes and what stays before anything
 * does — the worktree rule's reasoning, that anything ending work asks in
 * the middle of the screen and not at the foot of a row.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { folderSentence, type MoveDone, type MovePlan } from "../../../shared/move";
import * as api from "../session";
import { Icon } from "./Icon";

export interface PickItem {
  id: string;
  label: string;
  hint?: string;
}

export type DialogState =
  | {
      kind: "prompt";
      title: string;
      hint?: string;
      value: string;
      /** What the button says. "Save" when absent, which is what a rename is. */
      submitLabel?: string;
      /** Shown in the empty field — for a commit, what a message looks like. */
      placeholder?: string;
      onSubmit: (value: string) => void;
    }
  | {
      kind: "confirm";
      title: string;
      hint?: string;
      confirmLabel: string;
      onConfirm: () => void;
    }
  | {
      kind: "ask";
      title: string;
      hint?: string;
      /** The plain yes/cancel case. Absent when only `choices` is offered. */
      yes?: string;
      run?: () => void;
      /** A second way through, next to Cancel — "Just move" beside "Merge". */
      alt?: { label: string; run: () => void };
      /** A blocked merge's two resolutions, each with a sentence on what it does. */
      choices?: { label: string; outcome: string; run: () => void }[];
    }
  | {
      kind: "pick";
      title: string;
      hint?: string;
      items: PickItem[];
      onPick: (id: string) => void;
      /** Management, in place: the switcher is also where profiles are renamed. */
      onRename?: (id: string) => void;
      onDelete?: (id: string) => void;
      /**
       * And where they are made. A list of the things that exist with no way to
       * add one is a dead end you have to already know the keybind to get out
       * of; `run` puts the next dialog up itself, so it does not close this one.
       */
      onCreate?: { label: string; run: () => void };
    }
  | {
      kind: "move";
      title: string;
      hint?: string;
      workspaceId: string;
      nodeId: string;
    };

export function Dialog({ state, onClose }: { state: DialogState; onClose: () => void }) {
  return (
    <div className="scrim" onPointerDown={onClose}>
      <div className={state.kind === "move" ? "dialog dialog-move" : "dialog"} onPointerDown={(event) => event.stopPropagation()} role="dialog" aria-modal>
        <h2 className="dialog-title">{state.title}</h2>
        {state.hint && <p className="dialog-hint">{state.hint}</p>}
        {state.kind === "prompt" && <Prompt state={state} onClose={onClose} />}
        {state.kind === "confirm" && <Confirm state={state} onClose={onClose} />}
        {state.kind === "ask" && <Ask state={state} onClose={onClose} />}
        {state.kind === "pick" && <Pick state={state} onClose={onClose} />}
        {state.kind === "move" && <Move state={state} onClose={onClose} />}
      </div>
    </div>
  );
}

function Prompt({ state, onClose }: { state: Extract<DialogState, { kind: "prompt" }>; onClose: () => void }) {
  const [value, setValue] = useState(state.value);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.select();
  }, []);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        state.onSubmit(value);
        onClose();
      }}
    >
      <input
        ref={field}
        className="dialog-input"
        value={value}
        autoFocus
        placeholder={state.placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") onClose();
        }}
        autoComplete="off"
        spellCheck={false}
      />
      <div className="dialog-actions">
        <button type="button" className="button button-quiet" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="button">
          {state.submitLabel ?? "Save"}
        </button>
      </div>
    </form>
  );
}

function Confirm({ state, onClose }: { state: Extract<DialogState, { kind: "confirm" }>; onClose: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Focus lands on Cancel: this dialog only ever appears in front of something
    // destructive, so the safe answer is the one enter gives you.
    button.current?.focus();
  }, []);

  return (
    <div
      className="dialog-actions"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onClose();
      }}
    >
      <button ref={button} className="button button-quiet" onClick={onClose}>
        Cancel
      </button>
      <button
        className="button button-danger"
        onClick={() => {
          state.onConfirm();
          onClose();
        }}
      >
        {state.confirmLabel}
      </button>
    </div>
  );
}

function Ask({ state, onClose }: { state: Extract<DialogState, { kind: "ask" }>; onClose: () => void }) {
  const yes = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Focus lands on Yes, not Cancel: unlike `confirm`, which only ever fronts
    // something destructive, this is the question behind dragging a card to
    // Done or pressing Merge — the person already meant to say yes, so Enter
    // should do that. A question with only `choices` has no Yes to default to,
    // and gets `confirm`'s safe default instead.
    (yes.current ?? cancel.current)?.focus();
  }, []);

  return (
    <div
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onClose();
      }}
    >
      {state.choices?.map((choice) => (
        <div key={choice.label} className="dialog-ask-choice">
          <button
            className="button"
            onClick={() => {
              choice.run();
              onClose();
            }}
          >
            {choice.label}
          </button>
          <p className="dialog-ask-outcome">{choice.outcome}</p>
        </div>
      ))}
      <div className="dialog-actions">
        <button ref={cancel} className="button button-quiet" onClick={onClose}>
          Cancel
        </button>
        {state.alt && (
          <button
            className="button button-quiet"
            onClick={() => {
              state.alt?.run();
              onClose();
            }}
          >
            {state.alt.label}
          </button>
        )}
        {state.yes && (
          <button
            ref={yes}
            className="button"
            onClick={() => {
              state.run?.();
              onClose();
            }}
          >
            {state.yes}
          </button>
        )}
      </div>
    </div>
  );
}

function Pick({ state, onClose }: { state: Extract<DialogState, { kind: "pick" }>; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);

  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return state.items;
    return state.items.filter(
      (item) =>
        item.label.toLowerCase().includes(needle) || (item.hint ?? "").toLowerCase().includes(needle),
    );
  }, [state.items, query]);

  /**
   * The create row is the last stop of the same ring the items are in, and the
   * filter never touches it: a list filtered down to nothing is exactly when you
   * want to make the thing you were looking for.
   */
  const create = state.onCreate;
  const rows = items.length + (create ? 1 : 0);
  const index = Math.min(at, Math.max(0, rows - 1));
  const onCreate = create != null && index === items.length;
  const choose = (id: string) => {
    state.onPick(id);
    onClose();
  };

  return (
    <div
      onKeyDown={(event) => {
        // The picker owns every key it understands; the rest reach the input and
        // nothing at all reaches a terminal.
        event.stopPropagation();
        const key = event.key;
        if (key === "Escape") return onClose();
        if (key === "ArrowDown" || (event.ctrlKey && key === "n")) {
          event.preventDefault();
          return setAt(Math.min(index + 1, rows - 1));
        }
        if (key === "ArrowUp" || (event.ctrlKey && key === "p")) {
          event.preventDefault();
          return setAt(Math.max(index - 1, 0));
        }
        if (key === "Enter") {
          event.preventDefault();
          if (onCreate) return create.run();
          const item = items[index];
          if (item) choose(item.id);
        }
      }}
    >
      <input
        className="dialog-input"
        value={query}
        autoFocus
        placeholder="Filter…"
        onChange={(event) => {
          setQuery(event.target.value);
          setAt(0);
        }}
        autoComplete="off"
        spellCheck={false}
      />
      <ul className="dialog-list">
        {items.length === 0 && <li className="muted dialog-empty">Nothing matches.</li>}
        {items.map((item, i) => (
          <li key={item.id} className={i === index ? "dialog-row dialog-row-on" : "dialog-row"}>
            <button className="dialog-pick" onClick={() => choose(item.id)}>
              <span className="dialog-label">{item.label}</span>
              {item.hint && <span className="dialog-rowhint">{item.hint}</span>}
            </button>
            {state.onRename && (
              <button className="mini" title="Rename" onClick={() => state.onRename!(item.id)}>
                <Icon name="edit" />
              </button>
            )}
            {state.onDelete && (
              <button className="mini mini-danger" title="Delete" onClick={() => state.onDelete!(item.id)}>
                <Icon name="close" />
              </button>
            )}
          </li>
        ))}
        {create && (
          <li className={onCreate ? "dialog-row dialog-row-on" : "dialog-row"}>
            <button className="dialog-pick dialog-new" onClick={create.run}>
              <span className="dialog-label">+ {create.label}</span>
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

/** How long the folder field sits still before the node is asked about it. */
const CHECK_AFTER_MS = 500;

/**
 * Move to <node>…: the folder on that node, checked there as it is typed;
 * what goes and what stays, from the server; and the button, which waits
 * for both. A refusal is drawn above the lists so it is read first, and the
 * folder is still checked under it, so both things to fix are seen at once.
 */
function Move({ state, onClose }: { state: Extract<DialogState, { kind: "move" }>; onClose: () => void }) {
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [folder, setFolder] = useState("");
  /** The folder the plan's check is about, so a field edited since is not mistaken for one checked. */
  const [checked, setChecked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [moved, setMoved] = useState<{ done: MoveDone; node: string; url: string } | null>(null);
  const asked = useRef(0);

  const ask = (value: string | null) => {
    const n = ++asked.current;
    api.moveWorkspacePlan(state.workspaceId, state.nodeId, value).then(
      (next) => {
        if (n !== asked.current) return;
        setPlan(next);
        setError(null);
        // The words asked about, not the node's spelling of them: "~/x" and
        // "/home/me/x" are one folder, and a field compared against the other
        // spelling would be checked again for ever.
        const words = value ?? next.check?.shown ?? "";
        setChecked(words);
        if (value === null) setFolder(words);
      },
      (err: unknown) => {
        if (n === asked.current) setError(err instanceof Error ? err.message : String(err));
      },
    );
  };

  useEffect(() => {
    ask(null);
    // Asked once on opening; the field's own effect below asks after that.
  }, [state.workspaceId, state.nodeId]);

  useEffect(() => {
    if (checked === null || folder.trim() === checked) return;
    const timer = setTimeout(() => ask(folder.trim()), CHECK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [folder, checked]);

  const node = plan?.node.name ?? "the node";
  const check = plan?.check ?? null;
  const fresh = checked !== null && folder.trim() === checked;
  const ready = plan !== null && plan.refusal === null && check !== null && check.problem === null && fresh && !moving;

  const go = () => {
    if (!ready || !check) return;
    setMoving(true);
    setError(null);
    api.moveWorkspaceTo(state.workspaceId, state.nodeId, check.folder).then(
      (result) => {
        setMoving(false);
        setMoved(result);
      },
      (err: unknown) => {
        setMoving(false);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  };

  const keys = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape" && !moving) onClose();
  };

  if (moved) {
    return (
      <div onKeyDown={keys}>
        <p className="dialog-move-done">
          {moved.done.name} is on {moved.node} now{moved.done.again ? " (it had already arrived)" : ""}: {moved.done.cards} card
          {moved.done.cards === 1 ? "" : "s"}, in its profile {moved.done.profile}. Its board here is in Search → Deleted.
        </p>
        <div className="dialog-actions">
          {moved.url && (
            <a className="button button-quiet" href={moved.url} target="_blank" rel="noreferrer">
              Open {moved.node}
            </a>
          )}
          <button className="button" autoFocus onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div onKeyDown={keys}>
      {!plan && !error && <p className="dialog-hint">Asking {node}…</p>}
      {plan?.refusal && <p className="dialog-move-refused">{plan.refusal}</p>}
      {plan && (
        <>
          <label className="dialog-move-label" htmlFor="move-folder">
            The project's folder on {node}
          </label>
          <input
            id="move-folder"
            className="dialog-input"
            value={folder}
            autoFocus
            disabled={moving}
            onChange={(event) => setFolder(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (fresh) go();
                else ask(folder.trim());
              }
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <p className={check?.problem || plan.checkError ? "dialog-move-check dialog-move-bad" : "dialog-move-check"}>
            {!fresh
              ? "Checking…"
              : check
                ? `${folderSentence(check.problem, node, check.shown)} It arrives in ${node}'s profile ${check.profile}${check.clash ? `, which already has a workspace called ${plan.workspace.name}` : ""}.`
                : (plan.checkError ?? "")}
          </p>
          <h3 className="dialog-move-head">Moves to {node}</h3>
          <ul className="dialog-move-list">
            {plan.moves.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <h3 className="dialog-move-head">Stays here</h3>
          <ul className="dialog-move-list">
            {plan.stays.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
      {error && <p className="dialog-move-refused">{error}</p>}
      <div className="dialog-actions">
        <button className="button button-quiet" onClick={onClose} disabled={moving}>
          Cancel
        </button>
        <button className="button" onClick={go} disabled={!ready}>
          {moving ? "Moving…" : `Move to ${node}`}
        </button>
      </div>
    </div>
  );
}
