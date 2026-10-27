/**
 * Pictures through the chat: what a message's picture is, the words Kuru is
 * handed, and — the part that matters — which files may go to Telegram's
 * servers at all. The disk half runs against temp folders standing in for a
 * project, the user's home and kururu's data directory, so a refusal is
 * tested as the realpath'd, root-checked thing the server does.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { judge, updatesFrom, type IncomingMessage } from "../../shared/channels";
import { imageKindOf } from "../../shared/drops";
import {
  CAPTION_MAX,
  PHOTO_OUT_MAX,
  PICTURE_OUT_MAX,
  isPictureName,
  pictureFileName,
  pictureOf,
  pictureWords,
  photoRefusedForShape,
  placeRefusal,
  sendAs,
  splitCaption,
} from "../../shared/pictures";
import { PictureRefused, dropStaged, inboxDir, keepIncoming, outboxDir, stageOutgoing, wholePath } from "../src/pictures";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3]);
const GIF = new TextEncoder().encode("GIF89a....");

describe("pictureOf", () => {
  it("takes the largest size of a photo", () => {
    const photo = [
      { file_id: "small", width: 90, height: 60, file_size: 1_000 },
      { file_id: "large", width: 1280, height: 853, file_size: 120_000 },
      { file_id: "medium", width: 320, height: 213, file_size: 9_000 },
    ];
    expect(pictureOf({ photo })).toEqual({ fileId: "large", size: 120_000, name: null, mime: "image/jpeg" });
  });

  it("takes a file that says it is a picture, by its type or its name, and nothing else", () => {
    expect(pictureOf({ document: { file_id: "d1", file_name: "IMG_0001.HEIC", mime_type: "image/heic", file_size: 2_000_000 } })).toEqual({
      fileId: "d1",
      size: 2_000_000,
      name: "IMG_0001.HEIC",
      mime: "image/heic",
    });
    expect(pictureOf({ document: { file_id: "d2", file_name: "shot.png" } })?.fileId).toBe("d2");
    expect(pictureOf({ document: { file_id: "d3", file_name: "notes.pdf", mime_type: "application/pdf" } })).toBeNull();
    expect(pictureOf({ sticker: { file_id: "s1" } })).toBeNull();
    expect(pictureOf({ photo: [] })).toBeNull();
    expect(pictureOf({ photo: [{ width: 10 }] })).toBeNull();
  });

  it("is read off an update with its caption and album, and judged as words with a picture", () => {
    const got = updatesFrom({
      ok: true,
      result: [
        {
          update_id: 1,
          message: { message_id: 7, date: 100, chat: { id: 111, type: "private" }, from: { id: 111, is_bot: false }, caption: "what is this?", media_group_id: "g1", photo: [{ file_id: "p", width: 1, height: 1 }] },
        },
        {
          update_id: 2,
          message: { message_id: 8, date: 100, chat: { id: 111, type: "private" }, from: { id: 111, is_bot: false }, text: "hm", reply_to_message: { message_id: 7, date: 90, from: { id: 111, is_bot: false }, photo: [{ file_id: "p" }] } },
        },
      ],
    })!;
    const [photo, reply] = got.messages as [IncomingMessage, IncomingMessage];
    expect(photo).toMatchObject({ text: null, caption: "what is this?", album: "g1", picture: { fileId: "p" } });
    // A picture with no caption is still something a reply can say it answered.
    expect(reply.answered?.text).toBe("[picture]");
    const ctx = { allowed: ["111"], enabled: true, enabledAt: 0, pairing: null, now: 200_000 };
    expect(judge(photo, ctx)).toEqual({ kind: "pass", text: "what is this?", picture: photo.picture! });
    expect(judge({ ...photo, caption: null }, ctx)).toEqual({ kind: "pass", text: "", picture: photo.picture! });
    // The list is still the list: a stranger's photo is nothing.
    expect(judge(photo, { ...ctx, allowed: ["222"] }).kind).toBe("ignore");
    expect(judge(photo, { ...ctx, enabledAt: 500_000 }).kind).toBe("stale");
  });
});

describe("the words Kuru is handed", () => {
  it("names the pictures first, then what came with them", () => {
    expect(pictureWords(["/d/telegram/inbox/a.jpg"], "what is this?")).toBe("(picture: /d/telegram/inbox/a.jpg) what is this?");
    expect(pictureWords(["/d/a.jpg", "/d/b.jpg"], "")).toBe("(2 pictures: /d/a.jpg /d/b.jpg)");
    expect(pictureWords(["/d/a.jpg"], "", 1)).toBe("(picture: /d/a.jpg) (a picture that could not be fetched from Telegram)");
    // A data directory somebody moved under a space is escaped as a dropped path is.
    expect(pictureWords(["/Users/me/My Data/a.jpg"], "")).toBe("(picture: /Users/me/My\\ Data/a.jpg)");
  });

  it("keeps a picture under when it came and which message it was", () => {
    expect(pictureFileName(new Date(2026, 9, 27, 15, 30, 12), 4567, "jpg")).toBe("2026-10-27-153012-4567.jpg");
  });
});

describe("what may go out", () => {
  it("refuses a hidden folder anywhere below the root, and ~/Library", () => {
    expect(placeRefusal("shots/a.png", "/Users/me/Desktop/shots/a.png", "/Users/me")).toBeNull();
    expect(placeRefusal(".ssh/a.png", "/Users/me/.ssh/a.png", "/Users/me")).toMatch(/hidden folder/);
    expect(placeRefusal("app/.env.d/qr.png", "/Users/me/p/app/.env.d/qr.png", "/Users/me")).toMatch(/hidden folder/);
    expect(placeRefusal("Library/Messages/Attachments/x.jpg", "/Users/me/Library/Messages/Attachments/x.jpg", "/Users/me")).toMatch(/Library/);
  });

  it("sends a picture as a photo up to Telegram's limit, as a file past it, and refuses what is not one", () => {
    expect(sendAs("png", 1_000)).toBe("photo");
    expect(sendAs("webp", PHOTO_OUT_MAX)).toBe("photo");
    expect(sendAs("jpg", PHOTO_OUT_MAX + 1)).toBe("document");
    expect(sendAs("jpg", PICTURE_OUT_MAX + 1)).toEqual({ refused: expect.stringContaining("20 MB") });
    expect(sendAs("gif", 1_000)).toEqual({ refused: expect.stringContaining("GIF") });
    expect(sendAs(null, 1_000)).toEqual({ refused: expect.stringContaining("not a picture") });
    expect(sendAs("png", 0)).toEqual({ refused: "it is empty" });
  });

  it("keeps a caption whole, or sends it after the picture", () => {
    expect(splitCaption(null)).toEqual({ caption: null, after: null });
    expect(splitCaption("  the build  ")).toEqual({ caption: "the build", after: null });
    const long = "x".repeat(CAPTION_MAX + 1);
    expect(splitCaption(long)).toEqual({ caption: null, after: long });
  });

  it("knows which refusals a file would not get", () => {
    expect(photoRefusedForShape("Bad Request: PHOTO_INVALID_DIMENSIONS")).toBe(true);
    expect(photoRefusedForShape("Bad Request: chat not found")).toBe(false);
    expect(isPictureName("a/b/Shot.PNG")).toBe(true);
    expect(isPictureName("notes.md")).toBe(false);
  });
});

let dir: string;
let was: string | undefined;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "kururu-pictures-")));
  was = process.env.KURURU_DATA_DIR;
  process.env.KURURU_DATA_DIR = join(dir, "data");
});

afterEach(() => {
  if (was === undefined) delete process.env.KURURU_DATA_DIR;
  else process.env.KURURU_DATA_DIR = was;
  rmSync(dir, { recursive: true, force: true });
});

describe("keepIncoming", () => {
  it("keeps a picture owner-only under its message, by what its bytes are", async () => {
    const path = await keepIncoming(PNG, new Date(2026, 9, 27, 9, 5, 1), 42);
    expect(path).toBe(join(inboxDir(), "2026-10-27-090501-42.png"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(inboxDir()).mode & 0o777).toBe(0o700);
  });

  it("refuses what is not a picture", async () => {
    await expect(keepIncoming(new TextEncoder().encode("#!/bin/sh\nrm -rf ~"), new Date(), 1)).rejects.toThrow(PictureRefused);
    await expect(keepIncoming(new Uint8Array(), new Date(), 1)).rejects.toThrow(/empty/);
  });

  it.skipIf(process.platform !== "darwin")("turns HEIC into a JPEG Claude can read", async () => {
    const png = join(dir, "red.png");
    const heic = join(dir, "red.heic");
    execFileSync("/usr/bin/sips", ["-s", "format", "png", "-z", "8", "8", "/System/Library/CoreServices/Finder.app/Contents/Resources/Finder.icns", "--out", png], { stdio: "ignore" });
    execFileSync("/usr/bin/sips", ["-s", "format", "heic", png, "--out", heic], { stdio: "ignore" });
    const bytes = readFileSync(heic);
    expect(imageKindOf(bytes)).toBe("heic");
    const path = await keepIncoming(bytes, new Date(2026, 0, 1), 9);
    expect(path.endsWith("-9.jpg")).toBe(true);
    expect(imageKindOf(readFileSync(path))).toBe("jpg");
    // Nothing of the HEIC is left beside it.
    expect(readdirSync(inboxDir())).toEqual([path.slice(path.lastIndexOf("/") + 1)]);
  });
});

describe("stageOutgoing", () => {
  function tree() {
    const project = join(dir, "project");
    const home = join(dir, "home");
    mkdirSync(join(project, "shots"), { recursive: true });
    mkdirSync(join(project, ".private"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(project, "shots", "ok.png"), PNG);
    writeFileSync(join(project, ".private", "key.png"), PNG);
    writeFileSync(join(project, "shots", "loop.gif"), GIF);
    writeFileSync(join(project, "notes.txt"), "hello");
    writeFileSync(join(home, "elsewhere.png"), PNG);
    symlinkSync(join(home, "elsewhere.png"), join(project, "shots", "link.png"));
    return { project, home };
  }

  it("copies a picture from inside a root into the outbox, owner-only, and lets the copy go after", async () => {
    const { project } = tree();
    const staged = await stageOutgoing(join(project, "shots", "ok.png"), [project]);
    expect(staged.as).toBe("photo");
    expect(staged.name).toBe("ok.png");
    expect(staged.file.startsWith(outboxDir())).toBe(true);
    expect(readFileSync(staged.file)).toEqual(Buffer.from(PNG));
    expect(statSync(staged.file).mode & 0o777).toBe(0o600);
    dropStaged(staged.file);
    expect(existsSync(staged.file)).toBe(false);
    // The original is never touched.
    expect(existsSync(join(project, "shots", "ok.png"))).toBe(true);
  });

  it("refuses outside every root, below a hidden folder, through a link out, and anything not a still picture", async () => {
    const { project, home } = tree();
    await expect(stageOutgoing(join(home, "elsewhere.png"), [project])).rejects.toThrow(/not in a project/);
    await expect(stageOutgoing(join(project, ".private", "key.png"), [project])).rejects.toThrow(/hidden folder/);
    await expect(stageOutgoing(join(project, "shots", "link.png"), [project])).rejects.toThrow(/not in a project/);
    await expect(stageOutgoing(join(project, "shots", "loop.gif"), [project])).rejects.toThrow(/GIF/);
    await expect(stageOutgoing(join(project, "notes.txt"), [project])).rejects.toThrow(/not a picture/);
    await expect(stageOutgoing(join(project, "shots", "gone.png"), [project])).rejects.toThrow(/no file/);
    // A root is not a picture to send.
    await expect(stageOutgoing(project, [project])).rejects.toThrow(PictureRefused);
    expect(existsSync(outboxDir()) ? readdirSync(outboxDir()) : []).toEqual([]);
  });

  it("finds a path as Kuru wrote it", () => {
    const { project } = tree();
    expect(wholePath("shots/ok.png", [join(dir, "nowhere"), project])).toBe(join(project, "shots", "ok.png"));
    expect(wholePath("shots/none.png", [project])).toBeNull();
    expect(wholePath("/abs/x.png", [])).toBe("/abs/x.png");
    expect(wholePath("~/Desktop/x.png", [])!.endsWith("/Desktop/x.png")).toBe(true);
    expect(wholePath("shots/ok\\ .png", [])).toBeNull();
  });
});
