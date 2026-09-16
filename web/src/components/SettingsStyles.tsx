/**
 * Settings → Styles: what `../kururu-styles` is offering, and what of it this
 * machine has.
 *
 * A tab of its own rather than a section on Appearance, and the line between
 * them is worth stating because it decides what goes where. **Appearance is what
 * you are wearing**: every theme and skin available on this machine, built-in
 * and installed alike, in one list with no idea where any of them came from.
 * **Styles is the shop**: things that are not here yet, and the versions of the
 * ones that are. Somebody changing theme ten times an afternoon should never
 * pass through a list of downloads to do it.
 *
 * ## Picking is installing, and that is the whole gesture
 *
 * There is no *Install* button followed by a *Use* button. Clicking a row
 * downloads it and puts it on, because the second step decides nothing — nobody
 * installs a theme they have just chosen and then thinks about whether to wear
 * it. A style you already have says so and offers the one thing that is
 * genuinely a separate decision, which is removing it.
 *
 * *Update* is the exception and is deliberately not the same button. Updating a
 * style you are not currently wearing is not a request to start wearing it, and
 * a window that changed shape because somebody accepted a patch release would be
 * a surprise nobody forgives. So the row sends `activate=1` for a pick and not
 * for an update, and the server does what it is told rather than deciding.
 *
 * ## What is drawn, and why it is not a list of names
 *
 * A theme is drawn in its own colours and a skin in its own shape, which is the
 * same argument the Appearance tab already makes about swatches: a row of names
 * would make you install something to find out what it is and then install
 * another. Both come out of the `preview` block the registry's index carries, so
 * a card costs nothing beyond the one fetch that drew the list.
 *
 * A mascot is the one kind whose preview is a picture rather than a number, so
 * it comes through `/api/styles/preview` — the server proxying the sheet, which
 * is the same act as fetching a manifest and keeps the browser from ever talking
 * to GitHub.
 *
 * This component holds the catalogue and nothing else. What is *installed* comes
 * from the snapshot, like everything else in the window, which is what makes an
 * install on the desktop show up in a phone's Settings without either of them
 * knowing about the other.
 */
import { useCallback, useEffect, useState } from "react";
import type { MascotClip, MascotConfig } from "../../../shared/model";
import { BASE_ICONS } from "../../../shared/skin";
import type { StyleKind, StyleLibrary, StylePreview } from "../../../shared/styles";
import { Icon } from "./Icon";
import { Mascot } from "./Status";

interface CatalogEntry {
  kind: StyleKind;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  licence: string;
  homepage?: string;
  source?: string;
  preview: StylePreview;
  installedVersion: string | null;
  update: boolean;
}

interface Catalog {
  entries: CatalogEntry[];
  stale: boolean;
  error?: string;
  home: string;
}

/** Plural, and the order the sections come in: two axes, then the fun, then the shortcuts. */
const SECTIONS: ReadonlyArray<readonly [StyleKind, string, string]> = [
  ["theme", "Themes", "what colour the window and its terminals are"],
  ["skin", "Skins", "what shape it is — radii, line weights, the type ramp"],
  ["mascot", "Mascots", "what moves in the sidebar while an agent is working"],
  ["pack", "Packs", "one of each, chosen to go together. Installing one installs its three"],
];

