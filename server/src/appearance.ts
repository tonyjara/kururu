/**
 * How kururu looks, as the user left it.
 *
 * Nothing but persistence lives here, which is `keys.ts`'s shape and for
 * `keys.ts`'s reason: the themes, the tokens and the adopting are all in
 * `shared/theme.ts`, because the client needs every one of them too and a second
 * copy of a palette is a palette that disagrees with itself. What this module
 * knows is the filename.
 *
 * `~/.config/kururu/appearance.json` — the config directory rather than the
 * state one, on `config.ts`'s reasoning: a state directory wiped between
 * versions is an inconvenience, and kururu can no more invent which theme you
 * like than it can invent your keyboard. It holds a theme *id* and the terminal
 * settings, never a palette, so a flavour restyled in a later version restyles
 * rather than being frozen at whatever it looked like the day you picked it.
 *
 * Re-read at start rather than watched, which is also how a hand edit takes
 * effect — and restarting the server costs a reconnect and no agents, which is
 * what makes that a reasonable thing to tell somebody to do.
 */
import { adoptAppearance, type Appearance } from "../../shared/theme";
import { readConfigFile, writeConfigFile } from "./config";

const FILE = "appearance.json";

export function readAppearance(): Appearance {
  return adoptAppearance(readConfigFile(FILE));
}

export function writeAppearance(appearance: Appearance): void {
  writeConfigFile(FILE, appearance);
}
