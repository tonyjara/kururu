/**
 * Which binaries a process title turns into a Dock tile, and where the helper
 * that does not is. The paths are the shapes the app, the dev shell and a
 * host's clone actually run from; the behaviour behind them was read off
 * `lsappinfo` for probes on each (`proctitle.ts`).
 */
import { describe, expect, test } from "bun:test";
import { bundleOf, helperOf, isAppBinary } from "../src/proctitle";

const MAIN = "/Applications/Kururu.app/Contents/MacOS/Kururu";
const HELPER = "/Applications/Kururu.app/Contents/Frameworks/Kururu Helper.app/Contents/MacOS/Kururu Helper";
const SHELL = "/x/kururu/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
const CLONE = "/Users/me/.local/state/kururu/runtime/0.3.0-ab12cd34ef/Kururu.app/Contents/MacOS/Kururu";

describe("bundleOf", () => {
  test("is the app an executable is the main binary of", () => {
    expect(bundleOf(MAIN)).toBe("/Applications/Kururu.app");
    expect(bundleOf("/x/release/mac-arm64/Kururu.app/Contents/MacOS/Kururu")).toBe("/x/release/mac-arm64/Kururu.app");
  });

  test("is the outer app for a helper, which is the one a host is cloned from", () => {
    expect(bundleOf(HELPER)).toBe("/Applications/Kururu.app");
    expect(bundleOf("/A/Kururu.app/Contents/Frameworks/Kururu Helper (Plugin).app/Contents/MacOS/Kururu Helper (Plugin)")).toBe("/A/Kururu.app");
  });

  test("is null for a bare binary", () => {
    expect(bundleOf("/opt/homebrew/bin/node")).toBeNull();
    expect(bundleOf("/Applications/Kururu.app/Contents/Resources/server/run.mjs")).toBeNull();
    expect(bundleOf("/Applications/Kururu.app/Contents/Resources/server/talkkey")).toBeNull();
  });

  test("is not fooled by a folder named like an app further up", () => {
    expect(bundleOf("/Users/me/odd.app/release/Kururu.app/Contents/MacOS/Kururu")).toBe("/Users/me/odd.app/release/Kururu.app");
  });
});

describe("isAppBinary", () => {
  test("is true for an app's main binary, wherever the app is", () => {
    expect(isAppBinary(MAIN)).toBe(true);
    expect(isAppBinary(SHELL)).toBe(true);
    expect(isAppBinary(CLONE)).toBe(true);
  });

  test("is false for a helper and for plain node", () => {
    expect(isAppBinary(HELPER)).toBe(false);
    expect(isAppBinary("/opt/homebrew/bin/node")).toBe(false);
    expect(isAppBinary("/Users/me/.bun/bin/bun")).toBe(false);
  });
});

describe("helperOf", () => {
  test("is the helper Electron puts beside the main binary, by its name", () => {
    expect(helperOf(MAIN)).toBe(HELPER);
    expect(helperOf(SHELL)).toBe("/x/kururu/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper");
  });

  test("is null for what is already a helper, and for what is in no app", () => {
    expect(helperOf(HELPER)).toBeNull();
    expect(helperOf("/opt/homebrew/bin/node")).toBeNull();
  });
});
