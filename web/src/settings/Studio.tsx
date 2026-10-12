/**
 * Settings → Appearance → Studio: making a skin, with the window as the preview.
 *
 * Winamp's skins were a directory of bitmaps, and the reason a thousand people
 * drew one is that the format asked for pictures rather than CSS. This page is
 * that: the parts of the chrome, a place to drop a picture on each, and the
 * numbers beside it. There is no preview pane, because the whole window behind
 * the dialog is wearing the skin you are editing, and the phone on the same
 * server is wearing it too.
 *
 * What it edits is an ordinary installed skin in
 * `~/.config/kururu/styles/skins/<id>/`, with a `skin.json` in exactly the
 * format `../kururu-styles` takes and its pictures beside it, so publishing is
 * copying the folder. The one liberty is that a picture dropped on a part is
 * named after the part, which is a way of never asking for a file name.
 *
 * A slider produces sixty values a second and each would be a file written
 * and a snapshot to every client, so the manifest is applied locally at once
 * and sent 150ms after the last change. That is the one place this page holds
 * state the server does not yet have, and it is bounded: the timer fires, or
 * the page unmounts and flushes.
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
import { Icon } from "../components/Icon";
import { iconUrl } from "../icons";
import { Action, Banner, Btn, Danger, Details, Empty, Field, Gallery, Group, Mono, P, Readout, Row, Select, Slider, Toggle, useTyping } from "./ui";

/** The manifest as the studio holds it: the registry's shape, loosely typed because it is a file being edited. */
type Manifest = Record<string, unknown> & {
  tokens?: Partial<Record<keyof SkinTokens, string>>;
  parts?: Partial<Record<PartName, ManifestPaint>>;
  colors?: Partial<UiTokens>;
  icons?: Partial<Record<IconName, string | null>>;
  iconSheet?: { image: string; mode: "mask" | "image" };
  fonts?: { family: string; file: string; weight: string; style: string }[];
};

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

type Patch = (fn: (m: Manifest) => Manifest) => void;
type Upload = (file: string, blob: Blob) => Promise<{ width?: number; height?: number } | null>;

