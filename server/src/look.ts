/**
 * The settings a person changes from a window, saved and told to every
 * client: the look, the mascots, the notifications, the launchers, a
 * project's settings — and a style installed from the registry and worn.
 *
 * Each read happens once, at start, in `context.ts`; this is the other half,
 * where a verb writes the file and assigns what the snapshot carries
 * (`provide`). `appearance.ts` and its siblings stay persistence only; what is
 * here is the server deciding what a change means — which parts a pack
 * replaces, which a theme leaves alone, and the font a pack brings.
 */
import type { LaunchSettings } from "../../shared/launchers";
import type { MascotSet } from "../../shared/model";
import type { NotifySettings } from "../../shared/notify";
import { adoptProject } from "../../shared/projects";
import { skinFor } from "../../shared/skin";
import {
  type InstalledStyle,
  isBuiltinPack,
  type Look,
  PACK_PARTS,
  type PackManifest,
  type StyleKind,
  wearKururu,
} from "../../shared/styles";
import { type Appearance, themeFor } from "../../shared/theme";
import { writeAppearance } from "./appearance";
import { appearance, mascots, notify, projects, provide, pushSnapshot, state, styles } from "./context";
import { writeLaunch } from "./launch";
import { freshMascotId, writeMascots } from "./mascot";
import { writeNotify } from "./notify";
import { withProject, writeProjects } from "./projects";
import { installedPack, install as installStyle, readLibrary, rememberMascotId } from "./styles";

/**
 * Every appearance change is the same two steps the mascot's are — write it
 * down, then tell every client — and the snapshot is the answer, exactly as it
 * is to a split. Nothing here restarts, reloads or repaints anything: the
 * window redraws because the snapshot it is rendering changed, which is what
 * makes a theme picked on the desktop land on the phone without either of them
 * knowing about the other.
 */
export function saveAppearance(next: Appearance): void {
  provide("appearance", next);
  writeAppearance(next);
  pushSnapshot();
}

/** The same two steps, for the same reason. See `saveAppearance`. */
export function saveNotify(next: NotifySettings): void {
  provide("notify", next);
  writeNotify(next);
  pushSnapshot();
}

/** And again, for the new-tab menu. */
export function saveLaunch(next: LaunchSettings): void {
  provide("launch", next);
  writeLaunch(next);
  pushSnapshot();
}

/**
 * And for one repository. The root is checked against what the server has
 * found for itself — the repositories the active profile's workspaces are in,
 * and the ones already in the file — and anything else is dropped: a settings
 * write is not a way to teach kururu a path.
 */
export function saveProject(root: unknown, raw: unknown): void {
  if (typeof root !== "string") return;
  const known = root in projects || state.projects.some((project) => project.root === root);
  if (!known) return;
  provide("projects", withProject(projects, root, adoptProject(raw)));
  writeProjects(projects);
  pushSnapshot();
}

/**
 * Every mascot change goes through here, because all five of them are the same
 * two steps — write it down, then tell every client — and a verb that forgot the
 * second would leave the window that sent it drawing the badge it had before.
 * The snapshot is the answer to these messages, the way it is to a split.
 */
export function saveMascots(next: MascotSet): void {
  provide("mascots", next);
  writeMascots(next);
  pushSnapshot();
}

/**
 * Fetch a style, put it on disk, and make it the one in use if that is what was
 * meant.
 *
 * The four kinds end in four different places and that asymmetry is real rather
 * than an inconsistency. A theme and a skin are one id in `appearance.json`. A
 * **mascot** is not: it becomes a row in the user's mascot list — the same list
 * Settings edits by dragging cells out of a sheet — because once it is installed
 * there is no useful difference between a mascot from the registry and one
 * somebody cut out by hand, and keeping two kinds would mean every reader
 * downstream learning which it had. A **sound** lands in a fourth place again,
 * `notify.json`, and that is the one worth defending: a noise is not a look, so
 * it does not belong in `appearance.json` — the same sentence `server/src/notify.ts`
 * already makes about why that file exists at all. A **pack** is a handful of
 * ids and nothing else, so installing one is installing what it names; it is
 * stored as a record so that it can be listed and removed, and removing it
 * deliberately leaves its parts alone, because a pack is a *reference* and
 * taking away the recommendation is not taking away the theme.
 */
