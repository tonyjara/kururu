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
 * ## One kind at a time, because the registry only grows
 *
 * The kinds were stacked sections, which was right when there were
 * fourteen entries between them and is wrong now: a shop whose whole promise is
 * that other people keep adding to it cannot be a page you scroll to the bottom
 * of. They are a strip of kinds and a filter instead, and only the kind you
 * picked is drawn.
 *
 * The strip is **pills rather than the underlined tabs the dialog uses**, which
 * is not decoration. A second strip in the same clothes directly under the first
 * reads as a second level of navigation, and this is not one — it is which
 * *shelf* you are looking at, and it keeps the search box beside it on the same
 * line to say so.
 *
 * The filter is substring, not fuzzy, on `Dialog.tsx`'s argument: a list you are
 * reading answers for is a list where a match has to be explicable, and "nrd"
 * finding Nord costs more in false hits than it saves in keystrokes. Every word
 * has to appear, in any order, so `dark gruv` narrows the way somebody typing it
 * expects rather than the way a regex would.
 *
 * **A filter that hides a hit behind a tab you are not on is the trap this shape
 * is born with**, so it is closed here rather than left: every pill carries the
 * number of matches under the current query, and a shelf with nothing on it says
 * which of the others has the thing and offers to go there. Without that, typing
 * `fox` on Themes says the registry has no fox, which is a lie the user has no
 * way to see through.
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
 * **A sound goes further, because a sound cannot be drawn at all.** Its card is
 * a button that plays it, through the same proxy, and that is not a nicety: a
 * row of names is a list you would have to install from to find out what you
 * were installing, and then uninstall. `docs/notifications.md` already made this
 * argument about the Notifications tab — *a list of words is not a list of
 * noises* — and the only thing new here is that the noise has not been
 * downloaded yet, which is what the proxy is for.
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
import { playUrl } from "../notify";
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

/**
 * The shelves, and the order they come in: two axes, then the fun, then the
 * shortcuts. Plural, because a pill names a shelf rather than a thing on it.
 */
const SHELVES: ReadonlyArray<readonly [StyleKind, string, string]> = [
  ["theme", "Themes", "what colour the window and its terminals are"],
  ["skin", "Skins", "what shape it is — radii, line weights, the type ramp"],
  ["mascot", "Mascots", "what moves in the sidebar while an agent is working"],
  ["sound", "Sounds", "what a notification sounds like"],
  ["pack", "Packs", "one of each, chosen to go together"],
];

/**
 * Whether a row survives the filter.
 *
 * Over the four things the row already *shows* — its name, what it is, who made
 * it — plus the id, which is the one thing it does not show and is nonetheless
 * how half the world refers to a style. Nothing here is the licence: filtering a
 * shop by licence is a real question and a checkbox's job, not a thing you get
 * by accident for typing `cc0` while looking for a colour.
 */
function matches(entry: CatalogEntry, words: string[]): boolean {
  if (words.length === 0) return true;
  const hay = `${entry.id} ${entry.name} ${entry.description} ${entry.author}`.toLowerCase();
  return words.every((word) => hay.includes(word));
}

