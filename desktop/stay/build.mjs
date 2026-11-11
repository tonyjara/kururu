/**
 * Compile `stay.m`, the one window property Electron does not reach, into an
 * addon main can load (`dist/stay.node`).
 *
 * `talkkey/build.mjs` again, for its reasons: a step of its own so
 * `desktop/build.mjs` does not compile on every save, skipped when the addon
 * is newer than the source, both architectures in one file, and a warning
 * rather than a failed build without Xcode. An app without it only has
 * floating windows that hide with the app, as they always did (`stays.js`).
 *
 * Objective-C and `clang` rather than Swift: a Node-API addon is a bundle
 * that exports one C symbol and calls back into the binary that loads it,
 * which is three flags to clang and a fight with Swift's runtime.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, "stay.m");
const OUT = join(here, "..", "dist", "stay.node");
/** As the talk key's: `canHide` is far older. */
const MIN_OS = "12.0";

function sdkPath() {
  try {
    const sdk = execFileSync("xcrun", ["--show-sdk-path", "--sdk", "macosx"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    execFileSync("xcrun", ["-f", "clang"], { stdio: "ignore" });
    return sdk || null;
  } catch {
    return null;
  }
}

if (process.platform !== "darwin") {
  console.log("stay: macOS only, skipping");
  process.exit(0);
}

if (existsSync(OUT) && statSync(OUT).mtimeMs >= statSync(SOURCE).mtimeMs) {
  console.log("stay: up to date");
  process.exit(0);
}

const sdk = sdkPath();
if (!sdk) {
  console.warn("stay: no clang (xcode-select --install), so the floating windows will hide with the app");
  process.exit(0);
}

mkdirSync(dirname(OUT), { recursive: true });
const slices = [];
for (const arch of ["arm64", "x86_64"]) {
  const slice = `${OUT}-${arch}`;
  try {
    execFileSync(
      "xcrun",
      // `-undefined dynamic_lookup`: the Node-API functions are the loading binary's, found when it loads this.
      ["clang", "-fobjc-arc", "-O2", "-Wall", "-Werror", "-bundle", "-undefined", "dynamic_lookup", "-framework", "AppKit", "-isysroot", sdk, "-arch", arch, `-mmacosx-version-min=${MIN_OS}`, "-o", slice, SOURCE],
      { stdio: "inherit" },
    );
    slices.push(slice);
  } catch (err) {
    console.warn(`stay: could not build the ${arch} slice (${err.message})`);
  }
}
if (!slices.length) {
  console.warn("stay: nothing was built");
  process.exit(0);
}
if (slices.length === 1) {
  execFileSync("mv", [/** @type {string} */ (slices[0]), OUT]);
} else {
  execFileSync("lipo", ["-create", ...slices, "-output", OUT]);
  for (const slice of slices) rmSync(slice, { force: true });
}
console.log(`stay: built ${OUT} (${slices.length} slice${slices.length === 1 ? "" : "s"})`);
