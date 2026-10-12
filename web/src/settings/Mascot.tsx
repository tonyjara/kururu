/**
 * Settings → Appearance → Mascot: the ones you have kept, and the sheet the
 * current one is cut from.
 *
 * The picker exists because the alternative was a script: picking an
 * animation meant running a cutter over a sheet, dropping the result
 * somewhere, and reloading, to answer a question that is entirely visual and
 * has about forty answers per sheet. A grid you drag across, with the thing
 * itself hopping beside it, answers it in one gesture.
 *
 * A mascot has two animations, working and idle, sharing the sheet, the cell
 * size and the trim — the trim especially, which is what stops the frog from
 * changing size the moment it sits down. The trim is computed off the pixels
 * rather than asked for, as one box across every selected frame, since where a
 * sprite sits in its cell is how a sheet draws a jump.
 *
 * The sheet is drawn at integer zoom because pixel art at a fractional scale
 * is unreadable in exactly the way that matters: you are looking for the
 * frame where the legs leave the ground.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Mascot as SavedMascot, MascotClip, MascotConfig, MascotMotion, MascotSet } from "../../../shared/model";
import { adoptMascot, DEFAULT_MASCOT, defaultMascot, slugSheetName } from "../../../shared/model";
import { forgetSheet, sheetUrl, useSheet } from "../mascot";
import { Mascot } from "../components/Status";
import * as api from "../session";
import { Action, Banner, Btn, Choice, DangerButton, Group, IconBtn, Item, Mono, NumField, Row, Segments, Select, Slider, TextBox } from "./ui";

/** How wide the picker may get before it scrolls instead. */
const PICKER_WIDTH = 380;

type ClipName = "working" | "idle";

/** A new idle clip starts as the working one, slowed down: see `addIdle`. */
const IDLE_CYCLE = 1800;

function zoomFor(width: number): number {
  return Math.max(1, Math.floor(PICKER_WIDTH / Math.max(1, width)));
}

/** Two lists rather than one, because only one of them has a remove button. */
interface Catalogue {
  builtin: string[];
  imported: string[];
  dir: string;
}

const EMPTY: Catalogue = { builtin: [], imported: [], dir: "" };