export function StyleSettings({ styles }: { styles: StyleLibrary }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  /**
   * Fetched when the tab opens rather than carried in the snapshot, on
   * `/api/identity`'s reasoning: this is the *world's* state, not kururu's. It
   * changes when somebody merges a pull request in another repository, answering
   * it costs a request over the network, and nothing in the window needs it
   * except the page that is asking.
   */
  const load = useCallback((refresh: boolean) => {
    setFailed(null);
    void fetch(`/api/styles/catalog${refresh ? "?refresh=1" : ""}`)
      .then((r) => r.json())
      .then((data: Catalog) => setCatalog(data))
      .catch(() => setFailed("could not reach this server"));
  }, []);

  useEffect(() => load(false), [load]);

  /**
   * The installed set comes from the snapshot, so the row corrects itself when
   * the server pushes — but the *catalogue's* idea of what is installed is a
   * copy taken at fetch time, and after an install it is a version behind. One
   * reload is cheaper than teaching the row to reconcile two sources, and it is
   * off the cache, so it is a local round trip rather than a call to GitHub.
   */
  const act = async (path: string, entry: CatalogEntry, activate: boolean) => {
    setBusy(`${entry.kind}/${entry.id}`);
    setFailed(null);
    try {
      const query = `kind=${entry.kind}&id=${encodeURIComponent(entry.id)}${activate ? "&activate=1" : ""}`;
      const res = await fetch(`/api/styles/${path}?${query}`, { method: "POST" });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) setFailed(body.error ?? `could not ${path} ${entry.name}`);
      else load(false);
    } catch {
      setFailed(`could not ${path} ${entry.name}`);
    } finally {
      setBusy(null);
    }
  };

  const installed = new Map(styles.installed.map((r) => [`${r.kind}/${r.id}`, r]));
  const updates = catalog?.entries.filter((e) => e.update).length ?? 0;

  return (
    <div className="set-page">
      <section className="set-section">
        <div className="set-row set-row-split">
          <p className="set-note set-note-flush">
            Themes, skins and mascots from{" "}
            <span className="set-mono">kururu-styles</span>. Picking one downloads it to{" "}
            <span className="set-mono">{catalog?.home ?? "~/.config/kururu/styles"}</span> and puts
            it on — nothing is fetched while the window is painting, so a style you have keeps
            working with no network.
          </p>
          <button className="button button-quiet style-refresh" onClick={() => load(true)}>
            Check for updates
          </button>
        </div>

        {catalog?.stale && (
          <p className="set-warn">
            {catalog.error ?? "Could not reach the registry"}
            {catalog.entries.length > 0
              ? " — showing the last list this machine saw."
              : " — nothing to show until it answers."}
          </p>
        )}
        {failed && <p className="set-warn">{failed}</p>}
        {updates > 0 && (
          <p className="set-note">
            {updates === 1 ? "One style has" : `${updates} styles have`} a newer version.
          </p>
        )}
      </section>

      {SECTIONS.map(([kind, title, note]) => {
        const rows = catalog?.entries.filter((e) => e.kind === kind) ?? [];
        if (rows.length === 0) return null;
        return (
          <section className="set-section" key={kind}>
            <h3 className="set-h">{title}</h3>
            <p className="set-note">{note}</p>
            <div className="style-list">
              {rows.map((entry) => (
                <StyleRow
                  key={entry.id}
                  entry={entry}
                  have={installed.has(`${entry.kind}/${entry.id}`)}
                  busy={busy === `${entry.kind}/${entry.id}`}
                  onPick={() => void act("install", entry, true)}
                  onUpdate={() => void act("install", entry, false)}
                  onRemove={() => void act("remove", entry, false)}
                />
              ))}
            </div>
          </section>
        );
      })}

      {catalog === null && !failed && <p className="set-note">Asking the registry…</p>}
    </div>
  );
}

