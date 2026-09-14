/**
 * Settings, which for now is one thing: which part of which sprite sheet the
 * mascot is.
 *
 * It exists because the alternative was a script. Picking an animation meant
 * running a cutter over a sheet, dropping the result somewhere, and reloading —
 * three steps to answer a question ("which of these do I want?") that is
 * entirely visual and has about forty answers per sheet. A grid you drag across,
 * with the thing itself hopping beside it, answers it in one gesture and is the
 * only version where you can *compare* two choices.
 *
 * The picker is the sheet at integer zoom with its grid drawn on top, because
 * pixel art at a fractional scale is unreadable in exactly the way that matters
 * here — you are looking for the frame where the legs leave the ground. Drag
 * along a row to take a run of cells; the selection is a rectangle one row tall,
 * which is what an animation is in every sheet of this shape.
 *
 * The trim is computed, not asked for. What you want is "the part of the cell
 * the sprite is actually in", and a canvas can answer that off the pixels far
 * better than anybody can by typing numbers — with the one rule that it must be
 * a single box across every selected frame, since where a sprite sits *in* its
 * cell is how a sheet draws a jump. Trimming each frame to its own content would
 * land them all on the floor and throw the animation away.
 *
 * Nothing here holds the config. It sends `set-mascot` and draws what comes back
 * in the snapshot — the same rule as the layout, and the reason a second window
 * sees the change without being told.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { MascotConfig, MascotMotion } from "../../../shared/model";
import { adoptMascot, DEFAULT_MASCOT } from "../../../shared/model";
import { sheetUrl, useSheet } from "../mascot";
import * as api from "../session";
import { Mascot } from "./Status";

/** What the sheet is drawn at in the picker. Integer, so the pixels stay square. */
const ZOOM = 2;

interface Catalogue {
  sheets: string[];
  custom: boolean;
  customPath: string;
}

