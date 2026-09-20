/**
 * Settings → Skin studio: making a skin, with the window as the preview.
 *
 * Winamp's skins were a directory of bitmaps — a titlebar, a set of buttons, a
 * frame — and the reason a thousand people drew one is that the format asked
 * for pictures rather than for CSS. This page is that: a list of the parts of
 * the chrome, a place to drop a picture on each, and a handful of numbers
 * beside it. There is no preview pane, because there is a whole window behind
 * the dialog wearing the skin you are editing, and the phone on the same server
 * is wearing it too. Every change here is a write to the server and a snapshot
 * back, exactly the road a theme picked on the Appearance tab takes — the studio
 * holds the manifest it is editing and nothing else about how the window looks.
 *
 * ## What it edits is a manifest, and the manifest is the registry's
 *
 * The skin under edit is an ordinary installed skin in
 * `~/.config/kururu/styles/skins/<id>/`, with a `skin.json` in exactly the
 * format `../kururu-styles` takes and its pictures beside it. The page edits
 * that file: `tokens`, `parts`, `colors`, `icons`, `fonts`, and the fields a
 * pull request needs. Nothing is compiled and nothing is proprietary to the
 * studio, so publishing is copying the directory. The one liberty taken is that
 * a picture dropped on a part is *named after the part* — `pane.png`,
 * `statusbar.png` — which is not a rule of the format, only a way of never
 * asking the person for a file name.
 *
 * ## Why the write is debounced and not the render
 *
 * A slider produces sixty values a second and each one is a file written and a
 * snapshot to every client, so the manifest is applied to local state at once
 * and sent 150ms after the last change. That is the one place this page holds
 * state the server does not yet have, and it is bounded: the timer fires, or
 * the page unmounts and flushes. It is not the `typing` pattern the font box
 * uses, because nothing here is a controlled input fed from a round trip — the
 * manifest is loaded once when a skin is opened and is this page's afterwards.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  allSkins,
  ICON_NAMES,
  PAINT_MODES,
  PAINT_REPEATS,
  PART_NAMES,
  PARTS,
  partVarNames,
  partVars,
  skinFor,
  type IconName,
  type PaintMode,
  type PaintRepeat,
  type PartName,
  type PartPaint,
  type SkinTokens,
} from "../../../shared/skin";
import type { StyleLibrary } from "../../../shared/styles";
import { themeFor, type Appearance, type UiTokens } from "../../../shared/theme";
import { iconUrl } from "../icons";
import { Icon } from "./Icon";

/** The manifest as the studio holds it: the registry's shape, loosely typed because it is a file being edited. */
type Manifest = Record<string, unknown> & {
  tokens?: Partial<Record<keyof SkinTokens, string>>;
  parts?: Partial<Record<PartName, ManifestPaint>>;
  colors?: Partial<UiTokens>;
  icons?: Partial<Record<IconName, string | null>>;
  iconSheet?: { image: string; mode: "mask" | "image" };
  fonts?: { family: string; file: string; weight: string; style: string }[];
};

/** A part in the manifest names a file; the same shape otherwise. */
interface ManifestPaint {
  image: string;
  mode?: PaintMode;
  slice?: number | [number, number, number, number];
  scale?: number;
  repeat?: PaintRepeat;
}

interface Loaded {
  id: string;
  manifest: Manifest;
  files: string[];
  dir: string;
}

/**
 * The chrome tokens the colour section offers, in the order somebody thinks of
 * them: the grounds, the text, the accent, then the states. All of `UiTokens`
 * rather than a curated few, because a skin that painted its status bar red
 * needs `dim` to read against red, and a list that left `dim` out would be a
 * list that could not finish the job.
 */
const COLOR_ROWS: ReadonlyArray<readonly [keyof UiTokens, string]> = [
  ["bg", "Pane ground"],
  ["chrome", "Chrome"],
  ["chromeHigh", "Chrome, raised"],
  ["line", "Lines"],
  ["lineHigh", "Lines, picked out"],
  ["text", "Text"],
  ["textStrong", "Text, strong"],
  ["dim", "Text, dim"],
  ["dimmer", "Text, dimmer"],
  ["accent", "Accent"],
  ["onAccent", "Text on accent"],
  ["idle", "Idle"],
  ["working", "Working"],
  ["blocked", "Needs you"],
  ["done", "Done"],
  ["exited", "Exited"],
  ["danger", "Danger"],
  ["dangerBg", "Danger button"],
  ["onDanger", "Text on danger"],
];

/** The overlay presets, in words rather than gradients. Written in theme tokens where they can be. */
const OVERLAYS: ReadonlyArray<readonly [string, string, string]> = [
  ["none", "None", "none"],
  ["scanlines", "Scanlines", "repeating-linear-gradient(to bottom, rgba(0, 0, 0, 0.18) 0 1px, transparent 1px 3px)"],
  ["grid", "Grid", "repeating-linear-gradient(to right, var(--line) 0 1px, transparent 1px 24px), repeating-linear-gradient(to bottom, var(--line) 0 1px, transparent 1px 24px)"],
  ["vignette", "Vignette", "radial-gradient(ellipse at center, transparent 55%, rgba(0, 0, 0, 0.55) 100%)"],
  ["glow", "Top glow", "radial-gradient(120% 90% at 50% 0%, rgba(255, 255, 255, 0.05), transparent 60%)"],
];

/** The base ramp, so a type step can be applied to every size at once. */
const RAMP: ReadonlyArray<readonly [keyof SkinTokens, number]> = [
  ["fsXs", 9],
  ["fsSm", 10],
  ["fsBase", 11],
  ["fsMd", 12],
  ["fsLg", 13],
  ["fsXl", 15],
];

