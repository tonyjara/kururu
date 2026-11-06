/**
 * Compile the screen pen's helper (`glance.swift`) into a binary the app can
 * spawn — `talkkey/build.mjs` again, for the same reasons: a step of its own
 * so `desktop/build.mjs` does not compile Swift on every save, skipped when
 * the binary is newer than the source, both architectures in one file, and
 * a warning rather than a failed build without Xcode, since an app without
 * it only has no pen.
 *
 * macOS 14 at least, unlike the talk key's 12: a still of one display with
 * given windows left out is `SCScreenshotManager`, which arrived in 14. On an
 * older Mac the binary does not start and the pen says it is missing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, "glance.swift");
const OUT = join(here, "..", "dist", "glance");
const MIN_OS = "14.0";

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
  console.log("glance: macOS only, skipping");
  process.exit(0);
}

if (existsSync(OUT) && statSync(OUT).mtimeMs >= statSync(SOURCE).mtimeMs) {
  console.log("glance: up to date");
  process.exit(0);
}

const found = toolchain();
if (!found) {
  console.warn("glance: no swiftc (xcode-select --install), so the app will have no screen pen");
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
    console.warn(`glance: could not build the ${arch} slice (${err.message})`);
  }
}
if (!slices.length) {
  console.warn("glance: nothing was built");
  process.exit(0);
}
if (slices.length === 1) {
  execFileSync("mv", [/** @type {string} */ (slices[0]), OUT]);
} else {
  execFileSync("lipo", ["-create", ...slices, "-output", OUT]);
  for (const slice of slices) rmSync(slice, { force: true });
}
console.log(`glance: built ${OUT} (${slices.length} slice${slices.length === 1 ? "" : "s"})`);
