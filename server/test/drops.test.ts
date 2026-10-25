/**
 * A file handed to Kuru's box, judged by its bytes and kept under a name the
 * server chose. The judging is the part that matters: the folder takes what
 * any page holding the token sends it, so what a page *says* a file is must
 * never be what decides — a `.command` called `image/png` is still a
 * `.command`, and must arrive as nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DROP_MAX_BYTES, dropFileName, dropRefusal, judgeDrop } from "../../shared/drops";
import { DropRefused, dropsDir, keepDrop } from "../src/drops";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const bytes = (s: string) => new TextEncoder().encode(s);

describe("judgeDrop", () => {
  it("knows the four pictures Claude reads by their bytes, whatever they are called", () => {
    expect(judgeDrop(PNG, "image.png")).toEqual({ kind: "image", ext: "png" });
    expect(judgeDrop(JPEG, "photo.png")).toEqual({ kind: "image", ext: "jpg" });
    expect(judgeDrop(bytes("GIF89a\x01\x00"), "")).toEqual({ kind: "image", ext: "gif" });
    expect(judgeDrop(bytes("RIFF\x10\x00\x00\x00WEBPVP8 "), "x")).toEqual({ kind: "image", ext: "webp" });
  });

  it("takes text, keeping an extension it knows and calling the rest .txt", () => {
    expect(judgeDrop(bytes("# Notes\n\nä ok"), "notes.md")).toEqual({ kind: "text", ext: "md" });
    expect(judgeDrop(bytes("a,b\n1,2\n"), "Sheet.CSV")).toEqual({ kind: "text", ext: "csv" });
    expect(judgeDrop(bytes("echo hi\n"), "run.command")).toEqual({ kind: "text", ext: "txt" });
    expect(judgeDrop(bytes("plain"), "")).toEqual({ kind: "text", ext: "txt" });
  });

  it("refuses binary that is not one of the pictures, and says so", () => {
    const pdf = bytes("%PDF-1.7\n\x00\x01binary");
    expect(judgeDrop(pdf, "a.pdf")).toHaveProperty("refused");
    // Latin-1 is not UTF-8: a fault in the decode is a refusal, not a guess.
    expect(judgeDrop(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), "a.txt")).toHaveProperty("refused");
    expect(judgeDrop(new Uint8Array(0), "a.txt")).toEqual({ refused: "That file is empty." });
  });

  it("gives an iPhone's HEIC its own answer, since the fix is on the phone", () => {
    const heic = Uint8Array.from([0, 0, 0, 24, ...bytes("ftypheic"), 0, 0, 0, 0]);
    const judged = judgeDrop(heic, "IMG_0001.HEIC");
    expect("refused" in judged && judged.refused).toMatch(/HEIC/);
  });
});

describe("dropRefusal", () => {
  it("lets through what a page can see is a picture or text", () => {
    expect(dropRefusal({ name: "image.png", type: "image/png", size: 10 })).toBeNull();
    expect(dropRefusal({ name: "notes.md", type: "", size: 10 })).toBeNull();
    expect(dropRefusal({ name: "x", type: "text/plain", size: 10 })).toBeNull();
  });

  it("stops the rest before it is uploaded", () => {
    expect(dropRefusal({ name: "big.png", type: "image/png", size: DROP_MAX_BYTES + 1 })).toMatch(/over 20 MB/);
    expect(dropRefusal({ name: "a.pdf", type: "application/pdf", size: 10 })).toMatch(/not a picture or a text file/);
    expect(dropRefusal({ name: "IMG_1.HEIC", type: "image/heic", size: 10 })).toMatch(/HEIC/);
    expect(dropRefusal({ name: "folder", type: "", size: 96 })).toMatch(/not a picture/);
  });
});

describe("dropFileName", () => {
  const at = new Date(2026, 9, 25, 13, 55, 16);

  it("is when, then what it was called, then the extension the bytes earned", () => {
    expect(dropFileName("image.png", { kind: "image", ext: "png" }, at)).toBe("2026-10-25-135516-image.png");
    expect(dropFileName("Screenshot 2026-10-25 at 1.55.16 PM.png", { kind: "image", ext: "png" }, at)).toBe(
      "2026-10-25-135516-Screenshot-2026-10-25-at-1.55.16-PM.png",
    );
  });

  it("keeps nothing of a name that would need escaping or climb out of the folder", () => {
    expect(dropFileName("../../etc/passwd", { kind: "text", ext: "txt" }, at)).toBe("2026-10-25-135516-passwd.txt");
    expect(dropFileName("$(rm -rf ~).png", { kind: "image", ext: "png" }, at)).toBe("2026-10-25-135516-rm-rf.png");
    expect(dropFileName("", { kind: "image", ext: "jpg" }, at)).toBe("2026-10-25-135516-image.jpg");
    expect(dropFileName("...", { kind: "text", ext: "md" }, at)).toBe("2026-10-25-135516-text.md");
  });

  it("is never so long that a path in a message gets hard to read", () => {
    const name = dropFileName(`${"a".repeat(200)}.png`, { kind: "image", ext: "png" }, at);
    expect(name.length).toBeLessThanOrEqual("2026-10-25-135516-".length + 48 + ".png".length);
  });
});

describe("keepDrop", () => {
  let dir: string;
  let was: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kururu-drops-"));
    was = process.env.KURURU_DATA_DIR;
    process.env.KURURU_DATA_DIR = dir;
  });
  afterEach(() => {
    if (was === undefined) delete process.env.KURURU_DATA_DIR;
    else process.env.KURURU_DATA_DIR = was;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the bytes under drops/, private to the user, and says where", () => {
    const at = new Date(2026, 9, 25, 13, 55, 16);
    const { path } = keepDrop(PNG, "image.png", at);
    expect(path).toBe(join(dir, "drops", "2026-10-25-135516-image.png"));
    expect(readFileSync(path)).toEqual(Buffer.from(PNG));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dropsDir()).mode & 0o777).toBe(0o700);
  });

  it("numbers a second copy of the same second rather than writing over the first", () => {
    const at = new Date(2026, 9, 25, 13, 55, 16);
    const first = keepDrop(PNG, "image.png", at).path;
    const second = keepDrop(Uint8Array.from([...PNG, 1]), "image.png", at).path;
    expect(first).not.toBe(second);
    expect(readdirSync(dropsDir()).sort()).toEqual(["2026-10-25-135516-image-2.png", "2026-10-25-135516-image.png"]);
    expect(readFileSync(first)).toEqual(Buffer.from(PNG));
  });

  it("refuses what it does not take, and writes nothing for it", () => {
    expect(() => keepDrop(bytes("%PDF\x00"), "a.pdf")).toThrow(DropRefused);
    expect(readdirSync(dir)).toEqual([]);
  });
});
