/**
 * What an agent made: the paths a reply names, and which of them earn a link.
 * Tested against replies shaped the way agents actually end a turn — a
 * research turn's "written to", a feature turn's list of files, a diagnosis
 * pointing at a line — because the rule's whole job is telling those apart,
 * and the server half's disk checks are tested beside it against a real
 * temporary project.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MADE_MAX,
  adoptMade,
  mentionsIn,
  nextMade,
  pickMade,
  readsInReader,
  sameMade,
  splitMentions,
  withPinned,
  type Located,
  type MadeFile,
} from "../../shared/made";
import { allowRoot } from "../src/files";
import { MadeFiles, locateMentions } from "../src/made";

const paths = (text: string) => mentionsIn(text).map((m) => m.path);
const cues = (text: string) => mentionsIn(text).map((m) => `${m.path}${m.cue ? " *" : ""}`);

describe("mentionsIn", () => {
  test("backticks, Markdown links and bare paths, in the order they come", () => {
    expect(paths("Read [the plan](docs/plan.md), then `server/src/index.ts:120`, and notes/today.txt.")).toEqual([
      "docs/plan.md",
      "server/src/index.ts",
      "notes/today.txt",
    ]);
  });

  test("a line on the end is the line, in each of the ways agents write one", () => {
    const lines = (text: string) => mentionsIn(text).map((m) => m.line);
    expect(lines("`a/b.ts:12` `a/c.ts:3:9` `a/d.ts:40-52` a/e.ts#L7 a/f.ts#L8-L9 `a/g.ts`")).toEqual([12, 3, 40, 7, 8, null]);
  });

  test("the text is the words as written, so the drawer can find them again", () => {
    const [m] = mentionsIn("see `docs/x.md:3` now");
    expect(m).toMatchObject({ text: "docs/x.md:3", path: "docs/x.md", line: 3 });
    expect("see `docs/x.md:3` now".slice(m!.at, m!.at + m!.text.length)).toBe("docs/x.md:3");
  });

  test("an anchor is not part of the file", () => {
    expect(paths("`docs/layout.md#worktrees`")).toEqual(["docs/layout.md"]);
  });

  test("URLs, commands, versions and numbers are not paths", () => {
    expect(paths("Open https://example.com/docs/x.md or run `bun run dev`, v0.3.0 is 3.5× faster; `true`.")).toEqual([]);
  });

  test("home, relative and absolute roots are kept as written", () => {
    expect(paths("~/notes/a.md ../other/b.md ./c.md /Users/me/d.md")).toEqual(["~/notes/a.md", "../other/b.md", "./c.md", "/Users/me/d.md"]);
  });

  test("a path with a space is only a path between backticks", () => {
    expect(paths("`docs/Mi plan.md` and docs/Mi plan.md")).toEqual(["docs/Mi plan.md", "plan.md"]);
  });

  test("names without a dot or a slash are words", () => {
    expect(paths("`Makefile` and `README` and `docs/`")).toEqual(["docs/"]);
  });

  test("a bare path inside backticks is found once", () => {
    expect(mentionsIn("`docs/a.md`")).toHaveLength(1);
  });

  test("capped, since each one costs a stat", () => {
    const many = Array.from({ length: 50 }, (_, i) => `f${i}/x.md`).join(" ");
    expect(mentionsIn(many)).toHaveLength(32);
  });
});

describe("presented as the result", () => {
  test("verbs of making, in English and Spanish", () => {
    expect(cues("Written to `docs/research/soportes-tablet.md`.")).toEqual(["docs/research/soportes-tablet.md *"]);
    expect(cues("I wrote the plan to docs/plan.md")).toEqual(["docs/plan.md *"]);
    expect(cues("Lo guardé en `docs/socios.md`.")).toEqual(["docs/socios.md *"]);
    expect(cues("La investigación está en `docs/research/a.md`")).toEqual(["docs/research/a.md *"]);
    expect(cues("Escribí `docs/b.md`")).toEqual(["docs/b.md *"]);
  });

  test("where it is now, and here's", () => {
    expect(cues("The report is in `out/report.md`")).toEqual(["out/report.md *"]);
    expect(cues("Here's the script: `tools/fix.ts`")).toEqual(["tools/fix.ts *"]);
  });

  test("a label right before it, and (new) right after", () => {
    expect(cues("**Plan:** `docs/plan.md`")).toEqual(["docs/plan.md *"]);
    expect(cues("Report → docs/r.md")).toEqual(["docs/r.md *"]);
    expect(cues("- `docs/new.md` (new)")).toEqual(["docs/new.md *"]);
    expect(cues("- `docs/nuevo.md` — nuevo")).toEqual(["docs/nuevo.md *"]);
  });

  test("a mention of a plan is not a presentation of one", () => {
    expect(cues("Implemented the plan in `docs/plan.md`")).toEqual(["docs/plan.md"]);
    expect(cues("Per `CLAUDE.md`, I did not commit.")).toEqual(["CLAUDE.md"]);
  });

  test("the cue is this sentence's, not the last one's", () => {
    expect(cues("Wrote the handler. It reads `config.json`.")).toEqual(["config.json"]);
    expect(cues("Created the table\n- uses `db/schema.sql`")).toEqual(["db/schema.sql"]);
  });
});

const ROOT = "/p";

function at(path: string, opts: { cue?: boolean; changed?: boolean; line?: number | null; order?: number } = {}): Located {
  return {
    mention: { text: path, path, line: opts.line ?? null, cue: opts.cue ?? false, at: opts.order ?? 0 },
    file: { root: ROOT, path, line: opts.line ?? null },
    changed: opts.changed ?? false,
  };
}

const picked = (found: Located[]) => pickMade(found).map((f) => f.path);

describe("pickMade", () => {
  test("a research turn: the document it changed, though nothing presented it", () => {
    expect(picked([at("docs/research/soportes-tablet.md", { changed: true })])).toEqual(["docs/research/soportes-tablet.md"]);
  });

  test("a feature turn: the docs it touched on the way are not the deliverable", () => {
    expect(
      picked([
        at("server/src/made.ts", { changed: true, order: 1 }),
        at("web/src/Sidebar.tsx", { changed: true, order: 2 }),
        at("docs/layout.md", { changed: true, order: 3 }),
      ]),
    ).toEqual([]);
  });

  test("…unless one is presented: a new plan beside the code is still the thing to read", () => {
    expect(picked([at("server/src/a.ts", { changed: true }), at("docs/plan.md", { changed: true, cue: true, order: 1 })])).toEqual(["docs/plan.md"]);
  });

  test("an unchanged document that was only mentioned is not a link", () => {
    expect(picked([at("CLAUDE.md")])).toEqual([]);
  });

  test("an unchanged document presented as the answer is", () => {
    expect(picked([at("docs/plan.md", { cue: true })])).toEqual(["docs/plan.md"]);
  });

  test("code needs presenting, and a reply about one or two files", () => {
    expect(picked([at("tools/fix.ts", { cue: true, changed: true })])).toEqual(["tools/fix.ts"]);
    expect(picked([at("a.ts", { cue: true }), at("b.ts", { cue: true, order: 1 }), at("c.ts", { cue: true, order: 2 })])).toEqual([]);
    expect(picked([at("a.ts", { changed: true })])).toEqual([]);
  });

  test("presented first, then in the order named, at most two", () => {
    expect(
      picked([
        at("docs/a.md", { changed: true, order: 1 }),
        at("docs/b.md", { changed: true, order: 2 }),
        at("docs/c.md", { cue: true, order: 3 }),
      ]),
    ).toEqual(["docs/c.md", "docs/a.md"]);
    expect(MADE_MAX).toBe(2);
  });

  test("a file named twice counts once, with the cue and the line either mention gave", () => {
    const out = pickMade([at("tools/fix.ts", { order: 1 }), at("tools/fix.ts", { cue: true, line: 40, order: 2 })]);
    expect(out).toEqual([{ root: ROOT, path: "tools/fix.ts", line: 40 }]);
  });

  test("a picture is never a link", () => {
    expect(picked([at("shots/after.png", { cue: true })])).toEqual([]);
  });
});

describe("nextMade", () => {
  const before: MadeFile[] = [{ root: ROOT, path: "docs/plan.md", line: null }];

  test("a turn that names nothing keeps the last links", () => {
    expect(nextMade(before, [])).toEqual(before);
  });

  test("a turn that only mentions files in passing keeps them too", () => {
    expect(nextMade(before, [at("CLAUDE.md")])).toEqual(before);
  });

  test("a turn that worked on other files moves on", () => {
    expect(nextMade(before, [at("a.ts", { changed: true }), at("b.ts", { changed: true }), at("c.ts", { changed: true })])).toEqual([]);
  });

  test("a turn with a deliverable replaces them", () => {
    expect(nextMade(before, [at("docs/next.md", { cue: true })]).map((f) => f.path)).toEqual(["docs/next.md"]);
  });
});

describe("the small helpers", () => {
  test("withPinned puts the file first, once, and keeps the cap", () => {
    const a = { root: ROOT, path: "a.md", line: null };
    const b = { root: ROOT, path: "b.md", line: null };
    const c = { root: ROOT, path: "c.md", line: 3 };
    expect(withPinned([a, b], c)).toEqual([c, a]);
    expect(withPinned([a, b], { ...b, line: 9 })).toEqual([{ ...b, line: 9 }, a]);
  });

  test("sameMade and adoptMade", () => {
    expect(sameMade(undefined, [])).toBe(true);
    expect(sameMade([{ root: ROOT, path: "a", line: 1 }], [{ root: ROOT, path: "a", line: 2 }])).toBe(false);
    expect(adoptMade([{ root: "/p", path: "a.md", line: 3 }, { root: "rel", path: "x" }, "junk", { root: "/p", path: "b.md", line: -1 }])).toEqual([
      { root: "/p", path: "a.md", line: 3 },
    ]);
    expect(adoptMade("nope")).toEqual([]);
  });

  test("readsInReader is the reader's own three", () => {
    expect(["a.md", "a.markdown", "a.mdx", "a.txt", "a.ts"].map(readsInReader)).toEqual([true, true, true, false, false]);
  });

  test("splitMentions puts the words back together around the paths", () => {
    const text = "Written to `docs/a.md`, see x.ts:3.";
    const parts = splitMentions(text);
    expect(parts.map((p) => ("text" in p ? p.text : `[${p.mention.text}]`)).join("")).toBe("Written to `[docs/a.md]`, see [x.ts:3].");
  });
});

// ---------------------------------------------------------------------------
// The disk half
// ---------------------------------------------------------------------------

let dir = "";
let project = "";

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "kururu-made-")));
  project = join(dir, "holapy");
  mkdirSync(join(project, "docs", "research"), { recursive: true });
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "docs", "research", "soportes-tablet.md"), "# Soportes\n");
  writeFileSync(join(project, "src", "app.ts"), "export {};\n");
  writeFileSync(join(project, "CLAUDE.md"), "rules\n");
  writeFileSync(join(dir, "outside.md"), "not in the project\n");
  // Older than any turn below, so only what a test touches counts as changed.
  const old = new Date(Date.now() - 3_600_000);
  for (const file of ["docs/research/soportes-tablet.md", "src/app.ts", "CLAUDE.md"]) utimesSync(join(project, file), old, old);
  allowRoot(project);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("locateMentions", () => {
  test("relative to the agent's directory, inside an allowed root, with whether the turn changed it", () => {
    const since = Date.now() - 60_000;
    writeFileSync(join(project, "docs", "research", "soportes-tablet.md"), "# Soportes\n\nRAM mounts.\n");
    const found = locateMentions(mentionsIn("Written to `docs/research/soportes-tablet.md`, per CLAUDE.md."), [project], since);
    expect(found.map((f) => [f.file.path, f.changed])).toEqual([
      ["docs/research/soportes-tablet.md", true],
      ["CLAUDE.md", false],
    ]);
    expect(found[0]!.file.root).toBe(project);
  });

  test("a file that is not there, or is outside every root, is not found", () => {
    const found = locateMentions(mentionsIn("`docs/missing.md` and `../outside.md` and `/etc/hosts`"), [project], 0);
    expect(found).toEqual([]);
  });

  test("an absolute path inside the root is found from anywhere", () => {
    const found = locateMentions(mentionsIn(`See ${join(project, "src", "app.ts")}:4`), ["/nowhere"], 0);
    expect(found.map((f) => [f.file.path, f.file.line])).toEqual([["src/app.ts", 4]]);
  });
});

describe("MadeFiles", () => {
  test("a turn's pick lands on the agent, survives a reload from disk, and goes when the file does", () => {
    const file = join(dir, "made.json");
    const made = new MadeFiles(file);
    const agent = { id: "a1", createdAt: 1, cwd: project };
    const since = Date.now() - 60_000;
    writeFileSync(join(project, "docs", "research", "soportes-tablet.md"), "# Soportes v2\n");
    const changed = made.turnEnded(agent, "Updated `docs/research/soportes-tablet.md` with the RAM mounts.", since);
    expect(changed).toBe(true);
    expect(made.of("a1").map((f) => f.path)).toEqual(["docs/research/soportes-tablet.md"]);
    made.flush();

    const again = new MadeFiles(file);
    again.load();
    expect(again.of("a1").map((f) => f.path)).toEqual(["docs/research/soportes-tablet.md"]);
    // A different terminal that was given the same id after a host restart
    // inherits nothing.
    expect(again.sweep([{ id: "a1", createdAt: 2 }])).toBe(true);
    expect(again.of("a1")).toEqual([]);

    rmSync(join(project, "docs", "research", "soportes-tablet.md"));
    expect(made.sweep([{ id: "a1", createdAt: 1 }])).toBe(true);
    expect(made.of("a1")).toEqual([]);
  });
});
