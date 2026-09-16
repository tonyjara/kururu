/**
 * When to interrupt somebody, as they left it.
 *
 * Nothing but persistence lives here, which is `keys.ts`'s shape and `keys.ts`'s
 * reason: the settings type, the adopting, the gate and the words a notification
 * uses are all in `shared/notify.ts`, because the client needs the type and the
 * policy has to be spelt once. What this module knows is the filename.
 *
 * `~/.config/kururu/notify.json`, beside the keyboard rather than inside
 * `appearance.json` — a keyboard is not a look, and neither is this. Nor is it
 * the *state* directory: a state directory wiped between versions is an
 * inconvenience, and a config one wiped is somebody's decision to be left alone
 * at midnight.
 *
 * Server-owned rather than per device, which is the one arguable call in the
 * feature and goes the way every other decision in kururu goes — the theme, the
 * keymap, the mascot. Picking the croak on the desktop should be picking it on
 * the phone, for the reason a theme picked on one is worn on the other: two
 * clients of one server are one application. What genuinely *is* per device
 * stays per device and is not in this file at all — whether the browser will
 * show a notification is its own permission, and whether a terminal is on screen
 * is answered per client by the gate.
 *
 * Re-read at start rather than watched, which is also how a hand edit takes
 * effect — and restarting the server costs a reconnect and no agents.
 */
import { adoptNotify, type NotifySettings } from "../../shared/notify";
import { readConfigFile, writeConfigFile } from "./config";

const FILE = "notify.json";

export function readNotify(): NotifySettings {
  return adoptNotify(readConfigFile(FILE));
}

export function writeNotify(settings: NotifySettings): void {
  writeConfigFile(FILE, settings);
}
