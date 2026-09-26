/**
 * What each repository has been told about itself, as it was left.
 *
 * Persistence only, on `launch.ts`'s shape: the type, the defaults and the
 * adopting live in `shared/projects.ts` because the Settings page draws the same
 * map. `~/.config/kururu/projects.json`, re-read at start. An entry that is all
 * defaults is left out of the file rather than written, so the file lists the
 * repositories somebody has actually decided something about.
 */
import { adoptProjects, isDefaultProject, type ProjectSettings, type ProjectSettingsMap } from "../../shared/projects";
import { readConfigFile, writeConfigFile } from "./config";

const FILE = "projects.json";

export function readProjects(): ProjectSettingsMap {
  return adoptProjects(readConfigFile(FILE));
}

export function writeProjects(map: ProjectSettingsMap): void {
  writeConfigFile(FILE, map);
}

/** The map with one repository's settings changed, or its entry gone when they are the defaults. */
export function withProject(map: ProjectSettingsMap, root: string, settings: ProjectSettings): ProjectSettingsMap {
  const { [root]: _was, ...rest } = map;
  return isDefaultProject(settings) ? rest : { ...rest, [root]: settings };
}
