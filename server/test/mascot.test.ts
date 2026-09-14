/**
 * The mascot is the one asset a user is invited to replace, so the two things
 * worth pinning down are that the built-in is really there — it is inlined as
 * base64 and nothing else would notice if it rotted — and that a replacement
 * wins without being second-guessed.
 */
import { describe, expect, it, afterAll, beforeAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { mascot, mascotPath } from "../src/mascot";

const tmp = join(realpathSync("/tmp"), `kururu-mascot-test-${process.pid}`);
const replacement = join(tmp, "mine.png");

/** Eight bytes is all it takes to be recognisably a PNG. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.KURURU_MASCOT;
});

describe("the built-in", () => {
  it("is a PNG, and is served when there is no replacement", () => {
    process.env.KURURU_MASCOT = join(tmp, "nothing-here.png");
    const { body, custom } = mascot();
    expect(custom).toBe(false);
    expect(body.subarray(0, 8)).toEqual(PNG_MAGIC);
  });

  it("is a strip of square frames, which is the whole contract", () => {
    process.env.KURURU_MASCOT = join(tmp, "nothing-here.png");
    // IHDR is the first chunk of every PNG: width and height, big-endian, at 16.
    const { body } = mascot();
    const width = body.readUInt32BE(16);
    const height = body.readUInt32BE(20);
    expect(width % height).toBe(0);
    expect(width / height).toBeGreaterThan(1);
  });
});

describe("a replacement", () => {
  it("wins, and is handed over exactly as it was left", () => {
    const mine = Buffer.concat([PNG_MAGIC, Buffer.from("not really a png")]);
    writeFileSync(replacement, mine);
    process.env.KURURU_MASCOT = replacement;
    const { body, custom } = mascot();
    expect(custom).toBe(true);
    expect(body).toEqual(mine);
  });

  it("is refused above a megabyte, since it ships to a phone on every load", () => {
    writeFileSync(replacement, Buffer.alloc(1024 * 1024 + 1));
    process.env.KURURU_MASCOT = replacement;
    expect(mascot().custom).toBe(false);
  });

  it("is looked for under the config directory, not the state one", () => {
    delete process.env.KURURU_MASCOT;
    process.env.XDG_CONFIG_HOME = tmp;
    expect(mascotPath()).toBe(join(tmp, "kururu", "mascot.png"));
    delete process.env.XDG_CONFIG_HOME;
  });
});
