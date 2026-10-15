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
import { BOARD_TAB, docTab, panes, type LayoutNode } from "../../shared/layout";
import { adoptReaders, readSnapshot, snapshotPath, writeSnapshot } from "../src/persist";
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

/**
 * Auto Swap is a preference, not a process, so it is one of the few things
 * about a profile that survives a cold start as it was — and only when on,
 * so a file from before it existed reads as off.
 */
describe("Auto Swap on disk", () => {
  it("is off for a new profile, and comes back on for one that had it on", () => {
    const workspaces = new Workspaces();
    workspaces.newProfile("work");
    const [first, second] = workspaces.all();
    expect(first!.autoSwap).toBe(false);
    workspaces.setAutoSwap(second!.id, true);
    writeSnapshot(workspaces.all(), workspaces.active.id);
    expect(readSnapshot()!.profiles.map((p) => p.autoSwap)).toEqual([false, true]);
  });

  it("reads anything but true as off", () => {
    const workspaces = new Workspaces();
    writeSnapshot(workspaces.all(), workspaces.active.id);
    const session = JSON.parse(readFileSync(snapshotPath(), "utf8"));
    session.profiles[0].autoSwap = "yes";
    writeFileSync(snapshotPath(), JSON.stringify(session));
    expect(readSnapshot()!.profiles[0]!.autoSwap).toBe(false);
  });
});

/**
 * Where agents open is a preference, so it survives a cold start; so does
 * the agents' pane's mark, though not what was in the pane, because the
 * mark is how the next agent finds the pane again.
 */
describe("where agents open, on disk", () => {
  it("keeps the profile's choice, a workspace's own, and the mark", () => {
    const workspaces = new Workspaces();
    workspaces.newProfile("work");
    const [first, second] = workspaces.all();
    workspaces.setAgentPlacement(second!.id, "top");
    workspaces.setWorkspaceAgentPlacement(first!.id, first!.workspaces[0]!.id, "off");
    workspaces.setWorkspaceAgentPlacement(second!.id, second!.workspaces[0]!.id, "off");
    workspaces.setWorkspaceAgentPlacement(second!.id, second!.workspaces[0]!.id, null);
    workspaces.agentPaneIn(second!.id, second!.workspaces[0]!.id);
    writeSnapshot(workspaces.all(), workspaces.active.id);
    const after = readSnapshot()!.profiles;
    expect(after.map((p) => p.agentPlacement)).toEqual(["bottom", "top"]);
    expect(after.map((p) => p.workspaces[0]!.agentPlacement)).toEqual(["off", null]);
    expect(panes(after[1]!.workspaces[0]!.layout).map((p) => p.forAgents === true)).toEqual([true, false]);
  });

  it("reads a file from before it as the default, and junk as no choice", () => {
    const workspaces = new Workspaces();
    writeSnapshot(workspaces.all(), workspaces.active.id);
    const session = JSON.parse(readFileSync(snapshotPath(), "utf8"));
    delete session.profiles[0].agentPlacement;
    session.profiles[0].workspaces[0].agentPlacement = "sideways";
    session.profiles[0].workspaces[0].layout.pane.forAgents = "yes";
    writeFileSync(snapshotPath(), JSON.stringify(session));
    const read = readSnapshot()!.profiles[0]!;
    expect(read.agentPlacement).toBe("bottom");
    expect(read.workspaces[0]!.agentPlacement).toBeNull();
    expect(panes(read.workspaces[0]!.layout)[0]!.forAgents).toBeUndefined();
  });
});

/**
 * Workspaces wore a colour until 2026-10-12, and every session file written
 * before then still says which. It must load as it did, minus the colour, and
 * the colour must be gone from the file after the next save rather than ride
 * along in it for ever.
 */
describe("a workspace colour on disk", () => {
  it("is read past, and not written back", () => {
    const workspaces = new Workspaces();
    workspaces.newWorkspace("second");
    writeSnapshot(workspaces.all(), workspaces.active.id);
    const session = JSON.parse(readFileSync(snapshotPath(), "utf8"));
    session.profiles[0].workspaces[0].color = "violet";
    session.profiles[0].workspaces[1].color = "url(javascript:0)";
    writeFileSync(snapshotPath(), JSON.stringify(session));

    const read = readSnapshot()!;
    expect(read.profiles[0]!.workspaces.map((w) => w.name)).toEqual(["main", "second"]);
    for (const w of read.profiles[0]!.workspaces) expect(w).not.toHaveProperty("color");

    writeSnapshot(read.profiles, read.activeProfileId);
    expect(readFileSync(snapshotPath(), "utf8")).not.toContain("color");
  });
});

/**
 * Where a workspace's shells run is a preference like its mascot, so it comes
 * back as it was — and is read as a command line's ingredients are, since that
 * is what it becomes. Removing the machine brings every workspace on it home.
 */
describe("a workspace's machine on disk", () => {
  it("goes round the trip, and a folder a shell would read as code does not", () => {
    const workspaces = new Workspaces();
    const id = workspaces.activeWorkspace.id;
    expect(workspaces.activeWorkspace.machine).toBeNull();
    workspaces.setWorkspaceMachine(id, { machineId: "m1", dir: "~/code" });
    writeSnapshot(workspaces.all(), workspaces.active.id);
    expect(readSnapshot()!.profiles[0]!.workspaces[0]!.machine).toEqual({ machineId: "m1", dir: "~/code" });

    const session = JSON.parse(readFileSync(snapshotPath(), "utf8"));
    session.profiles[0].workspaces[0].machine.dir = "~/x; rm -rf ~";
    writeFileSync(snapshotPath(), JSON.stringify(session));
    expect(readSnapshot()!.profiles[0]!.workspaces[0]!.machine).toBeNull();
  });

  it("is let go of everywhere when the machine is removed", () => {
    const workspaces = new Workspaces();
    workspaces.setWorkspaceMachine(workspaces.activeWorkspace.id, { machineId: "m1", dir: "~" });
    workspaces.newProfile("work");
    workspaces.setWorkspaceMachine(workspaces.activeWorkspace.id, { machineId: "m2", dir: "~" });
    workspaces.unpinMachine("m1");
    expect(workspaces.all().map((p) => p.workspaces[0]!.machine?.machineId ?? null)).toEqual([null, "m2"]);
  });
});