export function StyleSettings({
  styles,
  volume,
  onEditing,
}: {
  styles: StyleLibrary;
  /**
   * What to audition a sound at — the notification volume, straight off the
   * snapshot. Passed in rather than read here because this page has no other
   * business with `NotifySettings`, and a preview that played at full volume
   * while somebody had the slider at a tenth would be the page arguing with the
   * setting it is about to write.
   */
  volume: number;
  /**
   * The filter is the one field on this page, and it only wants the keyboard to
   * stand down while there is something in it to lose — see the escape handler
   * below. Every other page in Settings hands this over for a whole edit; this
   * one hands it over for exactly as long as escape means "clear" instead of
   * "close".
   */
  onEditing: (on: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  /**
   * What is being done to which entry, and what last went wrong with which —
   * keyed by entry, never one value for the page. The first cut kept a single
   * `busy` id, and pressing Use on a second row while the first was still
   * downloading overwrote it: the second row showed "working…", the first
   * finished and cleared it, and the second went on installing behind a button
   * that offered to start it again. Every row is its own job.
   */
  const [working, setWorking] = useState<Record<string, Job>>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  /** The catalogue's own trouble — not reaching this server, or refreshing — which is the page's, not a row's. */
  const [failed, setFailed] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /**
   * Which shelf, and what is typed. Both are this window's, like the dialog's
   * own tab and for the same reason: where somebody is looking is not a fact
   * about the session, and a phone should not be dragged onto Packs because the
   * desktop went there.
   */
  const [kind, setKind] = useState<StyleKind>("theme");
  const [query, setQuery] = useState("");

  /**
   * Fetched when the tab opens rather than carried in the snapshot, because
   * this is the *world's* state and not kururu's. It changes when somebody
   * merges a pull request in another repository, answering
   * it costs a request over the network, and nothing in the window needs it
   * except the page that is asking.
   */
  const load = useCallback((refresh: boolean) => {
    setFailed(null);
    if (refresh) setRefreshing(true);
    void fetch(`/api/styles/catalog${refresh ? "?refresh=1" : ""}`)
      .then((r) => r.json())
      .then((data: Catalog) => setCatalog(data))
      .catch(() => setFailed("could not reach this server"))
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => load(false), [load]);

  /**
   * Leaving the page with a query still in the box would leave the dialog's
   * keyboard stood down for a field that is gone. Unmounting is the only way out
   * of here, so it is the only place this has to be said.
   */
  useEffect(() => () => onEditing(false), [onEditing]);

  /**
   * The installed set comes from the snapshot, so the row corrects itself when
   * the server pushes — but the *catalogue's* idea of what is installed is a
   * copy taken at fetch time, and after an install it is a version behind. One
   * reload is cheaper than teaching the row to reconcile two sources, and it is
   * off the cache, so it is a local round trip rather than a call to GitHub.
   */
  const act = async (job: Job, entry: CatalogEntry) => {
    const key = `${entry.kind}/${entry.id}`;
    if (working[key]) return;
    const path = job === "install" || job === "update" ? "install" : job;
    setWorking((w) => ({ ...w, [key]: job }));
    setProblems(({ [key]: _gone, ...rest }) => rest);
    try {
      const query = `kind=${entry.kind}&id=${encodeURIComponent(entry.id)}${job === "install" ? "&activate=1" : ""}`;
      const res = await fetch(`/api/styles/${path}?${query}`, { method: "POST" });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) setProblems((p) => ({ ...p, [key]: body.error ?? `could not ${path} ${entry.name}` }));
      else load(false);
    } catch {
      setProblems((p) => ({ ...p, [key]: `could not ${path} ${entry.name} — is the server up?` }));
    } finally {
      setWorking(({ [key]: _done, ...rest }) => rest);
    }
  };

  /**
   * Typing puts the keyboard down and an empty box picks it back up, so that
   * escape means the nearest undoable thing: clear what I typed, and only then
   * close the dialog. Done here rather than on focus because an empty box that
   * merely *has* the caret has nothing to lose, and swallowing escape for it
   * would cost the one keyboard way out of Settings for no gain.
   */
  const type = (value: string) => {
    setQuery(value);
    onEditing(value.trim().length > 0);
  };

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const entries = catalog?.entries ?? [];
  const hits = new Map<StyleKind, number>(
    SHELVES.map(([k]) => [k, entries.filter((e) => e.kind === k && matches(e, words)).length]),
  );
  const shelf = SHELVES.find(([k]) => k === kind) ?? SHELVES[0]!;
  const rows = entries.filter((e) => e.kind === kind && matches(e, words));
  const elsewhere = SHELVES.filter(([k]) => k !== kind && (hits.get(k) ?? 0) > 0);

  const installed = new Map(styles.installed.map((r) => [`${r.kind}/${r.id}`, r]));
  const updates = entries.filter((e) => e.update).length;

  return (
    <div className="set-page">
      <section className="set-section">
        <div className="set-row set-row-split">
          <p className="set-note set-note-flush">
            From <span className="set-mono">kururu-styles</span>. Picking one downloads it to{" "}
            <span className="set-mono">{catalog?.home ?? "~/.config/kururu/styles"}</span> and puts
            it on.
          </p>
          <button className="button button-quiet style-refresh" onClick={() => load(true)} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Check for updates"}
          </button>
        </div>

        {catalog?.stale && (
          <p className="set-warn">
            {catalog.error ?? "Could not reach the registry"}
            {entries.length > 0
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

      <section className="set-section">
        <div className="style-bar">
          <div className="style-shelves" role="tablist" aria-label="Kinds of style">
            {SHELVES.map(([k, title]) => (
              <button
                key={k}
                role="tab"
                aria-selected={kind === k}
                className={`style-shelf ${kind === k ? "style-shelf-on" : ""}`}
                onClick={() => setKind(k)}
              >
                {title}
                {/* The count is the whole answer to "is what I typed somewhere
                    else", so it is drawn whether or not there is a query — a
                    number that appears only while filtering is a number nobody
                    learns to read. */}
                <span className="style-shelf-n">{hits.get(k) ?? 0}</span>
              </button>
            ))}
          </div>
          <input
            className="style-find"
            type="search"
            value={query}
            placeholder="Find a style…"
            aria-label="Find a style"
            onChange={(event) => type(event.target.value)}
            /* Escape is the way out of the filter before it is the way out of
               Settings, which is what somebody with a full box means by it. The
               box empties itself and hands the keyboard back, so a second
               escape closes the dialog the way it always did. */
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !query) return;
              event.stopPropagation();
              type("");
            }}
          />
        </div>
        <p className="set-note set-note-under">{shelf[2]}</p>

        {rows.length > 0 && (
          <div className="style-list">
            {rows.map((entry) => (
              <StyleRow
                key={entry.id}
                entry={entry}
                have={installed.has(`${entry.kind}/${entry.id}`)}
                volume={volume}
                working={working[`${entry.kind}/${entry.id}`] ?? null}
                problem={problems[`${entry.kind}/${entry.id}`] ?? null}
                onPick={() => void act("install", entry)}
                onWear={() => void act("wear", entry)}
                onUpdate={() => void act("update", entry)}
                onRemove={() => void act("remove", entry)}
              />
            ))}
          </div>
        )}

        {catalog !== null && rows.length === 0 && (
          <p className="set-note">
            {words.length === 0 ? (
              `The registry is not offering any ${shelf[1].toLowerCase()} yet.`
            ) : (
              <>
                No {shelf[1].toLowerCase()} match that.
                {elsewhere.length > 0 && (
                  <>
                    {" It is under "}
                    {elsewhere.map(([k, title], i) => (
                      <span key={k}>
                        {i > 0 && (i === elsewhere.length - 1 ? " and " : ", ")}
                        <button className="style-jump" onClick={() => setKind(k)}>
                          {title.toLowerCase()}
                        </button>
                      </span>
                    ))}
                    .
                  </>
                )}
              </>
            )}
          </p>
        )}
      </section>

      {catalog === null && !failed && <p className="set-note">Asking the registry…</p>}
    </div>
  );
}

/**
 * What a row can be in the middle of. `update` is an install that keeps what you
 * are wearing; `wear` is the other half of that sentence — a style already here,
 * put back on, with nothing downloaded.
 */
type Job = "install" | "update" | "remove" | "wear";

const DOING: Record<Job, string> = {
  install: "Installing…",
  update: "Updating…",
  remove: "Removing…",
  wear: "Putting it on…",
};

function StyleRow({
  entry,
  have,
  volume,
  working,
  problem,
  onPick,
  onUpdate,
  onWear,
  onRemove,
}: {
  entry: CatalogEntry;
  have: boolean;
  volume: number;
  working: Job | null;
  problem: string | null;
  onPick: () => void;
  onUpdate: () => void;
  onWear: () => void;
  onRemove: () => void;
}) {
  return (
    <div className={`style-row ${have ? "style-row-have" : ""} ${working ? "style-row-working" : ""}`}>
      <StylePreviewCard entry={entry} volume={volume} />
      <div className="style-text">
        <span className="style-name">
          {entry.name}
          <span className="style-version">{entry.version}</span>
        </span>
        <span className="style-desc">{entry.description}</span>
        <span className="style-meta">
          {entry.author} · {entry.licence}
          {/* The face a pack asks for, set in that face — which makes this the
              one thing on the row that says something the registry cannot:
              whether this machine *has* it. A machine that has not falls back
              to the row's own type, and the honest reading of that is the true
              one, because wearing the pack would not change the font either. */}
          {typeof entry.preview.font === "string" && entry.preview.font && (
            <>
              {" · in "}
              <span style={{ fontFamily: `"${entry.preview.font}", inherit` }}>{entry.preview.font}</span>
            </>
          )}
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
        {/* What went wrong sits on the row it went wrong on, beside the button
            that tries again — a banner at the top of a long list is a message
            about nothing in particular. */}
        {problem && !working && (
          <span className="style-state style-state-bad" role="alert" title={problem}>
            {problem}
          </span>
        )}
        {working ? (
          <span className="style-state style-state-working" aria-live="polite">
            {DOING[working]}
          </span>
        ) : !have ? (
          <button className="button style-button" onClick={onPick}>
            {entry.kind === "pack" ? "Use pack" : "Use"}
          </button>
        ) : (
          <>
            {entry.update && (
              <button
                className="button style-button"
                onClick={onUpdate}
                title={`Installed ${entry.installedVersion}`}
              >
                Update to {entry.version}
              </button>
            )}
            {/* The row used to say "Installed" here and stop, which is the state
                and not an offer — and a pack is five decisions, so the thing
                you want from it most is the second time: put it back on after
                you have changed the skin and want the rest of it again. The
                word is still on the row, as the row's own colour. */}
            <button
              className="button button-quiet style-button"
              onClick={onWear}
              title={`Installed ${entry.installedVersion ?? entry.version} — put it back on`}
            >
              {entry.kind === "pack" ? "Use pack" : "Use"}
            </button>
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
 * A shape per kind, because the kinds are genuinely different questions, and the
 * two that matter most are already solved next door: a theme card is
 * `ThemeOption`'s argument and a skin card is `SkinOption`'s, each built from
 * the `preview` block rather than from a manifest nobody has downloaded. They
 * are not *shared* with those components because the ones on the Appearance tab
 * draw a `Theme` and a `Skin`, which is what you have once it is installed, and
 * a preview is deliberately less than that — making them common would mean
 * inventing a half-theme for the sake of one card.
 */
function StylePreviewCard({ entry, volume }: { entry: CatalogEntry; volume: number }) {
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
    /**
     * A skin made of pictures cannot be previewed from numbers — its whole
     * content is the pictures — so the registry carries the name of a
     * screenshot the author put beside them, proxied the way a mascot's sheet
     * is. One without a screenshot falls through to the card drawn from its
     * tokens, which is honest about what it can show.
     */
    if (typeof p.shot === "string") {
      return (
        <span className="style-shot style-shot-picture" aria-hidden>
          <img
            src={`/api/styles/preview?kind=skin&id=${encodeURIComponent(entry.id)}&file=${encodeURIComponent(p.shot)}`}
            alt=""
          />
        </span>
      );
    }
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

  if (entry.kind === "sound") {
    /**
     * The one card that is a control rather than a picture, and the one that is
     * not `aria-hidden` — every other preview restates something the row says in
     * words beside it, and this one is the only way to know what the entry *is*.
     *
     * It plays the registry's copy rather than an installed one, which is the
     * whole point: the question a shop answers is what something sounds like
     * before you have it. A sound you already have plays from the same URL, so
     * the button does not change meaning the moment the row does.
     */
    const file = typeof p.file === "string" ? p.file : null;
    return (
      <button
        type="button"
        className="style-shot style-shot-sound"
        title={`Play ${entry.name}`}
        aria-label={`Play ${entry.name}`}
        disabled={!file}
        onClick={() => {
          if (!file) return;
          void playUrl(
            `/api/styles/preview?kind=sound&id=${encodeURIComponent(entry.id)}&file=${encodeURIComponent(file)}`,
            volume,
          );
        }}
      >
        <Icon name="play" />
      </button>
    );
  }

  return (
    <span className="style-shot style-shot-pack" aria-hidden>
      {[p.theme, p.skin, p.mascot, p.sound].filter((x): x is string => typeof x === "string").map((id) => (
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