export async function installOne(kind: string, id: string, activate: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await installStyle(kind, id);
  if (!result.ok) return result;

  if (result.mascot) {
    const { name, config, replaces } = result.mascot;
    const already = replaces ? mascots.list.find((m) => m.id === replaces) : undefined;
    const mascotId = already?.id ?? freshMascotId(mascots.list);
    const one = { id: mascotId, name: name.slice(0, 40), ...config };
    // The default is left alone even when this is being worn: `wear` below is
    // the one place that decides, and it needs the id `rememberMascotId` is
    // about to write down.
    saveMascots({
      default: mascots.default,
      list: already ? mascots.list.map((m) => (m.id === mascotId ? one : m)) : [...mascots.list, one],
    });
    rememberMascotId(result.record.kind, result.record.id, mascotId);
  }

  provide("styles", readLibrary());

  if (result.record.kind === "pack") {
    const pack = (result.manifest ?? {}) as Record<string, unknown>;
    for (const part of PACK_PARTS) {
      const partId = pack[part];
      if (typeof partId !== "string") continue;
      // A part that fails is reported nowhere and that is deliberate: a pack
      // whose skin is temporarily unreachable should still leave you with its
      // theme, its mascot and its sound, which is most of the look. Refusing the
      // lot would make one bad file take three good ones down with it.
      //
      // Never activated on the way past, even when the pack is being worn. What
      // a pack *means* is one answer and `wear` below is where it is given; a
      // part that put itself on here would be a second, arrived at by a
      // different route, and the two would drift the first time a pack learned
      // to name something new. It also saves three writes of `appearance.json`
      // for one click.
      await installOne(part, partId, false);
    }
    provide("styles", readLibrary());
  }

  if (activate) wear(result.record.kind, result.record.id);
  else pushSnapshot();
  return { ok: true };
}

/*
 * `Look` is the three files a style can land in, gathered up so that wearing a
 * pack writes each of them at most once. It lives in `shared/styles.ts` beside
 * `wearKururu`, which builds one.
 *
 * A pack is the reason it exists. Every other style is one decision in one
 * file and `saveAppearance` is the whole story; a pack is up to five — a theme,
 * a skin, a mascot, a sound and a face — spread across `appearance.json`,
 * `mascots.json` and `notify.json`, and doing them one saver at a time would
 * push three snapshots for one click and repaint the window three times on the
 * way to the look somebody asked for. So the parts are folded into a `Look`
 * first and written afterwards.
 */

/**
 * One installed style, folded into a look.
 *
 * The four kinds land in the four places `installOne`'s comment argues for, and
 * the ids are resolved through `themeFor` and `skinFor` for the reason those
 * exist: what is being worn has to be something this version can draw, and the
 * fallback belongs at the moment of wearing rather than in the file.
 *
 * A mascot is the one that can silently decline. It is worn by *its row in the
 * user's list*, not by its registry id — see `installOne` — so a record from
 * before `mascotId` was written down, or one whose row somebody has since
 * deleted in Settings, has nothing to point at. Leaving the current mascot up is
 * the right answer there: the alternative is a badge that goes blank because a
 * pack mentioned a sprite that is not on the machine any more.
 */
function put(look: Look, record: InstalledStyle): Look {
  switch (record.kind) {
    case "theme":
      return { ...look, appearance: { ...look.appearance, themeId: themeFor(record.id, styles.themes).id } };
    case "skin":
      return { ...look, appearance: { ...look.appearance, skinId: skinFor(record.id, styles.skins).id } };
    case "mascot":
      if (!record.mascotId || !look.mascots.list.some((m) => m.id === record.mascotId)) return look;
      return { ...look, mascots: { ...look.mascots, default: record.mascotId } };
    /**
     * Picking the sound, and not also turning notifications on.
     *
     * `enabled` and `events` are a decision about being interrupted and this is
     * a decision about what the interruption sounds like — so a pack worn by
     * somebody who has notifications switched off is a pack whose sound is
     * waiting for them when they switch them back on, rather than a style
     * choice that quietly started interrupting them.
     */
    case "sound":
      return { ...look, notify: { ...look.notify, sound: record.id } };
    default:
      return look;
  }
}

