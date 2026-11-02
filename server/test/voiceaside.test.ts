/**
 * The two doors into the speaker answer to one switch. `spoke` — Kuru's last
 * message — always asked "speak replies"; the `say` tool went to `speak`
 * directly and talked with the switch off. The class is built for real, with
 * its config in a temp directory, and `speak` itself is stubbed: what is
 * tested is who reaches it, and no test should make a sound.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Voice } = await import("../src/voice");

/**
 * The config directory is pointed elsewhere only while the class reads it, and
 * put back: every test file shares this process, and a `KURURU_CONFIG_DIR` left
 * set wins over the `XDG_CONFIG_HOME` the next file sets.
 */
function voiceWith(speak: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "kururu-voiceaside-"));
  writeFileSync(join(dir, "voice.json"), JSON.stringify({ speak }));
  const was = process.env.KURURU_CONFIG_DIR;
  process.env.KURURU_CONFIG_DIR = dir;
  let voice: InstanceType<typeof Voice>;
  try {
    voice = new Voice({ broadcast: () => {}, index: { load: () => [], save: () => {} }, profileIdOf: () => "p1", changed: () => {} });
  } finally {
    if (was === undefined) delete process.env.KURURU_CONFIG_DIR;
    else process.env.KURURU_CONFIG_DIR = was;
  }
  const reached: string[] = [];
  voice.speak = (_key: string, text: string) => {
    reached.push(text);
    return "u1";
  };
  return { voice, reached };
}

describe("Voice, with speak replies off", () => {
  it("says neither the reply nor an aside", () => {
    const { voice, reached } = voiceWith(false);
    expect(voice.speaks()).toBe(false);
    expect(voice.spoke("pk", "All three agents are done.")).toBeNull();
    expect(voice.aside("pk", "Starting three agents now.")).toBeNull();
    expect(reached).toEqual([]);
  });
});

describe("Voice, with speak replies on", () => {
  it("says both, through the one speaker", () => {
    const { voice, reached } = voiceWith(true);
    expect(voice.speaks()).toBe(true);
    expect(voice.spoke("pk", "All three agents are done.")).toBe("u1");
    expect(voice.aside("pk", "Starting three agents now.")).toBe("u1");
    expect(reached).toEqual(["All three agents are done.", "Starting three agents now."]);
  });
});
