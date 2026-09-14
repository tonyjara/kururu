/**
 * The three questions kururu ever asks: name this, are you sure, and which one.
 *
 * One component rather than three because they are the same shape — a modal that
 * owns the keyboard until it is answered — and because the thing that actually
 * matters about them is shared: while a dialog is up, **no key reaches a pty**.
 * A rename prompt that let keystrokes through to the terminal underneath would
 * type your new tab name into an agent.
 *
 * The picker is a filter, not a fuzzy matcher. Substring matching over a list
 * that is rarely longer than a dozen rows is the whole of what a picker this
 * size needs, and a scoring function nobody can predict is worse than one
 * anybody can.
 */
import { useEffect, useMemo, useRef, useState } from "react";

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
    };

export function Dialog({ state, onClose }: { state: DialogState; onClose: () => void }) {
  return (
    <div className="scrim" onPointerDown={onClose}>
      <div className="dialog" onPointerDown={(event) => event.stopPropagation()} role="dialog" aria-modal>
        <h2 className="dialog-title">{state.title}</h2>
        {state.hint && <p className="dialog-hint">{state.hint}</p>}
        {state.kind === "prompt" && <Prompt state={state} onClose={onClose} />}
        {state.kind === "confirm" && <Confirm state={state} onClose={onClose} />}
        {state.kind === "pick" && <Pick state={state} onClose={onClose} />}
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
          Save
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
                ✎
              </button>
            )}
            {state.onDelete && (
              <button className="mini mini-danger" title="Delete" onClick={() => state.onDelete!(item.id)}>
                ✕
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