export function StudioSettings({
  styles,
  appearance,
  onEditing,
}: {
  styles: StyleLibrary;
  appearance: Appearance;
  onEditing: (on: boolean) => void;
}) {
  const mine = useMemo(() => styles.installed.filter((r) => r.kind === "skin" && r.local), [styles.installed]);
  const [id, setId] = useState<string | null>(() =>
    mine.some((r) => r.id === appearance.skinId) ? appearance.skinId : (mine[0]?.id ?? null),
  );
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [stamp, setStamp] = useState(Date.now());
  const [making, setMaking] = useState<null | { name: string; from: string }>(null);
  const [deleting, setDeleting] = useState(false);
  /**
   * The one thing the page is in the middle of, if any, and the files on their
   * way up. Buttons say what they are doing and refuse a second press while they
   * do it: a Create pressed twice before the server answered would be two skins
   * with one name, and a drop that gave no sign of having landed gets dropped
   * again.
   */
  const [working, setWorking] = useState<null | "create" | "delete">(null);
  const [uploading, setUploading] = useState<Record<string, true>>({});

  /**
   * If the skin open here disappears — removed from another window, say — fall
   * back to another of yours rather than sitting on a page for a file that is
   * gone. And if there were none and now there is one, open it.
   */
  useEffect(() => {
    if (id && !mine.some((r) => r.id === id)) setId(mine[0]?.id ?? null);
    if (!id && mine[0]) setId(mine[0].id);
  }, [mine, id]);

  useEffect(() => {
    if (!id) {
      setLoaded(null);
      return;
    }
    let live = true;
    void fetch(`/api/studio/skin?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((data: { manifest?: Manifest; files?: string[]; dir?: string; error?: string }) => {
        if (!live) return;
        if (!data.manifest) {
          setNote(data.error ?? "could not open that skin");
          return;
        }
        setLoaded({ id, manifest: data.manifest, files: data.files ?? [], dir: data.dir ?? "" });
      })
      .catch(() => live && setNote("could not reach this server"));
    return () => {
      live = false;
    };
  }, [id]);

  // --- saving -------------------------------------------------------------
  const pending = useRef<{ id: string; manifest: Manifest } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    void fetch(`/api/studio/skin?id=${encodeURIComponent(p.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p.manifest),
    })
      .then((r) => r.json())
      .then((data: { error?: string }) => data.error && setNote(data.error))
      .catch(() => setNote("could not save — is the server up?"));
  }, []);

  useEffect(() => flush, [flush]);

  const save = useCallback(
    (next: Manifest) => {
      if (!loaded) return;
      setLoaded({ ...loaded, manifest: next });
      pending.current = { id: loaded.id, manifest: next };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, 150);
    },
    [loaded, flush],
  );

  const patch = (fn: (m: Manifest) => Manifest) => loaded && save(fn(loaded.manifest));

  // --- files --------------------------------------------------------------
  /**
   * One file, into the skin's directory, under a name the studio chose. The
   * answer carries the picture's size, which is what lets a dropped bezel start
   * with a plausible slice rather than zero — see `guessPaint`.
   */
  const upload = async (file: string, blob: Blob): Promise<{ width?: number; height?: number } | null> => {
    if (!loaded) return null;
    setNote(null);
    setUploading((u) => ({ ...u, [file]: true }));
    try {
      const response = await fetch(
        `/api/studio/asset?id=${encodeURIComponent(loaded.id)}&file=${encodeURIComponent(file)}`,
        { method: "POST", headers: { "content-type": "application/octet-stream" }, body: await blob.arrayBuffer() },
      );
      const data = (await response.json()) as { error?: string; files?: string[]; width?: number; height?: number; stamp?: number };
      if (!response.ok) {
        setNote(data.error ?? "that file could not be added");
        return null;
      }
      setLoaded((l) => (l ? { ...l, files: data.files ?? l.files } : l));
      setStamp(data.stamp ?? Date.now());
      return { width: data.width, height: data.height };
    } catch {
      setNote("that file could not be added — is the server up?");
      return null;
    } finally {
      setUploading(({ [file]: _done, ...rest }) => rest);
    }
  };

  const assetUrl = (file: string) =>
    loaded ? `/api/styles/asset?kind=skin&id=${encodeURIComponent(loaded.id)}&file=${encodeURIComponent(file)}&v=${stamp}` : "";

  // --- making and unmaking --------------------------------------------------
  const taken = new Set([...allSkins(styles.skins).map((s) => s.id), ...styles.installed.filter((r) => r.kind === "skin").map((r) => r.id)]);

  const create = async () => {
    if (!making || working) return;
    const base = slug(making.name) || "my-skin";
    let next = base;
    for (let n = 2; taken.has(next); n++) next = `${base.slice(0, 58)}-${n}`;
    setNote(null);
    setWorking("create");
    try {
      const from = making.from ? `&from=${encodeURIComponent(making.from)}` : "";
      const response = await fetch(
        `/api/studio/skin?id=${encodeURIComponent(next)}&name=${encodeURIComponent(making.name || next)}${from}`,
        { method: "POST" },
      );
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setNote(data.error ?? "could not make that skin");
        return;
      }
      setMaking(null);
      setId(next);
    } catch {
      setNote("could not make that skin — is the server up?");
    } finally {
      setWorking(null);
    }
  };

  const remove = async () => {
    if (!loaded || working) return;
    setDeleting(false);
    setNote(null);
    setWorking("delete");
    try {
      const response = await fetch(`/api/styles/remove?kind=skin&id=${encodeURIComponent(loaded.id)}`, { method: "POST" });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setNote(data.error ?? "could not remove that skin");
        return;
      }
      setLoaded(null);
      setId(null);
    } catch {
      setNote("could not remove that skin — is the server up?");
    } finally {
      setWorking(null);
    }
  };

  const wearing = allSkins(styles.skins);
  const worn = skinFor(appearance.skinId, styles.skins);

  return (
    <div className="set-page studio">
      <section className="set-section">
        <div className="set-row set-row-split">
          <p className="set-note set-note-flush">
            Pictures for each part of the window, and the numbers that go with them. Changes land
            on the window behind this dialog as you make them.
          </p>
        </div>

        <div className="set-row studio-bar">
          <span className="set-label">Skin</span>
          <select
            className="set-select"
            value={id ?? ""}
            onChange={(event) => setId(event.target.value || null)}
            disabled={mine.length === 0}
          >
            {mine.length === 0 && <option value="">none yet</option>}
            {mine.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button className="button button-quiet studio-inline" onClick={() => setMaking({ name: "", from: "" })}>
            New…
          </button>
          <button className="button button-quiet studio-inline" onClick={() => setMaking({ name: `${worn.name} remix`, from: worn.id })}>
            Fork {worn.name}…
          </button>
          {loaded && appearance.skinId !== loaded.id && (
            <button className="button button-quiet studio-inline" onClick={() => flushAndWear(loaded, save)}>
              Wear it
            </button>
          )}
          {loaded && (
            <button
              className={`set-choice studio-inline ${deleting ? "set-choice-warn" : ""}`}
              onClick={() => (deleting ? void remove() : setDeleting(true))}
              onBlur={() => setDeleting(false)}
              disabled={working !== null}
            >
              {working === "delete" ? "Deleting…" : deleting ? "Really delete?" : "Delete"}
            </button>
          )}
        </div>

        {making && (
          <div className="set-row studio-make">
            <input
              className="set-text"
              placeholder="A name for it"
              value={making.name}
              autoFocus
              onFocus={() => onEditing(true)}
              onBlur={() => onEditing(false)}
              onChange={(event) => setMaking({ ...making, name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") void create();
                if (event.key === "Escape") setMaking(null);
              }}
            />
            <select className="set-select" value={making.from} onChange={(event) => setMaking({ ...making, from: event.target.value })}>
              <option value="">Start from nothing</option>
              {wearing.map((s) => (
                <option key={s.id} value={s.id}>
                  Start from {s.name}
                </option>
              ))}
            </select>
            <button className="button studio-inline" onClick={() => void create()} disabled={working !== null}>
              {working === "create" ? "Creating…" : "Create"}
            </button>
            <button className="button button-quiet studio-inline" onClick={() => setMaking(null)}>
              Cancel
            </button>
          </div>
        )}

        {note && <p className="set-warn">{note}</p>}
        {Object.keys(uploading).length > 0 && (
          <p className="set-note" aria-live="polite">
            Adding {Object.keys(uploading).join(", ")}…
          </p>
        )}
      </section>

      {!loaded && !making && (
        <section className="set-section">
          <p className="set-note">
            {mine.length === 0
              ? "You have no skins of your own yet. Make one from nothing, or fork the one you are wearing and change what you like."
              : "Opening…"}
          </p>
        </section>
      )}

      {loaded && (
        <>
          <About loaded={loaded} patch={patch} onEditing={onEditing} />
          <Parts loaded={loaded} patch={patch} upload={upload} assetUrl={assetUrl} />
          <Colours loaded={loaded} patch={patch} appearance={appearance} styles={styles} />
          <Shape loaded={loaded} patch={patch} upload={upload} onEditing={onEditing} />
          <Icons loaded={loaded} patch={patch} upload={upload} assetUrl={assetUrl} onEditing={onEditing} />
          <Effects loaded={loaded} patch={patch} upload={upload} onEditing={onEditing} />
          <Publish loaded={loaded} />
        </>
      )}
    </div>
  );
}

/** Wearing is a save: the server puts on whatever it was just handed. */
function flushAndWear(loaded: Loaded, save: (m: Manifest) => void): void {
  save({ ...loaded.manifest });
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

function About({ loaded, patch, onEditing }: { loaded: Loaded; patch: (fn: (m: Manifest) => Manifest) => void; onEditing: (on: boolean) => void }) {
  const m = loaded.manifest;
  const field = (key: string, label: string, placeholder: string, wide = false) => (
    <label className="set-row">
      <span className="set-label">{label}</span>
      <input
        className={`set-text ${wide ? "studio-wide" : ""}`}
        value={typeof m[key] === "string" ? (m[key] as string) : ""}
        placeholder={placeholder}
        spellCheck={false}
        onFocus={() => onEditing(true)}
        onBlur={() => onEditing(false)}
        onChange={(event) => patch((x) => ({ ...x, [key]: event.target.value }))}
      />
    </label>
  );
  return (
    <section className="set-section">
      <h3 className="set-h">About it</h3>
      {field("name", "Name", "What it is called")}
      {field("description", "Line", "One line: what kind of window this is", true)}
      <div className="set-row">
        {field("author", "By", "you")}
        {field("licence", "Licence", "CC0-1.0")}
        {field("version", "Version", "1.0.0")}
      </div>
      <p className="set-note set-note-under">
        The registry wants all four. A picture you did not draw needs the licence it came with.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/**
 * A first guess at how a dropped picture is meant to be used, from its size
 * and which part it landed on. A guess and not a rule: every number is a
 * control the person can move a moment later, and the point is that the bezel
 * appears on the window the instant the file lands rather than after four
 * fields have been filled in.
 *
 * The slice is a third of the shorter side, which is what a bezel drawn with
 * an obvious frame and an obvious middle nearly always is. The scale is chosen
 * so small pixel art comes out big — a 24px bezel is drawn at 3x, a 200px one
 * at 1x — because nobody draws a 24px bezel expecting it to be 24px on a
 * retina display.
 */
function guessPaint(part: PartName, file: string, size: { width?: number; height?: number }): ManifestPaint {
  const w = size.width ?? 0;
  const h = size.height ?? 0;
  const ground = part === "sidebar" || part === "well";
  const scale = Math.min(w, h) <= 32 ? 4 : Math.min(w, h) <= 64 ? 3 : Math.min(w, h) <= 128 ? 2 : 1;
  if (ground) return { image: file, mode: "tile", scale, slice: 0, repeat: "stretch" };
  const slice = w && h ? Math.max(1, Math.floor(Math.min(w, h) / 3)) : 4;
  return { image: file, mode: "nine", slice, scale, repeat: "stretch" };
}

function Parts({
  loaded,
  patch,
  upload,
  assetUrl,
}: {
  loaded: Loaded;
  patch: (fn: (m: Manifest) => Manifest) => void;
  upload: (file: string, blob: Blob) => Promise<{ width?: number; height?: number } | null>;
  assetUrl: (file: string) => string;
}) {
  const parts = loaded.manifest.parts ?? {};
  const set = (name: PartName, paint: ManifestPaint | null) =>
    patch((m) => {
      const next = { ...(m.parts ?? {}) } as Partial<Record<PartName, ManifestPaint>>;
      if (paint) next[name] = paint;
      else delete next[name];
      return { ...m, parts: next };
    });

  const drop = async (name: PartName, blob: File) => {
    if (!/\.png$/i.test(blob.name) && blob.type !== "image/png") return;
    const file = `${name}.png`;
    const size = await upload(file, blob);
    if (size) set(name, guessPaint(name, file, size));
  };

  return (
    <section className="set-section">
      <h3 className="set-h">Parts</h3>
      <p className="set-note">
        Drop a PNG on a part to paint it. <b>Nine-slice</b> uses the picture's edges as a frame
        and its middle as the ground, the slice being how thick that frame is in the picture's own
        pixels; <b>tile</b> repeats it as a texture; <b>stretch</b> fits it to the box. Keep scale
        whole, or pixel art goes soft.
      </p>
      <div className="studio-parts">
        {PART_NAMES.map((name) => (
          <PartCard
            key={name}
            name={name}
            paint={parts[name]}
            parentPainted={!!(PARTS[name].stateOf && parts[PARTS[name].stateOf!])}
            files={loaded.files}
            assetUrl={assetUrl}
            onDrop={(blob) => drop(name, blob)}
            onChange={(paint) => set(name, paint)}
          />
        ))}
      </div>
    </section>
  );
}

function PartCard({
  name,
  paint,
  parentPainted,
  files,
  assetUrl,
  onDrop,
  onChange,
}: {
  name: PartName;
  paint: ManifestPaint | undefined;
  parentPainted: boolean;
  files: string[];
  assetUrl: (file: string) => string;
  onDrop: (blob: File) => Promise<void>;
  onChange: (paint: ManifestPaint | null) => void;
}) {
  const info = PARTS[name];
  const [over, setOver] = useState(false);
  /** A picture on its way up. The card says so where the picture will be, so a drop is never silent. */
  const [adding, setAdding] = useState(false);
  const [uneven, setUneven] = useState(Array.isArray(paint?.slice));
  const take = (file: File) => {
    if (adding) return;
    setAdding(true);
    void onDrop(file).finally(() => setAdding(false));
  };
  const input = useRef<HTMLInputElement | null>(null);

  /**
   * The thumbnail is the part compiled exactly as the window compiles it — the
   * same `partVars`, on a paint whose file name has become the URL the window
   * would use — so what the card shows is what the window is doing, at a
   * different size. A thumbnail drawn some other way would be a second
   * renderer for the same picture, and it would be the one that lied.
   */
  const shot = useMemo(() => {
    if (!paint || !files.includes(paint.image)) return null;
    const full: PartPaint = {
      image: assetUrl(paint.image),
      mode: paint.mode ?? "nine",
      slice: sliceOf(paint.slice),
      scale: Math.max(1, Math.min(8, Math.round(paint.scale ?? 1))),
      repeat: paint.repeat ?? "stretch",
    };
    const vars = partVars({ [name]: full });
    const v = partVarNames(name);
    return {
      borderImage: vars[v.frame],
      borderWidth: vars[v.w],
      borderStyle: "solid",
      borderColor: "transparent",
      background: `${vars[v.bg]}, var(--chrome)`,
      imageRendering: "pixelated" as const,
    };
  }, [paint, files, assetUrl, name]);

  const slice = sliceOf(paint?.slice);

  return (
    <div
      className={`studio-part ${over ? "studio-part-over" : ""} ${paint ? "studio-part-on" : ""}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        const file = event.dataTransfer.files[0];
        if (file) take(file);
      }}
    >
      <button className="studio-shot" style={shot ?? undefined} onClick={() => input.current?.click()} title={`Choose a picture for ${info.label.toLowerCase()}`}>
        {adding ? (
          <span className="studio-shot-empty" aria-live="polite">adding…</span>
        ) : (
          !shot && <span className="studio-shot-empty">{parentPainted ? `same as ${PARTS[info.stateOf!].label.toLowerCase()}` : "drop a PNG"}</span>
        )}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/png"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) take(file);
          event.target.value = "";
        }}
      />
      <div className="studio-part-text">
        <span className="studio-part-name">{info.label}</span>
        <span className="studio-part-covers">{info.covers}</span>
        {paint ? (
          <div className="studio-part-controls">
            <select className="set-select studio-mini" value={paint.mode ?? "nine"} onChange={(e) => onChange({ ...paint, mode: e.target.value as PaintMode })}>
              {PAINT_MODES.map((m) => (
                <option key={m} value={m}>
                  {m === "nine" ? "nine-slice" : m}
                </option>
              ))}
            </select>
            <label className="studio-num">
              <span>scale</span>
              <select className="set-select studio-mini" value={paint.scale ?? 1} onChange={(e) => onChange({ ...paint, scale: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}×
                  </option>
                ))}
              </select>
            </label>
            {(paint.mode ?? "nine") === "nine" && (
              <>
                {uneven ? (
                  <label className="studio-num">
                    <span>slice</span>
                    {slice.map((n, i) => (
                      <input
                        key={i}
                        className="set-num studio-mini"
                        type="number"
                        min={0}
                        max={512}
                        value={n}
                        title={["top", "right", "bottom", "left"][i]}
                        onChange={(e) => {
                          const next = [...slice] as [number, number, number, number];
                          next[i] = Number(e.target.value) || 0;
                          onChange({ ...paint, slice: next });
                        }}
                      />
                    ))}
                  </label>
                ) : (
                  <label className="studio-num">
                    <span>slice</span>
                    <input
                      className="set-num studio-mini"
                      type="number"
                      min={0}
                      max={512}
                      value={slice[0]}
                      onChange={(e) => onChange({ ...paint, slice: Number(e.target.value) || 0 })}
                    />
                  </label>
                )}
                <button
                  className="studio-link"
                  onClick={() => {
                    if (uneven) onChange({ ...paint, slice: slice[0] });
                    setUneven(!uneven);
                  }}
                >
                  {uneven ? "even" : "per side"}
                </button>
                <select className="set-select studio-mini" value={paint.repeat ?? "stretch"} onChange={(e) => onChange({ ...paint, repeat: e.target.value as PaintRepeat })}>
                  {PAINT_REPEATS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </>
            )}
            <button className="studio-link studio-remove" onClick={() => onChange(null)} title="Stop painting this part">
              <Icon name="close" />
            </button>
          </div>
        ) : (
          <span className="studio-part-hint">{info.hint}</span>
        )}
      </div>
    </div>
  );
}

function sliceOf(value: number | [number, number, number, number] | undefined): [number, number, number, number] {
  if (typeof value === "number") return [value, value, value, value];
  if (Array.isArray(value) && value.length === 4) return value;
  return [0, 0, 0, 0];
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/**
 * The chrome's colours, as overrides. A row that is not overridden shows the
 * colour the *current theme* gives it and a button to take it over; taking it
 * over starts from that colour, because "the theme's, but a bit darker" is how
 * these are actually chosen. Cleared, it follows the theme again. The terminal
 * is not here: a skin does not get to change what an agent's output looks like,
 * and a pack is how a skin ships with the palette it was drawn against.
 */
function Colours({ loaded, patch, appearance, styles }: { loaded: Loaded; patch: (fn: (m: Manifest) => Manifest) => void; appearance: Appearance; styles: StyleLibrary }) {
  const theme = themeFor(appearance.themeId, styles.themes);
  const colors = loaded.manifest.colors ?? {};
  const set = (token: keyof UiTokens, value: string | null) =>
    patch((m) => {
      const next = { ...(m.colors ?? {}) } as Partial<UiTokens>;
      if (value) next[token] = value;
      else delete next[token];
      return { ...m, colors: Object.keys(next).length ? next : undefined };
    });
  return (
    <section className="set-section">
      <h3 className="set-h">Colours</h3>
      <p className="set-note">
        A skin follows the theme unless it says otherwise — which pictures usually have to, so
        their text reads against their own bezel. The terminals stay the theme's.
      </p>
      <div className="studio-colors">
        {COLOR_ROWS.map(([token, label]) => {
          const mine = colors[token];
          const shown = mine ?? theme.ui[token];
          return (
            <div key={token} className={`studio-color ${mine ? "studio-color-on" : ""}`}>
              <label className="studio-swatch" style={{ background: shown }} title={mine ? "Your colour — click to change" : "The theme's colour — click to override it"}>
                <input type="color" value={toHex(shown)} onChange={(e) => set(token, e.target.value)} />
              </label>
              <span className="studio-color-name">{label}</span>
              {mine ? (
                <button className="studio-link" onClick={() => set(token, null)}>
                  theme's
                </button>
              ) : (
                <span className="studio-color-from">theme</span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** `<input type="color">` takes six-digit hex and nothing else. Near enough for anything a theme says. */
function toHex(value: string): string {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  if (/^#[0-9a-f]{8}$/i.test(v)) return v.slice(0, 7);
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
  if (m) return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  return "#000000";
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

function Shape({
  loaded,
  patch,
  upload,
  onEditing,
}: {
  loaded: Loaded;
  patch: (fn: (m: Manifest) => Manifest) => void;
  upload: (file: string, blob: Blob) => Promise<{ width?: number; height?: number } | null>;
  onEditing: (on: boolean) => void;
}) {
  const base = skinFor(null).tokens;
  const tokens = loaded.manifest.tokens ?? {};
  const setTokens = (next: Partial<Record<keyof SkinTokens, string | undefined>>) =>
    patch((m) => {
      const merged = { ...(m.tokens ?? {}), ...next } as Record<string, string | undefined>;
      for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
      return { ...m, tokens: merged as Manifest["tokens"] };
    });

  const px = (value: string | undefined, fallback: number) => {
    const n = Number.parseFloat(value ?? "");
    return Number.isFinite(n) ? n : fallback;
  };
  const corner = px(tokens.radiusXl, px(base.radiusXl, 5));
  const line = px(tokens.border, px(base.border, 1));
  const gutter = px(tokens.gutter, px(base.gutter, 3));
  const step = px(tokens.fsBase, 11) - 11;
  const font = loaded.manifest.fonts?.[0];
  const fontInput = useRef<HTMLInputElement | null>(null);

  const setFont = async (blob: File) => {
    const file = blob.name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);
    if (!/\.(woff2|woff|ttf|otf)$/i.test(file)) return;
    const put = await upload(file, blob);
    if (!put) return;
    const family = font?.family || file.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
    patch((m) => ({
      ...m,
      fonts: [{ family, file, weight: "400 700", style: "normal" }],
      tokens: { ...(m.tokens ?? {}), ui: `"${family}", ${base.ui}` },
    }));
  };

  return (
    <section className="set-section">
      <h3 className="set-h">Shape</h3>
      <label className="set-row">
        <span className="set-label">Corners</span>
        <input
          type="range"
          className="set-range"
          min={0}
          max={16}
          value={corner}
          onChange={(e) => {
            const r = Number(e.target.value);
            setTokens({
              radiusXs: `${Math.round(r * 0.4)}px`,
              radiusSm: `${Math.round(r * 0.4)}px`,
              radiusMd: `${Math.round(r * 0.6)}px`,
              radiusLg: `${Math.round(r * 0.8)}px`,
              radiusXl: `${r}px`,
            });
          }}
        />
        <span className="set-value">{corner}px</span>
      </label>
      <label className="set-row">
        <span className="set-label">Lines</span>
        <input
          type="range"
          className="set-range"
          min={1}
          max={4}
          value={line}
          onChange={(e) => {
            const n = Number(e.target.value);
            setTokens({ border: `${n}px`, borderThick: `${n + 1}px` });
          }}
        />
        <span className="set-value">{line}px</span>
      </label>
      <label className="set-row">
        <span className="set-label">Gutter</span>
        <input type="range" className="set-range" min={0} max={24} value={gutter} onChange={(e) => setTokens({ gutter: `${e.target.value}px` })} />
        <span className="set-value">{gutter}px</span>
      </label>
      <label className="set-row">
        <span className="set-label">Type</span>
        <input
          type="range"
          className="set-range"
          min={-2}
          max={8}
          value={step}
          onChange={(e) => {
            const s = Number(e.target.value);
            const next: Partial<Record<keyof SkinTokens, string>> = {};
            for (const [token, size] of RAMP) next[token] = `${size + s}px`;
            setTokens(next);
          }}
        />
        <span className="set-value">{step >= 0 ? `+${step}` : step}</span>
      </label>
      <p className="set-note set-note-under">
        The whole ramp moves together — a pixel face at 8px wants every size in the window down a
        step, not one of them.
      </p>

      <div className="set-row">
        <span className="set-label">Face</span>
        <input
          className="set-text"
          placeholder="Family name, as the file calls it"
          value={font?.family ?? ""}
          spellCheck={false}
          onFocus={() => onEditing(true)}
          onBlur={() => onEditing(false)}
          onChange={(e) => {
            const family = e.target.value;
            patch((m) => ({
              ...m,
              fonts: font ? [{ ...font, family }] : m.fonts,
              tokens: { ...(m.tokens ?? {}), ui: family ? `"${family}", ${base.ui}` : undefined },
            }))
          }}
        />
        <button className="button button-quiet studio-inline" onClick={() => fontInput.current?.click()}>
          {font ? `Replace ${font.file}` : "Add a font file…"}
        </button>
        <input
          ref={fontInput}
          type="file"
          accept=".woff2,.woff,.ttf,.otf"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void setFont(f);
            e.target.value = "";
          }}
        />
        {font && (
          <button className="studio-link" onClick={() => patch((m) => ({ ...m, fonts: undefined, tokens: { ...(m.tokens ?? {}), ui: undefined } }))}>
            system face
          </button>
        )}
      </div>
      <p className="set-note set-note-under">
        Served from this machine, never from the internet. Add its licence file under Publish.
      </p>

      <div className="set-row">
        <label className="set-check">
          <input type="checkbox" checked={(tokens.uiSmoothing ?? base.uiSmoothing) === "none"} onChange={(e) => setTokens({ uiSmoothing: e.target.checked ? "none" : undefined })} />
          Pixel text (no smoothing)
        </label>
        <label className="set-check">
          <input type="checkbox" checked={(tokens.imageRendering ?? base.imageRendering) === "pixelated"} onChange={(e) => setTokens({ imageRendering: e.target.checked ? undefined : "auto" })} />
          Pixel art (crisp scaling)
        </label>
        <label className="set-check">
          <input type="checkbox" checked={(tokens.outlineOn ?? base.outlineOn) !== "none"} onChange={(e) => setTokens({ outlineOn: e.target.checked ? undefined : "none" })} />
          Ring on the focused pane
        </label>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function Icons({
  loaded,
  patch,
  upload,
  assetUrl,
  onEditing,
}: {
  loaded: Loaded;
  patch: (fn: (m: Manifest) => Manifest) => void;
  upload: (file: string, blob: Blob) => Promise<{ width?: number; height?: number } | null>;
  assetUrl: (file: string) => string;
  onEditing: (on: boolean) => void;
}) {
  const icons = loaded.manifest.icons ?? {};
  const sheet = loaded.manifest.iconSheet;
  const input = useRef<HTMLInputElement | null>(null);

  const setGlyph = (name: IconName, value: string) =>
    patch((m) => {
      const next = { ...(m.icons ?? {}) } as Partial<Record<IconName, string | null>>;
      if (value) next[name] = value;
      else delete next[name];
      return { ...m, icons: next };
    });

  const dropSheet = async (blob: File) => {
    const size = await upload("icons.png", blob);
    if (!size) return;
    patch((m) => ({ ...m, iconSheet: { image: "icons.png", mode: m.iconSheet?.mode ?? "mask" } }));
  };

  return (
    <section className="set-section">
      <h3 className="set-h">Icons</h3>
      <p className="set-note">
        Two ways. Type a character or two per icon, in the skin's own face — or draw them all as
        one strip, {ICON_NAMES.length} square cells in this order, and drop it here. <b>Mask</b>{" "}
        paints each cell in the button's text colour, so it follows the theme and lights on hover;{" "}
        <b>image</b> keeps your colours. A typed glyph wins over the strip for that icon.
      </p>
      <div className="set-row">
        <button
          className={`studio-strip ${sheet ? "studio-strip-on" : ""}`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            e.stopPropagation();
            const f = e.dataTransfer.files[0];
            if (f) void dropSheet(f);
          }}
          title="Drop a strip of icons, or click to choose one"
        >
          {sheet && loaded.files.includes(sheet.image) ? (
            <img src={assetUrl(sheet.image)} alt="" className="studio-strip-img" />
          ) : (
            <span className="studio-shot-empty">drop a {ICON_NAMES.length}-cell strip</span>
          )}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/png"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void dropSheet(f);
            e.target.value = "";
          }}
        />
        {sheet && (
          <>
            <select className="set-select studio-mini" value={sheet.mode} onChange={(e) => patch((m) => ({ ...m, iconSheet: { image: sheet.image, mode: e.target.value as "mask" | "image" } }))}>
              <option value="mask">mask</option>
              <option value="image">image</option>
            </select>
            <button className="studio-link" onClick={() => patch((m) => ({ ...m, iconSheet: undefined }))}>
              kururu's drawings
            </button>
          </>
        )}
        <button className="button button-quiet studio-inline" onClick={() => void downloadTemplate()}>
          Template strip…
        </button>
      </div>
      <div className="studio-glyphs">
        {ICON_NAMES.map((name) => (
          <label key={name} className="studio-glyph">
            <Icon name={name} />
            <span className="studio-glyph-name">{name}</span>
            <input
              className="set-text studio-glyph-input"
              value={icons[name] ?? ""}
              maxLength={2}
              placeholder="·"
              onFocus={() => onEditing(true)}
              onBlur={() => onEditing(false)}
              onChange={(e) => setGlyph(name, e.target.value)}
            />
          </label>
        ))}
      </div>
    </section>
  );
}

/**
 * The strip, as kururu would draw it, for drawing over. Fourteen cells of
 * sixteen pixels with the built-in vector in each, so somebody starting a
 * pixel set has the order and the size in front of them rather than in a
 * paragraph. Rendered here because the vectors live here — the server has no
 * canvas, and the registry has no idea what the icons are.
 */
async function downloadTemplate(): Promise<void> {
  const cell = 16;
  const canvas = document.createElement("canvas");
  canvas.width = cell * ICON_NAMES.length;
  canvas.height = cell;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  await Promise.all(
    ICON_NAMES.map(
      (name, i) =>
        new Promise<void>((done) => {
          const img = new Image();
          img.onload = () => {
            ctx.drawImage(img, i * cell + 1, 1, cell - 2, cell - 2);
            done();
          };
          img.onerror = () => done();
          // `iconUrl` is a `url("data:…")`; the image wants the data URI alone.
          img.src = iconUrl(name).slice(5, -2);
        }),
    ),
  );
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = "icons.png";
  a.click();
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

function Effects({
  loaded,
  patch,
  upload,
  onEditing,
}: {
  loaded: Loaded;
  patch: (fn: (m: Manifest) => Manifest) => void;
  upload: (file: string, blob: Blob) => Promise<{ width?: number; height?: number } | null>;
  onEditing: (on: boolean) => void;
}) {
  const tokens = loaded.manifest.tokens ?? {};
  const setTokens = (next: Partial<Record<keyof SkinTokens, string | undefined>>) =>
    patch((m) => {
      const merged = { ...(m.tokens ?? {}), ...next } as Record<string, string | undefined>;
      for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
      return { ...m, tokens: merged as Manifest["tokens"] };
    });
  const preset = OVERLAYS.find(([, , css]) => css === (tokens.overlay ?? "none"))?.[0] ?? "custom";
  const opacity = Number.parseFloat(tokens.overlayOpacity ?? "1");
  const arrow = useRef<HTMLInputElement | null>(null);
  const hand = useRef<HTMLInputElement | null>(null);

  const setCursor = async (which: "cursor" | "cursorPointer", blob: File) => {
    const file = which === "cursor" ? "cursor.png" : "cursor-hand.png";
    const size = await upload(file, blob);
    if (!size) return;
    const hot = Math.max(0, Math.min(31, Math.floor((size.width ?? 0) / 8)));
    setTokens({ [which]: `url(${file}) ${hot} ${hot}, ${which === "cursor" ? "auto" : "pointer"}` });
  };

  return (
    <section className="set-section">
      <h3 className="set-h">Effects</h3>
      <div className="set-row">
        <span className="set-label">Overlay</span>
        <select
          className="set-select"
          value={preset}
          onChange={(e) => {
            const found = OVERLAYS.find(([id]) => id === e.target.value);
            if (found) setTokens({ overlay: found[2] === "none" ? undefined : found[2], overlayOpacity: found[2] === "none" ? undefined : (tokens.overlayOpacity ?? "0.3") });
          }}
        >
          {OVERLAYS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
          {preset === "custom" && <option value="custom">Custom</option>}
        </select>
        {preset !== "none" && (
          <>
            <input type="range" className="set-range" min={0} max={1} step={0.05} value={Number.isFinite(opacity) ? opacity : 1} onChange={(e) => setTokens({ overlayOpacity: e.target.value })} />
            <span className="set-value">{Math.round((Number.isFinite(opacity) ? opacity : 1) * 100)}%</span>
          </>
        )}
      </div>
      <p className="set-note set-note-under">
        The one control here that sits on top of the terminals. Keep it faint, or leave it off.
      </p>

      <div className="set-row">
        <span className="set-label">Frame</span>
        <input
          className="set-text studio-wide"
          placeholder="A box-shadow in theme tokens, e.g. inset 0 0 0 2px var(--line)"
          value={tokens.frame ?? ""}
          spellCheck={false}
          onFocus={() => onEditing(true)}
          onBlur={() => onEditing(false)}
          onChange={(e) => setTokens({ frame: e.target.value || undefined })}
        />
      </div>
      <div className="set-row">
        <span className="set-label">Focused</span>
        <input
          className="set-text studio-wide"
          placeholder="The same, for the pane that has the keyboard"
          value={tokens.frameOn ?? ""}
          spellCheck={false}
          onFocus={() => onEditing(true)}
          onBlur={() => onEditing(false)}
          onChange={(e) => setTokens({ frameOn: e.target.value || undefined })}
        />
      </div>

      <div className="set-row">
        <span className="set-label">Pointer</span>
        <button className="button button-quiet studio-inline" onClick={() => arrow.current?.click()}>
          {tokens.cursor ? "Replace arrow…" : "Arrow picture…"}
        </button>
        <button className="button button-quiet studio-inline" onClick={() => hand.current?.click()}>
          {tokens.cursorPointer ? "Replace hand…" : "Hand picture…"}
        </button>
        {(tokens.cursor || tokens.cursorPointer) && (
          <button className="studio-link" onClick={() => setTokens({ cursor: undefined, cursorPointer: undefined })}>
            system pointer
          </button>
        )}
        <input ref={arrow} type="file" accept="image/png" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void setCursor("cursor", f); e.target.value = ""; }} />
        <input ref={hand} type="file" accept="image/png" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void setCursor("cursorPointer", f); e.target.value = ""; }} />
      </div>
      <p className="set-note set-note-under">
        A PNG up to 32px. The hotspot is guessed near the top-left; edit <span className="set-mono">tokens.cursor</span> in the
        manifest for another.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

function Publish({ loaded }: { loaded: Loaded }) {
  const licence = useRef<HTMLInputElement | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const addLicence = async (blob: File) => {
    if (adding) return;
    const name = /^(ofl|licen[cs]e)/i.test(blob.name) ? blob.name.replace(/[^A-Za-z0-9._-]+/g, "-") : "LICENCE.txt";
    setAdding(true);
    setSaid(null);
    try {
      const response = await fetch(`/api/studio/asset?id=${encodeURIComponent(loaded.id)}&file=${encodeURIComponent(name)}`, {
        method: "POST",
        body: await blob.arrayBuffer(),
      });
      const data = (await response.json()) as { error?: string };
      setSaid(response.ok ? `${name} added` : (data.error ?? "could not add that"));
    } catch {
      setSaid("could not add that — is the server up?");
    } finally {
      setAdding(false);
    }
  };
  return (
    <section className="set-section">
      <h3 className="set-h">Publish</h3>
      <p className="set-note">
        The skin is the folder <span className="set-mono">{loaded.dir}</span> — {loaded.files.length}{" "}
        {loaded.files.length === 1 ? "file" : "files"}. To share it, copy that folder to{" "}
        <span className="set-mono">skins/{loaded.id}</span> in a checkout of{" "}
        <span className="set-mono">kururu-styles</span>, run <span className="set-mono">node tools/validate.mjs</span>,
        and open a pull request. The validator says in words what still needs doing.
      </p>
      <div className="set-row">
        <button
          className="button button-quiet studio-inline"
          onClick={() => void fetch(`/api/studio/reveal?id=${encodeURIComponent(loaded.id)}`, { method: "POST" })}
        >
          Show the folder
        </button>
        <button className="button button-quiet studio-inline" onClick={() => licence.current?.click()} disabled={adding}>
          {adding ? "Adding…" : "Add a licence file…"}
        </button>
        <input ref={licence} type="file" accept=".txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void addLicence(f); e.target.value = ""; }} />
        {said && <span className="set-note">{said}</span>}
      </div>
      <p className="set-note set-note-under">
        Files: {loaded.files.join(", ") || "none yet"}
      </p>
    </section>
  );
}
