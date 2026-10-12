/**
 * Settings → Appearance → Explore: what `../kururu-styles` is offering, and
 * what of it this machine has.
 *
 * **Picking is installing, and that is the whole gesture.** Clicking Use
 * downloads a style and puts it on, because nobody installs a theme they have
 * just chosen and then thinks about whether to wear it. Update is deliberately
 * not the same button: updating a style you are not wearing is not a request
 * to start wearing it, so the row sends `activate=1` for a pick and not for an
 * update.
 *
 * One shelf at a time, because the registry only grows, and every pill
 * carries its count under the current filter so a hit on another shelf is
 * never hidden behind the one you are on. The filter is substring, every word
 * in any order, for `Dialog.tsx`'s reason: a match has to be explicable.
 *
 * A theme is drawn in its colours, a skin in its shape, a mascot moving, a
 * sound as a button that plays it — a row of names is a list you would have
 * to install from to find out what you were installing. All of it comes
 * through the server: the browser never talks to GitHub.
 *
 * This holds the catalogue and nothing else. What is installed comes from the
 * snapshot, like everything else in the window.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MascotClip, MascotConfig } from "../../../shared/model";
import { BASE_ICONS } from "../../../shared/skin";
import type { StyleKind, StyleLibrary, StylePreview } from "../../../shared/styles";
import { Icon } from "../components/Icon";
import { Mascot } from "../components/Status";
import { playUrl } from "../notify";
import { A, Action, Banner, Btn, Empty, Group, IconBtn, Item, Mono, Outcome, SearchBox, Segments, Toolbar, useEditing } from "./ui";

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

/** The shelves, in order: two axes, then the fun, then the shortcuts. */
const SHELVES: ReadonlyArray<readonly [StyleKind, string, string]> = [
  ["theme", "Themes", "what colour the window and its terminals are"],
  ["skin", "Skins", "what shape it is: radii, line weights, the type ramp"],
  ["mascot", "Mascots", "what moves in the sidebar while an agent is working"],
  ["sound", "Sounds", "what a notification sounds like"],
  ["pack", "Packs", "one of each, chosen to go together"],
];

/** Over what the row shows plus the id, which is how half the world refers to a style. Never the licence. */
function matches(entry: CatalogEntry, words: string[]): boolean {
  if (words.length === 0) return true;
  const hay = `${entry.id} ${entry.name} ${entry.description} ${entry.author}`.toLowerCase();
  return words.every((word) => hay.includes(word));
}

type Job = "install" | "update" | "remove" | "wear";

const DOING: Record<Job, string> = {
  install: "Installing…",
  update: "Updating…",
  remove: "Removing…",
  wear: "Putting it on…",
};