export function Settings({ mascot, onClose }: { mascot: MascotConfig; onClose: () => void }) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);

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
      .catch(() => live && setCatalogue({ sheets: [], custom: false, customPath: "" }));
    return () => {
      live = false;
    };
  }, []);

  /** Every change is sent, so there is no save button and nothing to discard. */
  const change = (patch: Partial<MascotConfig>) => api.setMascot(adoptMascot({ ...mascot, ...patch }));

  return (
    <div className="scrim" onPointerDown={onClose}>
      <div
        className="dialog dialog-wide"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal
        aria-label="Settings"
      >
        <h2 className="dialog-title">Settings</h2>

        <section className="set-section">
          <h3 className="set-head">
            Mascot
            <span className="set-note">what the badge does while an agent is working</span>
          </h3>

          <div className="set-row">
            <label className="set-label" htmlFor="mascot-sheet">
              Sheet
            </label>
            <select
              id="mascot-sheet"
              className="set-select"
              value={mascot.sheet}
              onChange={(event) => change({ sheet: event.target.value })}
            >
              {catalogue?.sheets.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
              {/* Offered only when there is one. An option that cannot be chosen
                  is a worse explanation than the line of prose below. */}
              {catalogue?.custom && <option value="custom">custom</option>}
            </select>
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

          {catalogue && !catalogue.custom && (
            <p className="set-hint">
              Drop a PNG at <code>{catalogue.customPath || "~/.config/kururu/mascot.png"}</code> to
              use your own. Any grid of frames will do — a plain strip is a sheet one row tall.
            </p>
          )}

          <div className="set-stage">
            <SheetPicker mascot={mascot} onChange={change} />
            {/* The badge itself, twice: once at the size it will actually be in
                a sidebar row, and once big enough to see what you picked. Both
                are the same component the rows use, so a preview that looked
                right and a badge that did not would be impossible. */}
            <div className="set-preview">
              <span className="status status-working preview-big" role="img" aria-label="Preview">
                <Mascot config={mascot} />
              </span>
              <span className="status status-working" role="img" aria-label="Preview, actual size">
                <Mascot config={mascot} />
              </span>
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
              value={mascot.cycle}
              onChange={(event) => change({ cycle: Number(event.target.value) })}
            />
            <span className="set-note">{(mascot.cycle / 1000).toFixed(2)}s a loop</span>
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
          </div>
          {mascot.motion === "system" && (
            <p className="set-hint">
              Follows <code>prefers-reduced-motion</code>. With Reduce Motion switched on in macOS
              the mascot holds still — which says no more than the dot it replaced, so “Always” is
              the default.
            </p>
          )}
        </section>

        <div className="dialog-actions">
          <button className="button-quiet" onClick={() => api.setMascot(DEFAULT_MASCOT)}>
            Reset
          </button>
          <button className="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The sheet, its grid, and the cells currently taken.
 *
 * Pointer events rather than clicks, so one gesture does the whole selection:
 * down picks the row and the first cell, moving extends the run, up ends it.
 * Backwards drags are normalised, because a run from six to three is a run from
 * three to six and making somebody drag the other way would be a rule with
 * nothing behind it.
 */
function SheetPicker({
  mascot,
  onChange,
}: {
  mascot: MascotConfig;
  onChange: (patch: Partial<MascotConfig>) => void;
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
    if (trim.x !== x || trim.y !== y || trim.size !== size) onChange({ trim });
    // `onChange` closes over the current config by design; re-running on it would
    // re-send the trim that was just accepted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trim]);

  if (!sheet) {
    return <p className="set-hint">That sheet could not be loaded.</p>;
  }

  const cols = Math.max(1, Math.floor(sheet.width / mascot.frame));
  const rows = Math.max(1, Math.floor(sheet.height / mascot.frame));

  const cellAt = (event: React.PointerEvent): { row: number; col: number } | null => {
    const box = surface.current?.getBoundingClientRect();
    if (!box) return null;
    const col = Math.floor((event.clientX - box.left) / (mascot.frame * ZOOM));
    const row = Math.floor((event.clientY - box.top) / (mascot.frame * ZOOM));
    if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
    return { row, col };
  };

  const extend = (to: { row: number; col: number }) => {
    const from = anchor.current;
    if (!from) return;
    const col = Math.min(from.col, to.col);
    const count = Math.abs(to.col - from.col) + 1;
    onChange({ row: from.row, col, count });
  };

  return (
    <>
      <div className="sheet-wrap">
        <div
          ref={surface}
          className="sheet"
          style={{
            width: sheet.width * ZOOM,
            height: sheet.height * ZOOM,
            backgroundImage: `url(${src})`,
            backgroundSize: `${sheet.width * ZOOM}px ${sheet.height * ZOOM}px`,
            // The grid is drawn rather than composed of elements: a 16x16 sheet
            // is 256 divs that exist only to be looked through.
            "--cell": `${mascot.frame * ZOOM}px`,
          } as React.CSSProperties}
          onPointerDown={(event) => {
            const cell = cellAt(event);
            if (!cell) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            anchor.current = cell;
            onChange({ row: cell.row, col: cell.col, count: 1 });
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
          <span
            className="sheet-sel"
            style={{
              left: mascot.col * mascot.frame * ZOOM,
              top: mascot.row * mascot.frame * ZOOM,
              width: mascot.count * mascot.frame * ZOOM,
              height: mascot.frame * ZOOM,
            }}
          />
        </div>
      </div>
      <p className="set-hint">
        Drag along a row to take a run of cells. Row {mascot.row}, {mascot.count}{" "}
        {mascot.count === 1 ? "cell" : "cells"} from {mascot.col}.
      </p>
    </>
  );
}

/**
 * The box the selected frames actually occupy, measured off the pixels.
 *
 * One box for all of them, squared up and grown *upwards*, because a sprite
 * stands on the floor of its cell and the room it needs is above: growing a
 * 19x21 frog to a square by padding the top keeps its feet where the sheet put
 * them, and keeps the jump.
 *
 * A canvas rather than anything cleverer because the question is literally
 * "which pixels are not transparent", and the image is already decoded and
 * same-origin. Returns null while it cannot answer, which is also what it
 * returns for a fully transparent selection — nothing is a better trim than a
 * guess at one.
 */
function useTrim(src: string, mascot: MascotConfig): { x: number; y: number; size: number } | null {
  const { frame, row, col, count } = mascot;
  const [trim, setTrim] = useState<{ x: number; y: number; size: number } | null>(null);
  /** Only the selection matters, so a re-render with the same one measures nothing. */
  const key = useMemo(() => `${src}|${frame}|${row}|${col}|${count}`, [src, frame, row, col, count]);

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
  }, [key, src, frame, row, col, count]);

  return trim;
}
