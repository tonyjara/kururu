/**
 * Give the dev shell its own identity.
 *
 * `electron .` runs the prebuilt Electron.app straight out of node_modules, so
 * as far as macOS is concerned this app is "Electron", `com.github.Electron` —
 * the same identity every other Electron project on the machine runs under.
 * Anything keying off the bundle id then cannot tell kururu apart from the next
 * dev shell: a window manager pinning it to a workspace grabs both, and the
 * Dock and app switcher show a stock Electron icon with no name on it. So we
 * stamp our own id and name into that copy's Info.plist.
 *
 * The id is deliberately *not* the one a packaged build will carry. A dev shell
 * and an installed kururu should be separately addressable — you want both open
 * at once and treated differently, not merged by whatever is reading the id.
 *
 * This runs from `postinstall` because `bun install` restores the pristine
 * bundle; a one-off by hand would silently come undone on the next install.
 * It only ever touches node_modules, so nothing outside kururu sees it.
 *
 * No re-signing. The prebuilt bundle is *linker-signed* ad-hoc: `codesign -dv`
 * reports `Info.plist=not bound` and `Sealed Resources=none`, so the signature
 * covers the Mach-O executable and nothing else and a plist edit leaves it
 * untouched. Worth saying what is not a check here — `codesign --verify` fails
 * on the *stock* bundle ("code has no resources but signature indicates they
 * must be present") while that same bundle launches fine, so its verdict says
 * nothing about whether we broke anything. The thing that would actually break
 * is AMFI refusing the executable, and we have not changed the executable.
 *
 * Changing the bundle id resets anything macOS grants per-identity — Screen
 * Recording, Accessibility, Automation. Expect to re-approve those prompts once.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** What the dev shell should call itself. The packaged app takes `com.twonary.kururu`. */
const IDENTITY = {
  CFBundleIdentifier: "com.twonary.kururu.dev",
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

  // `plutil -convert json` rather than a plist parser: it ships with macOS, and
  // we are already shelling out to its `-replace` to write.
  const current = JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" }),
  );
  const stale = Object.entries(IDENTITY).filter(([key, value]) => current[key] !== value);
  if (stale.length === 0) return;

  for (const [key, value] of stale) {
    execFileSync("plutil", ["-replace", key, "-string", value, plist]);
  }
  console.log(`branded dev shell as ${IDENTITY.CFBundleName} (${IDENTITY.CFBundleIdentifier})`);
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
