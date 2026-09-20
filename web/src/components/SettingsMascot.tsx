/**
 * The mascot page: the ones you have kept, and the sheet the current one is cut
 * from.
 *
 * The picker exists because the alternative was a script. Picking an animation
 * meant running a cutter over a sheet, dropping the result somewhere, and
 * reloading — three steps to answer a question ("which of these do I want?")
 * that is entirely visual and has about forty answers per sheet. A grid you drag
 * across, with the thing itself hopping beside it, answers it in one gesture and
 * is the only version where you can *compare* two choices.
 *
 * The list down the side exists because comparing is what people actually do
 * with it, and a picker with nothing to keep makes you re-find a selection you
 * already made. So a mascot is a saved thing with a name on it, and a workspace
 * wears one the way it wears a colour. One of them is the default, which is what
 * a workspace that has not chosen gets — a field rather than "the first one",
 * because the frog is what kururu ships with, not what you are stuck with.
 *
 * A mascot has two animations: one for while the agent is going and one for
 * while it is stopped. They share the sheet, the cell size and the trim, because
 * those are facts about the picture rather than about the animation — and
 * sharing the trim in particular is what stops the frog from changing size the
 * moment it sits down.
 *
 * The picker itself is the sheet at integer zoom with its grid drawn on top,
 * because pixel art at a fractional scale is unreadable in exactly the way that
 * matters here — you are looking for the frame where the legs leave the ground.
 * Drag along a row to take a run of cells; the selection is a rectangle one row
 * tall, which is what an animation is in every sheet of this shape.
 *
 * The trim is computed, not asked for. What you want is "the part of the cell
 * the sprite is actually in", and a canvas can answer that off the pixels far
 * better than anybody can by typing numbers — with the one rule that it must be
 * a single box across every selected frame, since where a sprite sits *in* its
 * cell is how a sheet draws a jump. Trimming each frame to its own content would
 * land them all on the floor and throw the animation away.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Mascot as SavedMascot,
  MascotClip,
  MascotConfig,
  MascotMotion,
  MascotSet,
} from "../../../shared/model";
import { adoptMascot, DEFAULT_MASCOT, defaultMascot, slugSheetName } from "../../../shared/model";
import { forgetSheet, sheetUrl, useSheet } from "../mascot";
import * as api from "../session";
import { Mascot } from "./Status";
import { Icon } from "./Icon";

/**
 * How wide the picker is allowed to get before it starts scrolling instead.
 * Roughly the dialog, minus the list down one side and the preview down the other.
 */
const PICKER_WIDTH = 380;

/** Which of a mascot's two animations is being edited. */
type ClipName = "working" | "idle";

/** A new idle clip starts as the working one, slowed down: see `addIdle`. */
const IDLE_CYCLE = 1800;

/**
 * What to draw a sheet at. An integer, always, because pixel art at a fractional
 * scale is unreadable in exactly the way that matters here — you are looking for
 * the frame where the legs leave the ground. So a small sheet is blown up to fill
 * the space and a large one is shown at 1:1 and scrolled, rather than either
 * being fitted to the box at 1.7x.
 */
function zoomFor(width: number): number {
  return Math.max(1, Math.floor(PICKER_WIDTH / Math.max(1, width)));
}

/**
 * What there is to pick from. Two lists rather than one, because only one of
 * them has a remove button: what ships is not the user's to delete from in here.
 */
interface Catalogue {
  builtin: string[];
  imported: string[];
  /** Where an import lands, so the dialog can say so without spelling it twice. */
  dir: string;
}

const EMPTY: Catalogue = { builtin: [], imported: [], dir: "" };

