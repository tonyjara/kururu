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
 * There is a third source and it is the reason this file also writes a config
 * directory: a `sound` entry installed from the styles registry. It is the one
 * source whose path does not come from a `readdir` — `installedSounds` resolves
 * it against `installed.json` — so a record that disagrees with what is on disk
 * has to drop out of the list rather than reach the dropdown as a name that
 * 404s.
 *
 * `KURURU_SOUNDS` and `XDG_CONFIG_HOME` are both set before the import, which is
 * why this file imports dynamically: the first is read once at load, and the
 * second must not be the user's real config directory — this test would
 * otherwise pass or fail depending on what they happen to have installed.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let config: string;
let sounds: typeof import("../src/sounds").sounds;
let soundBytes: typeof import("../src/sounds").soundBytes;

/** One installed style entry, written the way `install` writes it. */
function installSound(id: string, file: string, bytes: string, manifest?: Record<string, unknown>): void {
  const entry = join(config, "kururu", "styles", "sounds", id);
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, file), bytes);
  writeFileSync(
    join(entry, "sound.json"),
    JSON.stringify(manifest ?? { schema: 1, kind: "sound", id, name: id.toUpperCase(), file }),
  );
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kururu-sounds-test-"));
  config = mkdtempSync(join(tmpdir(), "kururu-sounds-config-"));
  // Not real audio: nothing here decodes it, and the listing is by extension.
  writeFileSync(join(dir, "croak.mp3"), "not really an mp3");
  writeFileSync(join(dir, "bell.wav"), "not really a wav");
  // Neither playable nor convertible, so it must not be offered at all — the
  // failure this module exists to prevent is a name in the dropdown that is
  // silence when you pick it.
  writeFileSync(join(dir, "notes.txt"), "text");

  process.env.KURURU_SOUNDS = dir;
  process.env.XDG_CONFIG_HOME = config;

  installSound("coin", "coin.wav", "not really a wav either");
  // A record whose directory was emptied by hand: still in `installed.json`,
  // nothing on disk. It must not be offered.
  installSound("ghost", "ghost.wav", "x");
  rmSync(join(config, "kururu", "styles", "sounds", "ghost", "ghost.wav"));
  // And one whose id kururu's own sound already answers to, which must lose.
  installSound("croak", "croak.wav", "an impostor");

  mkdirSync(join(config, "kururu", "styles"), { recursive: true });
  writeFileSync(
    join(config, "kururu", "styles", "installed.json"),
    JSON.stringify(
      ["coin", "ghost", "croak"].map((id) => ({
        kind: "sound",
        id,
        name: id === "coin" ? "Coin" : id,
        version: "1.0.0",
        digest: `sha256-${"0".repeat(64)}`,
        installedAt: "2026-01-01T00:00:00.000Z",
        files: [`${id}.wav`, "sound.json"],
      })),
    ),
  );

  ({ sounds, soundBytes } = await import("../src/sounds"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(config, { recursive: true, force: true });
  delete process.env.KURURU_SOUNDS;
  delete process.env.XDG_CONFIG_HOME;
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

/**
 * The third source. The ordering claim here is the load-bearing one and it is
 * the opposite way round from what "most deliberately chosen wins" would
 * suggest: an installed entry sits *after* kururu's own, so that a registry
 * entry called `croak` cannot take over the sound `notify.json` already names.
 */
describe("sounds a style installed", () => {
  it("offers one, under the name the Styles tab listed", () => {
    const coin = sounds().find((sound) => sound.id === "coin");
    expect(coin).toEqual({ id: "coin", name: "Coin", kind: "style" });
  });

  it("serves its bytes by id", async () => {
    const sound = await soundBytes("coin");
    expect(sound?.type).toBe("audio/wav");
    expect(sound?.bytes.toString()).toBe("not really a wav either");
  });

  it("drops a record whose file is no longer there", async () => {
    expect(sounds().some((sound) => sound.id === "ghost")).toBe(false);
    expect(await soundBytes("ghost")).toBeNull();
  });

  /**
   * An installed entry may not shadow kururu's own. The failure this prevents is
   * quiet and permanent: `croak` is the default in `DEFAULT_NOTIFY`, so an entry
   * that won this tie would change what every existing `notify.json` means.
   */
  it("cannot take an id kururu already answers to", async () => {
    const croak = sounds().filter((sound) => sound.id === "croak");
    expect(croak).toHaveLength(1);
    expect(croak[0]!.kind).toBe("kururu");
    expect((await soundBytes("croak"))?.bytes.toString()).toBe("not really an mp3");
  });

  it("comes after kururu's own and before the machine's", () => {
    const kinds = sounds().map((sound) => sound.kind);
    expect(kinds.lastIndexOf("kururu")).toBeLessThan(kinds.indexOf("style"));
    if (kinds.includes("system")) expect(kinds.lastIndexOf("style")).toBeLessThan(kinds.indexOf("system"));
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
