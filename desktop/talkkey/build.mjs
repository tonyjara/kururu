/**
 * Compile the talk-key hook into a binary the app can spawn.
 *
 * A step of its own rather than a line in `desktop/build.mjs`, because that
 * one runs on every save under `bun run dev` and compiling Swift on every
 * save would be paying for a key hook that has not changed. This runs from
 * `bun run build` and before `dev:desktop`, and skips itself when the binary
 * is newer than the source.
 *
 * Both architectures, one file: the DMG ships for each, and `lipo` costs
 * nothing. No Xcode means no hook — the app says so in its menu and the key
 * works in the window as it always has — so a missing `swiftc` is a warning
 * here and never a failed build.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, "talkkey.swift");
const OUT = join(here, "..", "dist", "talkkey");
/** Old enough for any Mac that runs the app; the APIs used are older still. */
const MIN_OS = "12.0";

/**
 * The compiler and the SDK, both through `xcrun`. Called by its path alone,
 * `swiftc` has no SDK and fails with "unable to load standard library",
 * which names neither the SDK nor the fix.
 */
function toolchain() {
  try {
    const sdk = execFileSync("xcrun", ["--show-sdk-path", "--sdk", "macosx"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    execFileSync("xcrun", ["-f", "swiftc"], { stdio: "ignore" });
    return sdk ? { sdk } : null;
  } catch {
    return null;
  }
}

if (process.platform !== "darwin") {
  console.log("talkkey: macOS only, skipping");
  process.exit(0);
}

if (existsSync(OUT) && statSync(OUT).mtimeMs >= statSync(SOURCE).mtimeMs) {
  console.log("talkkey: up to date");
  process.exit(0);
}

const found = toolchain();
if (!found) {
  console.warn("talkkey: no swiftc (xcode-select --install), so the app will have no system-wide talk key");
  process.exit(0);
}

mkdirSync(dirname(OUT), { recursive: true });
const slices = [];
for (const arch of ["arm64", "x86_64"]) {
  const slice = `${OUT}-${arch}`;
  try {
    execFileSync("xcrun", ["swiftc", "-O", "-sdk", found.sdk, "-target", `${arch}-apple-macos${MIN_OS}`, "-o", slice, SOURCE], { stdio: "inherit" });
    slices.push(slice);
  } catch (err) {
    console.warn(`talkkey: could not build the ${arch} slice (${err.message})`);
  }
}
if (!slices.length) {
  console.warn("talkkey: nothing was built");
  process.exit(0);
}
if (slices.length === 1) {
  execFileSync("mv", [slices[0], OUT]);
} else {
  execFileSync("lipo", ["-create", ...slices, "-output", OUT]);
  for (const slice of slices) rmSync(slice, { force: true });
}
console.log(`talkkey: built ${OUT} (${slices.length} slice${slices.length === 1 ? "" : "s"})`);