export function MascotSettings({
  mascots,
  onEditing,
}: {
  mascots: MascotSet;
  onEditing: (on: boolean) => void;
}) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  /** Why the last import or removal did not happen. Cleared by the next attempt. */
  const [note, setNote] = useState<string | null>(null);
  /** Which of the two is under way, so the button says so and cannot be pressed twice. */
  const [working, setWorking] = useState<null | "import" | "remove">(null);
  /** Removing a sheet asks once, in the button itself. */
  const [confirming, setConfirming] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  /**
   * Which one is open in the picker, and which of its two animations.
   *
   * View state, deliberately: *editing* a mascot is not a fact about the session
   * the way being the default is, and a second window should not have its picker
   * yanked onto something else because this one clicked a row. It falls back to
   * the default, which is also what happens when the one being edited is deleted.
   */
  const [editing, setEditing] = useState<string | null>(null);
  const [clipName, setClipName] = useState<ClipName>("working");
  const mascot = mascots.list.find((m) => m.id === editing) ?? defaultMascot(mascots);
  const clip = clipName === "working" ? mascot.working : mascot.idle;

  /**
   * Fetched when the dialog opens rather than carried in the snapshot: it is a
   * catalogue, wanted once, by this. Putting it on every status change would be
   * paying for it continuously to save a request nobody makes twice.
   */
  useEffect(() => {
    let live = true;
    void fetch("/api/mascot/sheets")
      .then((response) => response.json())
      .then((body) => live && setCatalogue(body as Catalogue))
      .catch(() => live && setCatalogue(EMPTY));
    return () => {
      live = false;
    };
  }, []);

  /** Every change is sent, so there is no save button and nothing to discard. */
  const change = (patch: Partial<MascotConfig>) =>
    api.setMascot(mascot.id, adoptMascot({ ...mascot, ...patch }));

  /** The same, for whichever animation is in front of you. */
  const changeClip = (patch: Partial<MascotClip>) => {
    if (!clip) return;
    const next = { ...clip, ...patch };
    change(clipName === "working" ? { working: next } : { idle: next });
  };

  /**
   * An idle animation, seeded from the working one rather than from a guess.
   *
   * Nothing here knows what is on this sheet — the frog's idle frames are three
   * cells to the left of its jump, and that is a fact about one sheet, not about
   * sheets. So a new idle clip starts as a slower copy of the one you already
   * chose: recognisably wrong, in the right row, and one drag from right.
   */
  const addIdle = () => {
    change({ idle: { ...mascot.working, cycle: IDLE_CYCLE } });
    setClipName("idle");
  };

  const mine = catalogue?.imported.includes(mascot.sheet) ?? false;

  /**
   * A file somebody picked, on its way to the sheets directory.
   *
   * The name is derived here and checked again by the server — not because this
   * one is suspect, but because a name that reaches a filesystem should not have
   * been decided by whoever sent it. What this side adds is the part the server
   * cannot do politely: picking one that is free, so importing two files called
   * `sheet.png` is not an error message.
   */
  const importSheet = async (chosen: File) => {
    if (working) return;
    setNote(null);
    setWorking("import");
    const list = new Set([...(catalogue?.builtin ?? []), ...(catalogue?.imported ?? [])]);
    const base = slugSheetName(chosen.name);
    let name = base;
    for (let n = 2; list.has(name); n++) name = `${base.slice(0, 58)}-${n}`;

    try {
      const response = await fetch(`/api/mascot/import?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: await chosen.arrayBuffer(),
      });
      const answer = (await response.json()) as Catalogue & { name?: string; error?: string };
      if (!response.ok || !answer.name) {
        setNote(answer.error ?? "that file could not be imported");
        return;
      }
      forgetSheet(answer.name);
      setCatalogue({ builtin: answer.builtin, imported: answer.imported, dir: answer.dir });
      // Importing a sheet and then having to go and select it would be a step
      // that decided nothing: you picked the file because you want to use it.
      change({ sheet: answer.name });
    } catch {
      setNote("that file could not be imported");
    } finally {
      setWorking(null);
    }
  };

  const removeSheet = async (name: string) => {
    if (working) return;
    setNote(null);
    setConfirming(false);
    setWorking("remove");
    try {
      const response = await fetch(`/api/mascot/sheets?name=${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      const answer = (await response.json()) as Catalogue & { error?: string };
      if (!response.ok) {
        setNote(answer.error ?? "could not remove that sheet");
        return;
      }
      forgetSheet(name);
      setCatalogue({ builtin: answer.builtin, imported: answer.imported, dir: answer.dir });
      // The sheet this mascot was cut from has gone, so it falls back to the one
      // that ships rather than to a picker with nothing in it.
      change({ sheet: DEFAULT_MASCOT.sheet });
    } catch {
      setNote("could not remove that sheet");
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="set-split">
      <MascotList
        mascots={mascots}
        editing={mascot.id}
        onEdit={setEditing}
        onEditing={onEditing}
      />

      <div className="set-main">
        <div className="set-row">
          <label className="set-label" htmlFor="mascot-sheet">
            Sheet
          </label>
          <select
            id="mascot-sheet"
            className="set-select"
            value={mascot.sheet}
            onChange={(event) => {
              setConfirming(false);
              change({ sheet: event.target.value });
            }}
          >
            {/* Grouped, because the two halves answer different questions: one
                is what kururu came with, the other is what you brought — and
                only the second can be removed. */}
            <optgroup label="Included">
              {catalogue?.builtin.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </optgroup>
            {catalogue && catalogue.imported.length > 0 && (
              <optgroup label="Imported">
                {catalogue.imported.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>

          <input
            ref={file}
            className="set-file"
            type="file"
            accept="image/png,.png"
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              // Cleared so that picking the same file twice — after fixing it in
              // an editor, which is the whole reason you would — fires again.
              event.target.value = "";
              if (chosen) void importSheet(chosen);
            }}
          />
          <button className="set-choice" onClick={() => file.current?.click()} disabled={working !== null}>
            {working === "import" ? "Importing…" : "Import…"}
          </button>
          {/* Asked once, in the button, rather than through a dialog: Settings is
              already modal, and a confirm over a confirm is a stack. */}
          {mine &&
            (working === "remove" ? (
              <button className="set-choice" disabled>
                Removing…
              </button>
            ) : confirming ? (
              <button
                className="set-choice set-choice-warn"
                onClick={() => void removeSheet(mascot.sheet)}
              >
                Remove {mascot.sheet}?
              </button>
            ) : (
              <button className="set-choice" onClick={() => setConfirming(true)} disabled={working !== null}>
                Remove
              </button>
            ))}

          <label className="set-label" htmlFor="mascot-frame">
            Cell
          </label>
          <input
            id="mascot-frame"
            className="set-num"
            type="number"
            min={1}
            max={256}
            value={mascot.frame}
            onChange={(event) => change({ frame: Number(event.target.value) })}
          />
          <span className="set-note">px</span>
        </div>

        {note && <p className="set-hint key-note">{note}</p>}

        <p className="set-hint">
          PNG only — the trim is measured off the alpha channel. Any grid of frames will do; a
          plain strip is a sheet one row tall. Imports land in{" "}
          <code>{catalogue?.dir || "~/.config/kururu/sheets"}</code>.
        </p>

        {/* The two animations, as two tabs rather than two pickers side by side:
            they are the same gesture on the same sheet, and drawing the grid
            twice would halve it for no gain. */}
        <div className="set-row set-clips">
          {(
            [
              ["working", "Working", "while the agent is going"],
              ["idle", "Idle", "while it is stopped"],
            ] as [ClipName, string, string][]
          ).map(([value, label, what]) => (
            <button
              key={value}
              className={`set-choice ${clipName === value ? "set-choice-on" : ""}`}
              title={what}
              onClick={() => setClipName(value)}
            >
              {label}
              {value === "idle" && !mascot.idle && <span className="set-note"> · dot</span>}
            </button>
          ))}
          <span className="set-note">
            {clipName === "working" ? "while the agent is going" : "while it is stopped"}
          </span>
        </div>

        <div className="set-stage">
          {clip ? (
            <SheetPicker
              mascot={mascot}
              clip={clip}
              onChange={changeClip}
              onTrim={(trim) => change({ trim })}
            />
          ) : (
            /* Idle with no animation is not a broken state — it is the dot this
               badge was for two years, and saying so where the grid would be is
               the only place that reads as deliberate rather than as missing. */
            <div className="sheet-col set-empty">
              <p className="set-hint">
                Idle is a dot. Animate it and the badge breathes while the agent waits; blocked
                and done keep their dots either way.
              </p>
              <button className="set-choice" onClick={addIdle}>
                Animate idle
              </button>
            </div>
          )}

          {/* The badge itself: the clip you are editing, big enough to judge, and
              both of them at the size they will actually be in a row. Same
              component the rows use, so a preview that looked right and a badge
              that did not would be impossible. */}
          <div className="set-preview">
            <span className="status status-working preview-big" role="img" aria-label="Preview">
              <Mascot config={mascot} clip={clip ?? mascot.working} />
            </span>
            <span className="set-note">{clip ? clipName : "idle is a dot"}</span>
            <div className="preview-pair">
              <span className="status status-working" role="img" aria-label="Working, actual size">
                <Mascot config={mascot} clip={mascot.working} />
              </span>
              <span className="status status-idle" role="img" aria-label="Idle, actual size">
                {mascot.idle ? (
                  <Mascot config={mascot} clip={mascot.idle} />
                ) : (
                  <span className="status-dot" />
                )}
              </span>
            </div>
            <span className="set-note">actual size</span>
          </div>
        </div>

        <div className="set-row">
          <label className="set-label" htmlFor="mascot-cycle">
            Speed
          </label>
          <input
            id="mascot-cycle"
            className="set-range"
            type="range"
            min={160}
            max={2400}
            step={20}
            disabled={!clip}
            value={clip?.cycle ?? IDLE_CYCLE}
            onChange={(event) => changeClip({ cycle: Number(event.target.value) })}
          />
          <span className="set-note">
            {clip ? `${(clip.cycle / 1000).toFixed(2)}s a loop` : "—"}
          </span>
          {clipName === "idle" && mascot.idle && (
            <button className="set-choice" onClick={() => change({ idle: null })}>
              Use the dot
            </button>
          )}
        </div>

        <div className="set-row">
          <span className="set-label">Motion</span>
          {(
            [
              ["always", "Always"],
              ["system", "Follow system"],
              ["never", "Never"],
            ] as [MascotMotion, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              className={`set-choice ${mascot.motion === value ? "set-choice-on" : ""}`}
              onClick={() => change({ motion: value })}
            >
              {label}
            </button>
          ))}
          <button
            className="button-quiet set-reset"
            onClick={() => api.setMascot(mascot.id, DEFAULT_MASCOT)}
          >
            Reset this one
          </button>
        </div>
        {mascot.motion === "system" && (
          <p className="set-hint">
            Follows <code>prefers-reduced-motion</code>, so Reduce Motion holds the mascot still.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The mascots you have kept, which one you are editing, and which one is the
 * default.
 *
 * Each row draws itself with the same component the sidebar draws, animating,
 * because the whole reason to keep several is that you cannot tell them apart
 * from a handful of numbers — "row 1, four cells from 7" is not a thing anybody
 * recognises, and a frog mid-jump is.
 *
 * The star is drawn on every row rather than only on the default, for the same
 * reason the workspace colour swatch is drawn on untagged workspaces: a control
 * that appears only once it has been used is one nobody finds.
 *
 * Adding copies the one you are looking at rather than starting from the
 * default: you press it when what is in front of you is nearly right, and a
 * fresh default would throw away the sheet and cell size you had just found.
 */
function MascotList({
  mascots,
  editing,
  onEdit,
  onEditing,
}: {
  mascots: MascotSet;
  editing: string;
  onEdit: (id: string) => void;
  onEditing: (on: boolean) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  /**
   * Escape cancels a rename by blurring the field, which is also how enter and
   * clicking away commit one — so the commit lives in `blur` and this is what
   * tells it which of the three just happened.
   */
  const cancelled = useRef(false);

  useEffect(() => {
    onEditing(renaming !== null);
    return () => onEditing(false);
  }, [renaming, onEditing]);

  return (
    <aside className="mascot-list">
      {mascots.list.map((one: SavedMascot) => (
        <div
          key={one.id}
          className={`mascot-row ${one.id === editing ? "mascot-row-on" : ""}`}
          onPointerDown={() => onEdit(one.id)}
        >
          <span className="status status-working mascot-chip" role="img" aria-label={one.name}>
            <Mascot config={one} clip={one.working} />
          </span>

          {renaming === one.id ? (
            <input
              className="ws-edit"
              defaultValue={one.name}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") cancelled.current = true;
                if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
              }}
              onBlur={(event) => {
                // Blur is the exit every path goes through, so the commit lives
                // here and escape's only job is to say it was not one. An empty
                // name is refused by the server, which hands back the old one.
                if (!cancelled.current) api.renameMascot(one.id, event.currentTarget.value);
                cancelled.current = false;
                setRenaming(null);
              }}
              spellCheck={false}
            />
          ) : (
            <span className="mascot-name" onDoubleClick={() => setRenaming(one.id)}>
              {one.name}
            </span>
          )}

          {renaming !== one.id && (
            <>
              <button
                className={`mascot-star ${one.id === mascots.default ? "mascot-star-on" : ""}`}
                title={
                  one.id === mascots.default
                    ? "The default, for workspaces that have not picked"
                    : `Make ${one.name} the default`
                }
                aria-pressed={one.id === mascots.default}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  api.setDefaultMascot(one.id);
                }}
              >
                {one.id === mascots.default ? "★" : "☆"}
              </button>
              {/* Hidden rather than disabled at one, because the reason it cannot
                  go is that a working row must always have something in it —
                  which is an explanation, not a state of this button. */}
              {mascots.list.length > 1 && (
                <button
                  className="mascot-drop"
                  title="Forget this one"
                  aria-label={`Forget ${one.name}`}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    api.removeMascot(one.id);
                  }}
                >
                  <Icon name="close" />
                </button>
              )}
            </>
          )}
        </div>
      ))}

      <button className="mascot-add" onClick={() => api.addMascot(editing)}>
        + Add
      </button>
      <p className="set-hint mascot-listhint">
        Double-click a name to rename it. ★ is the default — what a workspace gets when it has not
        picked one of its own, in its right-click menu.
      </p>
    </aside>
  );
}

/**
 * The sheet, its grid, and the cells the current animation is taken from.
 *
 * Pointer events rather than clicks, so one gesture does the whole selection:
 * down picks the row and the first cell, moving extends the run, up ends it.
 * Backwards drags are normalised, because a run from six to three is a run from
 * three to six and making somebody drag the other way would be a rule with
 * nothing behind it.
 */
function SheetPicker({
  mascot,
  clip,
  onChange,
  onTrim,
}: {
  mascot: MascotConfig;
  clip: MascotClip;
  onChange: (patch: Partial<MascotClip>) => void;
  /** Separate from `onChange` because the trim belongs to the mascot, not to
      one of its animations — it is measured across both. */
  onTrim: (trim: MascotConfig["trim"]) => void;
}) {
  const src = sheetUrl(mascot.sheet);
  const sheet = useSheet(src);
  const surface = useRef<HTMLDivElement>(null);
  /** Where a drag started, so the run can be measured from it in both directions. */
  const anchor = useRef<{ row: number; col: number } | null>(null);
  const trim = useTrim(src, mascot);

  /**
   * The trim is a consequence of the selection, so it is applied when it lands
   * rather than being something else for the user to keep in step. Sent only
   * when it actually differs, or every measurement would be a round trip.
   */
  useEffect(() => {
    if (!trim) return;
    const { x, y, size } = mascot.trim;
    if (trim.x !== x || trim.y !== y || trim.size !== size) onTrim(trim);
    // `onTrim` closes over the current config by design; re-running on it would
    // re-send the trim that was just accepted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trim]);

  if (!sheet) {
    return <p className="set-hint">That sheet could not be loaded.</p>;
  }

  const zoom = zoomFor(sheet.width);
  const cols = Math.max(1, Math.floor(sheet.width / mascot.frame));
  const rows = Math.max(1, Math.floor(sheet.height / mascot.frame));

  const cellAt = (event: React.PointerEvent): { row: number; col: number } | null => {
    const box = surface.current?.getBoundingClientRect();
    if (!box) return null;
    const col = Math.floor((event.clientX - box.left) / (mascot.frame * zoom));
    const row = Math.floor((event.clientY - box.top) / (mascot.frame * zoom));
    if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
    return { row, col };
  };

  /**
   * Only when it actually changed. `pointermove` fires per pixel, and every one
   * of these is a message, a snapshot to every client and a write to disk — a
   * single drag across a row would be a hundred of them to say sixteen things.
   */
  const select = (row: number, col: number, count: number) => {
    if (row === clip.row && col === clip.col && count === clip.count) return;
    onChange({ row, col, count });
  };

  const extend = (to: { row: number; col: number }) => {
    const from = anchor.current;
    if (!from) return;
    select(from.row, Math.min(from.col, to.col), Math.abs(to.col - from.col) + 1);
  };

  /** The other animation, marked faintly, so the two cannot be chosen blind. */
  const other = clip === mascot.working ? mascot.idle : mascot.working;

  return (
    /* The sheet and the line describing the selection are one column, not two
       items in the stage's row — as siblings the caption took a flex slot of its
       own and squeezed the picture it describes down to half a sheet. Not
       `picker`: the sidebar's colour popup has that class, and it is fixed. */
    <div className="sheet-col">
      <div className="sheet-wrap">
        <div
          ref={surface}
          className="sheet"
          style={{
            width: sheet.width * zoom,
            height: sheet.height * zoom,
            backgroundImage: `url(${src})`,
            backgroundSize: `${sheet.width * zoom}px ${sheet.height * zoom}px`,
            // The grid is drawn rather than composed of elements: a 16x16 sheet
            // is 256 divs that exist only to be looked through.
            "--cell": `${mascot.frame * zoom}px`,
          } as React.CSSProperties}
          onPointerDown={(event) => {
            const cell = cellAt(event);
            if (!cell) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            anchor.current = cell;
            select(cell.row, cell.col, 1);
          }}
          onPointerMove={(event) => {
            if (!anchor.current) return;
            const cell = cellAt(event);
            if (cell) extend(cell);
          }}
          onPointerUp={() => {
            anchor.current = null;
          }}
          onPointerCancel={() => {
            anchor.current = null;
          }}
        >
          {other && (
            <span
              className="sheet-sel sheet-sel-other"
              style={{
                left: other.col * mascot.frame * zoom,
                top: other.row * mascot.frame * zoom,
                width: other.count * mascot.frame * zoom,
                height: mascot.frame * zoom,
              }}
            />
          )}
          <span
            className="sheet-sel"
            style={{
              left: clip.col * mascot.frame * zoom,
              top: clip.row * mascot.frame * zoom,
              width: clip.count * mascot.frame * zoom,
              height: mascot.frame * zoom,
            }}
          />
        </div>
      </div>
      <p className="set-hint">
        Drag along a row to take a run of cells. Row {clip.row}, {clip.count}{" "}
        {clip.count === 1 ? "cell" : "cells"} from {clip.col}.
      </p>
    </div>
  );
}

/**
 * The box the mascot's frames actually occupy, measured off the pixels.
 *
 * One box for every frame of *every* clip, squared up and grown upwards. Two
 * reasons, and they are the same reason at two scales. Within a clip: a sprite
 * stands on the floor of its cell and the room it needs is above, so growing a
 * 19x21 frog to a square by padding the top keeps its feet where the sheet put
 * them, and keeps the jump. Across clips: a sitting frog is smaller than a
 * jumping one, and a box each would scale them to the same badge — so the frog
 * would visibly change size the moment its agent stopped.
 *
 * A canvas rather than anything cleverer because the question is literally
 * "which pixels are not transparent", and the image is already decoded and
 * same-origin. Returns null while it cannot answer, which is also what it
 * returns for a fully transparent selection — nothing is a better trim than a
 * guess at one.
 */
function useTrim(src: string, mascot: MascotConfig): { x: number; y: number; size: number } | null {
  const { frame, working, idle } = mascot;
  const [trim, setTrim] = useState<{ x: number; y: number; size: number } | null>(null);
  const clips = useMemo(() => (idle ? [working, idle] : [working]), [working, idle]);
  /** Only the selection matters, so a re-render with the same one measures nothing. */
  const key = useMemo(
    () => `${src}|${frame}|${clips.map((c) => `${c.row},${c.col},${c.count}`).join(";")}`,
    [src, frame, clips],
  );

  useEffect(() => {
    let live = true;
    const image = new Image();
    image.onload = () => {
      if (!live) return;
      const canvas = document.createElement("canvas");
      canvas.width = frame;
      canvas.height = frame;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;

      let left = frame, top = frame, right = 0, bottom = 0;
      for (const { row, col, count } of clips) {
        for (let i = 0; i < count; i++) {
          context.clearRect(0, 0, frame, frame);
          context.drawImage(image, (col + i) * frame, row * frame, frame, frame, 0, 0, frame, frame);
          const { data } = context.getImageData(0, 0, frame, frame);
          for (let y = 0; y < frame; y++) {
            for (let x = 0; x < frame; x++) {
              if (data[(y * frame + x) * 4 + 3]! === 0) continue;
              if (x < left) left = x;
              if (x + 1 > right) right = x + 1;
              if (y < top) top = y;
              if (y + 1 > bottom) bottom = y + 1;
            }
          }
        }
      }
      if (right <= left || bottom <= top) return;

      const size = Math.min(frame, Math.max(right - left, bottom - top));
      // Centre horizontally, and take the room upwards: see the note above.
      const x = Math.max(0, Math.min(left - Math.floor((size - (right - left)) / 2), frame - size));
      const y = Math.max(0, Math.min(bottom - size, frame - size));
      setTrim({ x, y, size });
    };
    image.src = src;
    return () => {
      live = false;
    };
  }, [key, src, frame, clips]);

  return trim;
}