export function ExplorePage({ styles, volume }: { styles: StyleLibrary; volume: number }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  /** Keyed by entry, never one value for the page: every row is its own job. */
  const [working, setWorking] = useState<Record<string, Job>>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [kind, setKind] = useState<StyleKind>("theme");
  const [query, setQuery] = useState("");
  const tell = useEditing();

  /**
   * Fetched when the page opens rather than carried in the snapshot: this is
   * the world's state, it changes when somebody merges a pull request in
   * another repository, and nothing in the window needs it but this page.
   */
  const load = useCallback((refresh: boolean) => {
    setFailed(null);
    if (refresh) setRefreshing(true);
    void fetch(`/api/styles/catalog${refresh ? "?refresh=1" : ""}`)
      .then((r) => r.json())
      .then((data: Catalog) => setCatalog(data))
      .catch(() => setFailed("Could not reach this server."))
      .finally(() => setRefreshing(false));
  }, []);
  useEffect(() => load(false), [load]);

  const act = async (job: Job, entry: CatalogEntry) => {
    const key = `${entry.kind}/${entry.id}`;
    if (working[key]) return;
    const path = job === "install" || job === "update" ? "install" : job;
    setWorking((w) => ({ ...w, [key]: job }));
    setProblems(({ [key]: _gone, ...rest }) => rest);
    try {
      const q = `kind=${entry.kind}&id=${encodeURIComponent(entry.id)}${job === "install" ? "&activate=1" : ""}`;
      const res = await fetch(`/api/styles/${path}?${q}`, { method: "POST" });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) setProblems((p) => ({ ...p, [key]: body.error ?? `could not ${path} ${entry.name}` }));
      // The catalogue's idea of what is installed is a copy taken at fetch
      // time; one reload off the cache is cheaper than reconciling two sources.
      else load(false);
    } catch {
      setProblems((p) => ({ ...p, [key]: `could not ${path} ${entry.name}: is the server up?` }));
    } finally {
      setWorking(({ [key]: _done, ...rest }) => rest);
    }
  };

  /**
   * Typing stands the keyboard down and an empty box picks it back up, so that
   * escape means the nearest undoable thing: clear what I typed, then close.
   */
  const held = useRef(false);
  const type = (value: string) => {
    const is = value.trim().length > 0;
    setQuery(value);
    if (held.current !== is) {
      held.current = is;
      tell(is);
    }
  };
  // Leaving the page with a query still in the box would leave the keyboard stood down for a field that is gone.
  useEffect(
    () => () => {
      if (held.current) tell(false);
    },
    [tell],
  );

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const entries = catalog?.entries ?? [];
  const hits = new Map<StyleKind, number>(SHELVES.map(([k]) => [k, entries.filter((e) => e.kind === k && matches(e, words)).length]));
  const shelf = SHELVES.find(([k]) => k === kind) ?? SHELVES[0]!;
  const rows = entries.filter((e) => e.kind === kind && matches(e, words));
  const elsewhere = SHELVES.filter(([k]) => k !== kind && (hits.get(k) ?? 0) > 0);
  const installed = new Map(styles.installed.map((r) => [`${r.kind}/${r.id}`, r]));
  const updates = entries.filter((e) => e.update).length;

  return (
    <>
      {catalog?.stale && (
        <Banner>
          {catalog.error ?? "Could not reach the registry."} {entries.length > 0 ? "Showing the last list this machine saw." : "Nothing to show until it answers."}
        </Banner>
      )}
      {failed && <Banner tone="bad">{failed}</Banner>}

      <Group>
        <Action
          label="Registry"
          hint={
            <>
              From <Mono>kururu-styles</Mono>. Picking one downloads it to <Mono>{catalog?.home ?? "~/.config/kururu/styles"}</Mono> and puts it on.
            </>
          }
          button="Check for updates"
          busy={refreshing}
          busyLabel="Checking…"
          onClick={() => load(true)}
          outcome={catalog && !refreshing ? { text: updates === 0 ? "Everything installed is current." : updates === 1 ? "One style has a newer version." : `${updates} styles have a newer version.` } : null}
        />
      </Group>

      <Group title={shelf[1]} foot={shelf[2]}>
        <Toolbar>
          <Segments
            value={kind}
            onChange={setKind}
            label="Kind of style"
            options={SHELVES.map(([k, title]) => [k, `${title} ${hits.get(k) ?? 0}`] as const)}
          />
          <SearchBox value={query} onChange={type} placeholder="Find a style…" />
        </Toolbar>

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

        {catalog === null && !failed && <Empty>Asking the registry…</Empty>}
        {catalog !== null && rows.length === 0 && (
          <Empty>
            {words.length === 0 ? (
              `The registry is not offering any ${shelf[1].toLowerCase()} yet.`
            ) : (
              <>
                No {shelf[1].toLowerCase()} match that.
                {elsewhere.length > 0 && (
                  <>
                    {" Under "}
                    {elsewhere.map(([k, title], i) => (
                      <span key={k}>
                        {i > 0 && (i === elsewhere.length - 1 ? " and " : ", ")}
                        <button type="button" className="st-jump" onClick={() => setKind(k)}>
                          {title.toLowerCase()}
                        </button>
                      </span>
                    ))}
                    .
                  </>
                )}
              </>
            )}
          </Empty>
        )}
      </Group>
    </>
  );
}

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
  const meta = (
    <>
      {entry.description}
      <span className="st-item-meta">
        {entry.author} · {entry.licence}
        {/* The face a pack asks for, set in that face: whether this machine
            *has* it is the one thing the registry cannot say, and a machine
            that has not falls back to the row's own type, which is the true
            reading. */}
        {typeof entry.preview.font === "string" && entry.preview.font && (
          <>
            {" · in "}
            <span style={{ fontFamily: `"${entry.preview.font}", inherit` }}>{entry.preview.font}</span>
          </>
        )}
        {entry.homepage && (
          <>
            {" · "}
            <A href={entry.homepage}>home</A>
          </>
        )}
        {entry.source && (
          <>
            {" · "}
            <A href={entry.source}>source</A>
          </>
        )}
      </span>
      {problem && !working && <Outcome bad>{problem}</Outcome>}
    </>
  );
  return (
    <Item
      lead={<Shot entry={entry} volume={volume} />}
      name={
        <>
          {entry.name} <span className="st-version">{entry.version}</span>
        </>
      }
      sub={meta}
      on={have}
      className={working ? "st-item-busy" : undefined}
    >
      {working ? (
        <span className="st-busy" aria-live="polite">
          {DOING[working]}
        </span>
      ) : !have ? (
        <Btn primary onClick={onPick}>
          Use
        </Btn>
      ) : (
        <>
          {entry.update && (
            <Btn primary onClick={onUpdate} title={`Installed ${entry.installedVersion}`}>
              Update to {entry.version}
            </Btn>
          )}
          <Btn onClick={onWear} title={`Installed ${entry.installedVersion ?? entry.version}: put it back on`}>
            Use
          </Btn>
          <IconBtn icon="close" label={`Remove ${entry.name}`} danger onClick={onRemove} />
        </>
      )}
    </Item>
  );
}