export function MascotPage({ mascots }: { mascots: MascotSet }) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [working, setWorking] = useState<null | "import" | "remove">(null);
  const file = useRef<HTMLInputElement>(null);

  /** View state: a second window should not have its picker yanked onto something else because this one clicked a row. */
  const [editing, setEditing] = useState<string | null>(null);
  const [clipName, setClipName] = useState<ClipName>("working");
  const mascot = mascots.list.find((m) => m.id === editing) ?? defaultMascot(mascots);
  const clip = clipName === "working" ? mascot.working : mascot.idle;

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

  const change = (patch: Partial<MascotConfig>) => api.setMascot(mascot.id, adoptMascot({ ...mascot, ...patch }));
  const changeClip = (patch: Partial<MascotClip>) => {
    if (!clip) return;
    const next = { ...clip, ...patch };
    change(clipName === "working" ? { working: next } : { idle: next });
  };

  /** Seeded from the working one: recognisably wrong, in the right row, and one drag from right. */
  const addIdle = () => {
    change({ idle: { ...mascot.working, cycle: IDLE_CYCLE } });
    setClipName("idle");
  };

  const mine = catalogue?.imported.includes(mascot.sheet) ?? false;

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
      // You picked the file because you want to use it.
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
    setWorking("remove");
    try {
      const response = await fetch(`/api/mascot/sheets?name=${encodeURIComponent(name)}`, { method: "DELETE" });
      const answer = (await response.json()) as Catalogue & { error?: string };
      if (!response.ok) {
        setNote(answer.error ?? "could not remove that sheet");
        return;
      }
      forgetSheet(name);
      setCatalogue({ builtin: answer.builtin, imported: answer.imported, dir: answer.dir });
      change({ sheet: DEFAULT_MASCOT.sheet });
    } catch {
      setNote("could not remove that sheet");
    } finally {
      setWorking(null);
    }
  };

  return (
    <>
      {note && <Banner tone="bad">{note}</Banner>}

      <MascotList mascots={mascots} editing={mascot.id} onEdit={setEditing} />

      <Group title={`Sheet for ${mascot.name}`} foot={<>PNG only; the trim is measured off the alpha channel. Imports land in <Mono>{catalogue?.dir || "~/.config/kururu/sheets"}</Mono>.</>}>
        <Select label="Sheet" value={mascot.sheet} onChange={(sheet) => change({ sheet })}>
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
        </Select>
        <Row label="Import a sheet" hint="Any grid of frames; a plain strip is a sheet one row tall.">
          <input
            ref={file}
            type="file"
            accept="image/png,.png"
            hidden
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              event.target.value = "";
              if (chosen) void importSheet(chosen);
            }}
          />
          <Btn onClick={() => file.current?.click()} disabled={working !== null}>
            {working === "import" ? "Importing…" : "Import…"}
          </Btn>
          {mine && <DangerButton label="Remove" ask={`Remove ${mascot.sheet}?`} onConfirm={() => void removeSheet(mascot.sheet)} busy={working === "remove"} busyLabel="Removing…" />}
        </Row>
        <NumField label="Cell" value={mascot.frame} min={1} max={256} unit="px" onCommit={(frame) => change({ frame })} />
      </Group>

      <Group title="Animation">
        <Row label="Editing" hint={clipName === "working" ? "While the agent is going." : "While it is stopped."}>
          <Segments
            value={clipName}
            onChange={setClipName}
            label="Which animation"
            options={[
              ["working", "Working"],
              ["idle", mascot.idle ? "Idle" : "Idle · dot"],
            ]}
          />
        </Row>
        <div className="st-stage">
          {clip ? (
            <SheetPicker mascot={mascot} clip={clip} onChange={changeClip} onTrim={(trim) => change({ trim })} />
          ) : (
            <div className="st-sheet-col st-empty-stage">
              <span className="st-hint">Idle is a dot. Animate it and the badge breathes while the agent waits; blocked and done keep their dots either way.</span>
              <Btn onClick={addIdle}>Animate idle</Btn>
            </div>
          )}
          <div className="st-preview">
            <span className="status status-working st-preview-big" role="img" aria-label="Preview">
              <Mascot config={mascot} clip={clip ?? mascot.working} />
            </span>
            <span className="st-hint">{clip ? clipName : "idle is a dot"}</span>
            <div className="st-preview-pair">
              <span className="status status-working" role="img" aria-label="Working, actual size">
                <Mascot config={mascot} clip={mascot.working} />
              </span>
              <span className="status status-idle" role="img" aria-label="Idle, actual size">
                {mascot.idle ? <Mascot config={mascot} clip={mascot.idle} /> : <span className="status-dot" />}
              </span>
            </div>
            <span className="st-hint">actual size</span>
          </div>
        </div>
        <Slider label="Speed" min={160} max={2400} step={20} value={clip?.cycle ?? IDLE_CYCLE} disabled={!clip} format={(n) => `${(n / 1000).toFixed(2)}s`} onChange={(cycle) => changeClip({ cycle })} />
        {clipName === "idle" && mascot.idle && <Action label="Back to the dot" button="Use the dot" onClick={() => change({ idle: null })} />}
        <Choice
          label="Motion"
          hint={mascot.motion === "system" ? "Follows Reduce Motion, which holds the mascot still." : undefined}
          value={mascot.motion}
          onChange={(motion) => change({ motion: motion as MascotMotion })}
          options={[
            ["always", "Always"],
            ["system", "System"],
            ["never", "Never"],
          ]}
        />
        <Action label="Reset this mascot" hint="Back to the frog." button="Reset" onClick={() => api.setMascot(mascot.id, DEFAULT_MASCOT)} />
      </Group>
    </>
  );
}

/**
 * The mascots you have kept, which one you are editing, and which is the
 * default. Each row draws itself animating, because four numbers are not a
 * thing anybody recognises their own selection by and a frog mid-jump is. The
 * star is on every row rather than only the default: a control that appears
 * only once it has been used is one nobody finds. Adding copies the one you
 * are looking at, since you press it when what is in front of you is nearly
 * right.
 */