function StyleRow({
  entry,
  have,
  busy,
  onPick,
  onUpdate,
  onRemove,
}: {
  entry: CatalogEntry;
  have: boolean;
  busy: boolean;
  onPick: () => void;
  onUpdate: () => void;
  onRemove: () => void;
}) {
  return (
    <div className={`style-row ${have ? "style-row-have" : ""}`}>
      <StylePreviewCard entry={entry} />
      <div className="style-text">
        <span className="style-name">
          {entry.name}
          <span className="style-version">{entry.version}</span>
        </span>
        <span className="style-desc">{entry.description}</span>
        <span className="style-meta">
          {entry.author} · {entry.licence}
          {entry.homepage && (
            <>
              {" · "}
              <a className="style-link" href={entry.homepage} target="_blank" rel="noreferrer noopener">
                home
                <Icon name="external" />
              </a>
            </>
          )}
          {entry.source && (
            <>
              {" · "}
              <a className="style-link" href={entry.source} target="_blank" rel="noreferrer noopener">
                source
                <Icon name="external" />
              </a>
            </>
          )}
        </span>
      </div>
      <div className="style-actions">
        {busy ? (
          <span className="style-state">working…</span>
        ) : !have ? (
          <button className="button style-button" onClick={onPick}>
            {entry.kind === "pack" ? "Use pack" : "Use"}
          </button>
        ) : (
          <>
            {entry.update ? (
              <button
                className="button style-button"
                onClick={onUpdate}
                title={`Installed ${entry.installedVersion}`}
              >
                Update to {entry.version}
              </button>
            ) : (
              <span className="style-state">Installed</span>
            )}
            <button className="style-remove" onClick={onRemove} title={`Remove ${entry.name}`} aria-label={`Remove ${entry.name}`}>
              <Icon name="close" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The entry, drawn as itself.
 *
 * Four shapes because the four kinds are genuinely different questions, and the
 * two that matter most are already solved next door: a theme card is
 * `ThemeOption`'s argument and a skin card is `SkinOption`'s, each built from
 * the `preview` block rather than from a manifest nobody has downloaded. They
 * are not *shared* with those components because the ones on the Appearance tab
 * draw a `Theme` and a `Skin`, which is what you have once it is installed, and
 * a preview is deliberately less than that — making them common would mean
 * inventing a half-theme for the sake of one card.
 */
function StylePreviewCard({ entry }: { entry: CatalogEntry }) {
  const p = entry.preview;
  const str = (name: string, fallback = "") => (typeof p[name] === "string" ? (p[name] as string) : fallback);

  if (entry.kind === "theme") {
    return (
      <span
        className="style-shot style-shot-theme"
        style={{ background: str("bg", "var(--bg)"), borderColor: str("line", "var(--line)") }}
        aria-hidden
      >
        <span className="style-shot-chrome" style={{ background: str("chrome", "var(--chrome)") }} />
        <span className="style-shot-dots">
          {["accent", "working", "blocked", "done"].map((name) => (
            <span key={name} className="style-shot-dot" style={{ background: str(name, "var(--dim)") }} />
          ))}
        </span>
      </span>
    );
  }

  if (entry.kind === "skin") {
    return (
      <span
        className="style-shot style-shot-skin"
        style={{
          borderRadius: str("radiusXl", "var(--radius-xl)"),
          borderWidth: str("border", "var(--border)"),
          borderStyle: str("borderStyle", "solid"),
          boxShadow: str("frame", "none"),
          fontFamily: str("ui", "var(--ui)"),
          fontSize: str("fsXs", "var(--fs-xs)"),
          letterSpacing: str("uiLetterSpacing", "normal"),
        }}
        aria-hidden
      >
        {str("run", BASE_ICONS.run)}
      </span>
    );
  }

  if (entry.kind === "mascot") {
    /**
     * The geometry is the manifest's, straight out of the preview, and the sheet
     * is the one thing that has to come over the network — see
     * `/api/styles/preview`. `Mascot` takes the URL because of this one caller:
     * every other mascot in the window is installed and is found by name.
     */
    const frame = num(p.frame, 16);
    const trim = (p.trim ?? {}) as { x?: number; y?: number; size?: number };
    const config: MascotConfig = {
      sheet: entry.id,
      frame,
      trim: { x: num(trim.x, 0), y: num(trim.y, 0), size: num(trim.size, frame) },
      motion: "always",
      working: clip(p.working, frame),
      idle: null,
    };
    return (
      <span className="style-shot style-shot-mascot" aria-hidden>
        {/* The badge is its own square inside the alignment box. `Mascot` draws a
            whole strip of cells and relies on its parent being exactly one cell
            wide to show one of them — hand it the 52px box every other preview
            uses and you see one and two thirds of a fox. */}
        <span className="style-shot-cell">
          <Mascot
            config={config}
            clip={config.working}
            src={`/api/styles/preview?kind=mascot&id=${encodeURIComponent(entry.id)}`}
          />
        </span>
      </span>
    );
  }

  return (
    <span className="style-shot style-shot-pack" aria-hidden>
      {[p.theme, p.skin, p.mascot].filter((x): x is string => typeof x === "string").map((id) => (
        <span key={id} className="style-shot-part">
          {id}
        </span>
      ))}
    </span>
  );
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clip(value: unknown, frame: number): MascotClip {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    row: num(raw.row, 0),
    col: num(raw.col, 0),
    count: Math.max(1, num(raw.count, 1)),
    cycle: Math.max(100, num(raw.cycle, 800)),
  };
}
