/**
 * What the keyboard can do, by name — and which key does it.
 *
 * This table used to live in `web/src/keys.ts`, beside the browser event
 * handling, which was right while the map was a constant. It stopped being one:
 * a key you can rebind is a key the *server* has to store and validate, and
 * validating an action name means checking it against the list — the same rule
 * as a sheet name and a workspace colour, and for the same reason, since a
 * rebinding arrives from a client and kururu is reachable from the tailnet. So
 * the table moved here, where both halves can see it, and `web/src/keys.ts` kept
 * the half that needs a `KeyboardEvent`.
 *
 * What is stored is the **difference from the defaults**, not the whole map. A
 * saved map would freeze kururu's keys at the version you first opened Settings
 * in: an action added later would be unbound forever, for everybody who had ever
 * touched a binding. An override list cannot rot that way — a new default
 * appears on its own unless you had already taken that key for something else.
 * Which is why an override may be `null`: "this default is off" is a thing
 * somebody can mean, and nothing else could express it.
 *
 * The defaults are still ghosttown's, key for key. Rebinding them is a user's
 * business; shipping something different is not.
 */

export type Action =
  | "split-right"
  | "split-down"
  | "new-tab"
  | "next-tab"
  | "prev-tab"
  | "close-tab"
  | "rename-tab"
  | "close-pane"
  | "focus-left"
  | "focus-right"
  | "focus-up"
  | "focus-down"
  | "toggle-sidebar"
  | "zen-mode"
  | "resize-mode"
  | "switch-profile"
  | "new-profile"
  | "new-workspace"
  | "next-workspace"
  | "prev-workspace"
  | "last-workspace"
  | "rename-workspace"
  | "delete-workspace"
  | "find-workspace"
  | "find-agent"
  | "open-reader"
  | "settings"
  | "reload"
  | "restart-server"
  | "help";

/** The sections Settings and the help overlay print, in the order they print them. */
export type ActionGroup = "terminals" | "panes" | "workspaces" | "profiles" | "window";

export const ACTION_GROUPS: ReadonlyArray<readonly [ActionGroup, string]> = [
  ["terminals", "Terminals"],
  ["panes", "Panes"],
  ["workspaces", "Workspaces"],
  ["profiles", "Profiles"],
  ["window", "The window"],
];

/**
 * What each action is called where a person reads it.
 *
 * One sentence fragment, lowercase, and the destructive ones say what they end —
 * this text is the whole of what the help overlay and the rebinding list have to
 * go on, and "close tab" and "close tab (ends it)" are not the same promise.
 */
export const ACTION_INFO: Record<Action, { label: string; group: ActionGroup }> = {
  "new-tab": { label: "new terminal", group: "terminals" },
  "next-tab": { label: "next tab", group: "terminals" },
  "prev-tab": { label: "previous tab", group: "terminals" },
  "close-tab": { label: "close tab (ends it)", group: "terminals" },
  "rename-tab": { label: "rename tab", group: "terminals" },
  "find-agent": { label: "find an agent", group: "terminals" },

  "split-right": { label: "split right", group: "panes" },
  "split-down": { label: "split down", group: "panes" },
  "close-pane": { label: "close pane and everything in it", group: "panes" },
  "focus-left": { label: "focus the pane to the left", group: "panes" },
  "focus-down": { label: "focus the pane below", group: "panes" },
  "focus-up": { label: "focus the pane above", group: "panes" },
  "focus-right": { label: "focus the pane to the right", group: "panes" },
  "resize-mode": { label: "resize mode — then h j k l, esc to leave", group: "panes" },

  "new-workspace": { label: "new workspace", group: "workspaces" },
  "next-workspace": { label: "next workspace", group: "workspaces" },
  "prev-workspace": { label: "previous workspace", group: "workspaces" },
  "last-workspace": { label: "last workspace (a toggle)", group: "workspaces" },
  "rename-workspace": { label: "rename workspace", group: "workspaces" },
  "delete-workspace": { label: "delete workspace (ends what is in it)", group: "workspaces" },
  "find-workspace": { label: "find a workspace", group: "workspaces" },

  // The id is what a saved override points at, so it keeps the name it was
  // bound under even though the page it opens now does more than switch. The
  // label is what the help overlay prints, and that has to be true today.
  "switch-profile": { label: "profiles: switch, rename, accounts", group: "profiles" },
  "new-profile": { label: "new profile", group: "profiles" },

  "open-reader": { label: "read the markdown open next door", group: "panes" },

  "toggle-sidebar": { label: "toggle the sidebar", group: "window" },
  "zen-mode": { label: "zen mode", group: "window" },
  settings: { label: "settings", group: "window" },
  reload: { label: "reload the window", group: "window" },
  "restart-server": { label: "restart the server (agents keep running)", group: "window" },
  help: { label: "the help overlay", group: "window" },
};

export const ACTIONS = Object.keys(ACTION_INFO) as Action[];

