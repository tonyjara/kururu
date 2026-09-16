/**
 * Give the dev shell its own identity.
 *
 * `electron .` runs the prebuilt Electron.app straight out of node_modules, so
 * as far as macOS is concerned this app is "Electron", `com.github.Electron` —
 * the same identity every other Electron project on the machine runs under.
 * Anything keying off the bundle id then cannot tell kururu apart from the next
 * dev shell: a window manager pinning it to a workspace grabs both, and the
 * Dock and app switcher show a stock Electron icon with no name on it. So we
 * stamp our own id and name into that copy's Info.plist, and our own frog over
 * the icon it points at.
 *
 * The icon is a *file replacement* rather than anything Electron offers, because
 * the two things that draw it — the Dock tile at launch and the app switcher —
 * read the bundle and not the running process. `app.dock.setIcon` would change
 * the tile a moment after the wrong one had already appeared in it, and would
 * still leave ⌘-tab showing Electron's.
 *
 * The id is deliberately *not* the one a packaged build will carry. A dev shell
 * and an installed kururu should be separately addressable — you want both open
 * at once and treated differently, not merged by whatever is reading the id.
 *
 * This runs from `postinstall` because `bun install` restores the pristine
 * bundle; a one-off by hand would silently come undone on the next install.
 * It only ever touches node_modules, so nothing outside kururu sees it.
 *
 * **Then re-signed, and the reason is notifications.** This file used to say it
 * deliberately did not re-sign, and everything that paragraph argued was true:
 * the prebuilt bundle is *linker-signed* ad-hoc, `codesign -dv` reports
 * `Info.plist=not bound` and `Sealed Resources=none`, so the signature covers the
 * Mach-O and nothing else — which is one sentence about `Resources/electron.icns`
 * and about the plist alike, and why both can be written here. `codesign --verify`
 * failing says nothing either: it fails on the *stock* bundle too ("code has no
 * resources but signature indicates they must be present") while that bundle
 * launches perfectly well. AMFI only cares about the executable, and we do not
 * touch the executable.
 *
 * What all of that answers is *will it launch*, and the answer stayed yes. It is
 * not the only question. macOS's notification service keys authorisation on the
 * **code-signing identifier**, not on `CFBundleIdentifier` — so a bundle stamped
 * `io.github.tonyjara.kururu.dev` whose signature still says `Electron` is an app
 * `usernotificationsd` will not authorise. It does not prompt, it does not
 * appear in System Settings → Notifications, and every notification fails with
 * `UNErrorDomain error 1` (*notifications not allowed*), including ones raised
 * from the main process. That is invisible until something tries to notify,
 * which is exactly how it was found: the sound played and no card ever appeared.
 *
 * So the bundle is re-signed ad-hoc with the id we just stamped, which is one
 * `codesign` call and makes the two identifiers agree. **This changes the rule
 * above rather than sitting beside it**: the re-signed bundle *does* have sealed
 * resources, so from here on editing the plist or the icon without re-signing
 * breaks something real. Which is why signing is last, runs whenever anything was
 * stamped, and runs again whenever the identifier has drifted back — a fresh
 * `bun install` restores the pristine bundle and puts `Electron` back.
 *
 * Changing the bundle id resets anything macOS grants per-identity — Screen
 * Recording, Accessibility, Automation. Expect to re-approve those prompts once.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The frog, generated from the sprite sheet by `bun run icon` and committed.
 * `CFBundleIconFile` in the stock plist already says `electron.icns`, so the
 * icon is changed by replacing what that name points at rather than by pointing
 * it somewhere else — one edit instead of two, and it survives Electron renaming
 * nothing.
 */
const ICON = join(dirname(fileURLToPath(import.meta.url)), "icon", "kururu.icns");

/** What the dev shell should call itself. The packaged app takes `io.github.tonyjara.kururu`. */
const IDENTITY = {
  CFBundleIdentifier: "io.github.tonyjara.kururu.dev",
  CFBundleName: "Kururu (dev)",
  CFBundleDisplayName: "Kururu (dev)",
};

/**
 * A postinstall step that fails fails the install, and an unbranded dev shell
 * is an annoyance, not a broken checkout. Everything below reports and gives up.
 */
function main() {
  if (process.platform !== "darwin") return;

  const plist = infoPlist();
  if (!plist) return;

  // `||` would skip the icon on a run that only changed the identity, so both
  // are evaluated and the results combined afterwards.
  const identity = stampIdentity(plist);
  const icon = stampIcon(plist);
  // Last, because signing now seals what the two above just wrote. The drift
  // check is what covers a `bun install` that restored the pristine bundle and
  // a run of this that has nothing else left to do.
  if (identity || icon || !signedAsUs(plist)) resign(plist);
}

