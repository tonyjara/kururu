/**
 * The one field `persist.ts` keeps as it was: a profile's login key.
 *
 * The file's rule is structure, never processes, and ids are minted fresh on
 * the way back in — which is right for everything that names something in the
 * old process and wrong for the one thing that names something on disk. A key
 * that changed across a cold start would be a login directory nobody is pointed
 * at any more, so it goes round the trip unchanged, and a file from before it
 * existed comes back with a fresh one rather than none.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOGIN_KEY } from "../../shared/model";
import { readSnapshot, snapshotPath, writeSnapshot } from "../src/persist";
import { Workspaces } from "../src/workspaces";

let dir: string;
let previous: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kururu-persist-"));
  previous = process.env.KURURU_STATE_DIR;
  process.env.KURURU_STATE_DIR = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.KURURU_STATE_DIR;
  else process.env.KURURU_STATE_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe("loginKey on disk", () => {
  it("goes round the trip unchanged while the ids do not", () => {
    const workspaces = new Workspaces();
    workspaces.newProfile("work");
    const before = workspaces.all();
    writeSnapshot(before, workspaces.active.id);
    const after = readSnapshot()!;
    expect(after.profiles.map((p) => p.loginKey)).toEqual(before.map((p) => p.loginKey));
    expect(after.profiles.map((p) => p.id)).not.toEqual(before.map((p) => p.id));
  });

  it("mints one for a session written before keys existed, and for a key that is not one", () => {
    const workspaces = new Workspaces();
    writeSnapshot(workspaces.all(), workspaces.active.id);
    const session = JSON.parse(readFileSync(snapshotPath(), "utf8"));
    delete session.profiles[0].loginKey;
    session.profiles.push({ ...session.profiles[0], name: "tampered", loginKey: "../../etc" });
    writeFileSync(snapshotPath(), JSON.stringify(session));
    const [old, tampered] = readSnapshot()!.profiles;
    expect(old!.loginKey).toMatch(LOGIN_KEY);
    expect(tampered!.loginKey).toMatch(LOGIN_KEY);
    expect(tampered!.loginKey).not.toBe(old!.loginKey);
  });
});
