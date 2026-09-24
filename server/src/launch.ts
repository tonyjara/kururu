/**
 * Which agents the new-tab menu offers, as they left it.
 *
 * Persistence only, on `notify.ts`'s shape: the catalogue, the type and the
 * adopting live in `shared/launchers.ts` because the client draws the menu from
 * the same list. `~/.config/kururu/launch.json`, re-read at start.
 */
import { adoptLaunch, type LaunchSettings } from "../../shared/launchers";
import { readConfigFile, writeConfigFile } from "./config";

const FILE = "launch.json";

export function readLaunch(): LaunchSettings {
  return adoptLaunch(readConfigFile(FILE));
}

export function writeLaunch(settings: LaunchSettings): void {
  writeConfigFile(FILE, settings);
}