function MascotList({ mascots, editing, onEdit }: { mascots: MascotSet; editing: string; onEdit: (id: string) => void }) {
  return (
    <Group title="Mascots" foot="★ is the default: what a workspace gets when it has not picked one of its own, in its right-click menu.">
      {mascots.list.map((one: SavedMascot) => (
        <Item
          key={one.id}
          on={one.id === editing}
          onClick={() => onEdit(one.id)}
          lead={
            <span className="status status-working st-mascot-chip" role="img" aria-label={one.name}>
              <Mascot config={one} clip={one.working} />
            </span>
          }
          name={<TextBox className="st-input-bare" value={one.name} aria-label="Mascot name" onCommit={(name) => name.trim() && api.renameMascot(one.id, name)} />}
        >
          <IconBtn glyph={one.id === mascots.default ? "★" : "☆"} on={one.id === mascots.default} label={one.id === mascots.default ? "The default" : `Make ${one.name} the default`} onClick={() => api.setDefaultMascot(one.id)} />
          {/* Hidden rather than disabled at one, because the reason it cannot go
              is that a working row must always have something in it. */}
          {mascots.list.length > 1 && <IconBtn icon="close" danger label={`Forget ${one.name}`} onClick={() => api.removeMascot(one.id)} />}
        </Item>
      ))}
      <Row label="Another" hint="A copy of the one you are editing.">
        <Btn onClick={() => api.addMascot(editing)}>Add</Btn>
      </Row>
    </Group>
  );
}

/**
 * The sheet, its grid, and the cells the current animation is taken from.
 * Pointer events so one gesture does the whole selection: down picks the row
 * and the first cell, moving extends the run, up ends it. Backwards drags are
 * normalised.
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
  onTrim: (trim: MascotConfig["trim"]) => void;
}) {
  const src = sheetUrl(mascot.sheet);
  const sheet = useSheet(src);
  const surface = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ row: number; col: number } | null>(null);
  const trim = useTrim(src, mascot);

  /** The trim is a consequence of the selection, applied when it lands; sent only when it differs. */
  useEffect(() => {
    if (!trim) return;
    const { x, y, size } = mascot.trim;
    if (trim.x !== x || trim.y !== y || trim.size !== size) onTrim(trim);
    // `onTrim` closes over the current config by design; re-running on it would re-send the trim just accepted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trim]);

  if (!sheet) return <span className="st-hint">That sheet could not be loaded.</span>;

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

  /** Only when it actually changed: every one of these is a message, a snapshot to every client and a write to disk. */
  const select = (row: number, col: number, count: number) => {
    if (row === clip.row && col === clip.col && count === clip.count) return;
    onChange({ row, col, count });
  };
  const extend = (to: { row: number; col: number }) => {
    const from = anchor.current;
    if (!from) return;
    select(from.row, Math.min(from.col, to.col), Math.abs(to.col - from.col) + 1);
  };

  const other = clip === mascot.working ? mascot.idle : mascot.working;

  return (
    <div className="st-sheet-col">
      <div className="st-sheet-wrap">
        <div
          ref={surface}
          className="st-sheet"
          style={
            {
              width: sheet.width * zoom,
              height: sheet.height * zoom,
              backgroundImage: `url(${src})`,
              backgroundSize: `${sheet.width * zoom}px ${sheet.height * zoom}px`,
              "--cell": `${mascot.frame * zoom}px`,
            } as React.CSSProperties
          }
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
              className="st-sheet-sel st-sheet-sel-other"
              style={{ left: other.col * mascot.frame * zoom, top: other.row * mascot.frame * zoom, width: other.count * mascot.frame * zoom, height: mascot.frame * zoom }}
            />
          )}
          <span
            className="st-sheet-sel"
            style={{ left: clip.col * mascot.frame * zoom, top: clip.row * mascot.frame * zoom, width: clip.count * mascot.frame * zoom, height: mascot.frame * zoom }}
          />
        </div>
      </div>
      <span className="st-hint">
        Drag along a row to take a run of cells. Row {clip.row}, {clip.count} {clip.count === 1 ? "cell" : "cells"} from {clip.col}.
      </span>
    </div>
  );
}

/**
 * The box the mascot's frames actually occupy, measured off the pixels: one
 * box for every frame of every clip, squared up and grown upwards, so a
 * sprite keeps its feet where the sheet put them and a sitting frog is the
 * same size as a jumping one. Null while it cannot answer.
 */
function useTrim(src: string, mascot: MascotConfig): { x: number; y: number; size: number } | null {
  const { frame, working, idle } = mascot;
  const [trim, setTrim] = useState<{ x: number; y: number; size: number } | null>(null);
  const clips = useMemo(() => (idle ? [working, idle] : [working]), [working, idle]);
  const key = useMemo(() => `${src}|${frame}|${clips.map((c) => `${c.row},${c.col},${c.count}`).join(";")}`, [src, frame, clips]);

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
      let left = frame,
        top = frame,
        right = 0,
        bottom = 0;
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
