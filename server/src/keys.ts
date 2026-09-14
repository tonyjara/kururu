/**
 * The keyboard, as the user left it.
 *
 * Nothing but persistence lives here: the table, the validation and the merge
 * are all in `shared/keys.ts`, because the client needs every one of them too
 * and a second copy of a keymap is a keymap that disagrees with itself. What
 * this module knows is the filename.
 *
 * `~/.config/kururu/keys.json`, holding the *difference* from the defaults — so
 * the file of somebody who has never rebound anything does not exist, and the
 * file of somebody who has is short enough to read and fix by hand. Re-read at
 * start rather than watched, which is also how a hand edit takes effect.
 */
import { adoptKeys, type KeyOverrides } from "../../shared/keys";
import { readConfigFile, writeConfigFile } from "./config";

const FILE = "keys.json";

export function readKeys(): KeyOverrides {
  return adoptKeys(readConfigFile(FILE));
}

export function writeKeys(overrides: KeyOverrides): void {
  writeConfigFile(FILE, overrides);
}
