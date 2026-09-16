/**
 * The sound catalogue, against a directory this test writes.
 *
 * Two claims worth pinning, and both are about the thing that makes this module
 * different from `mascot.ts`: an id is resolved by *finding it in the list built
 * from disk*, never by being pasted into a path. So there is no traversal to
 * refuse — there is nothing to traverse — and the test of that is that a
 * malicious id simply does not match anything, including when the file it names
 * is really there.
 *
 * The other claim is the one the whole module exists for: a format the browser
 * cannot decode must come back as something it can. That half is macOS's
 * `afconvert` and is skipped elsewhere, because a test that asserted the
 * conversion on a machine with no converter would be asserting the fallback.
 *
 * `KURURU_SOUNDS` is set before the import, which is why this file imports
 * dynamically: the module reads it once, at load.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let sounds: typeof import("../src/sounds").sounds;
let soundBytes: typeof import("../src/sounds").soundBytes;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kururu-sounds-test-"));
  // Not real audio: nothing here decodes it, and the listing is by extension.
  writeFileSync(join(dir, "croak.mp3"), "not really an mp3");
  writeFileSync(join(dir, "bell.wav"), "not really a wav");
  // Neither playable nor convertible, so it must not be offered at all — the
  // failure this module exists to prevent is a name in the dropdown that is
  // silence when you pick it.
  writeFileSync(join(dir, "notes.txt"), "text");
  process.env.KURURU_SOUNDS = dir;
  ({ sounds, soundBytes } = await import("../src/sounds"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.KURURU_SOUNDS;
});

describe("the catalogue", () => {
  it("offers what a browser can play and nothing else", () => {
    const ours = sounds().filter((sound) => sound.kind === "kururu");
    expect(ours.map((sound) => sound.id).sort()).toEqual(["bell", "croak"]);
  });

  it("puts kururu's own sounds before the machine's", () => {
    const kinds = sounds().map((sound) => sound.kind);
    expect(kinds.indexOf("kururu")).toBe(0);
    // Every "kururu" comes before every "system", whatever the machine has.
    expect(kinds.lastIndexOf("kururu")).toBeLessThan(
      kinds.includes("system") ? kinds.indexOf("system") : Infinity,
    );
  });
});

describe("resolving an id", () => {
  it("serves one that is in the list, with a type the browser knows", async () => {
    const sound = await soundBytes("croak");
    expect(sound?.type).toBe("audio/mpeg");
    expect(sound?.bytes.length).toBeGreaterThan(0);
  });

  it("answers null for an id nothing is called", async () => {
    expect(await soundBytes("no-such-sound")).toBeNull();
    expect(await soundBytes("")).toBeNull();
  });

  /**
   * The point of resolving by lookup. An id that is a path matches no entry, so
   * it is refused for the same reason `zzz` is — there is no code path in which
   * it becomes a filename. It is checked against a file that genuinely exists so
   * that passing cannot be an accident of the target being missing.
   */
  it("cannot be talked into reading a file outside the sound directories", async () => {
    expect(existsSync("/etc/hosts")).toBe(true);
    for (const id of ["../../../../etc/hosts", "/etc/hosts", "../notes", "notes"]) {
      expect(await soundBytes(id)).toBeNull();
    }
  });
});

/**
 * The reason this module is not four lines. Measured, not assumed: Chromium
 * returns the empty string for `canPlayType("audio/aiff")` and throws from
 * `decodeAudioData`, so every one of the machine's alert sounds would be a name
 * in the dropdown that plays nothing.
 */
describe.if(process.platform === "darwin" && existsSync("/System/Library/Sounds/Frog.aiff"))(
  "the system's own sounds",
  () => {
    it("are offered", () => {
      expect(sounds().some((sound) => sound.id === "Frog" && sound.kind === "system")).toBe(true);
    });

    it("come back as WAV, because no browser decodes AIFF", async () => {
      const sound = await soundBytes("Frog");
      expect(sound?.type).toBe("audio/wav");
      // RIFF….WAVE — the conversion happened, rather than the file being passed
      // through with a hopeful content-type on it.
      expect(sound?.bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
      expect(sound?.bytes.subarray(8, 12).toString("latin1")).toBe("WAVE");
    });
  },
);
