/**
 * ⌘, and ⌘. against the chords beside them.
 *
 * The chords are caught on the window ahead of the terminal, so whatever they
 * match never reaches the pty. A test that is too loose here costs somebody a
 * key their program wanted — ctrl+, in a readline, ⇧⌘, in a browser — and that
 * loss is silent, which is why the near misses are listed one by one.
 */
import { describe, expect, it } from "bun:test";
import { drawerChord, isPrefix } from "../src/keys";

function press(key: string, mods: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {}): KeyboardEvent {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods } as KeyboardEvent;
}

describe("drawerChord", () => {
  it("is ⌘, for Kuru and ⌘. for what needs you", () => {
    expect(drawerChord(press(",", { metaKey: true }))).toBe("open-harness");
    expect(drawerChord(press(".", { metaKey: true }))).toBe("open-needs");
  });

  it("leaves a plain comma and period to the terminal", () => {
    expect(drawerChord(press(","))).toBeNull();
    expect(drawerChord(press("."))).toBeNull();
  });

  it("refuses them under any other modifier", () => {
    for (const key of [",", "."]) {
      expect(drawerChord(press(key, { ctrlKey: true }))).toBeNull();
      expect(drawerChord(press(key, { metaKey: true, ctrlKey: true }))).toBeNull();
      expect(drawerChord(press(key, { metaKey: true, altKey: true }))).toBeNull();
      // Shift folds into `key` on most layouts and arrives as "<" or ">", but not on all.
      expect(drawerChord(press(key, { metaKey: true, shiftKey: true }))).toBeNull();
    }
    expect(drawerChord(press("<", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(drawerChord(press(">", { metaKey: true, shiftKey: true }))).toBeNull();
  });

  it("is not another ⌘ key", () => {
    expect(drawerChord(press("/", { metaKey: true }))).toBeNull();
    expect(drawerChord(press("d", { metaKey: true }))).toBeNull();
  });

  it("is never the prefix, so the two cannot both claim a keydown", () => {
    expect(isPrefix(press(",", { metaKey: true }))).toBe(false);
    expect(isPrefix(press(".", { metaKey: true }))).toBe(false);
    expect(drawerChord(press("a", { ctrlKey: true }))).toBeNull();
  });
});