/**
 * The views a pane holds — the board and documents — come back in their order
 * and with the one that was showing still showing; the terminals beside them
 * do not, because they are processes. Both older shapes a reader has been
 * written in, on disk and in the host's blob, come back as document tabs.
 */
describe("view tabs on disk", () => {
  const ROOT = "/home/you/project";

  it("goes round the trip with the terminals left out", () => {
    const workspaces = new Workspaces();
    const pane = workspaces.focusedPaneId;
    workspaces.addTab("a1", ROOT, pane);
    workspaces.openBoard(pane, true);
    workspaces.openDoc(pane, ROOT, "a.md");
    workspaces.openDoc(pane, ROOT, "b.md");
    workspaces.selectTab(pane, 2);
    writeSnapshot(workspaces.all(), workspaces.active.id);
    const layout = readSnapshot()!.profiles[0]!.workspaces[0]!.layout;
    const [restored] = panes(layout);
    expect(restored!.agentIds).toEqual([BOARD_TAB, docTab(ROOT, "a.md"), docTab(ROOT, "b.md")]);
    expect(restored!.activeIdx).toBe(1);
  });

  it("reads a reader pane written before documents were tabs of any pane", () => {
    const workspaces = new Workspaces();
    writeSnapshot(workspaces.all(), workspaces.active.id);
    const session = JSON.parse(readFileSync(snapshotPath(), "utf8"));
    session.profiles[0].workspaces[0].layout = {
      type: "pane",
      pane: { reader: { root: ROOT, path: "b.md", docs: [{ root: ROOT, path: "a.md" }] } },
    };
    writeFileSync(snapshotPath(), JSON.stringify(session));
    const [restored] = panes(readSnapshot()!.profiles[0]!.workspaces[0]!.layout);
    expect(restored!.agentIds).toEqual([docTab(ROOT, "a.md"), docTab(ROOT, "b.md")]);
    expect(restored!.activeIdx).toBe(1);
  });

  it("adopts a host blob's reader pane, keeping who it follows", () => {
    const workspaces = new Workspaces();
    const [profile] = workspaces.all();
    const old = {
      type: "pane",
      pane: {
        id: "n1",
        agentIds: [],
        activeIdx: 0,
        reader: { root: ROOT, path: "a.md", follow: "a3", editor: "a3", docs: [{ root: ROOT, path: "a.md" }, { root: ROOT, path: "b.md" }], rev: 4 },
      },
    } as unknown as LayoutNode;
    const blob = [{ ...profile!, workspaces: [{ ...profile!.workspaces[0]!, layout: old }] }];
    const [pane] = panes(adoptReaders(blob)[0]!.workspaces[0]!.layout);
    expect(pane!.agentIds).toEqual([docTab(ROOT, "a.md"), docTab(ROOT, "b.md")]);
    expect(pane!.activeIdx).toBe(0);
    expect(pane!.reader).toEqual({ root: ROOT, follow: "a3", editor: "a3", rev: 4 });
    // Adopting what is already current changes nothing.
    const again = adoptReaders(adoptReaders(blob));
    expect(panes(again[0]!.workspaces[0]!.layout)[0]!.agentIds).toEqual(pane!.agentIds);
  });
});

/**
 * Boards are the database's, so the file carries the keys it knows them by
 * and never a card. A file from a build before the database still has
 * boards in it, and those are read — for `Store.attach` to adopt, never to
 * write back.
 */
describe("boards and the layout file", () => {
  it("writes keys and never a board, and reads an old file's boards and keyless workspaces", () => {
    const workspaces = new Workspaces();
    workspaces.openBoard(workspaces.focusedPaneId);
    writeSnapshot(workspaces.all(), workspaces.active.id);
    const stored = JSON.parse(readFileSync(snapshotPath(), "utf8"));
    expect(stored.profiles[0].key).toBe(workspaces.active.key);
    expect(stored.profiles[0].workspaces[0].key).toBe(workspaces.active.workspaces[0]!.key);
    expect(stored.profiles[0].board).toBeUndefined();
    expect(stored.profiles[0].workspaces[0].board).toBeUndefined();
    const back = readSnapshot()!;
    expect(back.profiles[0]!.key).toBe(workspaces.active.key);
    expect(back.profiles[0]!.workspaces[0]!.key).toBe(workspaces.active.workspaces[0]!.key);

    // As a build from before the database wrote it: boards, and no keys.
    delete stored.profiles[0].key;
    delete stored.profiles[0].workspaces[0].key;
    stored.profiles[0].workspaces[0].board = { next: 2, cards: [{ id: "c1", number: 1, title: "from an older server", column: "todo" }] };
    writeFileSync(snapshotPath(), JSON.stringify(stored));
    const old = readSnapshot()!;
    expect(old.profiles[0]!.key).toMatch(/^pk[0-9a-f]{12}$/);
    expect(old.profiles[0]!.workspaces[0]!.board!.cards.map((c) => c.title)).toEqual(["from an older server"]);
  });
});
