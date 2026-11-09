/**
 * The settings a person changes from a window, saved and told to every
 * client: the terminal's type and the bar, the mascots, the notifications,
 * the launchers, a project's settings.
 *
 * Each read happens once, at start, in `context.ts`; this is the other half,
 * where a verb writes the file and assigns what the snapshot carries
 * (`provide`). `appearance.ts` and its siblings stay persistence only.
 */
import type { LaunchSettings } from "../../shared/launchers";
import type { MascotSet } from "../../shared/model";
import type { NotifySettings } from "../../shared/notify";
import { adoptProject } from "../../shared/projects";
import type { Appearance } from "../../shared/theme";
import { writeAppearance } from "./appearance";
import { projects, provide, pushSnapshot, state } from "./context";
import { writeLaunch } from "./launch";
import { writeMascots } from "./mascot";
import { writeNotify } from "./notify";
import { withProject, writeProjects } from "./projects";

/**
 * Every appearance change is the same two steps the mascot's are — write it
 * down, then tell every client — and the snapshot is the answer, exactly as it
 * is to a split. Nothing here restarts, reloads or repaints anything: the
 * window redraws because the snapshot it is rendering changed, which is what
 * makes a font size picked on the desktop land on the phone without either of
 * them knowing about the other.
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