/** Write whichever of the three actually moved, then tell every client once. */
function saveLook(next: Look): void {
  if (next.appearance !== appearance) {
    provide("appearance", next.appearance);
    writeAppearance(next.appearance);
  }
  if (next.mascots !== mascots) {
    provide("mascots", next.mascots);
    writeMascots(next.mascots);
  }
  if (next.notify !== notify) {
    provide("notify", next.notify);
    writeNotify(next.notify);
  }
  pushSnapshot();
}

/**
 * Put on something that is already on the machine.
 *
 * Split out of `installOne` because wearing and installing stopped being the
 * same gesture. They were, for as long as the only way to arrive at a style was
 * to press its row in the registry — and then a pack is five decisions somebody
 * made once, in an order they cannot get back to afterwards: change the skin,
 * try a different mascot, and there is no longer any way to say *put the pack
 * back on* short of removing it and installing it again over the network. So
 * this takes an id and nothing else, touches no network, and is what both the
 * Appearance tab's pack picker and an installed row in the Styles tab call.
 *
 * A pack fans out here rather than in the caller, which is the whole point: what
 * it means to wear one is written down once.
 */
export function wear(kind: StyleKind, id: string): { ok: true } | { ok: false; error: string } {
  // Kururu's own pack first, and ahead of an installed pack that took its id:
  // it is the way back from every other pack, so nothing installed may stand
  // in front of it. Its parts are all built in, which is why it is not folded
  // through `put` — there is no record for any of them to be found by.
  if (kind === "pack" && isBuiltinPack(id)) {
    saveLook(wearKururu({ appearance, mascots, notify }));
    return { ok: true };
  }
  const record = styles.installed.find((r) => r.kind === kind && r.id === id);
  if (!record) return { ok: false, error: "that style is not installed" };
  let look: Look = { appearance, mascots, notify };
  if (kind === "pack") {
    const pack = installedPack(id);
    if (!pack) return { ok: false, error: `${record.name} is installed but its manifest is unreadable` };
    for (const part of PACK_PARTS) {
      const partId = pack[part];
      // A part the pack names but the machine does not have is skipped rather
      // than refused, which is `installOne`'s rule for a part that would not
      // download, arriving at the same conclusion from the other end: most of a
      // pack is most of the look, and nothing here is worth losing the rest of
      // it over.
      const partRecord = partId ? styles.installed.find((r) => r.kind === part && r.id === partId) : undefined;
      if (partRecord) look = put(look, partRecord);
    }
    look = wearFont(look, pack);
  } else {
    look = put(look, record);
  }
  saveLook(look);
  return { ok: true };
}

/**
 * The face a pack asks for, if it asks for one.
 *
 * Kururu installs no fonts and never should — see `adoptPackManifest` — so this
 * writes a *name* into the same field the box in Settings writes, and a machine
 * without that face keeps the one it had. Which is the honest behaviour and not
 * a silent failure: naming a font nobody has is what typing one character wrong
 * into that box already does, and `web/src/fonts.ts` exists because of it.
 *
 * A pack with no `font` leaves the setting alone rather than clearing it. The
 * empty string means "kururu's own stack" and writing it would make wearing a
 * pack quietly undo a font somebody chose for themselves, which is a decision
 * about type that the pack declined to have an opinion about.
 */
function wearFont(look: Look, pack: PackManifest): Look {
  if (!pack.font || pack.font === look.appearance.terminal.fontFamily) return look;
  return {
    ...look,
    appearance: { ...look.appearance, terminal: { ...look.appearance.terminal, fontFamily: pack.font } },
  };
}