function stampIdentity(plist) {
  // `plutil -convert json` rather than a plist parser: it ships with macOS, and
  // we are already shelling out to its `-replace` to write.
  const current = JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" }),
  );
  const stale = Object.entries(IDENTITY).filter(([key, value]) => current[key] !== value);
  if (stale.length === 0) return false;

  for (const [key, value] of stale) {
    execFileSync("plutil", ["-replace", key, "-string", value, plist]);
  }
  console.log(`branded dev shell as ${IDENTITY.CFBundleName} (${IDENTITY.CFBundleIdentifier})`);
  return true;
}

/**
 * Whether the signature already names us.
 *
 * `spawnSync` rather than `execFileSync`, which is the whole reason this is not
 * a one-liner: `codesign -dv` prints its description to **stderr** and exits 0,
 * and `execFileSync` returns stdout alone — so the obvious spelling reads an
 * empty string, concludes the identifier has drifted, and re-signs 287MB on
 * every install while reporting that it did. Both streams are read here, and
 * both are searched, in case a later codesign moves the line.
 *
 * A bundle it cannot read says nothing useful either, which reads the same as a
 * drifted identifier and takes the same action — so there is nothing to tell
 * apart and no error branch to write.
 */
function signedAsUs(plist) {
  const app = dirname(dirname(plist));
  const done = spawnSync("codesign", ["-dv", app], { encoding: "utf8" });
  const said = `${done.stdout ?? ""}${done.stderr ?? ""}`;
  return said.includes(`Identifier=${IDENTITY.CFBundleIdentifier}`);
}

/**
 * Sign the branded bundle as ourselves, ad-hoc.
 *
 * Ad-hoc (`--sign -`) because there is no developer identity to use and none is
 * needed: the notification service wants the identifier to match the bundle, not
 * a certificate anybody trusts. No `--deep` — the helpers and frameworks keep
 * their own signatures and are validated on their own, `--deep` is deprecated,
 * and re-signing 287MB of nested code on every install to fix the outer bundle's
 * name would be paying a great deal for nothing.
 *
 * A failure here is a dev shell that cannot show a notification, which is the
 * same class of annoyance as an unbranded one: reported, never fatal, on the
 * reasoning at the top of this file.
 */
function resign(plist) {
  const app = dirname(dirname(plist));
  try {
    execFileSync(
      "codesign",
      ["--force", "--sign", "-", "--identifier", IDENTITY.CFBundleIdentifier, app],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (error) {
    console.warn(`dev shell not re-signed, so macOS will refuse its notifications: ${error.message}`);
    return;
  }
  console.log(`signed dev shell as ${IDENTITY.CFBundleIdentifier}, so macOS will allow its notifications`);
}

/**
 * Put the frog where the bundle says its icon is.
 *
 * Compared by bytes rather than copied every time, so a `bun install` that
 * changes nothing says nothing — the same reason the identity above checks
 * before it writes. And the bundle's own timestamp is moved when it does change:
 * macOS caches an app's icon against the .app, and a dev shell that kept showing
 * the last frog after the artwork was regenerated would look exactly like a
 * generator that had not run.
 */
function stampIcon(plist) {
  if (!existsSync(ICON)) {
    console.warn(`skipping dev-shell icon: nothing at ${ICON} — run \`bun run icon\``);
    return false;
  }
  const contents = dirname(plist);
  const target = join(contents, "Resources", iconName(plist));
  if (existsSync(target) && readFileSync(target).equals(readFileSync(ICON))) return false;

  copyFileSync(ICON, target);
  const now = new Date();
  utimesSync(dirname(contents), now, now);
  console.log(`branded dev shell with ${IDENTITY.CFBundleName}'s icon`);
  return true;
}

/** Whatever `CFBundleIconFile` says today, rather than `electron.icns` spelled twice. */
function iconName(plist) {
  const name = execFileSync("plutil", ["-extract", "CFBundleIconFile", "raw", plist], {
    encoding: "utf8",
  }).trim();
  return name.endsWith(".icns") ? name : `${name}.icns`;
}

/**
 * Locate the Info.plist of the Electron.app that `electron .` will actually run.
 * `path.txt` is how the electron package itself resolves that binary, so this
 * follows the same trail rather than guessing at `dist/Electron.app`.
 */
function infoPlist() {
  const require = createRequire(import.meta.url);
  const pkg = dirname(require.resolve("electron/package.json"));
  const pathFile = join(pkg, "path.txt");
  if (!existsSync(pathFile)) {
    console.warn("skipping dev-shell branding: electron is not downloaded yet");
    return null;
  }
  // dist/Electron.app/Contents/MacOS/Electron -> dist/Electron.app
  const exe = join(pkg, "dist", readFileSync(pathFile, "utf8").trim());
  const plist = join(dirname(dirname(dirname(exe))), "Contents", "Info.plist");
  if (!existsSync(plist)) {
    console.warn(`skipping dev-shell branding: no Info.plist at ${plist}`);
    return null;
  }
  return plist;
}

try {
  main();
} catch (error) {
  console.warn(`skipping dev-shell branding: ${error.message}`);
}
