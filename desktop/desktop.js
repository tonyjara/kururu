/**
 * What the desktop app itself was told, as opposed to what a server was.
 *
 * Nearly every setting in kururu belongs to the server, because the phone has
 * to see it too. The handful here are the exceptions, and each is the
 * exception for the same reason: it is about *this Mac* and this app, and a
 * page served from a box in a cupboard has no business deciding it. Where the
 * server runs from. Whether a key hook is listening to every application on
 * this machine. Where a floating window was last left on this screen.
 *
 * Beside `servers.json`, in XDG's config directory and for its reason: these
 * are decisions, and a decision wiped between versions is somebody's checkout
 * path gone. Read per call rather than cached, so an isolated instance can
 * move it with `XDG_CONFIG_HOME` and a test can read back what it wrote.
 */
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");

const FILE = "desktop.json";

/** Which kururu the runner starts: the one inside this app, or a checkout somebody points it at. */
const SOURCES = ["app", "checkout"];

const DEFAULTS = {
  source: "app",
  /** An absolute path to a kururu checkout, or null. Only read when `source` is `checkout`. */
  checkout: null,
  /** The talk key is heard in every application, through the native hook. */
  talkKeyEverywhere: false,
  /** ⌥Space toggles the microphone, through a global shortcut that needs no permission. */
  altSpace: false,
  /** Where the floating pill was left, in screen points, or null for its own spot. */
  pill: null,
  /** The talk key the pill last reported, so the hook starts on it before a server has said. */
  talkKey: "ControlRight",
};

function configDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "kururu");
}

function file() {
  return path.join(configDir(), FILE);
}

/** Whatever is saved, with every field present and every value checked. A file that cannot be read is the defaults. */
function readDesktop() {
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(file(), "utf8"));
  } catch {
    return { ...DEFAULTS };
  }
  return adopt(raw);
}

/** Fields off the disk are read as if off the wire: a wrong type is the default, never a throw. */
function adopt(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const checkout = typeof r.checkout === "string" && path.isAbsolute(r.checkout) ? r.checkout : null;
  const pill =
    r.pill && typeof r.pill === "object" && Number.isFinite(r.pill.x) && Number.isFinite(r.pill.y)
      ? { x: Math.round(r.pill.x), y: Math.round(r.pill.y) }
      : null;
  return {
    source: SOURCES.includes(r.source) && (r.source !== "checkout" || checkout) ? r.source : "app",
    checkout,
    talkKeyEverywhere: r.talkKeyEverywhere === true,
    altSpace: r.altSpace === true,
    pill,
    talkKey: typeof r.talkKey === "string" && /^[A-Za-z0-9]{1,32}$/.test(r.talkKey) ? r.talkKey : DEFAULTS.talkKey,
  };
}

/** Merge a change in and write the whole file back, atomically, as `servers.js` does. */
function writeDesktop(patch) {
  const next = adopt({ ...readDesktop(), ...patch });
  try {
    mkdirSync(configDir(), { recursive: true });
    const temp = `${file()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(temp, file());
  } catch {
    // The change is live in this process; the next launch is what forgets it.
  }
  return next;
}

module.exports = { DEFAULTS, adopt, readDesktop, writeDesktop, desktopFile: file };