/**
 * All of `UiTokens` rather than a curated few, because a skin that painted its
 * status bar red needs `dim` to read against red, and a list that left `dim`
 * out could not finish the job.
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

export function StudioPage({ styles, appearance }: { styles: StyleLibrary; appearance: Appearance }) {
  const mine = useMemo(() => styles.installed.filter((r) => r.kind === "skin" && r.local), [styles.installed]);
  const [id, setId] = useState<string | null>(() => (mine.some((r) => r.id === appearance.skinId) ? appearance.skinId : (mine[0]?.id ?? null)));
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [stamp, setStamp] = useState(Date.now());
  const [making, setMaking] = useState<null | { name: string; from: string }>(null);
  const [working, setWorking] = useState<null | "create" | "delete">(null);
  const [uploading, setUploading] = useState<Record<string, true>>({});

  /** If the skin open here disappears, fall back to another of yours; if there were none and now there is one, open it. */
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
      .catch(() => setNote("could not save: is the server up?"));
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
  const patch: Patch = (fn) => loaded && save(fn(loaded.manifest));

  // --- files --------------------------------------------------------------
  const upload: Upload = async (file, blob) => {
    if (!loaded) return null;
    setNote(null);
    setUploading((u) => ({ ...u, [file]: true }));
    try {
      const response = await fetch(`/api/studio/asset?id=${encodeURIComponent(loaded.id)}&file=${encodeURIComponent(file)}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: await blob.arrayBuffer(),
      });
      const data = (await response.json()) as { error?: string; files?: string[]; width?: number; height?: number; stamp?: number };
      if (!response.ok) {
        setNote(data.error ?? "that file could not be added");
        return null;
      }
      setLoaded((l) => (l ? { ...l, files: data.files ?? l.files } : l));
      setStamp(data.stamp ?? Date.now());
      return { width: data.width, height: data.height };
    } catch {
      setNote("that file could not be added: is the server up?");
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
      const response = await fetch(`/api/studio/skin?id=${encodeURIComponent(next)}&name=${encodeURIComponent(making.name || next)}${from}`, { method: "POST" });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setNote(data.error ?? "could not make that skin");
        return;
      }
      setMaking(null);
      setId(next);
    } catch {
      setNote("could not make that skin: is the server up?");
    } finally {
      setWorking(null);
    }
  };

  const remove = async () => {
    if (!loaded || working) return;
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
      setNote("could not remove that skin: is the server up?");
    } finally {
      setWorking(null);
    }
  };

  const wearing = allSkins(styles.skins);
  const worn = skinFor(appearance.skinId, styles.skins);
  const adding = Object.keys(uploading);

  return (
    <>
      {note && <Banner tone="bad">{note}</Banner>}

      <Group title="Skin" foot="Changes land on the window behind this dialog as you make them, and on every phone wearing it.">
        {mine.length > 0 && (
          <Select label="Editing" value={id ?? ""} onChange={(value) => setId(value || null)}>
            {mine.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        )}
        {mine.length === 0 && !making && <Empty>No skins of your own yet. Make one from nothing, or fork the one you are wearing and change what you like.</Empty>}
        {!making && (
          <Row label="New skin" hint={`Fork starts from ${worn.name}, the one you are wearing.`}>
            <Btn onClick={() => setMaking({ name: "", from: "" })}>New…</Btn>
            <Btn onClick={() => setMaking({ name: `${worn.name} remix`, from: worn.id })}>Fork {worn.name}…</Btn>
          </Row>
        )}
        {making && (
          <>
            <Row label="Name" wide as="label">
              <NameBox value={making.name} onChange={(name) => setMaking({ ...making, name })} onEnter={() => void create()} onEscape={() => setMaking(null)} />
            </Row>
            <Select label="Start from" value={making.from} onChange={(from) => setMaking({ ...making, from })}>
              <option value="">Nothing</option>
              {wearing.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Row label="">
              <Btn onClick={() => setMaking(null)}>Cancel</Btn>
              <Btn primary onClick={() => void create()} disabled={working !== null}>
                {working === "create" ? "Creating…" : "Create"}
              </Btn>
            </Row>
          </>
        )}
        {loaded && appearance.skinId !== loaded.id && (
          <Action label="Not wearing it" hint="The window is in another skin, so edits here are not visible." button="Wear it" onClick={() => save({ ...loaded.manifest })} />
        )}
        {adding.length > 0 && <Empty>Adding {adding.join(", ")}…</Empty>}
      </Group>

      {loaded && (
        <>
          <About loaded={loaded} patch={patch} />
          <Parts loaded={loaded} patch={patch} upload={upload} assetUrl={assetUrl} />
          <Colours loaded={loaded} patch={patch} appearance={appearance} styles={styles} />
          <Shape loaded={loaded} patch={patch} upload={upload} />
          <Icons loaded={loaded} patch={patch} upload={upload} assetUrl={assetUrl} />
          <Effects loaded={loaded} patch={patch} upload={upload} />
          <Publish loaded={loaded} />
          <Group>
            <Danger
              label="Delete this skin"
              hint="Its folder and every picture in it."
              button="Delete"
              ask={`Delete ${typeof loaded.manifest.name === "string" ? loaded.manifest.name : loaded.id}?`}
              onConfirm={() => void remove()}
              busy={working === "delete"}
              busyLabel="Deleting…"
            />
          </Group>
        </>
      )}
    </>
  );
}

/** The name box while a skin is being made: plain, because it is a draft and not a setting. */
function NameBox({ value, onChange, onEnter, onEscape }: { value: string; onChange: (v: string) => void; onEnter: () => void; onEscape: () => void }) {
  const typing = useTyping();
  return (
    <input
      className="st-input"
      placeholder="A name for it"
      value={value}
      autoFocus
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onEnter();
        if (event.key === "Escape") onEscape();
      }}
      {...typing}
    />
  );
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function text(m: Manifest, key: string): string {
  return typeof m[key] === "string" ? (m[key] as string) : "";
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

function About({ loaded, patch }: { loaded: Loaded; patch: Patch }) {
  const m = loaded.manifest;
  const field = (key: string, label: string, placeholder: string) => (
    <Field label={label} value={text(m, key)} placeholder={placeholder} onCommit={(value) => patch((x) => ({ ...x, [key]: value }))} />
  );
  return (
    <Group title="About" foot="The registry wants all of these. A picture you did not draw needs the licence it came with.">
      {field("name", "Name", "What it is called")}
      {field("description", "Line", "One line: what kind of window this is")}
      {field("author", "By", "you")}
      {field("licence", "Licence", "CC0-1.0")}
      {field("version", "Version", "1.0.0")}
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/**
 * A first guess at how a dropped picture is meant to be used, from its size
 * and which part it landed on. A guess and not a rule: every number is a
 * control the person can move a moment later. The slice is a third of the
 * shorter side, which is what a bezel with an obvious frame and middle nearly
 * always is; the scale is chosen so small pixel art comes out big.
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

function Parts({ loaded, patch, upload, assetUrl }: { loaded: Loaded; patch: Patch; upload: Upload; assetUrl: (file: string) => string }) {
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
    <Group title="Parts" foot="Drop a PNG on a part to paint it.">
      <Gallery size="lg">
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
      </Gallery>
      <Details summary="How a picture is applied">
        <P>
          <b>Nine-slice</b> uses the picture's edges as a frame and its middle as the ground; the slice is how thick that frame is in the picture's own
          pixels. <b>Tile</b> repeats it as a texture. <b>Stretch</b> fits it to the box. Keep the scale whole, or pixel art goes soft.
        </P>
      </Details>
    </Group>
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
  const [adding, setAdding] = useState(false);
  const [uneven, setUneven] = useState(Array.isArray(paint?.slice));
  const input = useRef<HTMLInputElement | null>(null);
  const take = (file: File) => {
    if (adding) return;
    setAdding(true);
    void onDrop(file).finally(() => setAdding(false));
  };

  /** The thumbnail is the part compiled exactly as the window compiles it, so what the card shows is what the window is doing. */
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
      className={`st-part${over ? " st-part-over" : ""}${paint ? " st-part-on" : ""}`}
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
      <button type="button" className="st-part-shot" style={shot ?? undefined} onClick={() => input.current?.click()} title={`Choose a picture for ${info.label.toLowerCase()}`}>
        {adding ? <span aria-live="polite">adding…</span> : !shot && <span>{parentPainted ? `same as ${PARTS[info.stateOf!].label.toLowerCase()}` : "drop a PNG"}</span>}
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
      <div className="st-part-text">
        <span className="st-part-name">{info.label}</span>
        <span className="st-part-covers">{info.covers}</span>
        {paint ? (
          <div className="st-part-controls">
            <select className="st-select st-select-mini" value={paint.mode ?? "nine"} onChange={(e) => onChange({ ...paint, mode: e.target.value as PaintMode })}>
              {PAINT_MODES.map((m) => (
                <option key={m} value={m}>
                  {m === "nine" ? "nine-slice" : m}
                </option>
              ))}
            </select>
            <label className="st-part-num">
              <span>scale</span>
              <select className="st-select st-select-mini" value={paint.scale ?? 1} onChange={(e) => onChange({ ...paint, scale: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}×
                  </option>
                ))}
              </select>
            </label>
            {(paint.mode ?? "nine") === "nine" && (
              <>
                <label className="st-part-num">
                  <span>slice</span>
                  {(uneven ? slice : [slice[0]]).map((n, i) => (
                    <input
                      key={i}
                      className="st-input st-input-mono st-input-mini"
                      type="number"
                      min={0}
                      max={512}
                      value={n}
                      title={uneven ? ["top", "right", "bottom", "left"][i] : undefined}
                      onChange={(e) => {
                        if (!uneven) return onChange({ ...paint, slice: Number(e.target.value) || 0 });
                        const next = [...slice] as [number, number, number, number];
                        next[i] = Number(e.target.value) || 0;
                        onChange({ ...paint, slice: next });
                      }}
                    />
                  ))}
                </label>
                <button
                  type="button"
                  className="st-textbtn"
                  onClick={() => {
                    if (uneven) onChange({ ...paint, slice: slice[0] });
                    setUneven(!uneven);
                  }}
                >
                  {uneven ? "even" : "per side"}
                </button>
                <select className="st-select st-select-mini" value={paint.repeat ?? "stretch"} onChange={(e) => onChange({ ...paint, repeat: e.target.value as PaintRepeat })}>
                  {PAINT_REPEATS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </>
            )}
            <button type="button" className="st-iconbtn st-iconbtn-danger st-part-remove" onClick={() => onChange(null)} title="Stop painting this part" aria-label="Stop painting this part">
              <Icon name="close" />
            </button>
          </div>
        ) : (
          <span className="st-part-hint">{info.hint}</span>
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
 * colour the current theme gives it; taking it over starts from that colour,
 * because "the theme's, but a bit darker" is how these are actually chosen.
 * The terminal is not here: a skin does not get to change what an agent's
 * output looks like.
 */
function Colours({ loaded, patch, appearance, styles }: { loaded: Loaded; patch: Patch; appearance: Appearance; styles: StyleLibrary }) {
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
    <Group title="Colours" foot="A skin follows the theme unless it says otherwise, which pictures usually have to. The terminals stay the theme's.">
      <div className="st-colors">
        {COLOR_ROWS.map(([token, label]) => {
          const mine = colors[token];
          const shown = mine ?? theme.ui[token];
          return (
            <div key={token} className={`st-color${mine ? " st-color-on" : ""}`}>
              <label className="st-swatch" style={{ background: shown }} title={mine ? "Your colour: click to change" : "The theme's colour: click to override it"}>
                <input type="color" value={toHex(shown)} onChange={(e) => set(token, e.target.value)} />
              </label>
              <span className="st-color-name">{label}</span>
              {mine ? (
                <button type="button" className="st-textbtn" onClick={() => set(token, null)}>
                  theme's
                </button>
              ) : (
                <span className="st-color-from">theme</span>
              )}
            </div>
          );
        })}
      </div>
    </Group>
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

function useTokens(loaded: Loaded, patch: Patch) {
  const tokens = loaded.manifest.tokens ?? {};
  const setTokens = (next: Partial<Record<keyof SkinTokens, string | undefined>>) =>
    patch((m) => {
      const merged = { ...(m.tokens ?? {}), ...next } as Record<string, string | undefined>;
      for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
      return { ...m, tokens: merged as Manifest["tokens"] };
    });
  return { tokens, setTokens };
}

function Shape({ loaded, patch, upload }: { loaded: Loaded; patch: Patch; upload: Upload }) {
  const base = skinFor(null).tokens;
  const { tokens, setTokens } = useTokens(loaded, patch);
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
    <Group title="Shape" foot="The whole type ramp moves together: a pixel face at 8px wants every size in the window down a step.">
      <Slider
        label="Corners"
        min={0}
        max={16}
        value={corner}
        format={(n) => `${n}px`}
        onChange={(r) =>
          setTokens({
            radiusXs: `${Math.round(r * 0.4)}px`,
            radiusSm: `${Math.round(r * 0.4)}px`,
            radiusMd: `${Math.round(r * 0.6)}px`,
            radiusLg: `${Math.round(r * 0.8)}px`,
            radiusXl: `${r}px`,
          })
        }
      />
      <Slider label="Lines" min={1} max={4} value={line} format={(n) => `${n}px`} onChange={(n) => setTokens({ border: `${n}px`, borderThick: `${n + 1}px` })} />
      <Slider label="Gutter" min={0} max={24} value={gutter} format={(n) => `${n}px`} onChange={(n) => setTokens({ gutter: `${n}px` })} />
      <Slider
        label="Type"
        min={-2}
        max={8}
        value={step}
        format={(s) => (s >= 0 ? `+${s}` : String(s))}
        onChange={(s) => {
          const next: Partial<Record<keyof SkinTokens, string>> = {};
          for (const [token, size] of RAMP) next[token] = `${size + s}px`;
          setTokens(next);
        }}
      />
      <Field
        label="Face"
        hint="A font file served from this machine, never from the internet. Add its licence under Publish."
        value={font?.family ?? ""}
        placeholder="Family name, as the file calls it"
        onCommit={(family) =>
          patch((m) => ({
            ...m,
            fonts: font ? [{ ...font, family }] : m.fonts,
            tokens: { ...(m.tokens ?? {}), ui: family ? `"${family}", ${base.ui}` : undefined },
          }))
        }
      />
      <Row label="Font file">
        <Btn onClick={() => fontInput.current?.click()}>{font ? `Replace ${font.file}` : "Add a font file…"}</Btn>
        {font && <Btn onClick={() => patch((m) => ({ ...m, fonts: undefined, tokens: { ...(m.tokens ?? {}), ui: undefined } }))}>System face</Btn>}
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
      </Row>
      <Toggle label="Pixel text" hint="No smoothing: a glyph is on or off." on={(tokens.uiSmoothing ?? base.uiSmoothing) === "none"} onChange={(on) => setTokens({ uiSmoothing: on ? "none" : undefined })} />
      <Toggle label="Pixel art" hint="Crisp scaling for sprites." on={(tokens.imageRendering ?? base.imageRendering) === "pixelated"} onChange={(on) => setTokens({ imageRendering: on ? undefined : "auto" })} />
      <Toggle label="Ring on the focused pane" on={(tokens.outlineOn ?? base.outlineOn) !== "none"} onChange={(on) => setTokens({ outlineOn: on ? undefined : "none" })} />
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function Icons({ loaded, patch, upload, assetUrl }: { loaded: Loaded; patch: Patch; upload: Upload; assetUrl: (file: string) => string }) {
  const icons = loaded.manifest.icons ?? {};
  const sheet = loaded.manifest.iconSheet;
  const input = useRef<HTMLInputElement | null>(null);
  const typing = useTyping();

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
    <Group title="Icons" foot="A typed glyph wins over the strip for that icon.">
      <Row label="Strip" hint={`All ${ICON_NAMES.length} icons as one picture, square cells in this order.`} wide>
        <span className="st-strip-row">
          <button
            type="button"
            className={`st-strip${sheet ? " st-strip-on" : ""}`}
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
            {sheet && loaded.files.includes(sheet.image) ? <img src={assetUrl(sheet.image)} alt="" className="st-strip-img" /> : <span>drop a {ICON_NAMES.length}-cell strip</span>}
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
              <select className="st-select" value={sheet.mode} onChange={(e) => patch((m) => ({ ...m, iconSheet: { image: sheet.image, mode: e.target.value as "mask" | "image" } }))} aria-label="How the strip is painted">
                <option value="mask">mask: the button's text colour</option>
                <option value="image">image: its own colours</option>
              </select>
              <Btn onClick={() => patch((m) => ({ ...m, iconSheet: undefined }))}>Kururu's drawings</Btn>
            </>
          )}
          <Btn onClick={() => void downloadTemplate()}>Template strip…</Btn>
        </span>
      </Row>
      <Row label="Glyphs" hint="A character or two per icon, in the skin's own face." wide>
        <span className="st-glyphs">
          {ICON_NAMES.map((name) => (
            <label key={name} className="st-glyph">
              <Icon name={name} />
              <span className="st-glyph-name">{name}</span>
              <input
                className="st-input st-input-mono st-glyph-input"
                value={icons[name] ?? ""}
                maxLength={2}
                placeholder="·"
                aria-label={`Glyph for ${name}`}
                onChange={(e) => setGlyph(name, e.target.value)}
                {...typing}
              />
            </label>
          ))}
        </span>
      </Row>
    </Group>
  );
}

/**
 * The strip, as kururu would draw it, for drawing over: every cell with the
 * built-in vector in it, so somebody starting a pixel set has the order and
 * the size in front of them. Rendered here because the vectors live here.
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

function Effects({ loaded, patch, upload }: { loaded: Loaded; patch: Patch; upload: Upload }) {
  const { tokens, setTokens } = useTokens(loaded, patch);
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
    <Group title="Effects">
      <Select
        label="Overlay"
        hint="The one control here that sits on top of the terminals. Keep it faint, or off."
        value={preset}
        onChange={(value) => {
          const found = OVERLAYS.find(([id]) => id === value);
          if (found) setTokens({ overlay: found[2] === "none" ? undefined : found[2], overlayOpacity: found[2] === "none" ? undefined : (tokens.overlayOpacity ?? "0.3") });
        }}
      >
        {OVERLAYS.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
        {preset === "custom" && <option value="custom">Custom</option>}
      </Select>
      {preset !== "none" && (
        <Slider label="Opacity" min={0} max={1} step={0.05} value={Number.isFinite(opacity) ? opacity : 1} format={(n) => `${Math.round(n * 100)}%`} onChange={(n) => setTokens({ overlayOpacity: String(n) })} />
      )}
      <Field label="Frame" hint="A box-shadow in theme tokens, e.g. inset 0 0 0 2px var(--line)" mono value={tokens.frame ?? ""} onCommit={(v) => setTokens({ frame: v || undefined })} />
      <Field label="Focused frame" hint="The same, for the pane that has the keyboard." mono value={tokens.frameOn ?? ""} onCommit={(v) => setTokens({ frameOn: v || undefined })} />
      <Row label="Pointer" hint="A PNG up to 32px; the hotspot is guessed near the top left.">
        <Btn onClick={() => arrow.current?.click()}>{tokens.cursor ? "Replace arrow…" : "Arrow…"}</Btn>
        <Btn onClick={() => hand.current?.click()}>{tokens.cursorPointer ? "Replace hand…" : "Hand…"}</Btn>
        {(tokens.cursor || tokens.cursorPointer) && <Btn onClick={() => setTokens({ cursor: undefined, cursorPointer: undefined })}>System pointer</Btn>}
        <input
          ref={arrow}
          type="file"
          accept="image/png"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void setCursor("cursor", f);
            e.target.value = "";
          }}
        />
        <input
          ref={hand}
          type="file"
          accept="image/png"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void setCursor("cursorPointer", f);
            e.target.value = "";
          }}
        />
      </Row>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

function Publish({ loaded }: { loaded: Loaded }) {
  const licence = useRef<HTMLInputElement | null>(null);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
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
      setSaid(response.ok ? { text: `${name} added` } : { text: data.error ?? "could not add that", bad: true });
    } catch {
      setSaid({ text: "could not add that: is the server up?", bad: true });
    } finally {
      setAdding(false);
    }
  };
  return (
    <Group title="Publish">
      <Readout label="Folder" hint={`${loaded.files.length} ${loaded.files.length === 1 ? "file" : "files"}: ${loaded.files.join(", ") || "none yet"}`} value={<Mono>{loaded.dir}</Mono>}>
        <Btn onClick={() => void fetch(`/api/studio/reveal?id=${encodeURIComponent(loaded.id)}`, { method: "POST" })}>Show</Btn>
      </Readout>
      <Action label="Licence file" hint="Beside the pictures, for the registry." button="Add…" busy={adding} busyLabel="Adding…" onClick={() => licence.current?.click()} outcome={said} />
      <input
        ref={licence}
        type="file"
        accept=".txt"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void addLicence(f);
          e.target.value = "";
        }}
      />
      <Details summary="How to share it">
        <P>
          Copy the folder to <Mono>skins/{loaded.id}</Mono> in a checkout of <Mono>kururu-styles</Mono>, run <Mono>node tools/validate.mjs</Mono>, and open a pull
          request. The validator says in words what still needs doing.
        </P>
      </Details>
    </Group>
  );
}