/**
 * The entry, drawn as itself. A shape per kind: a theme card is the Theme
 * page's argument and a skin card the skin's, each built from the `preview`
 * block rather than a manifest nobody has downloaded. Not shared with those
 * cards because a preview is deliberately less than an installed style.
 */
function Shot({ entry, volume }: { entry: CatalogEntry; volume: number }) {
  const p = entry.preview;
  const str = (name: string, fallback = "") => (typeof p[name] === "string" ? (p[name] as string) : fallback);

  if (entry.kind === "theme") {
    return (
      <span className="st-shot st-shot-theme" style={{ background: str("bg", "var(--bg)"), borderColor: str("line", "var(--line)") }} aria-hidden>
        <span className="st-shot-chrome" style={{ background: str("chrome", "var(--chrome)") }} />
        <span className="st-shot-dots">
          {["accent", "working", "blocked", "done"].map((name) => (
            <span key={name} className="st-shot-dot" style={{ background: str(name, "var(--dim)") }} />
          ))}
        </span>
      </span>
    );
  }

  if (entry.kind === "skin") {
    if (typeof p.shot === "string") {
      return (
        <span className="st-shot st-shot-picture" aria-hidden>
          <img src={`/api/styles/preview?kind=skin&id=${encodeURIComponent(entry.id)}&file=${encodeURIComponent(p.shot)}`} alt="" />
        </span>
      );
    }
    return (
      <span
        className="st-shot st-shot-skin"
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
      <span className="st-shot st-shot-mascot" aria-hidden>
        {/* The badge is its own square inside the box: `Mascot` draws a whole
            strip of cells and relies on its parent being one cell wide. */}
        <span className="st-shot-cell">
          <Mascot config={config} clip={config.working} src={`/api/styles/preview?kind=mascot&id=${encodeURIComponent(entry.id)}`} />
        </span>
      </span>
    );
  }

  if (entry.kind === "sound") {
    /**
     * The one card that is a control: a sound cannot be drawn, and the button
     * plays the registry's copy because the question a shop answers is what
     * something sounds like before you have it.
     */
    const file = typeof p.file === "string" ? p.file : null;
    return (
      <button
        type="button"
        className="st-shot st-shot-sound"
        title={`Play ${entry.name}`}
        aria-label={`Play ${entry.name}`}
        disabled={!file}
        onClick={() => {
          if (!file) return;
          void playUrl(`/api/styles/preview?kind=sound&id=${encodeURIComponent(entry.id)}&file=${encodeURIComponent(file)}`, volume);
        }}
      >
        <Icon name="play" />
      </button>
    );
  }

  return (
    <span className="st-shot st-shot-pack" aria-hidden>
      {[p.theme, p.skin, p.mascot, p.sound]
        .filter((x): x is string => typeof x === "string")
        .map((id) => (
          <span key={id} className="st-shot-part">
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