export function isAction(value: unknown): value is Action {
  return typeof value === "string" && Object.hasOwn(ACTION_INFO, value);
}

/**
 * Key → action. An uppercase letter means shift, exactly as in ghosttown's
 * config, and the destructive ones are shifted for exactly that reason.
 *
 * `]` and `[` are the one deliberate addition: they split right and down beside
 * the shifted `|` and `-` they sit under on the keyboard, which is the pair of
 * splits without the reach for shift. They are safe to add precisely because
 * ghosttown leaves them unbound.
 */
export const DEFAULT_KEYMAP: Record<string, Action> = {
  // Ghosttown's key for its markdown reader, and the first of the ones kururu
  // left unbound to be claimed back — it was unbound because there was nothing
  // here that it meant, not because the key was spoken for.
  M: "open-reader",
  "|": "split-right",
  "\\": "split-right",
  "%": "split-right",
  "]": "split-right",
  "-": "split-down",
  '"': "split-down",
  "[": "split-down",
  T: "new-tab",
  n: "next-tab",
  p: "prev-tab",
  D: "close-tab",
  ",": "rename-tab",
  x: "close-pane",
  h: "focus-left",
  left: "focus-left",
  l: "focus-right",
  right: "focus-right",
  k: "focus-up",
  up: "focus-up",
  j: "focus-down",
  down: "focus-down",
  b: "toggle-sidebar",
  m: "zen-mode",
  r: "resize-mode",
  s: "switch-profile",
  S: "new-profile",
  C: "new-workspace",
  N: "next-workspace",
  P: "prev-workspace",
  z: "last-workspace",
  W: "rename-workspace",
  X: "delete-workspace",
  w: "find-workspace",
  a: "find-agent",
  g: "settings",
  R: "reload",
  B: "restart-server",
  "?": "help",
};

/**
 * What somebody changed, and nothing else. `null` is a default switched off —
 * see the note at the top of the file for why that has to be sayable.
 */
export type KeyOverrides = Record<string, Action | null>;

/**
 * The keys that arrive under a name rather than as themselves. Escape is
 * deliberately not among them: it is how you get out of the capture box in
 * Settings, so binding it would make the binding unreachable by the only gesture
 * that could unbind it.
 */
const NAMED_KEYS = new Set(["left", "right", "up", "down", "enter", "backspace", "tab", "space"]);

/**
 * Whether a key may carry a binding at all.
 *
 * `1`–`9` are refused: they jump to a workspace by number, which is not in the
 * table because it is nine bindings to one parameterised action, and a key bound
 * here would win the lookup and take a workspace out of reach with nothing in
 * the UI to explain where it went. Everything else printable is fair game.
 */
export function isBindableKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (NAMED_KEYS.has(value)) return true;
  if ([...value].length !== 1) return false;
  if (/^[1-9]$/.test(value)) return false;
  const code = value.codePointAt(0) ?? 0;
  return code > 0x20 && code !== 0x7f;
}

/**
 * Read a set of overrides out of whatever arrived — a client message, or a file
 * written by a version of kururu that has since renamed an action.
 *
 * Anything unrecognised is dropped rather than kept: an override naming an
 * action that no longer exists is a key that does nothing, and a key that does
 * nothing is indistinguishable from a broken one. Unlike a mascot's numbers
 * there is nothing to clamp towards — a key name is a name.
 */
export function adoptKeys(value: unknown): KeyOverrides {
  const out: KeyOverrides = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, action] of Object.entries(value as Record<string, unknown>)) {
    if (!isBindableKey(key)) continue;
    if (action === null) out[key] = null;
    else if (isAction(action)) out[key] = action;
  }
  return out;
}

/** The map the prefix is actually looked up in: the defaults, as amended. */
export function keymapFrom(overrides: KeyOverrides): Record<string, Action> {
  const map: Record<string, Action> = { ...DEFAULT_KEYMAP };
  for (const [key, action] of Object.entries(overrides)) {
    if (action === null) delete map[key];
    else map[key] = action;
  }
  return map;
}

/**
 * One key, rebound — or unbound, with `null`.
 *
 * An override that agrees with the default is deleted rather than stored, which
 * is what keeps the file a list of differences and what makes "put it back"
 * produce a file identical to never having touched it. There is no separate
 * unbind path: taking a key for one action takes it from whatever had it,
 * because a key means one thing and an action may have several.
 */
export function bindKey(overrides: KeyOverrides, key: string, action: Action | null): KeyOverrides {
  if (!isBindableKey(key)) return overrides;
  if (action !== null && !isAction(action)) return overrides;
  const next = { ...overrides };
  if ((DEFAULT_KEYMAP[key] ?? null) === action) delete next[key];
  else next[key] = action;
  return next;
}

/** Every key currently doing something, per action. Inverted for the two lists that print it. */
export function keysByAction(keymap: Record<string, Action>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, action] of Object.entries(keymap)) (out[action] ??= []).push(key);
  return out;
}
